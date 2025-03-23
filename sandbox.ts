import { $state, update } from "#/reactivity/sources.js";
import { derived } from "#/reactivity/deriveds.js";
import { $effect } from "#/reactivity/effects.js";
import { get } from "#/runtime.js";
import { exit } from "node:process";

let a = $state(0);
let b = $state(0);
let c = derived(() => get(a) * get(b));

const dump = () => ({
	a: get(a),
	b: get(b),
	c: get(c),
});

update(a); // 1
update(b); // 1

$effect.root(() => {
	console.log("$effect -  a", dump());
	$effect.root(() => {
		$effect(() => {
			console.log("$effect - b", dump());
		});
	});
	$effect(() => {
		console.log("$effect - c", dump());
	});
});

update(a); // 2
update(b); // 2

setTimeout(() => {
	update(a); // 3
	console.log("update - 100", dump());
}, 100);

setTimeout(() => {
	update(b); // 3
	console.log("update - 200", dump());
}, 200);

setTimeout(() => {
	update(a); // 4
	update(b); // 4
	console.log("update - 300", dump());
}, 300);

setTimeout(() => exit(0), 1000);
