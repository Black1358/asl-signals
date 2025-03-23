import type { State } from "#/types.js";
import { STATE_SYMBOL } from "#/constants.js";
import { state_descriptors_fixed, state_prototype_fixed } from "#/errors.js";
import { set, $state } from "#/reactivity/sources.js";
import { get, Runtime } from "#/runtime.js";

const UNINITIALIZED = Symbol();

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function proxy<T>(value: T): T {
	// if non-proxyable, or is already a proxy, return `value`
	if (typeof value !== "object" || value === null || STATE_SYMBOL in value) {
		return value;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== Array.prototype) {
		return value;
	}

	const sources: Map<any, State<any>> = new Map();
	const is_proxied_array = Array.isArray(value);
	const version = $state(0);
	const reaction = Runtime.active_reaction;

	const with_parent = <T>(fn: () => T) => {
		const previous_reaction = Runtime.active_reaction;
		Runtime.active_reaction = reaction;
		const result: T = fn();
		Runtime.active_reaction = previous_reaction;
		return result;
	};

	if (is_proxied_array) {
		// We need to create the length source eagerly to ensure that
		// mutations to the array are properly synced with our proxy
		sources.set("length", $state((value as unknown[]).length));
	}

	return new Proxy(/** @type {any} */ value, {
		defineProperty(_, prop, descriptor) {
			if (!("value" in descriptor) || descriptor.configurable === false || descriptor.enumerable === false || descriptor.writable === false) {
				// we disallow non-basic descriptors, because unless they are applied to the
				// target object — which we avoid, so that state can be forked — we will run
				// afoul of the various invariants
				// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/Proxy/getOwnPropertyDescriptor#invariants
				state_descriptors_fixed();
			}

			let s = sources.get(prop);

			if (s === undefined) {
				s = with_parent(() => $state(descriptor.value));
				sources.set(prop, s);
			} else {
				set(
					s,
					with_parent(() => proxy(descriptor.value))
				);
			}

			return true;
		},

		deleteProperty(target, prop) {
			const s = sources.get(prop);

			if (s === undefined) {
				if (prop in target) {
					sources.set(
						prop,
						with_parent(() => $state(UNINITIALIZED))
					);
				}
			} else {
				// When working with arrays, we need to also ensure we update the length when removing
				// an indexed property
				if (is_proxied_array && typeof prop === "string") {
					const ls = sources.get("length");
					const n = Number(prop);

					if (Number.isInteger(n) && n < ls!.v) {
						set(ls!, n);
					}
				}
				set(s, UNINITIALIZED);
				update_version(version);
			}

			return true;
		},

		get(target, prop, receiver) {
			if (prop === STATE_SYMBOL) return value;

			let s = sources.get(prop);
			const exists = prop in target;

			// create a source, but only if it's an own property and not a prototype property
			if (s === undefined && (!exists || Object.getOwnPropertyDescriptor(target, prop)?.writable)) {
				s = with_parent(() => $state(proxy(exists ? target[prop] : UNINITIALIZED)));
				sources.set(prop, s);
			}

			if (s !== undefined) {
				const v = get(s);
				return v === UNINITIALIZED ? undefined : v;
			}

			return Reflect.get(target, prop, receiver);
		},

		getOwnPropertyDescriptor(target, prop) {
			const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);

			if (descriptor && "value" in descriptor) {
				const s = sources.get(prop);
				if (s) descriptor.value = get(s);
			} else if (descriptor === undefined) {
				const source = sources.get(prop);
				const value = source?.v;

				if (source !== undefined && value !== UNINITIALIZED) {
					return {
						enumerable: true,
						configurable: true,
						value,
						writable: true,
					};
				}
			}

			return descriptor;
		},

		has(target, prop) {
			if (prop === STATE_SYMBOL) {
				return true;
			}

			let s = sources.get(prop);
			const has = (s !== undefined && s.v !== UNINITIALIZED) || Reflect.has(target, prop);

			if (s !== undefined || (Runtime.active_effect !== null && (!has || Object.getOwnPropertyDescriptor(target, prop)?.writable))) {
				if (s === undefined) {
					s = with_parent(() => $state(has ? proxy(target[prop]) : UNINITIALIZED));
					sources.set(prop, s);
				}

				const value = get(s);
				if (value === UNINITIALIZED) {
					return false;
				}
			}

			return has;
		},

		set(target, prop, value, receiver) {
			let s = sources.get(prop);
			let has = prop in target;

			// variable.length = value -> clear all signals with index >= value
			if (is_proxied_array && prop === "length") {
				for (let i = value; i < (s as State<number>).v; i += 1) {
					let other_s = sources.get(i + "");
					if (other_s !== undefined) {
						set(other_s, UNINITIALIZED);
					} else if (i in target) {
						// If the item exists in the original, we need to create an uninitialized source,
						// else a later read of the property would result in a source being created with
						// the value of the original item at that index.
						other_s = with_parent(() => $state(UNINITIALIZED));
						sources.set(i + "", other_s);
					}
				}
			}

			// If we haven't yet created a source for this property, we need to ensure
			// we do so otherwise if we read it later, then the write won't be tracked and
			// the heuristics of effects will be different vs if we had read the proxied
			// object property before writing to that property.
			if (s === undefined) {
				if (!has || Object.getOwnPropertyDescriptor(target, prop)?.writable) {
					s = with_parent(() => $state(undefined));
					set(
						s,
						with_parent(() => proxy(value))
					);
					sources.set(prop, s);
				}
			} else {
				has = s.v !== UNINITIALIZED;
				set(
					s,
					with_parent(() => proxy(value))
				);
			}

			const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);

			// Set the new value before updating any signals so that any listeners get the new value
			if (descriptor?.set) {
				descriptor.set.call(receiver, value);
			}

			if (!has) {
				// If we have mutated an array directly, we might need to
				// signal that length has also changed. Do it before updating metadata
				// to ensure that iterating over the array as a result of a metadata update
				// will not cause the length to be out of sync.
				if (is_proxied_array && typeof prop === "string") {
					const ls = sources.get("length") as State<number>;
					const n = Number(prop);

					if (Number.isInteger(n) && n >= ls.v) {
						set(ls, n + 1);
					}
				}

				update_version(version);
			}

			return true;
		},

		ownKeys(target) {
			get(version);

			const own_keys = Reflect.ownKeys(target).filter((key) => {
				const source = sources.get(key);
				return source === undefined || source.v !== UNINITIALIZED;
			});

			for (const [key, source] of sources) {
				if (source.v !== UNINITIALIZED && !(key in target)) {
					own_keys.push(key);
				}
			}

			return own_keys;
		},

		setPrototypeOf() {
			state_prototype_fixed();
		},
	});
}

function update_version(signal: State<number>, d: 1 | -1 = 1) {
	set(signal, signal.v + d);
}
