/** @jsxImportSource @opentui/solid */
import { useKeymap } from "@opentui/keymap/solid";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { PromptSuggestions } from "../presentation/components/PromptSuggestions.tsx";
import { uiColors } from "../presentation/theme/colors.ts";
import { bindings, paletteKeybinds } from "./keybinds.ts";
import { color } from "./theme/index.ts";
export type PaletteEntry = { command: string; description: string };
/** Search prepares text only. Enter here cannot dispatch a gateway method. */
export function CommandPalette(props: {
	entries: PaletteEntry[];
	active?: boolean;
	choose: (command: string) => void;
	close: () => void;
}) {
	const [filter, setFilter] = createSignal("");
	const [selectedCommand, setSelectedCommand] = createSignal<string>();
	const active = () => props.active !== false;
	const entries = createMemo(() => {
		const seen = new Set<string>();
		const query = filter().toLowerCase();
		return props.entries
			.filter((entry) => {
				if (
					seen.has(entry.command) ||
					!`${entry.command} ${entry.description}`.toLowerCase().includes(query)
				)
					return false;
				seen.add(entry.command);
				return true;
			})
			.slice(0, 64);
	});
	createEffect(() => {
		const first = entries()[0];
		if (selectedCommand() === undefined && first)
			setSelectedCommand(first.command);
	});
	const selection = () =>
		entries().findIndex((entry) => entry.command === selectedCommand());
	const suggestions = createMemo(() =>
		entries().map((entry) => {
			const name = entry.command.split(/\s/, 1)[0] ?? entry.command;
			const argumentsText = entry.command.slice(name.length).trim();
			return {
				name,
				text: entry.command,
				description: argumentsText
					? `${argumentsText} · ${entry.description}`
					: entry.description,
			};
		}),
	);
	const chooseCommand = (command: string) => {
		if (active() && entries().some((entry) => entry.command === command))
			props.choose(command);
	};
	const choose = () => {
		const command = selectedCommand();
		if (command !== undefined) chooseCommand(command);
	};
	const move = (direction: number) => {
		if (!active()) return;
		const current = selection();
		const next =
			current < 0
				? direction < 0
					? entries().length - 1
					: 0
				: Math.max(0, Math.min(entries().length - 1, current + direction));
		const entry = entries()[next];
		if (entry) setSelectedCommand(entry.command);
	};
	const unregister = useKeymap().registerLayer({
		id: "v2.command-palette",
		priority: 50,
		enabled: active,
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
				run: () => {
					if (active()) props.close();
				},
			},
		],
		bindings: bindings(paletteKeybinds),
	});
	onCleanup(unregister);
	return (
		<box
			flexDirection="column"
			flexShrink={0}
			backgroundColor={uiColors.bgMantle}
		>
			<box
				flexDirection="column"
				border={["left"]}
				borderColor={uiColors.accent}
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
						focused={active()}
						value={filter()}
						maxLength={256}
						placeholder="Filter native commands"
						onInput={(value) => {
							if (!active()) return;
							setFilter(value);
							setSelectedCommand(undefined);
						}}
					/>
				</box>
			</box>
			<PromptSuggestions
				items={suggestions()}
				selection={selection()}
				select={(index) => {
					if (!active()) return;
					const entry = entries()[index];
					if (entry) setSelectedCommand(entry.command);
				}}
				choose={(entry) => chooseCommand(entry.text)}
			/>
			<box
				border={["left"]}
				borderColor={uiColors.accent}
				paddingLeft={2}
				paddingRight={1}
			>
				<text fg={color("textMuted")}>
					{entries().length === 0
						? "No native command matches"
						: selection() < 0
							? "Selection unavailable · choose another command explicitly"
							: `${selection() + 1}/${entries().length}`}
				</text>
			</box>
		</box>
	);
}
