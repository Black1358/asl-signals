import type { Callback, Derived, Effect } from "#/types.js";
import { BOUNDARY_EFFECT, DERIVED, DESTROYED, DIRTY, EFFECT, EFFECT_HAS_DERIVED, EFFECT_RAN, ROOT_EFFECT, UNOWNED } from "#/constants.js";
import { effect_in_teardown, effect_in_unowned_derived, effect_orphan } from "#/errors.js";
import { remove_reactions, Runtime, schedule_effect, set_signal_status, update_effect } from "#/runtime.js";

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

//...

const create_effect = (type: number, fn: Callback, parent: Effect | null): Effect => ({
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
});

/**
 * `$effect(...)`
 */
function effect(fn: Callback): Effect {
	const parent = Runtime.active_effect; // Это глобальный объект-состояние

	if (parent === null && Runtime.active_reaction === null) effect_orphan();
	if (Runtime.active_reaction !== null && (Runtime.active_reaction.f & UNOWNED) !== 0 && parent === null) effect_in_unowned_derived();
	if (Runtime.is_destroying_effect) effect_in_teardown();

	const effect = create_effect(EFFECT, fn, parent);

	schedule_effect(effect);

	// Инертные эффекты - эффекты без зависимостей. Просто обычные функции, которые не нужно трекать
	const inert =
		effect.deps === null && effect.first === null && effect.teardown === null && (effect.f & (EFFECT_HAS_DERIVED | BOUNDARY_EFFECT)) === 0;

	if (!inert) {
		if (parent !== null) {
			const parent_last = parent.last;
			if (parent_last === null) {
				parent.last = parent.first = effect;
			} else {
				parent_last.next = effect;
				effect.prev = parent_last;
				parent.last = effect;
			}
		}

		// if we're in a derived, add the effect there too
		if (Runtime.active_reaction !== null && (Runtime.active_reaction.f & DERIVED) !== 0) {
			const derived = Runtime.active_reaction as Derived;
			(derived.effects ??= []).push(effect);
		}
	}

	return effect;
}

/**
 * `$effect.root(...)`
 */
function effect_root(fn: Callback): () => void {
	const parent = Runtime.active_effect; // Это глобальный объект-состояние
	const effect = create_effect(ROOT_EFFECT, fn, parent);

	try {
		update_effect(effect);
		effect.f |= EFFECT_RAN;
	} catch (e) {
		destroy_effect(effect);
		throw e;
	}

	return () => destroy_effect(effect); // Функция уничтожения зоны эффектов
}

/**
 * `$effect.tracking()`
 */
const effect_tracking = (): boolean => Runtime.active_reaction !== null && !Runtime.untracking;

//...

export type $Effect = typeof effect & { root: typeof effect_root; tracking: typeof effect_tracking };

const $effect: $Effect = effect as $Effect;
$effect.root = effect_root;
$effect.tracking = effect_tracking;

export { $effect };
