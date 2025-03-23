import type { Derived, Effect, Reaction, Signal, State } from "#/types.js";
import {
	BOUNDARY_EFFECT,
	CLEAN,
	DERIVED,
	DESTROYED,
	DIRTY,
	DISCONNECTED,
	EFFECT,
	EFFECT_IS_UPDATING,
	INERT,
	MAYBE_DIRTY,
	ROOT_EFFECT,
	UNOWNED,
} from "#/constants.js";
import { effect_update_depth_exceeded } from "#/errors.js";
import { destroy_derived_effects, update_derived } from "#/reactivity/deriveds.js";
import { destroy_effect_children, execute_effect_teardown, unlink_effect } from "#/reactivity/effects.js";
import { old_values } from "#/reactivity/sources.js";

export const Runtime: {
	/**
	 * Флаг игнорирования отслеживания зависимостей.
	 * Если true, значит оно находится в `untrack`
	 */
	untracking: boolean;
	/**
	 * Отслеживает изменения состояний, которые текущий эффект ещё не слушает,
	 * чтобы добавить зависимость позже, если эффект начнёт их читать
	 */
	untracked_writes: State[] | null;
	/**
	 * Пропуск добавления реакций, если нет активного контейнера,
	 * чтобы предотвратить утечки памяти
	 */
	skip_reaction: boolean;
	/**
	 * Флаг процесса уничтожения эффекта
	 */
	is_destroying_effect: boolean;
	/**
	 * Текущая выполняемая реакция
	 */
	active_reaction: Reaction | null;
	/**
	 * Текущий активный эффект
	 */
	active_effect: Effect | null;
	/**
	 * Источники данных для текущей реакции
	 */
	reaction_sources: State[] | null;
} = {
	untracking: false,
	untracked_writes: null,
	skip_reaction: false,
	is_destroying_effect: false,
	active_reaction: null,
	active_effect: null,
	reaction_sources: null,
};

export function push_reaction_value(value: State) {
	if (Runtime.active_reaction !== null && Runtime.active_reaction.f & EFFECT_IS_UPDATING) {
		if (Runtime.reaction_sources === null) {
			Runtime.reaction_sources = [value];
		} else {
			Runtime.reaction_sources.push(value);
		}
	}
}

//...

let is_throwing_error: boolean = false;
let is_updating_effect = false;

/**
 * The dependencies of the reaction that is currently being executed. In many cases,
 * the dependencies are unchanged between runs, and so this will be `null` unless
 * and until a new dependency is accessed — we track this via `skipped_deps`
 */
let new_deps: State[] | null = null;
let skipped_deps = 0;

/**
 * Используется состояниями и производными для захвата обновлений.
 * Версия начинается с 1, чтобы ненадёжные (unowned) производные отличали созданный эффект от запущенного для отслеживания
 */
let write_version: number = 1;

//...

export function increment_write_version() {
	return ++write_version;
}

/**
 * Determines whether a derived or effect is dirty.
 * If it is MAYBE_DIRTY, will set the status to CLEAN
 */
function check_dirtiness(reaction: Reaction): boolean {
	const flags = reaction.f;

	if ((flags & DIRTY) !== 0) {
		return true;
	}

	if ((flags & MAYBE_DIRTY) !== 0) {
		const dependencies: State[] | null = reaction.deps;
		const is_unowned = (flags & UNOWNED) !== 0;

		if (dependencies !== null) {
			let i: number;
			let dependency: State;
			const is_disconnected = (flags & DISCONNECTED) !== 0;
			const is_unowned_connected = is_unowned && Runtime.active_effect !== null && !Runtime.skip_reaction;
			const length = dependencies.length;

			// If we are working with a disconnected or an unowned signal that is now connected (due to an active effect)
			// then we need to re-connect the reaction to the dependency
			if (is_disconnected || is_unowned_connected) {
				const derived = reaction as Derived;
				const parent = derived.parent;

				for (i = 0; i < length; i++) {
					dependency = dependencies[i];

					// We always re-add all reactions (even duplicates) if the derived was
					// previously disconnected, however we don't if it was unowned as we
					// de-duplicate dependencies in that case
					if (is_disconnected || !dependency?.reactions?.includes(derived)) {
						(dependency.reactions ??= []).push(derived);
					}
				}

				if (is_disconnected) {
					derived.f ^= DISCONNECTED;
				}
				// If the unowned derived is now fully connected to the graph again (it's unowned and reconnected, has a parent
				// and the parent is not unowned), then we can mark it as connected again, removing the need for the unowned
				// flag
				if (is_unowned_connected && parent !== null && (parent.f & UNOWNED) === 0) {
					derived.f ^= UNOWNED;
				}
			}

			for (i = 0; i < length; i++) {
				dependency = dependencies[i];

				if (check_dirtiness(dependency as Derived)) {
					update_derived(dependency as Derived);
				}

				if (dependency.wv > reaction.wv) {
					return true;
				}
			}
		}

		// Unowned signals should never be marked as clean unless they
		// are used within an active_effect without skip_reaction
		if (!is_unowned || (Runtime.active_effect !== null && !Runtime.skip_reaction)) {
			set_signal_status(reaction, CLEAN);
		}
	}

	return false;
}

