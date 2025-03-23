import type { Derived, Effect } from "#/types.js";
import { BOUNDARY_EFFECT, DERIVED, DESTROYED, DIRTY, EFFECT, EFFECT_HAS_DERIVED, EFFECT_RAN, ROOT_EFFECT, UNOWNED } from "#/constants.js";
import { effect_in_teardown, effect_in_unowned_derived, effect_orphan } from "#/errors.js";
import { remove_reactions, Runtime, schedule_effect, set_signal_status, update_effect } from "#/runtime.js";

function validate_effect() {
	if (Runtime.active_effect === null && Runtime.active_reaction === null) effect_orphan();
	if (Runtime.active_reaction !== null && (Runtime.active_reaction.f & UNOWNED) !== 0 && Runtime.active_effect === null) effect_in_unowned_derived();
	if (Runtime.is_destroying_effect) effect_in_teardown();
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

function create_effect(type: number, fn: null | (() => void | (() => void)), sync: boolean, push: boolean = true): Effect {
	const parent = Runtime.active_effect;

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
		if (Runtime.active_reaction !== null && (Runtime.active_reaction.f & DERIVED) !== 0) {
			const derived = Runtime.active_reaction as Derived;
			(derived.effects ??= []).push(effect);
		}
	}

	return effect;
}

//...

/**
 * Internal representation of `$effect.tracking()`
 */
export function effect_tracking(): boolean {
	return Runtime.active_reaction !== null && !Runtime.untracking;
}

/**
 * Internal representation of `$effect(...)`
 * @param {() => void | (() => void)} fn
 */
export function user_effect(fn: () => void | (() => void)) {
	validate_effect();
	return create_effect(EFFECT, fn, false);
}

/**
 * Internal representation of `$effect.root(...)`
 */
export function effect_root(fn: () => void | (() => void)): () => void {
	const effect = create_effect(ROOT_EFFECT, fn, true);
	return () => {
		destroy_effect(effect);
	};
}

//...

export function execute_effect_teardown(effect: Effect) {
	const teardown = effect.teardown;
	if (teardown !== null) {
		const previously_destroying_effect = Runtime.is_destroying_effect;
		const previous_reaction = Runtime.active_reaction;
		Runtime.is_destroying_effect = true;
		Runtime.active_reaction = null;
		try {
			teardown.call(null);
		} finally {
			Runtime.is_destroying_effect = previously_destroying_effect;
			Runtime.active_reaction = previous_reaction;
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
