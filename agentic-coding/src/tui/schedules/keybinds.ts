import {
	hostKeybind,
	type Keybind,
	type KeybindSection,
} from "@agentic-coding/ui";
export type SchedulingSurface =
	| "list"
	| "history"
	| "output"
	| "editor"
	| "postpone"
	| "confirm"
	| "filter";
export function schedulingKeybindCatalog(
	surface: SchedulingSurface,
	jobs = false,
	paused = false,
	editing = false,
	reviewable = false,
	uncertain = false,
): KeybindSection[] {
	const filterBinding: Keybind = {
		key: "f",
		action: "Filter loaded page",
		short: "filter",
	};
	const navigation: Keybind[] = [
		{
			key: "Esc",
			action:
				surface === "confirm" && uncertain
					? "Keep uncertain request pinned"
					: surface === "editor" && editing
						? "Finish entry"
						: "Back",
			standard: true,
		},
		{ key: "PgUp/PgDn", action: "Scroll details", standard: true },
	];
	if (["list", "history", "output", "editor"].includes(surface) && !editing)
		navigation.push(
			{
				key: "↑/↓",
				action: surface === "output" ? "Scroll output" : "Move selection",
				standard: true,
			},
			{
				key: "j/k",
				action: surface === "output" ? "Scroll output" : "Move selection",
				standard: true,
			},
		);
	if (editing || surface === "filter" || surface === "postpone")
		navigation.push({
			key: "Backspace",
			action: "Delete last character",
			standard: true,
		});
	if (surface === "list")
		navigation.push({ key: "Enter", action: "Open details", standard: true });
	if (surface === "history" || surface === "output")
		navigation.push({
			key: "Enter",
			action: "Open execution target",
			standard: true,
		});
	const pages: Keybind[] = [
		{ key: "m", action: "Next page", standard: true },
		{ key: "b", action: "Previous page", standard: true },
		{ key: "g", action: "First page", standard: true },
	];
	let actions: Keybind[];
	switch (surface) {
		case "editor":
			actions = [
				{ key: "F2/Ctrl+Enter", action: "Preview and save", short: "save" },
				{ key: "Ctrl+R", action: "Reload saved version", short: "reload" },
				...(editing
					? [
							{ key: "Ctrl+U", action: "Clear field", short: "clear" },
							{
								key: "Enter",
								action: "Finish entry or add new line",
								standard: true,
							},
						]
					: [
							{ key: "Enter", action: "Edit or choose field", standard: true },
							{ key: "←/→", action: "Change choice", standard: true },
							{
								key: "Tab/Shift+Tab",
								action: "Move between fields",
								standard: true,
							},
						]),
			];
			break;
		case "postpone":
			actions = [
				{ key: "Enter", action: "Review postponement", short: "review" },
			];
			break;
		case "confirm":
			actions = [
				{
					key: "Enter",
					action: uncertain
						? "Retry exact pinned request"
						: "Confirm scheduling change",
					short: uncertain ? "retry" : "confirm",
				},
			];
			break;
		case "filter":
			actions = [{ key: "Enter", action: "Apply filter", short: "apply" }];
			break;
		case "output":
			actions = [
				{ key: "o", action: "Open execution target", short: "target" },
				{ key: "r", action: "Refresh", short: "refresh" },
			];
			break;
		case "history":
			actions = [
				...(reviewable
					? [
							{
								key: "a",
								action: "Review occurrence approval",
								short: "approve",
							},
						]
					: []),
				{ key: "o", action: "Open execution target", short: "target" },
				{ key: "r", action: "Refresh", short: "refresh" },
				filterBinding,
				...pages,
			];
			break;
		default:
			actions = [
				{ key: "n", action: "Create schedule", short: "new" },
				{ key: "N", action: "Create reusable job", short: "job" },
				{
					key: "e",
					action: jobs ? "Edit reusable job" : "Edit schedule",
					short: "edit",
				},
				{
					key: "x",
					action: jobs ? "Delete reusable job" : "Delete schedule",
					short: "delete",
				},
				{ key: "r", action: "Refresh", short: "refresh" },
				filterBinding,
				...pages,
				{
					key: "Tab/Shift+Tab",
					action: "Switch jobs and schedules",
					standard: true,
				},
				...(!jobs
					? [
							{ key: "h", action: "Occurrence history", short: "history" },
							{ key: "o", action: "Open last output", short: "output" },
							{
								key: "p",
								action: paused ? "Resume schedule" : "Pause schedule",
								short: paused ? "resume" : "pause",
							},
							{ key: "P", action: "Postpone next run", short: "postpone" },
							{ key: "R", action: "Run now", short: "run" },
							{ key: "c", action: "Cancel schedule", short: "cancel" },
						]
					: []),
			];
	}
	return [
		{ title: "Schedules", keybinds: [...actions, ...navigation] },
		{
			title: "Shell",
			keybinds: [
				hostKeybind("ctrl+p"),
				hostKeybind("?"),
				hostKeybind("ctrl+t"),
				hostKeybind("alt+d"),
				hostKeybind("q"),
			],
		},
	];
}
