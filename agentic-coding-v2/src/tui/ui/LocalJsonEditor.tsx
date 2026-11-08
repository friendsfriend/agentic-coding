/** @jsxImportSource @opentui/solid */
import type { TextareaRenderable } from "@opentui/core";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	Show,
	useContext,
} from "solid-js";
import { editorKeybinds, textareaBindings } from "./keybinds.ts";
import { LocalChoiceContext } from "./LocalChoice.ts";

/** Local text only. Scope replacement disposes the old widget, not the parent's draft.
 * Mirroring a supplied value is not a user edit and cannot invalidate a candidate. */
export function LocalJsonEditor(props: {
	value: string;
	scope: string;
	editing: boolean;
	interactive: boolean;
	height?: number;
	maxLength?: number;
	onLimit?: () => void;
	enter: () => void;
	change: (value: string) => void;
}) {
	const choices = useContext(LocalChoiceContext);
	const owner = createMemo(
		() => ({ view: choices?.scope(), source: props.scope }),
		undefined,
		{
			equals: (previous, next) =>
				previous?.view === next.view && previous?.source === next.source,
		},
	);
	return (
		<Show when={owner()} keyed>
			{(saved) => {
				const [editor, setEditor] = createSignal<TextareaRenderable>();
				let disposed = false;
				let mirroring = false;
				const active = () =>
					!disposed &&
					owner() === saved &&
					props.interactive &&
					(choices?.interactive() ?? true);
				createEffect(() => {
					props.editing;
					props.interactive;
					choices?.interactive();
					const value = props.value;
					const node = editor();
					if (!node || node.plainText === value) return;
					mirroring = true;
					try {
						node.setText(value);
					} finally {
						mirroring = false;
					}
				});
				onCleanup(() => {
					disposed = true;
				});
				return (
					<textarea
						ref={setEditor}
						initialValue={props.value}
						focused={active() && props.editing}
						height={props.height ?? 12}
						width="100%"
						keyBindings={textareaBindings(editorKeybinds)}
						onMouseDown={() => {
							if (active()) props.enter();
						}}
						onContentChange={(event) => {
							const node = editor();
							if (!active() || !props.editing || mirroring || !node) return;
							const value = typeof event === "string" ? event : node.plainText;
							if (value !== node.plainText || value === props.value) return;
							if (
								props.maxLength !== undefined &&
								value.length > props.maxLength
							) {
								mirroring = true;
								try {
									node.setText(props.value);
								} finally {
									mirroring = false;
								}
								props.onLimit?.();
								return;
							}
							props.change(value);
						}}
					/>
				);
			}}
		</Show>
	);
}
