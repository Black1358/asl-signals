import type { Derived, Effect } from "#/types.js";
import { CLEAN, DERIVED, DIRTY, EFFECT_HAS_DERIVED, MAYBE_DIRTY, UNOWNED } from "#/constants.js";
import { destroy_effect } from "#/reactivity/effects.js";
import { equals, safe_equals } from "#/reactivity/equality.js";
import {
	active_effect,
	active_reaction,
	increment_write_version,
	push_reaction_value,
	set_active_effect,
	set_signal_status,
	skip_reaction,
	update_reaction,
} from "#/runtime.js";

//...

export function derived<V>(fn: () => V): Derived<V> {
	let flags = DERIVED | DIRTY;
	const parent_derived = active_reaction !== null && (active_reaction.f & DERIVED) !== 0 ? (active_reaction as Derived) : null;

	if (active_effect === null || (parent_derived !== null && (parent_derived.f & UNOWNED) !== 0)) {
		flags |= UNOWNED;
	} else {
		// Since deriveds are evaluated lazily, any effects created inside them are
		// created too late to ensure that the parent effect is added to the tree
		active_effect.f |= EFFECT_HAS_DERIVED;
	}

	return {
		deps: null,
		effects: null,
		equals,
		f: flags,
		fn,
		reactions: null,
		rv: 0,
		v: null as V,
		wv: 0,
		parent: parent_derived ?? active_effect,
	};
}

export function user_derived<V>(fn: () => V): Derived<V> {
	const d = derived(fn);
	push_reaction_value(d);
	return d;
}

export function derived_safe_equal<V>(fn: () => V): Derived<V> {
	const signal = derived(fn);
	signal.equals = safe_equals;
	return signal;
}

//...

function get_derived_parent_effect(derived: Derived): Effect | null {
	let parent = derived.parent;
	while (parent !== null) {
		if ((parent.f & DERIVED) === 0) return parent as Effect;
		parent = parent.parent;
	}
	return null;
}

function execute_derived<T>(derived: Derived<T>): T {
	let value: T;
	const prev_active_effect = active_effect;

	set_active_effect(get_derived_parent_effect(derived));

	try {
		destroy_derived_effects(derived);
		value = update_reaction(derived);
	} finally {
		set_active_effect(prev_active_effect);
	}

	return value;
}

//...

export function update_derived(derived: Derived) {
	const value = execute_derived(derived);
	const status = (skip_reaction || (derived.f & UNOWNED) !== 0) && derived.deps !== null ? MAYBE_DIRTY : CLEAN;

	set_signal_status(derived, status);

	if (!derived.equals(value)) {
		derived.v = value;
		derived.wv = increment_write_version();
	}
}

export function destroy_derived_effects(derived: Derived) {
	const effects = derived.effects;
	if (effects !== null) {
		derived.effects = null;
		for (let i = 0; i < effects.length; i += 1) {
			destroy_effect(effects[i]);
		}
	}
}
