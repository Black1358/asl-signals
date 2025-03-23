import type { Derived, Effect, State } from "#/types.js";
import {
	active_reaction,
	active_effect,
	untracked_writes,
	get,
	schedule_effect,
	set_untracked_writes,
	set_signal_status,
	untrack,
	increment_write_version,
	reaction_sources,
	untracking,
	is_destroying_effect,
	push_reaction_value,
} from "#/runtime.js";
import { equals } from "#/reactivity/equality.js";
import { CLEAN, DERIVED, DIRTY, BRANCH_EFFECT, UNOWNED, MAYBE_DIRTY, BLOCK_EFFECT, ROOT_EFFECT } from "#/constants.js";
import { state_unsafe_mutation } from "#/errors.js";
import { proxy } from "#/proxy.js";

export const old_values = new Map();

export function source<V>(v: V): State<V> {
	return {
		f: 0, // Так рекомендовано делать в исходниках
		v,
		reactions: null,
		equals,
		rv: 0,
		wv: 0,
	};
}

export function state<V>(v: V): State<V> {
	const s = source<V>(v);
	push_reaction_value(s);
	return s;
}

export function mutate<V>(source: State<V>, value: V) {
	set(
		source,
		untrack(() => get(source))
	);
	return value;
}

export function set<V>(source: State<V>, value: V, should_proxy: boolean = false): V {
	if (active_reaction !== null && !untracking && (active_reaction.f & (DERIVED | BLOCK_EFFECT)) !== 0 && !reaction_sources?.includes(source)) {
		state_unsafe_mutation();
	}

	const new_value = should_proxy ? proxy(value) : value;

	return internal_set(source, new_value);
}

export function internal_set<V>(source: State<V>, value: V): V {
	if (!source.equals(value)) {
		const old_value = source.v;

		if (is_destroying_effect) {
			old_values.set(source, value);
		} else {
			old_values.set(source, old_value);
		}

		source.v = value;
		source.wv = increment_write_version();

		mark_reactions(source, DIRTY);

		// It's possible that the current reaction might not have up-to-date dependencies
		// whilst it's actively running. So in the case of ensuring it registers the reaction
		// properly for itself, we need to ensure the current effect actually gets
		// scheduled. i.e: `$effect(() => x++)`
		if (active_effect !== null && (active_effect.f & CLEAN) !== 0 && (active_effect.f & (BRANCH_EFFECT | ROOT_EFFECT)) === 0) {
			if (untracked_writes === null) {
				set_untracked_writes([source]);
			} else {
				untracked_writes.push(source);
			}
		}
	}
	return value;
}

export function update<T extends number | bigint>(source: State<T>, d: 1 | -1 = 1): T {
	let value = get(source);
	const result = d === 1 ? value++ : value--;
	set(source, value);
	return result as T;
}

export function update_pre<T extends number | bigint>(source: State<T>, d: 1 | -1 = 1): T {
	let value = get(source);
	// @ts-expect-error ts не умеет в математику
	return set(source, d === 1 ? ++value : --value);
}

/**
 * @param {State} signal
 * @param {number} status should be DIRTY or MAYBE_DIRTY
 * @returns {void}
 */
function mark_reactions(signal: State, status: number): void {
	const reactions = signal.reactions;
	if (reactions === null) return;

	const runes = true;
	const length = reactions.length;

	for (let i = 0; i < length; i++) {
		const reaction = reactions[i];
		const flags = reaction.f;

		// Skip any effects that are already dirty
		if ((flags & DIRTY) !== 0) continue;

		// In legacy mode, skip the current effect to prevent infinite loops
		if (!runes && reaction === active_effect) continue;

		set_signal_status(reaction, status);

		// If the signal a) was previously clean or b) is an unowned derived, then mark it
		if ((flags & (CLEAN | UNOWNED)) !== 0) {
			if ((flags & DERIVED) !== 0) {
				mark_reactions(reaction as Derived, MAYBE_DIRTY);
			} else {
				schedule_effect(reaction as Effect);
			}
		}
	}
}
