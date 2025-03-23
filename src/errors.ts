/**
 * `$effect()` cannot be used inside an effect cleanup function
 */
export function effect_in_teardown(): never {
	throw new Error(`https://svelte.dev/e/effect_in_teardown`);
}

/**
 * Effect cannot be created inside a `$derived` value that was not itself created inside an effect
 */
export function effect_in_unowned_derived(): never {
	throw new Error(`https://svelte.dev/e/effect_in_unowned_derived`);
}

/**
 * `$effect()` can only be used inside an `$effect.root()`
 */
export function effect_orphan(): never {
	throw new Error(`https://svelte.dev/e/effect_orphan`);
}

/**
 * Maximum update depth exceeded. This can happen when a reactive block or effect repeatedly sets a new value. Svelte limits the number of nested updates to prevent infinite loops
 */
export function effect_update_depth_exceeded(): never {
	throw new Error(`https://svelte.dev/e/effect_update_depth_exceeded`);
}

/**
 * Property descriptors defined on `$state` objects must contain `value` and always be `enumerable`, `configurable` and `writable`.
 */
export function state_descriptors_fixed(): never {
	throw new Error(`https://svelte.dev/e/state_descriptors_fixed`);
}

/**
 * Cannot set prototype of `$state` object
 */
export function state_prototype_fixed(): never {
	throw new Error(`https://svelte.dev/e/state_prototype_fixed`);
}

/**
 * Updating state inside a derived or a template expression is forbidden. If the value should not be reactive, declare it without `$state`
 */
export function state_unsafe_mutation(): never {
	throw new Error(`https://svelte.dev/e/state_unsafe_mutation`);
}
