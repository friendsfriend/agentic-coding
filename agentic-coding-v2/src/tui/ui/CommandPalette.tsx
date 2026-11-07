/** @jsxImportSource @opentui/solid */
import { useKeymap } from "@opentui/keymap/solid";
import { createMemo, createSignal, For, onCleanup } from "solid-js";
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
		bindings: [
			{ key: "up", cmd: "palette.previous" },
			{ key: "down", cmd: "palette.next" },
			{ key: "return", cmd: "palette.choose" },
			{ key: "escape", cmd: "palette.close" },
		],
	});
	onCleanup(unregister);
	return (
		<box flexDirection="column" border={true} padding={1} gap={1} height={12}>
			<text fg={color("primary")}>
				Command suggestions · filter then ↑/↓/Enter to prepare only · Escape
				closes
			</text>
			<text fg={color("textMuted")}>
				Existing unsent drafts are not replaced. No automatic submission,
				approval, reconnect or backend action.
			</text>
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
			<For
				each={entries().slice(
					Math.max(0, selection() - 2),
					Math.max(0, selection() - 2) + 5,
				)}
			>
				{(entry) => (
					<box onMouseDown={() => props.choose(entry.command)}>
						<text
							wrapMode="word"
							fg={
								entries()[selection()] === entry
									? color("accent")
									: color("textMuted")
							}
						>
							{entries()[selection()] === entry ? "›" : "·"} {entry.command} ·{" "}
							{entry.description}
						</text>
					</box>
				)}
			</For>
			<text fg={color("textMuted")}>
				{entries().length
					? `${selection() + 1}/${entries().length}`
					: "No native command matches"}
			</text>
		</box>
	);
}