function propagate_error(error: unknown, effect: Effect) {
	let current: Effect | null = effect;

	while (current !== null) {
		if ((current.f & BOUNDARY_EFFECT) !== 0) {
			try {
				// @ts-expect-error <наверное, всё норм>
				current.fn(error);
				return;
			} catch {
				// Remove boundary flag from effect
				current.f ^= BOUNDARY_EFFECT;
			}
		}

		current = current.parent;
	}

	is_throwing_error = false;
	throw error;
}

function should_rethrow_error(effect: Effect): boolean {
	return (effect.f & DESTROYED) === 0 && (effect.parent === null || (effect.parent.f & BOUNDARY_EFFECT) === 0);
}

function handle_error(error: unknown, effect: Effect, previous_effect: Effect | null) {
	if (is_throwing_error) {
		if (previous_effect === null) {
			is_throwing_error = false;
		}
		if (should_rethrow_error(effect)) {
			throw error;
		}
		return;
	}
	if (previous_effect !== null) is_throwing_error = true;
	propagate_error(error, effect);
}

function schedule_possible_effect_self_invalidation(state: State, effect: Effect, root = true) {
	const reactions = state.reactions;
	if (reactions === null) return;

	for (let i = 0; i < reactions.length; i++) {
		const reaction = reactions[i];

		// Пропускаем реакции, которые уже были обработаны
		if (Runtime.reaction_sources?.includes(state)) continue;

		if ((reaction.f & DERIVED) !== 0) {
			// Рекурсивная обработка производных сигналов
			schedule_possible_effect_self_invalidation(reaction as Derived, effect, false);
		} else if (effect === reaction) {
			if (root) {
				set_signal_status(reaction, DIRTY);
			} else if ((reaction.f & CLEAN) !== 0) {
				set_signal_status(reaction, MAYBE_DIRTY);
			}
			schedule_effect(reaction as Effect);
		}
	}
}

//...

/**
 * Версия каждого чтения состояния или производного, чтобы избежать дублирования зависимостей внутри реакции
 */
let read_version: number = 0;

