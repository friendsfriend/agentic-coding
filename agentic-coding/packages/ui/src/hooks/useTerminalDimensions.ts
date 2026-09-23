import { useRenderer } from "@opentui/solid";
import { type Accessor, createSignal } from "solid-js";

/** The terminal geometry every layout reads. */
export interface TerminalDimensions {
	width: number;
	height: number;
}

/**
 * One shared terminal-dimensions signal per renderer.
 *
 * `@opentui/solid`'s `useTerminalDimensions` installs a renderer `resize`
 * listener for every component that calls it. A screen can mount more than ten
 * dimension consumers at once, which trips Node's `MaxListenersExceededWarning`
 * and paints it over the TUI. This hook registers a single `resize` listener
 * per renderer and hands the same reactive accessor to every consumer, so the
 * listener count stays at one however many components read the dimensions.
 */
const shared = new WeakMap<object, Accessor<TerminalDimensions>>();

export function useTerminalDimensions(): Accessor<TerminalDimensions> {
	const renderer = useRenderer();
	const existing = shared.get(renderer);
	if (existing) return existing;

	const [dimensions, setDimensions] = createSignal<TerminalDimensions>({
		width: renderer.width,
		height: renderer.height,
	});
	const onResize = (width: number, height: number): void => {
		setDimensions({ width, height });
	};
	renderer.on("resize", onResize);
	renderer.once("destroy", () => {
		renderer.off("resize", onResize);
		shared.delete(renderer);
	});
	shared.set(renderer, dimensions);
	return dimensions;
}
