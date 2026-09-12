import type { HelpSection } from "@devenv/ui";
import {
	allContextHelpSectionsFromKeymap,
	getActiveFooterKeybindsFromKeymap,
	helpSectionsFromKeymap,
} from "../keyboard/keymap-metadata";
import type { DevenvKeymap } from "../keyboard/keymap-setup";
import { KEYBINDS } from "../keyboard/registry";
import type { AppStore } from "../stores/app-store";
import type { ChangeRequestStore } from "../stores/cr-store";
import type { IssueStore } from "../stores/issue-store";
import type { LogStore } from "../stores/log-store";
import type { UiStore } from "../stores/ui-store";

const COMMON_NAVIGATION_ITEMS: HelpSection["items"] = [
	{ key: "j/k, ↑/↓", description: "Move selection or scroll one line" },
	{ key: "u/d", description: "Page or half-page up/down where supported" },
	{ key: "g/G", description: "Go to top/bottom where supported" },
	{ key: "/", description: "Search current list where supported" },
	{ key: "F", description: "Filter current list where supported" },
	{ key: "O", description: "Order/sort current list where supported" },
	{ key: "h/l, ←/→", description: "Scroll horizontally where supported" },
	{
		key: "[/], Shift+K/J",
		description: "Previous/next page or file where supported",
	},
];

// ponytail: context titles map, extend when new view modes are added
const CONTEXT_TITLES: Record<string, string> = {
	global: "Global",
	table: "Repository Table",
	kubernetes: "Kubernetes Cluster",
	changeRequests: "Change Request List",
	changeRequestDetail: "Change Request Detail",
	jobs: "Pipeline Jobs",
	testResults: "Test Results",
	changedFiles: "Changed Files",
	discussionsView: "Discussions/Comments",
	appDetail: "Repository Details",
	providers: "Providers",
	issues: "Issues",
	issueDetail: "Issue Detail",
	issueTimeline: "Issue Timeline",
	issueScopePicker: "Issue Scope Picker",
	changeRequestLinkedIssues: "CR Linked Issues",
	references: "References",
	agentView: "Pi Sessions",
	sshPicker: "SSH Host Picker",
	logModal: "Log Modal",
	passphraseModal: "Passphrase Modal",
	branchSelector: "Branch Selector",
	createBranchModal: "Create Branch Modal",
	diffModal: "Diff Modal",
	worktreeManager: "Worktree Manager",
	connectProvider: "Provider Connect Modal",
	addRepositoryModal: "Add Repository Modal",
	taskArgsModal: "Task Args Modal",
	taskAddModal: "Task Add Modal",
	editorPicker: "Editor Picker",
	issueSubView: "Issue Sub-View",
	firstSteps: "First Steps",
	help: "Help",
	markdownModal: "Markdown Modal",
	errorDialog: "Error Dialog",
	confirmDialog: "Confirm Dialog",
	profilePicker: "Profile Picker",
};

function keyTokens(key: string): string[] {
	return key
		.split(/[,/]| or /)
		.map((token) => token.trim())
		.filter(Boolean);
}

function overlapsKey(a: string, b: string): boolean {
	const bTokens = new Set(keyTokens(b));
	return keyTokens(a).some((token) => bTokens.has(token));
}

function getSectionsForContext(context: string): HelpSection[] {
	const groups = new Map<string, Array<{ key: string; description: string }>>();

	for (const def of KEYBINDS) {
		if (def.context !== "global" && def.context !== context) continue;
		const key = def.keys.join(", ");
		if (!groups.has(def.category)) groups.set(def.category, []);
		const items = groups.get(def.category);
		if (!items) continue;
		if (
			!items.some(
				(item) => item.key === key && item.description === def.description,
			)
		) {
			items.push({ key, description: def.description });
		}
	}

	const navItems = groups.get("Navigation") ?? [];
	groups.set("Navigation", [
		...COMMON_NAVIGATION_ITEMS.filter(
			(common) => !navItems.some((item) => overlapsKey(common.key, item.key)),
		),
		...navItems,
	]);

	return Array.from(groups.entries()).map(([title, items]) => ({
		title,
		items,
	}));
}

function _getKeybindsForContext(
	context: string,
): Array<{ key: string; action: string }> {
	return KEYBINDS.filter(
		(d) => d.context === "global" || d.context === context,
	).map((d) => ({ key: d.keys.join(", "), action: d.description }));
}

function filterFooterKeybinds<T extends { key: string; action: string }>(
	binds: T[],
): T[] {
	return binds.filter((bind) => {
		const text = `${bind.key} ${bind.action}`.toLowerCase();
		return !/(copy|paste|console|quit|help|\besc\b|escape)/.test(text);
	});
}

function getFooterKeybindsForContext(
	context: string,
): Array<{ key: string; action: string }> {
	return filterFooterKeybinds(
		KEYBINDS.filter(
			(d) => d.context === context && d.category !== "Navigation",
		).map((d) => ({
			key: d.keys.join(", "),
			action: d.footerDescription ?? d.description,
		})),
	);
}