export function update_reaction<V>(reaction: Reaction): V {
	// Сохраняем предыдущее состояния контекста

	let previous_untracked_writes = Runtime.untracked_writes;

	const previous_reaction = Runtime.active_reaction;
	const previous_skip_reaction = Runtime.skip_reaction;
	const previous_reaction_sources = Runtime.reaction_sources;
	const previous_untracking = Runtime.untracking;

	const previous_deps = new_deps;
	const previous_skipped_deps = skipped_deps;

	const flags = reaction.f;

	new_deps = null;
	skipped_deps = 0;
	Runtime.untracked_writes = null;
	Runtime.skip_reaction = (flags & UNOWNED) !== 0 && (Runtime.untracking || !is_updating_effect || Runtime.active_reaction === null);
	Runtime.active_reaction = (flags & ROOT_EFFECT) === 0 ? reaction : null;

	Runtime.reaction_sources = null;
	Runtime.untracking = false;
	read_version++;

	reaction.f |= EFFECT_IS_UPDATING;

	try {
		// @ts-expect-error <Гарантирует, что функция будет вызвана с this = undefined>
		// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
		const result = (0, reaction.fn)() as Function;
		let deps = reaction.deps;

		// Обработка новых зависимостей
		if ((new_deps as State[] | null) !== null) {
			// eslint-disable-next-line no-var
			var i: number;

			remove_reactions(reaction, skipped_deps);

			// Объединяем старые и новые зависимости
			if (deps !== null && skipped_deps > 0) {
				deps.length = skipped_deps + new_deps!.length;
				for (i = 0; i < new_deps!.length; i++) {
					deps[skipped_deps + i] = new_deps![i];
				}
			} else {
				reaction.deps = deps = new_deps;
			}

			// Регистрируем реакцию в зависимостях
			if (!Runtime.skip_reaction) {
				for (i = skipped_deps; i < deps!.length; i++) {
					(deps![i].reactions ??= []).push(reaction);
				}
			}
		} else if (deps !== null && skipped_deps < deps.length) {
			remove_reactions(reaction, skipped_deps);
			deps.length = skipped_deps;
		}

		// If we're inside an effect, and we have untracked writes, then we need to
		// ensure that if any of those untracked writes result in re-invalidation
		// of the current effect, then that happens accordingly
		// noinspection PointlessBooleanExpressionJS
		if (Runtime.untracked_writes !== null && !Runtime.untracking && deps !== null && (reaction.f & (DERIVED | MAYBE_DIRTY | DIRTY)) === 0) {
			for (i = 0; i < (Runtime.untracked_writes as State[]).length; i++) {
				schedule_possible_effect_self_invalidation(Runtime.untracked_writes[i], reaction as Effect);
			}
		}

		// If we are returning to a previous reaction then
		// we need to increment the read version to ensure that
		// any dependencies in this reaction aren't marked with
		// the same version

		// Восстановление контекста для вложенных реакций
		if (previous_reaction !== null) {
			read_version++;

			if ((Runtime.untracked_writes as State[] | null) !== null) {
				if (previous_untracked_writes === null) {
					previous_untracked_writes = Runtime.untracked_writes;
				} else {
					previous_untracked_writes.push(...(Runtime.untracked_writes as unknown as State[]));
				}
			}
		}

		return result as V;
	} finally {
		// Восстанавливаем предыдущее состояние контекста

		Runtime.untracked_writes = previous_untracked_writes;
		Runtime.active_reaction = previous_reaction;
		Runtime.skip_reaction = previous_skip_reaction;
		Runtime.reaction_sources = previous_reaction_sources;
		Runtime.untracking = previous_untracking;

		new_deps = previous_deps;
		skipped_deps = previous_skipped_deps;

		reaction.f ^= EFFECT_IS_UPDATING;
	}
}

/**
 * @template V
 * @param {Reaction} signal
 * @param {State<V>} dependency
 * @returns {void}
 */
function remove_reaction<V>(signal: Reaction, dependency: State<V>): void {
	let reactions = dependency.reactions;
	if (reactions !== null) {
		const index = Array.prototype.indexOf.call(reactions, signal);
		if (index !== -1) {
			const new_length = reactions.length - 1;
			if (new_length === 0) {
				reactions = dependency.reactions = null;
			} else {
				// Swap with last element and then remove.
				reactions[index] = reactions[new_length];
				reactions.pop();
			}
		}
	}
	// If the derived has no reactions, then we can disconnect it from the graph,
	// allowing it to either reconnect in the future, or be GC'd by the VM.
	if (
		reactions === null &&
		(dependency.f & DERIVED) !== 0 &&
		// Destroying a child effect while updating a parent effect can cause a dependency to appear
		// to be unused, when in fact it is used by the currently-updating parent. Checking `new_deps`
		// allows us to skip the expensive work of disconnecting and immediately reconnecting it
		(new_deps === null || !new_deps.includes(dependency))
	) {
		set_signal_status(dependency, MAYBE_DIRTY);
		// If we are working with a derived that is owned by an effect, then mark it as being
		// disconnected.
		if ((dependency.f & (UNOWNED | DISCONNECTED)) === 0) {
			dependency.f ^= DISCONNECTED;
		}
		// Disconnect any reactions owned by this reaction
		destroy_derived_effects(dependency as Derived);
		remove_reactions(dependency as Derived, 0);
	}
}

/**
 * @param {Reaction} signal
 * @param {number} start_index
 * @returns {void}
 */
export function remove_reactions(signal: Reaction, start_index: number): void {
	const dependencies = signal.deps;
	if (dependencies === null) return;

	for (let i = start_index; i < dependencies.length; i++) {
		remove_reaction(signal, dependencies[i]);
	}
}

/**
 * @param {Effect} effect
 * @returns {void}
 */
export function update_effect(effect: Effect): void {
	const flags = effect.f;
	if ((flags & DESTROYED) !== 0) return;

	set_signal_status(effect, CLEAN); //Бит CLEAN у flags в 1

	const previous_effect = Runtime.active_effect;
	const was_updating_effect = is_updating_effect;

	Runtime.active_effect = effect;
	is_updating_effect = true;

	try {
		destroy_effect_children(effect);
		execute_effect_teardown(effect);
		const teardown = update_reaction(effect);
		effect.teardown = typeof teardown === "function" ? (teardown as () => void) : null;
		effect.wv = write_version;
	} catch (error) {
		handle_error(error, effect, previous_effect);
	} finally {
		is_updating_effect = was_updating_effect;
		Runtime.active_effect = previous_effect;
	}
}

