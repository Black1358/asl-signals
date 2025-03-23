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
	console.log("root", $effect.tracking());
	console.log("$effect -  a", dump());
	$effect.root(() => {
		console.log("nested", $effect.tracking());
		$effect(() => {
			console.log("nested - user_effect", $effect.tracking());
			console.log("$effect - b", dump());
			console.log("if", get(b) < 3, get(b));
			if (get(b) < 3) {
				console.log("if");
				$effect(() => {
					console.log("$effect - i", dump());
				});
			}
		});
	});
	$effect(() => {
		console.log("root - user_effect", $effect.tracking());
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
