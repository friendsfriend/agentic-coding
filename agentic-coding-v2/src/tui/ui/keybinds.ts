export type Keybind = {
	key: string;
	cmd: string;
	action: string;
	short?: string;
	standard?: boolean;
};
export const shellKeybinds: Keybind[] = [
	{ key: "ctrl+q", cmd: "shell.quit", action: "Quit", short: "quit" },
	{
		key: "f1",
		cmd: "shell.help",
		action: "Show all keybindings and prompt commands",
		short: "help",
	},
	{
		key: "ctrl+k",
		cmd: "shell.palette",
		action: "Search command suggestions (prepare only)",
		short: "commands",
	},
	{
		key: "alt+up",
		cmd: "shell.historyPrevious",
		action: "Recall previous accepted input",
		short: "recall",
	},
	{
		key: "alt+down",
		cmd: "shell.historyNext",
		action: "Recall next input or restore original draft",
		short: "restore",
	},
	{
		key: "ctrl+e",
		cmd: "shell.prompt",
		action: "Focus message/command prompt",
		short: "prompt",
	},
	{
		key: "alt+left",
		cmd: "shell.back",
		action: "Navigate back",
		standard: true,
	},
	{
		key: "alt+right",
		cmd: "shell.forward",
		action: "Navigate forward",
		standard: true,
	},
	{
		key: "ctrl+b",
		cmd: "shell.sessions",
		action: "Focus session sidebar",
		short: "sessions",
	},
	{
		key: "ctrl+v",
		cmd: "shell.viewpoints",
		action: "Focus native agents sidebar",
		short: "agents",
	},
	{
		key: "escape",
		cmd: "shell.content",
		action: "Close editor/palette/help and focus content",
		standard: true,
	},
	{
		key: "ctrl+p",
		cmd: "shell.bookmark",
		action: "Save local memory viewpoint",
		short: "bookmark",
	},
	...["opencode", "pi", "pi-durable", "orchestrator"].map((mode, index) => ({
		key: `alt+${index + 1}`,
		cmd: `shell.${mode}`,
		action: `Select ${mode} mode`,
		short: mode,
	})),
];
export const transcriptKeybinds: Keybind[] = [
	{
		key: "ctrl+up",
		cmd: "transcript.previous",
		action: "Select previous observed card",
		short: "previous card",
	},
	{
		key: "ctrl+down",
		cmd: "transcript.next",
		action: "Select next observed card",
		short: "next card",
	},
	{
		key: "ctrl+o",
		cmd: "transcript.toggle",
		action: "Toggle selected observed card",
		short: "expand",
	},
	{
		key: "ctrl+alt+a",
		cmd: "transcript.arguments",
		action: "Toggle requested arguments",
		short: "arguments",
	},
	{
		key: "ctrl+alt+o",
		cmd: "transcript.output",
		action: "Toggle retained/live output",
		short: "output",
	},
	{
		key: "ctrl+alt+d",
		cmd: "transcript.details",
		action: "Toggle native details",
		short: "details",
	},
];
export const actionKeybinds: Keybind[] = [
	{
		key: "ctrl+alt+j",
		cmd: "controls.next",
		action: "Select next rendered UI control",
		short: "next control",
	},
	{
		key: "ctrl+alt+k",
		cmd: "controls.previous",
		action: "Select previous rendered UI control",
		short: "previous control",
	},
	{
		key: "ctrl+alt+return",
		cmd: "controls.activate",
		action: "Activate selected UI control",
		short: "control",
	},
];
export const paletteKeybinds: Keybind[] = [
	{
		key: "up",
		cmd: "palette.previous",
		action: "Previous suggestion",
		standard: true,
	},
	{
		key: "down",
		cmd: "palette.next",
		action: "Next suggestion",
		standard: true,
	},
	{
		key: "return",
		cmd: "palette.choose",
		action: "Prepare selected command without submission",
		short: "prepare",
	},
	{
		key: "escape",
		cmd: "palette.close",
		action: "Dismiss suggestions",
		short: "close",
	},
];
export const promptKeybinds: Keybind[] = [
	{
		key: "up",
		cmd: "input.historyPrevious",
		action:
			"At first prompt line: recall only empty or unchanged recalled input",
		standard: true,
	},
	{
		key: "down",
		cmd: "input.historyNext",
		action:
			"At last prompt line: advance recalled input or restore original draft",
		standard: true,
	},
	{
		key: "?",
		cmd: "input.helpIfEmpty",
		action: "Open help only when the prompt is empty; otherwise type literally",
		standard: true,
	},
	{
		key: "return",
		cmd: "prompt.submit",
		action: "Submit explicit prompt",
		short: "submit",
	},
	{
		key: "shift+return",
		cmd: "prompt.newline",
		action: "Insert newline",
		standard: true,
	},
];
export const editorKeybinds: Keybind[] = [
	{
		key: "return",
		cmd: "editor.newline",
		action: "Insert local draft newline (not submission)",
		standard: true,
	},
	...shellKeybinds.filter((binding) => binding.cmd === "shell.content"),
];
export const textareaBindings = (catalog: Keybind[]) =>
	catalog
		.filter(
			(binding) =>
				binding.cmd.startsWith("prompt.") || binding.cmd.startsWith("editor."),
		)
		.map((binding) => ({
			name: binding.key.split("+").at(-1) ?? "",
			...(binding.key.includes("shift+") ? { shift: true } : {}),
			action:
				binding.cmd === "prompt.submit"
					? ("submit" as const)
					: ("newline" as const),
		}));
export const keybindCatalogs = {
	Shell: shellKeybinds,
	Transcript: transcriptKeybinds,
	Controls: actionKeybinds,
	Suggestions: paletteKeybinds,
	Prompt: promptKeybinds,
	Editor: editorKeybinds,
};
export const bindings = (catalog: Keybind[]) =>
	catalog.map(({ key, cmd }) => ({ key, cmd }));
export const keyLabel = (key: string) =>
	key
		.split("+")
		.map(
			(value) =>
				({
					ctrl: "Ctrl",
					alt: "Alt",
					shift: "Shift",
					return: "Enter",
					escape: "Escape",
				})[value] ??
				(value.length === 1
					? value.toUpperCase()
					: value[0]?.toUpperCase() + value.slice(1)),
		)
		.join("+");
export const keybindFooter = (catalog: Keybind[]) =>
	catalog
		.filter((binding) => !binding.standard)
		.map(
			(binding) =>
				`${keyLabel(binding.key)} ${binding.short ?? binding.action}`,
		)
		.join(" · ");