//...

/**
 * Последний запланированный эффект
 */
let last_scheduled_effect: Effect | null = null;

function infinite_loop_guard() {
	try {
		effect_update_depth_exceeded();
	} catch (error) {
		// Try and handle the error so it can be caught at a boundary, that's
		// if there's an effect available from when it was last scheduled
		if (last_scheduled_effect !== null) {
			handle_error(error, last_scheduled_effect, null);
		} else {
			throw error;
		}
	}
}

//...

/**
 * Очередь корневых эффектов
 */
let queued_root_effects: Effect[] = [];

/**
 * Выполнение эффектов
 */
let is_flushing: boolean = false;

function flush_queued_root_effects() {
	const was_updating_effect = is_updating_effect;

	try {
		let flush_count = 0;
		is_updating_effect = true;

		// Обрабатываем все корневые эффекты в очереди
		while (queued_root_effects.length > 0) {
			if (flush_count++ > 1000) {
				infinite_loop_guard();
			}

			// Берем текущую очередь и очищаем основную
			const root_effects = queued_root_effects;
			queued_root_effects = [];

			const length = root_effects.length;

			// Обрабатываем каждый корневой эффект
			for (let i = 0; i < length; i++) {
				// Собираем все дочерние эффекты в топологическом порядке
				const collected_effects = process_effects(root_effects[i]);
				// Выполняем собранные эффекты
				flush_queued_effects(collected_effects);
			}
		}
	} finally {
		// Восстанавливаем состояние системы
		is_flushing = false;
		is_updating_effect = was_updating_effect;
		last_scheduled_effect = null;
		old_values.clear();
	}
}

//...

function flush_queued_effects(effects: Array<Effect>): void {
	const length = effects.length;
	if (length === 0) return;

	for (let i = 0; i < length; i++) {
		const effect = effects[i];

		if ((effect.f & (DESTROYED | INERT)) === 0) {
			try {
				// Основная логика выполнения эффекта
				if (check_dirtiness(effect)) {
					update_effect(effect);

					// Effects with no dependencies or teardown do not get added to the effect tree.
					// Deferred effects (e.g. `$effect(...)`) _are_ added to the tree because we
					// don't know if we need to keep them until they are executed. Doing the check
					// here (rather than in `update_effect`) allows us to skip the work for
					// immediate effects.

					// Очистка ненужных эффектов
					if (effect.deps === null && effect.first === null) {
						if (effect.teardown === null) {
							// remove this effect from the graph
							unlink_effect(effect);
						} else {
							// keep the effect in the graph, but free up some memory
							effect.fn = null;
						}
					}
				}
			} catch (error) {
				handle_error(error, effect, null);
			}
		}
	}
}

export function schedule_effect(signal: Effect): void {
	if (!is_flushing) {
		is_flushing = true;
		queueMicrotask(flush_queued_root_effects);
	}

	// Идём вверх по цепочке родительских эффектов
	let effect = (last_scheduled_effect = signal);
	while (effect.parent !== null) {
		effect = effect.parent;
		const flags = effect.f;

		// Если нашли корневой эффект
		if ((flags & ROOT_EFFECT) !== 0) {
			// Если эффект уже чистый - выходим
			if ((flags & CLEAN) === 0) return;
			// Помечаем как "грязный" для последующей обработки
			effect.f ^= CLEAN;
		}
	}

	// Добавляем корневой эффект в очередь
	queued_root_effects.push(effect);
}

/**
 * This function both runs render effects and collects user effects in topological order
 * from the starting effect passed in. Effects will be collected when they match the filtered
 * bitwise flag passed in only. The collected effects array will be populated with all the user
 * effects to be flushed.
 */
