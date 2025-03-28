import type { Callback, Derived, Effect } from "#/types.js";
import {
	BOUNDARY_EFFECT,
	BRANCH_EFFECT,
	DERIVED,
	DESTROYED,
	DIRTY,
	EFFECT,
	EFFECT_HAS_DERIVED,
	EFFECT_RAN,
	ROOT_EFFECT,
	UNOWNED,
} from "#/constants.js";
import { effect_in_teardown, effect_in_unowned_derived, effect_orphan } from "#/errors.js";
import {
	active_effect,
	active_reaction,
	is_destroying_effect,
	remove_reactions,
	schedule_effect,
	set_active_reaction,
	set_is_destroying_effect,
	set_signal_status,
	untracking,
	update_effect,
} from "#/runtime.js";

//...

export function execute_effect_teardown(effect: Effect) {
	const teardown = effect.teardown;
	if (teardown !== null) {
		const previously_destroying_effect = is_destroying_effect;
		const previous_reaction = active_reaction;
		set_is_destroying_effect(true);
		set_active_reaction(null);
		try {
			teardown.call(null);
		} finally {
			set_is_destroying_effect(previously_destroying_effect);
			set_active_reaction(previous_reaction);
		}
	}
}

export function destroy_effect_children(signal: Effect) {
	let effect = signal.first;
	signal.first = signal.last = null;

	while (effect !== null) {
		const next = effect.next;

		if ((effect.f & ROOT_EFFECT) !== 0) {
			// this is now an independent root
			effect.parent = null;
		} else {
			destroy_effect(effect);
		}

		effect = next;
	}
}

export function destroy_block_effect_children(signal: Effect) {
	let effect = signal.first;

	while (effect !== null) {
		const next = effect.next;
		if ((effect.f & BRANCH_EFFECT) === 0) {
			destroy_effect(effect);
		}
		effect = next;
	}
}

export function destroy_effect(effect: Effect) {
	destroy_effect_children(effect);
	remove_reactions(effect, 0);
	set_signal_status(effect, DESTROYED);

	execute_effect_teardown(effect);

	const parent = effect.parent;

	// If the parent doesn't have any children, then skip this work altogether
	if (parent !== null && parent.first !== null) unlink_effect(effect);

	// `first` and `child` are nulled out in destroy_effect_children
	// we don't null out `parent` so that error propagation can work correctly
	effect.next = effect.prev = effect.teardown = effect.deps = effect.fn = null;
}

/**
 * Detach an effect from the effect tree, freeing up memory and
 * reducing the amount of work that happens on subsequent traversals
 */
export function unlink_effect(effect: Effect) {
	const parent = effect.parent;
	const prev = effect.prev;
	const next = effect.next;

	if (prev !== null) prev.next = next;
	if (next !== null) next.prev = prev;

	if (parent !== null) {
		if (parent.first === effect) parent.first = next;
		if (parent.last === effect) parent.last = prev;
	}
}

//...

function validate_effect() {
	if (active_effect === null && active_reaction === null) effect_orphan();
	if (active_reaction !== null && (active_reaction.f & UNOWNED) !== 0 && active_effect === null) effect_in_unowned_derived();
	if (is_destroying_effect) effect_in_teardown();
}

function push_effect(effect: Effect, parent_effect: Effect) {
	const parent_last = parent_effect.last;
	if (parent_last === null) {
		parent_effect.last = parent_effect.first = effect;
	} else {
		parent_last.next = effect;
		effect.prev = parent_last;
		parent_effect.last = effect;
	}
}

function create_effect(type: number, fn: Callback | null, sync: boolean, push: boolean = true): Effect {
	const parent = active_effect;

	const effect: Effect = {
		deps: null,
		f: type | DIRTY,
		first: null,
		fn,
		last: null,
		next: null,
		parent,
		prev: null,
		teardown: null,
		wv: 0,
	};

	if (sync) {
		try {
			update_effect(effect);
			effect.f |= EFFECT_RAN;
		} catch (e) {
			destroy_effect(effect);
			throw e;
		}
	} else if (fn !== null) {
		schedule_effect(effect);
	}

	// if an effect has no dependencies, no DOM and no teardown function,
	// don't bother adding it to the effect tree
	const inert =
		sync && effect.deps === null && effect.first === null && effect.teardown === null && (effect.f & (EFFECT_HAS_DERIVED | BOUNDARY_EFFECT)) === 0;

	if (!inert && push) {
		if (parent !== null) {
			push_effect(effect, parent);
		}

		// if we're in a derived, add the effect there too
		if (active_reaction !== null && (active_reaction.f & DERIVED) !== 0) {
			const derived = active_reaction as Derived;
			(derived.effects ??= []).push(effect);
		}
	}

	return effect;
}

//...

/**
 * `$effect(...)`
 */
export function effect(fn: Callback) {
	validate_effect();
	return create_effect(EFFECT, fn, false);
}

/**
 * `$effect.root(...)`
 */
export function effect_root(fn: Callback): () => void {
	const effect = create_effect(ROOT_EFFECT, fn, true);
	return () => destroy_effect(effect); // Функция уничтожения зоны эффектов
}

/**
 * `$effect.tracking()`
 */
export function effect_tracking(): boolean {
	return active_reaction !== null && !untracking;
}

//...

export type $Effect = typeof effect & { root: typeof effect_root; tracking: typeof effect_tracking };

const $effect: $Effect = effect as $Effect;
$effect.root = effect_root;
$effect.tracking = effect_tracking;

export { $effect };
