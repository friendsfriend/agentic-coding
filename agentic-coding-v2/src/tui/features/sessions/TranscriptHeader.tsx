/** @jsxImportSource @opentui/solid */
import type { BoxRenderable } from "@opentui/core";
import {
	createEffect,
	createMemo,
	type JSX,
	onCleanup,
	useContext,
} from "solid-js";
import type { RowGestureState } from "../../presentation/components/mouse/useRowMouse.ts";
import { useTap } from "../../presentation/components/mouse/useTap.ts";
import { LocalChoiceContext } from "../../ui/LocalChoice.ts";
import { TranscriptRowsContext } from "./TranscriptRows.ts";

/** Only the header toggles; selecting/scrolling output does not collapse it. */
export function TranscriptHeader(props: {
	identity: string;
	scope?: unknown;
	interactive?: boolean;
	select: (id: string) => void;
	toggle: (id: string) => void;
	anchor: (node: BoxRenderable | null) => void;
	children: JSX.Element;
}) {
	const choices = useContext(LocalChoiceContext),
		reading = useContext(TranscriptRowsContext);
	const source = createMemo(() => [
		props.identity,
		props.scope,
		props.interactive,
		choices?.scope(),
		choices?.interactive(),
	]);
	let disposed = false;
	const gesture: RowGestureState = {};
	const retire = () => {
		gesture.down = undefined;
		gesture.lastTap = undefined;
	};
	createEffect(() => {
		source();
		retire();
	});
	const active = () =>
		!disposed &&
		props.interactive !== false &&
		(choices?.interactive() ?? true) &&
		(reading?.selectable(props.identity) ?? true);
	const tap = useTap(
		() => {
			if (active()) {
				if (reading) reading.activate(props.identity);
				else {
					props.select(props.identity);
					props.toggle(props.identity);
				}
			}
		},
		{ gesture, enabled: active, stopPropagation: true },
	);
	onCleanup(() => {
		disposed = true;
		retire();
		props.anchor(null);
	});
	return (
		<box flexDirection="column" ref={(node) => props.anchor(node)} {...tap}>
			{props.children}
		</box>
	);
}
