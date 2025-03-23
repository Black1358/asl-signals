import type { Derived, Effect, State } from "#/types.js";
import { CLEAN, DERIVED, DIRTY, MAYBE_DIRTY, ROOT_EFFECT, UNOWNED } from "#/constants.js";
import { state_unsafe_mutation } from "#/errors.js";
import { proxy } from "#/proxy.js";
import { equals } from "#/reactivity/equality.js";
import { get, increment_write_version, push_reaction_value, Runtime, schedule_effect, set_signal_status, untrack } from "#/runtime.js";

//...

/**
 * @param {State} state
 * @param {number} status should be DIRTY or MAYBE_DIRTY
 */
function mark_reactions(state: State, status: number): void {
	const reactions = state.reactions;
	if (reactions === null) return;
	const length = reactions.length;

	for (let i = 0; i < length; i++) {
		const reaction = reactions[i];
		const flags = reaction.f;

		// Skip any effects that are already dirty
		if ((flags & DIRTY) !== 0) continue;
		set_signal_status(reaction, status);

		/*
			If the signal
				a) was previously clean or
				b) is an unowned derived, then mark it
		 */
		if ((flags & (CLEAN | UNOWNED)) !== 0) {
			if ((flags & DERIVED) !== 0) {
				mark_reactions(reaction as Derived, MAYBE_DIRTY);
			} else {
				schedule_effect(reaction as Effect);
			}
		}
	}
}

export const old_values = new Map();

function internal_set<V>(source: State<V>, value: V): V {
	if (!source.equals(value)) {
		const old_value = source.v;

		old_values.set(source, Runtime.is_destroying_effect ? value : old_value);

		source.v = value;
		source.wv = increment_write_version();

		mark_reactions(source, DIRTY);

		// It's possible that the current reaction might not have up-to-date dependencies
		// whilst it's actively running. So in the case of ensuring it registers the reaction
		// properly for itself, we need to ensure the current effect actually gets
		// scheduled. i.e: `$effect(() => x++)`
		if (Runtime.active_effect !== null && (Runtime.active_effect.f & CLEAN) !== 0 && (Runtime.active_effect.f & ROOT_EFFECT) === 0) {
			if (Runtime.untracked_writes === null) {
				Runtime.untracked_writes = [source];
			} else {
				Runtime.untracked_writes.push(source);
			}
		}
	}
	return value;
}

//...

export function mutate<V>(source: State<V>, value: V) {
	set(
		source,
		untrack(() => get(source))
	);
	return value;
}

export function set<V>(source: State<V>, value: V, should_proxy: boolean = false): V {
	if (
		Runtime.active_reaction !== null &&
		!Runtime.untracking &&
		(Runtime.active_reaction.f & DERIVED) !== 0 &&
		!Runtime.reaction_sources?.includes(source)
	) {
		state_unsafe_mutation();
	}

	const new_value = should_proxy ? proxy(value) : value;
	return internal_set(source, new_value);
}

export function update<T extends number | bigint>(source: State<T>, d: 1 | -1 = 1): T {
	let value = get(source);
	const result = d === 1 ? value++ : value--;
	set(source, value);
	return result as T;
}

export function update_pre<T extends number | bigint>(source: State<T>, d: 1 | -1 = 1): T {
	let value = get(source);
	// @ts-expect-error <ts не умеет в математику>
	return set(source, d === 1 ? ++value : --value);
}

//...

export function $state<V>(v: V): State<V> {
	const s: State<V> = {
		f: 0, // Так рекомендовано делать в исходниках
		v,
		reactions: null,
		equals,
		rv: 0,
		wv: 0,
	};
	push_reaction_value(s);
	return s;
}
