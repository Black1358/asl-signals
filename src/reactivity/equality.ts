import type { State } from "#/types.js";

export function equals(this: State, value: unknown): boolean {
	return value === this.v;
}

export function safe_not_equal(a: unknown, b: unknown): boolean {
	return a != a ? b == b : a !== b || (a !== null && typeof a === "object") || typeof a === "function";
}

export function safe_equals(this: State, value: unknown) {
	return !safe_not_equal(value, this.v);
}
