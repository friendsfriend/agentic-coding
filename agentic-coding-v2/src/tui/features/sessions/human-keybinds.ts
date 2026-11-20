import type { Keybind } from "../../ui/keybinds.ts";
export const humanHelpKeybinds: Keybind[] = [
	{
		key: "escape",
		cmd: "human.leave",
		action: "Close interaction keybindings",
		short: "close",
	},
	{
		key: "?",
		cmd: "human.leave",
		action: "Close interaction keybindings",
		short: "close",
	},
	{ key: "up", cmd: "human.helpUp", action: "Scroll help up", standard: true },
	{
		key: "down",
		cmd: "human.helpDown",
		action: "Scroll help down",
		standard: true,
	},
];
export const questionKeybinds: Keybind[] = [
	{
		key: "ctrl+up",
		cmd: "human.previewUp",
		action: "Scroll option preview up",
		standard: true,
	},
	{
		key: "ctrl+down",
		cmd: "human.previewDown",
		action: "Scroll option preview down",
		standard: true,
	},
	{ key: "up", cmd: "human.up", action: "Previous option", standard: true },
	{ key: "down", cmd: "human.down", action: "Next option", standard: true },
	{
		key: "tab",
		cmd: "human.tab",
		action: "Next question / Submit",
		standard: true,
	},
	{
		key: "shift+tab",
		cmd: "human.previousTab",
		action: "Previous question / Submit",
		standard: true,
	},
	{
		key: "left",
		cmd: "human.previousTab",
		action: "Previous question / Submit",
		standard: true,
	},
	{
		key: "right",
		cmd: "human.tab",
		action: "Next question / Submit",
		standard: true,
	},
	{
		key: "return",
		cmd: "human.confirm",
		action: "Select option / open editor / explicitly submit",
		short: "select",
	},
	{
		key: "space",
		cmd: "human.confirm",
		action: "Toggle multi-choice checkbox",
		standard: true,
	},
	...[1, 2, 3, 4, 5].map((n) => ({
		key: String(n),
		cmd: `human.number${n}`,
		action: `Select option ${n}`,
		standard: true,
	})),
	{
		key: "n",
		cmd: "human.notes",
		action: "Edit question / global notes",
		short: "notes",
	},
	{
		key: "escape",
		cmd: "human.leave",
		action: "Leave editor / postpone with draft preserved",
		short: "postpone",
	},
	{
		key: "?",
		cmd: "human.help",
		action: "Show interaction keybindings",
		short: "help",
	},
];
export const reviewDiffKeybinds: Keybind[] = [
	{
		key: "h",
		cmd: "human.scrollLeft",
		action: "Scroll diff left",
		standard: true,
	},
	{
		key: "left",
		cmd: "human.scrollLeft",
		action: "Scroll diff left",
		standard: true,
	},
	{
		key: "l",
		cmd: "human.scrollRight",
		action: "Scroll diff right",
		standard: true,
	},
	{
		key: "right",
		cmd: "human.scrollRight",
		action: "Scroll diff right",
		standard: true,
	},
	{
		key: "e",
		cmd: "human.editComment",
		action: "Edit draft comment at selected line",
		short: "edit",
	},
	{ key: "j", cmd: "human.down", action: "Next diff line", standard: true },
	{ key: "k", cmd: "human.up", action: "Previous diff line", standard: true },
	{ key: "down", cmd: "human.down", action: "Next diff line", standard: true },
	{ key: "up", cmd: "human.up", action: "Previous diff line", standard: true },
	{
		key: "v",
		cmd: "human.visual",
		action: "Select line range",
		short: "range",
	},
	{
		key: "c",
		cmd: "human.comment",
		action: "Draft line / range comment",
		short: "comment",
	},
	{
		key: "o",
		cmd: "human.side",
		action: "Toggle old / new comment side",
		short: "side",
	},
	{
		key: "s",
		cmd: "human.split",
		action: "Toggle split / unified diff",
		short: "split",
	},
	{ key: "n", cmd: "human.nextComment", action: "Next comment", short: "next" },
	{
		key: "shift+n",
		cmd: "human.previousComment",
		action: "Previous comment",
		standard: true,
	},
	{
		key: "[",
		cmd: "human.previousFile",
		action: "Previous file",
		standard: true,
	},
	{ key: "]", cmd: "human.nextFile", action: "Next file", standard: true },
	{
		key: "escape",
		cmd: "human.leave",
		action: "Return to same transcript tree; keep drafts",
		short: "close",
	},
	{
		key: "?",
		cmd: "human.help",
		action: "Show interaction keybindings",
		short: "help",
	},
];
export const questionEditorKeybinds: Keybind[] = [
	{
		key: "return",
		cmd: "human.saveText",
		action: "Keep draft answer / note and leave editor",
		short: "keep",
	},
	{
		key: "shift+return",
		cmd: "editor.newline",
		action: "Insert draft newline",
		standard: true,
	},
	{
		key: "ctrl+u",
		cmd: "human.clearText",
		action: "Clear current custom answer",
		short: "clear",
	},
	{
		key: "escape",
		cmd: "human.leave",
		action: "Leave editor with draft preserved (no answer selected)",
		short: "back",
	},
];
export const humanEditorKeybinds: Keybind[] = [
	{
		key: "return",
		cmd: "editor.newline",
		action: "Insert draft newline",
		standard: true,
	},
	{
		key: "ctrl+return",
		cmd: "human.saveText",
		action: "Keep draft text and leave editor",
		short: "keep",
	},
	{
		key: "escape",
		cmd: "human.leave",
		action: "Leave editor; preserve draft",
		short: "back",
	},
];
