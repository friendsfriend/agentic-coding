// Authoritative shell modal stack (compose-unified-feature-shell, task 3.1).
// One stack owns every overlay: the top instance exclusively owns overlay input
// and mouse ownership, closing it reveals the previous instance and restores
// the focus target the opener recorded. Instance identity (`kind#seq`) makes
// repeated dialog kinds distinguishable, so nested help over a review dialog is
// two stack entries rather than two competing booleans.
//
// The reducers are pure data so they can be unit-tested without a renderer;
// `createModalHost` adds the Solid-reactive wrapper the shell consumes.
import { createSignal } from "solid-js";

/** One open overlay. `id` is stable for the lifetime of the instance. */
export interface ModalInstance<TKind extends string = string> {
	id: string;
	kind: TKind;
	/** Focus target to restore when this instance closes (opener identity). */
	restoreFocusTo?: string;
	/** Footer/help context this overlay publishes while it is on top. */
	context?: string;
}

export interface ModalStackState<TKind extends string = string> {
	stack: Array<ModalInstance<TKind>>;
	nextSeq: number;
}

export function createModalStackState<
	TKind extends string,
>(): ModalStackState<TKind> {
	return { stack: [], nextSeq: 0 };
}

export interface PushModalOptions<TKind extends string> {
	kind: TKind;
	restoreFocusTo?: string;
	context?: string;
	/** When false, a second instance of the same kind may stack (nested help
	 * over a dialog of the same kind). Defaults to true: re-opening a kind
	 * replaces the existing singleton with a fresh instance. */
	singleton?: boolean;
}

/**
 * Push an overlay. A singleton kind already on the stack is removed first
 * (with a fresh instance id), so re-opening the same dialog never duplicates
 * its input ownership.
 */
export function pushModal<TKind extends string>(
	state: ModalStackState<TKind>,
	options: PushModalOptions<TKind>,
): ModalStackState<TKind> {
	const seq = state.nextSeq + 1;
	const instance: ModalInstance<TKind> = {
		id: `${options.kind}#${seq}`,
		kind: options.kind,
		...(options.restoreFocusTo !== undefined
			? { restoreFocusTo: options.restoreFocusTo }
			: {}),
		...(options.context !== undefined ? { context: options.context } : {}),
	};
	const base =
		options.singleton === false
			? state.stack
			: state.stack.filter((entry) => entry.kind !== options.kind);
	return { stack: [...base, instance], nextSeq: seq };
}

/** Pop the top overlay, revealing the previous one. The root state is stable. */
export function popModal<TKind extends string>(
	state: ModalStackState<TKind>,
): ModalStackState<TKind> {
	if (state.stack.length === 0) return state;
	return { ...state, stack: state.stack.slice(0, -1) };
}

/**
 * Remove a specific instance by id. Used when an overlay is dismissed from an
 * asynchronous continuation that captured its own instance: popping the top
 * blindly could close a newer overlay of the same kind (CONCURRENCY-005).
 */
export function popModalById<TKind extends string>(
	state: ModalStackState<TKind>,
	id: string,
): ModalStackState<TKind> {
	const index = state.stack.findIndex((entry) => entry.id === id);
	if (index < 0) return state;
	return {
		...state,
		stack: [...state.stack.slice(0, index), ...state.stack.slice(index + 1)],
	};
}

/**
 * Focus-restoration registry: the surface that opened an overlay registers a
 * restorer under its focus id, and closing the overlay invokes it so the
 * opener regains key ownership (task 3.1).
 */
const focusRestorers = new Map<string, () => void>();

export function registerFocusRestorer(
	id: string,
	restore: () => void,
): () => void {
	focusRestorers.set(id, restore);
	return () => {
		if (focusRestorers.get(id) === restore) focusRestorers.delete(id);
	};
}

/** Restore focus to `id`; returns whether a restorer was registered. */
export function restoreFocus(id: string | undefined): boolean {
	if (!id) return false;
	const restore = focusRestorers.get(id);
	if (!restore) return false;
	restore();
	return true;
}

/** The instance that exclusively owns overlay input, if any. */
export function topModal<TKind extends string>(
	state: ModalStackState<TKind>,
): ModalInstance<TKind> | undefined {
	return state.stack[state.stack.length - 1];
}

/** True while any overlay owns input; underlying views must not process keys. */
export function modalOwnsInput<TKind extends string>(
	state: ModalStackState<TKind>,
): boolean {
	return state.stack.length > 0;
}

/** Focus target restored when the top overlay closes. */
export function restoreFocusTarget<TKind extends string>(
	state: ModalStackState<TKind>,
): string | undefined {
	return topModal(state)?.restoreFocusTo;
}

/** Find a live instance by kind (for tests and for re-focusing a known dialog). */
export function findModal<TKind extends string>(
	state: ModalStackState<TKind>,
	kind: TKind,
): ModalInstance<TKind> | undefined {
	return state.stack.find((entry) => entry.kind === kind);
}

/** Solid-reactive host the shell components consume. */
export function createModalHost<TKind extends string>(
	initial: ModalStackState<TKind> = createModalStackState<TKind>(),
) {
	const [state, setState] = createSignal(initial);
	return {
		state,
		stack: () => state().stack,
		top: () => topModal(state()),
		ownsInput: () => modalOwnsInput(state()),
		restoreFocusTarget: () => restoreFocusTarget(state()),
		push: (options: PushModalOptions<TKind>) =>
			setState((current) => pushModal(current, options)),
		pop: () => setState((current) => popModal(current)),
		popById: (id: string) => setState((current) => popModalById(current, id)),
		set: setState,
	};
}
