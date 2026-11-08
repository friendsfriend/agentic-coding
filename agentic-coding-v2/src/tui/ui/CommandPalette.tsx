/** @jsxImportSource @opentui/solid */
import { useKeymap } from "@opentui/keymap/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
} from "solid-js";
import { useRowMouse } from "../presentation/components/mouse/useRowMouse.ts";
import { uiColors } from "../presentation/theme/colors.ts";
import { bindings, paletteKeybinds } from "./keybinds.ts";
import { color } from "./theme/index.ts";
export type PaletteEntry = { command: string; description: string };
/** Search prepares text only. Enter here cannot dispatch a gateway method. */
export function CommandPalette(props: {
	entries: PaletteEntry[];
	choose: (command: string) => void;
	close: () => void;
}) {
	const [filter, setFilter] = createSignal(""),
		[selection, setSelection] = createSignal(0);
	const entries = createMemo(() =>
		props.entries
			.filter((entry) =>
				`${entry.command} ${entry.description}`
					.toLowerCase()
					.includes(filter().toLowerCase()),
			)
			.slice(0, 64),
	);
	createEffect(() => {
		const count = entries().length;
		setSelection((value) => Math.max(0, Math.min(value, count - 1)));
	});
	const offset = () => Math.max(0, selection() - 2);
	const choose = () => {
		const entry = entries()[selection()];
		if (entry) props.choose(entry.command);
	};
	const move = (direction: number) =>
		setSelection((value) =>
			Math.max(0, Math.min(entries().length - 1, value + direction)),
		);
	const unregister = useKeymap().registerLayer({
		id: "v2.command-palette",
		priority: 50,
		commands: [
			{
				id: "palette.previous",
				name: "Previous command suggestion",
				run: () => move(-1),
			},
			{
				id: "palette.next",
				name: "Next command suggestion",
				run: () => move(1),
			},
			{
				id: "palette.choose",
				name: "Prepare command without submission",
				run: choose,
			},
			{
				id: "palette.close",
				name: "Dismiss palette",
				run: () => props.close(),
			},
		],
		bindings: bindings(paletteKeybinds),
	});
	onCleanup(unregister);
	return (
		<box
			flexDirection="column"
			flexShrink={0}
			border={["left"]}
			borderColor={uiColors.accent}
			backgroundColor={uiColors.bgMantle}
		>
			<text paddingLeft={2} paddingRight={1} fg={color("primary")}>
				Command suggestions · filter and prepare only
			</text>
			<text paddingLeft={2} paddingRight={1} fg={color("textMuted")}>
				Existing unsent drafts are not replaced. No automatic submission,
				approval, reconnect or backend action.
			</text>
			<box paddingLeft={2} paddingRight={1}>
				<input
					focused={true}
					value={filter()}
					maxLength={256}
					placeholder="Filter native commands"
					onInput={(value) => {
						setFilter(value);
						setSelection(0);
					}}
				/>
			</box>
			<For each={entries().slice(offset(), offset() + 5)}>
				{(entry, index) => (
					<box
						flexDirection="row"
						gap={2}
						paddingLeft={2}
						paddingRight={1}
						backgroundColor={
							offset() + index() === selection()
								? uiColors.selectionBg
								: undefined
						}
						{...useRowMouse({
							index: () => offset() + index(),
							selectedIndex: selection,
							activatable: () => true,
							onSelect: (row) =>
								setSelection(Math.max(0, Math.min(row, entries().length - 1))),
							onActivate: () => props.choose(entry.command),
						})}
					>
						<text
							width={14}
							flexShrink={0}
							fg={
								offset() + index() === selection()
									? uiColors.selectionText
									: uiColors.textPrimary
							}
						>
							{entry.command}
						</text>
						<text
							fg={
								offset() + index() === selection()
									? uiColors.selectionText
									: uiColors.textMuted
							}
						>
							{entry.description}
						</text>
					</box>
				)}
			</For>
			<text paddingLeft={2} paddingRight={1} fg={color("textMuted")}>
				{entries().length
					? `${selection() + 1}/${entries().length}`
					: "No native command matches"}
			</text>
		</box>
	);
}
