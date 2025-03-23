export type Callback = () => void | (() => void);
export type Equals = (this: State, value: unknown) => boolean;

export interface Signal {
	/** Flags bitmask */
	f: number;
	/** Write version */
	wv: number;
}

export interface State<V = unknown> extends Signal {
	/** Equality function */
	equals: Equals;
	/** Signals that read from this signal */
	reactions: Reaction[] | null;
	/** Read version */
	rv: number;
	/** Последнее значение сигнала */
	v: V;
}

export interface Reaction extends Signal {
	/** The reaction function */
	// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
	fn: Function | null;
	/** Signals that this signal reads from */
	deps: State[] | null;
}

export interface Derived<V = unknown> extends State<V>, Reaction {
	/** The derived function */
	fn: () => V;
	/** Effects created inside this signal */
	effects: Effect[] | null;
	/** Parent effect or derived */
	parent: Effect | Derived | null;
}

export interface Effect extends Reaction {
	/** The effect function */
	fn: null | (() => void | (() => void));
	/** The teardown function returned from the effect function */
	teardown: null | (() => void);
	/** Next sibling child effect created inside the parent signal */
	prev: null | Effect;
	/** Next sibling child effect created inside the parent signal */
	next: null | Effect;
	/** First child effect created inside this signal */
	first: null | Effect;
	/** Last child effect created inside this signal */
	last: null | Effect;
	/** Parent effect */
	parent: Effect | null;
}