export function createHelpActions(
	appStore: AppStore,
	issueStore: IssueStore,
	logStore: LogStore,
	changeRequestStore: ChangeRequestStore,
	uiStore: UiStore,
) {
	let keymap: DevenvKeymap | undefined;
	const setKeymap = (nextKeymap: DevenvKeymap | undefined) => {
		keymap = nextKeymap;
	};

	const showHelp = () => {
		appStore.setPreviousViewMode(appStore.viewMode());
		appStore.pushView("help");
	};

	const closeHelp = () => {
		appStore.popView();
	};

	const getHelpContent = (
		allContexts?: boolean,
	): { sections: HelpSection[]; title: string } => {
		if (allContexts) {
			if (keymap) {
				return {
					title: "All Contexts",
					sections: [
						{ title: "Navigation", items: COMMON_NAVIGATION_ITEMS },
						...allContextHelpSectionsFromKeymap(keymap),
					],
				};
			}
			// Group all keybinds by context name with context as section title
			const contextGroups = new Map<
				string,
				Array<{ key: string; description: string }>
			>();
			for (const def of KEYBINDS) {
				const ctxTitle = CONTEXT_TITLES[def.context] ?? def.context;
				if (!contextGroups.has(ctxTitle)) contextGroups.set(ctxTitle, []);
				contextGroups.get(ctxTitle)?.push({
					key: def.keys.join(", "),
					description: def.description,
				});
			}
			return {
				title: "All Contexts",
				sections: [
					{ title: "Navigation", items: COMMON_NAVIGATION_ITEMS },
					...Array.from(contextGroups.entries()).map(([title, items]) => ({
						title,
						items,
					})),
				],
			};
		}
		const currentView = appStore.previousViewMode() ?? "table";
		const context =
			currentView === "table" && appStore.activeTab() === "kubernetes"
				? "kubernetes"
				: currentView;
		const title =
			CONTEXT_TITLES[context] ??
			(context === "kubernetes" ? "Kubernetes" : "Help");
		return {
			title,
			sections: keymap
				? helpSectionsFromKeymap(keymap, context)
				: getSectionsForContext(context),
		};
	};

	const getKeybinds = () => {
		const activeKeymapBinds = keymap
			? filterFooterKeybinds(getActiveFooterKeybindsFromKeymap(keymap))
			: [];
		if (activeKeymapBinds.length > 0) return activeKeymapBinds;

		// Modal state overrides — these depend on runtime state, not registry
		if (uiStore.showPassphraseModal())
			return filterFooterKeybinds([
				{ key: "Enter", action: "Unlock Key" },
				{ key: "Esc", action: "Cancel" },
			]);
		if (appStore.viewMode() === "help")
			return getFooterKeybindsForContext("help");
		if (appStore.viewMode() === "discussionsView") {
			if (changeRequestStore.replyMode())
				return filterFooterKeybinds([
					{ key: "Ctrl+Enter", action: "Submit Reply" },
					{ key: "Esc", action: "Cancel Reply" },
				]);
			return getFooterKeybindsForContext("discussionsView");
		}
		if (logStore.showLogModal()) {
			if (logStore.logSearchMode())
				return filterFooterKeybinds([
					{ key: "Enter", action: "Confirm Search" },
					{ key: "Backspace", action: "Delete Char" },
					{ key: "Esc", action: "Cancel Search" },
				]);
			return getFooterKeybindsForContext("logModal");
		}
		if (appStore.viewMode() === "issueDetail") {
			if (issueStore.showCloseReasonModal())
				return filterFooterKeybinds([
					{ key: "j/k", action: "Navigate" },
					{ key: "Enter", action: "Select Reason" },
					{ key: "Esc", action: "Cancel" },
				]);
			if (issueStore.showLabelPicker())
				return filterFooterKeybinds([
					{ key: "j/k", action: "Navigate" },
					{ key: "Enter", action: "Toggle" },
					{ key: "Esc", action: "Confirm" },
				]);
			if (issueStore.showAssigneePicker())
				return filterFooterKeybinds([
					{ key: "j/k", action: "Navigate" },
					{ key: "Enter", action: "Assign/Unassign" },
					{ key: "Esc", action: "Cancel" },
				]);
			if (issueStore.showCommentModal())
				return filterFooterKeybinds([
					{ key: "Enter", action: "New line" },
					{ key: "Ctrl+Enter", action: "Submit" },
					{ key: "Esc", action: "Cancel" },
				]);
			return getFooterKeybindsForContext("issueDetail");
		}

		const viewMode = appStore.viewMode();
		const context =
			viewMode === "table" && appStore.activeTab() === "kubernetes"
				? "kubernetes"
				: viewMode;
		const binds = getFooterKeybindsForContext(context);
		if (binds.length > 0) return binds;

		// Fallback for table with sub-modes
		if (viewMode === "table" && appStore.tableSearchMode()) {
			return filterFooterKeybinds([
				{ key: "Enter", action: "Confirm" },
				{ key: "Backspace", action: "Delete Char" },
				{ key: "Esc", action: "Cancel" },
			]);
		}

		return binds;
	};

	return { showHelp, closeHelp, getHelpContent, getKeybinds, setKeymap };
}

export type HelpActions = ReturnType<typeof createHelpActions>;
