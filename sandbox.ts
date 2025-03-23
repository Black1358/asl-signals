import { state, update, set } from "#/reactivity/sources.js";
import { derived } from "#/reactivity/deriveds.js";
import { user_effect, effect_root, effect_tracking } from "#/reactivity/effects.js";
import { get } from "#/runtime.js";
import { exit } from "node:process";

const counter = state(0);
const x2 = derived(() => get(counter) * 2);

console.log("isRoot", !effect_tracking());

effect_root(() => {
	user_effect(() => {
		console.log("isEffect", effect_tracking());
	});
	user_effect(() => {
		console.log("effect - one - x2", get(x2));
		console.log("effect - one - counter", get(counter));
	});
	user_effect(() => {
		console.log("effect - two - counter", get(counter));
		console.log("effect - two - x2", get(x2));
	});
});

console.log("root - counter", get(counter));
console.log("root - x2", get(x2));

setTimeout(() => {
	console.log("update - before - counter", get(counter));
	console.log("update - before - x2", get(x2));
	update(counter);
	console.log("update - after - counter", get(counter));
	console.log("update - after - x2", get(x2));
}, 100);

setTimeout(() => {
	console.log("set - before - counter", get(counter));
	console.log("set - before - x2", get(x2));
	set(counter, 50);
	console.log("set - after", get(counter));
	console.log("set - after - counter", get(counter));
	console.log("set - after - x2", get(x2));
}, 200);

setTimeout(() => exit(0), 1000);