function process_effects(root: Effect): Effect[] {
	const effects: Effect[] = [];
	let effect: Effect | null = root;

	// Обход дерева эффектов в глубину
	while (effect !== null) {
		const flags = effect.f;
		const is_root = (flags & ROOT_EFFECT) !== 0;
		const is_skippable_root = is_root && (flags & CLEAN) !== 0;

		if (!is_skippable_root && (flags & INERT) === 0) {
			// Добавляем пользовательские эффекты в очередь
			if ((flags & EFFECT) !== 0) {
				effects.push(effect);
			} else if (is_root) {
				// Переключаем флаг CLEAN для корневых эффектов
				effect.f ^= CLEAN;
			} else {
				// Ensure we set the effect to be the active reaction
				// to ensure that unowned deriveds are correctly tracked
				// because we're flushing the current effect

				// Обработка производных
				const previous_active_reaction = Runtime.active_reaction;
				try {
					Runtime.active_reaction = effect;
					if (check_dirtiness(effect)) update_effect(effect);
				} catch (error) {
					handle_error(error, effect, null);
				} finally {
					Runtime.active_reaction = previous_active_reaction;
				}
			}

			// Переходим к дочерним эффектам
			const child: Effect | null = effect.first;
			if (child !== null) {
				effect = child;
				continue;
			}
		}

		// Переход к следующему эффекту в дереве
		let parent = effect.parent;
		effect = effect.next;

		// Возврат на уровень выше при необходимости
		while (effect === null && parent !== null) {
			effect = parent.next;
			parent = parent.parent;
		}
	}

	return effects;
}

//...

/**
 * Synchronously flush any pending updates.
 * Returns void if no callback is provided, otherwise returns the result of calling the callback.
 */
export function flush<T>(fn?: () => T): T {
	let result!: T;

	if (fn) {
		is_flushing = true;
		flush_queued_root_effects();
		result = fn();
	}

	while (queued_root_effects.length > 0) {
		is_flushing = true;
		flush_queued_root_effects();
	}

	return result as T;
}

/**
 * Returns a promise that resolves once any pending state changes have been applied
 */
export async function tick(): Promise<void> {
	await Promise.resolve();
	// By calling flushSync we guarantee that any pending state changes are applied after one tick.
	// TODO look into whether we can make flushing subsequent updates synchronously in the future.
	flush();
}

//...

export function get<V>(signal: State<V> | Derived<V>): V {
	const flags = signal.f;
	const is_derived = (flags & DERIVED) !== 0;
	const derived = signal as Derived<V>;

	// Регистрация зависимости в текущей реакции (effect/derived)
	if (Runtime.active_reaction !== null && !Runtime.untracking) {
		if (!Runtime.reaction_sources?.includes(signal)) {
			const deps = Runtime.active_reaction.deps;
			// Если сигнал не обновлялся с последнего чтения
			if (signal.rv < read_version) {
				signal.rv = read_version;
				// Оптимизация: если зависимости повторяются в том же порядке,
				// увеличиваем skipped_deps вместо создания новых зависимостей
				// уменьшает нагрузку на GC при повторных зависимостях
				if (new_deps === null && deps !== null && deps[skipped_deps] === signal) {
					skipped_deps++;
				} else if (new_deps === null) {
					new_deps = [signal];
				} else if (!Runtime.skip_reaction || !new_deps.includes(signal)) {
					// Обычно можно поместить дублирующиеся зависимости в "new_deps",
					// но если мы находимся внутри производной, которой никто не владеет (skip_reaction)
					// то нужно убедиться, что нет дубликатов
					new_deps.push(signal);
				}
			}
		}
	} else if (is_derived && derived.deps === null && derived.effects === null) {
		// Обработка ненадёжных (unowned) производных
		const parent = derived.parent;
		if (parent !== null && (parent.f & UNOWNED) === 0) {
			// Если производное значение принадлежит другому производному, то он ненадёжный
			// поскольку на производное значение могли ссылаться в другом контексте
			// и его родительский элемент может больше не быть его истинным владельцем
			derived.f ^= UNOWNED;
		}
	}

	// Обновление производных сигналов при необходимости
	if (is_derived && check_dirtiness(derived)) {
		update_derived(derived);
	}

	// Возврат старого значения во время уничтожения эффекта
	if (Runtime.is_destroying_effect && old_values.has(signal)) {
		return old_values.get(signal);
	}

	// Возврат актуального значения
	return signal.v;
}

/**
 * When used inside a [`$derived`](https://svelte.dev/docs/svelte/$derived) or [`$effect`](https://svelte.dev/docs/svelte/$effect),
 * any state read inside `fn` will not be treated as a dependency.
 *
 * ```ts
 * $effect(() => {
 *   // this will run when `data` changes, but not when `time` changes
 *   save(data, {
 *     timestamp: untrack(() => time)
 *   });
 * });
 * ```
 */
export function untrack<T>(fn: () => T): T {
	const previous_untracking = Runtime.untracking;
	try {
		Runtime.untracking = true;
		return fn();
	} finally {
		Runtime.untracking = previous_untracking;
	}
}

//...

const STATUS_MASK = ~(DIRTY | MAYBE_DIRTY | CLEAN);

export function set_signal_status(signal: Signal, status: number) {
	signal.f = (signal.f & STATUS_MASK) | status;
}
