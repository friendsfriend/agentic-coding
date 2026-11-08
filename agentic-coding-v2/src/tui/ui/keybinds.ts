export type Keybind = {
	key: string;
	cmd: string;
	action: string;
	short?: string;
	standard?: boolean;
};
export const shellKeybinds: Keybind[] = [
	{
		key: "ctrl+s",
		cmd: "shell.workspaceToggle",
		action: "Toggle workspace/content focus",
		short: "sidebar",
	},
	{
		key: "ctrl+h",
		cmd: "shell.workspacePrevious",
		action: "Previous workspace",
		standard: true,
	},
	{
		key: "ctrl+l",
		cmd: "shell.workspaceNext",
		action: "Next workspace",
		standard: true,
	},
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
		key: "ctrl+alt+h",
		cmd: "shell.historyChoose",
		action: "Search local accepted inputs (restore text only)",
		standard: true,
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
export const pageFocusKeybinds: Keybind[] = [
	{
		key: "tab",
		cmd: "page.focusNext",
		action: "Cycle breadcrumb/content focus on supported pages",
		short: "focus",
	},
	{
		key: "shift+tab",
		cmd: "page.focusPrevious",
		action: "Cycle page focus backwards",
		standard: true,
	},
];
export const breadcrumbKeybinds: Keybind[] = [
	...["h", "k", "left", "up"].map((key) => ({
		key,
		cmd: "breadcrumb.previous",
		action: "Previous structural ancestor",
		short: "previous",
		standard: key !== "h",
	})),
	...["l", "j", "right", "down"].map((key) => ({
		key,
		cmd: "breadcrumb.next",
		action: "Next structural ancestor",
		short: "next",
		standard: key !== "l",
	})),
	{
		key: "enter",
		cmd: "breadcrumb.open",
		action: "Open selected structural ancestor",
		short: "open",
	},
];
export const transcriptViewportKeybinds: Keybind[] = [
	{
		key: "pageup",
		cmd: "transcript.scrollUp",
		action: "Scroll supplied transcript up",
		short: "scroll ↑",
	},
	{
		key: "pagedown",
		cmd: "transcript.scrollDown",
		action: "Scroll supplied transcript down",
		short: "scroll ↓",
	},
	{
		key: "ctrl+u",
		cmd: "transcript.scrollUp",
		action: "Scroll supplied transcript up",
		standard: true,
	},
	{
		key: "ctrl+d",
		cmd: "transcript.scrollDown",
		action: "Scroll supplied transcript down",
		standard: true,
	},
];
export const transcriptKeybinds: Keybind[] = [
	{
		key: "ctrl+alt+g",
		cmd: "transcript.choose",
		action: "Choose a mounted thinking/tool card without native reads",
		short: "choose card",
		standard: true,
	},
	{
		key: "ctrl+alt+left",
		cmd: "transcript.parent",
		action: "Select uniquely linked supplied parent card",
		short: "parent card",
		standard: true,
	},
	{
		key: "ctrl+alt+right",
		cmd: "transcript.child",
		action: "Select uniquely linked child, or choose among supplied children",
		short: "child card",
		standard: true,
	},
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
			"At first line: recall eligible history; otherwise cycle open slash suggestions",
		standard: true,
	},
	{
		key: "down",
		cmd: "input.historyNext",
		action:
			"At last line: advance eligible history; otherwise cycle open slash suggestions",
		standard: true,
	},
	{
		key: "?",
		cmd: "input.helpIfEmpty",
		action: "Open help only when the prompt is empty; otherwise type literally",
		standard: true,
	},
	{
		key: "tab",
		cmd: "input.prepareSuggestion",
		action: "Complete selected bare slash prefix as text only (no submission)",
		standard: true,
	},
	{
		key: "return",
		cmd: "prompt.submit",
		action:
			"Prepare selected slash suggestion, or submit the exact edited draft",
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
	Transcript: [...transcriptKeybinds, ...transcriptViewportKeybinds],
	Controls: actionKeybinds,
	Suggestions: paletteKeybinds,
	"Page focus": pageFocusKeybinds,
	Breadcrumbs: breadcrumbKeybinds,
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
