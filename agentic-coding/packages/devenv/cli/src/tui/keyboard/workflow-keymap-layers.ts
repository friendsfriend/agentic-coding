import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { handleActionsKeys } from "./actions-keys";
import { handleAppDetailKeys } from "./app-detail-keys";
import { handleChangedFilesKeys } from "./changed-files-keys";
import { handleCrDetailKeys } from "./cr-detail-keys";
import { handleCrListKeys } from "./cr-list-keys";
import { handleDiscussionsKeys } from "./discussions-keys";
import { handleIssueDetailKeys } from "./issue-detail-keys";
import { handleIssueListKeys } from "./issue-list-keys";
import { handleIssueTimelineKeys } from "./issue-timeline-keys";
import { handleJobsKeys } from "./jobs-keys";
import { handleReferencesKeys } from "./references-keys";
import { handleTestResultsKeys } from "./test-results-keys";
import type { KeyboardActions, KeyboardContext, KeyboardStores } from "./types";
import { handleWorktreeManagerKeys } from "./worktree-manager-keys";

export interface WorkflowKeymapLayerDeps {
	stores: KeyboardStores;
	actions: KeyboardActions;
	ctx: KeyboardContext;
}

const WORKFLOW_PRIORITY = 100;
const WORKTREE_PRIORITY = 1_100;

const COMMON_WORKFLOW_KEYS = [
	"tab",
	"shift+tab",
	"up",
	"down",
	"left",
	"right",
	"escape",
	"return",
	"enter",
	"backspace",
	"delete",
	"j",
	"k",
	"h",
	"l",
	"g",
	"G",
	"d",
	"D",
	"u",
	"/",
	"F",
	"O",
	"space",
	"?",
	"[",
	"]",
	"a",
	"A",
	"b",
	"B",
	"c",
	"C",
	"e",
	"E",
	"i",
	"I",
	"m",
	"M",
	"n",
	"N",
	"o",
	"p",
	"P",
	"q",
	"r",
	"R",
	"s",
	"S",
	"t",
	"T",
	"v",
	"x",
	"X",
	"ctrl+d",
	"ctrl+u",
	"ctrl+j",
	"ctrl+k",
	"ctrl+n",
	"ctrl+p",
	"ctrl+r",
	"ctrl+enter",
] as const;

const PANEL_SCROLL_KEYS = ["j", "k", "up", "down"] as const;
const PANEL_HALF_PAGE_KEYS = ["d", "u", "ctrl+d", "ctrl+u"] as const;
const PANEL_EDGE_KEYS = ["g", "G"] as const;

const bindAll = (command: string, context: string) =>
	COMMON_WORKFLOW_KEYS.map((key) => ({
		key,
		cmd: command,
		context,
		category: "Workflow",
		discoverable: false,
	}));

const bindPanel = (
	keys: readonly string[],
	command: string,
	context: string,
	footer?: string,
) =>
	keys.map((key) => ({
		key,
		cmd: command,
		context,
		category: "Panel",
		footer,
		discoverable: Boolean(footer),
	}));

function withSequence(event: KeyEvent): KeyEvent & { sequence?: string } {
	return Object.assign(event, {
		sequence:
			(event as KeyEvent & { sequence?: string }).sequence ??
			(event.shift && event.name.length === 1
				? event.name.toUpperCase()
				: event.name),
	});
}

export function registerWorkflowKeymapLayers(
	keymap: Keymap<Renderable, KeyEvent>,
	deps: WorkflowKeymapLayerDeps,
): () => void {
	const run =
		(
			handler: (
				event: KeyEvent,
				stores: KeyboardStores,
				actions: KeyboardActions,
				ctx: KeyboardContext,
			) => boolean | Promise<boolean>,
		) =>
		(event: KeyEvent) =>
			handler(withSequence(event), deps.stores, deps.actions, deps.ctx);
	const runAppDetail = (event: KeyEvent) => {
		const normalized = withSequence(event);
		const handled = handleAppDetailKeys(
			normalized,
			deps.stores.appDetailStore,
			deps.stores.appStore,
			deps.actions.appActions.expandDependencyNode,
		);
		if (handled) return true;
		if (normalized.name === "escape" || normalized.name === "esc") {
			deps.actions.appActions.closeAppDetail();
			return true;
		}
		return false;
	};

	const layers = [
		{
			viewMode: "appDetail",
			command: "app-detail.handle",
			title: "App detail",
			handler: runAppDetail,
		},
		{
			viewMode: "issues",
			command: "issues.handle",
			title: "Issues",
			handler: run(handleIssueListKeys),
		},
		{
			viewMode: "changeRequestLinkedIssues",
			command: "linked-issues.handle",
			title: "Linked issues",
			handler: run(handleIssueListKeys),
		},
		{
			viewMode: "issueDetail",
			command: "issue-detail.handle",
			title: "Issue detail",
			handler: run(handleIssueDetailKeys),
		},
		{
			viewMode: "issueTimeline",
			command: "issue-timeline.handle",
			title: "Issue timeline",
			handler: run(handleIssueTimelineKeys),
		},
		{
			viewMode: "references",
			command: "references.handle",
			title: "References",
			handler: run(handleReferencesKeys),
		},
		{
			viewMode: "changeRequests",
			command: "change-requests.handle",
			title: "Change requests",
			handler: run(handleCrListKeys),
		},
		{
			viewMode: "changeRequestDetail",
			command: "change-request-detail.handle",
			title: "Change request detail",
			handler: run(handleCrDetailKeys),
		},
		{
			viewMode: "changedFiles",
			command: "changed-files.handle",
			title: "Changed files",
			handler: run(handleChangedFilesKeys),
		},
		{
			viewMode: "discussionsView",
			command: "discussions.handle",
			title: "Discussions",
			handler: run(handleDiscussionsKeys),
		},
		{
			viewMode: "testResults",
			command: "test-results.handle",
			title: "Test results",
			handler: run(handleTestResultsKeys),
		},
		{
			viewMode: "jobs",
			command: "jobs.handle",
			title: "Jobs",
			handler: run(handleJobsKeys),
		},
		{
			viewMode: "actions",
			command: "actions.handle",
			title: "Actions",
			handler: (event: KeyEvent) =>
				handleActionsKeys(
					withSequence(event),
					deps.stores.actionRunStore,
					deps.stores.appStore,
					undefined,
					deps.stores.uiStore,
				),
		},
	] as const;

	const disposers = layers.map(({ viewMode, command, title, handler }) =>
		keymap.registerLayer({
			name: title,
			priority: WORKFLOW_PRIORITY,
			shutdown: false,
			activeModal: "none",
			appViewMode: viewMode,
			commands: [
				{
					name: command,
					context: viewMode,
					category: "Workflow",
					title,
					desc: `Handle ${title} keyboard input.`,
					discoverable: false,
					run: ({ event }) => handler(event),
				},
			],
			bindings: bindAll(command, viewMode),
		}),
	);

	const panelLayers = [
		{
			viewMode: "appDetail",
			focusedPanel: "appDetail:0",
			command: "app-detail.panel.summary",
			title: "App summary panel",
			handler: runAppDetail,
		},
		{
			viewMode: "appDetail",
			focusedPanel: "appDetail:1",
			command: "app-detail.panel.commands",
			title: "App commands panel",
			handler: runAppDetail,
		},
		{
			viewMode: "appDetail",
			focusedPanel: "appDetail:2",
			command: "app-detail.panel.dependencies",
			title: "App dependency panel",
			scrollTitle: "Navigate dependencies",
			handler: runAppDetail,
			extra: { key: "enter", title: "Expand/collapse dependency" },
		},
		{
			viewMode: "issueDetail",
			focusedPanel: "issueDetail:0",
			command: "issue-detail.panel.body",
			title: "Issue body panel",
			handler: run(handleIssueDetailKeys),
		},
		{
			viewMode: "issueDetail",
			focusedPanel: "issueDetail:1",
			command: "issue-detail.panel.references",
			title: "Issue references panel",
			handler: run(handleIssueDetailKeys),
			extra: { key: "o", title: "Open references" },
		},
		{
			viewMode: "issueDetail",
			focusedPanel: "issueDetail:2",
			command: "issue-detail.panel.comments",
			title: "Issue comments panel",
			handler: run(handleIssueDetailKeys),
		},
		{
			viewMode: "changeRequestDetail",
			focusedPanel: "changeRequestDetail:0",
			command: "cr-detail.panel.summary",
			title: "CR summary panel",
			handler: run(handleCrDetailKeys),
		},
		{
			viewMode: "changeRequestDetail",
			focusedPanel: "changeRequestDetail:1",
			command: "cr-detail.panel.description",
			title: "CR description panel",
			handler: run(handleCrDetailKeys),
		},
		{
			viewMode: "changeRequestDetail",
			focusedPanel: "changeRequestDetail:2",
			command: "cr-detail.panel.files",
			title: "CR changed files panel",
			handler: run(handleCrDetailKeys),
			extra: { key: "o", title: "Open changed files" },
		},
		{
			viewMode: "changeRequestDetail",
			focusedPanel: "changeRequestDetail:3",
			command: "cr-detail.panel.jobs",
			title: "CR pipeline jobs panel",
			handler: run(handleCrDetailKeys),
			extra: { key: "o", title: "Open jobs" },
		},
		{
			viewMode: "changeRequestDetail",
			focusedPanel: "changeRequestDetail:4",
			command: "cr-detail.panel.issues",
			title: "CR linked issues panel",
			handler: run(handleCrDetailKeys),
			extra: { key: "o", title: "Open linked issues" },
		},
		{
			viewMode: "changeRequestDetail",
			focusedPanel: "changeRequestDetail:5",
			command: "cr-detail.panel.discussions",
			title: "CR discussions panel",
			handler: run(handleCrDetailKeys),
			extra: { key: "o", title: "Open discussions" },
		},
		{
			viewMode: "changeRequestDetail",
			focusedPanel: "changeRequestDetail:6",
			command: "cr-detail.panel.tests",
			title: "CR test results panel",
			handler: run(handleCrDetailKeys),
			extra: { key: "o", title: "Open test results" },
		},
	] as const;

	for (const layer of panelLayers) {
		const { viewMode, focusedPanel, command, title, handler } = layer;
		const scrollTitle =
			("scrollTitle" in layer ? layer.scrollTitle : undefined) ??
			"Scroll focused panel";
		const extra = "extra" in layer ? layer.extra : undefined;
		const switchCommand = `${command}.switch-panel`;
		const halfPageCommand = `${command}.half-page`;
		const edgeCommand = `${command}.edge`;
		const extraCommand = extra && `${command}.${extra.key}`;
		disposers.push(
			keymap.registerLayer({
				name: title,
				priority: WORKFLOW_PRIORITY + 20,
				shutdown: false,
				activeModal: "none",
				appViewMode: viewMode,
				focusedPanel,
				commands: [
					{
						name: command,
						context: viewMode,
						category: "Panel",
						title: scrollTitle,
						desc: `${title} focused panel controls.`,
						footer: "j/k",
						discoverable: true,
						run: ({ event }) => handler(event),
					},
					{
						name: halfPageCommand,
						context: viewMode,
						category: "Panel",
						title: "Half page",
						desc: `Scroll ${title} by half a page.`,
						footer: "d/u",
						discoverable: true,
						run: ({ event }) => handler(event),
					},
					{
						name: edgeCommand,
						context: viewMode,
						category: "Panel",
						title: "Top/bottom",
						desc: `Scroll ${title} to top or bottom.`,
						footer: "g/G",
						discoverable: true,
						run: ({ event }) => handler(event),
					},
					{
						name: switchCommand,
						context: viewMode,
						category: "Navigation",
						title: "Switch panel",
						desc: "Move focus to adjacent panel.",
						footer: "J/K",
						discoverable: true,
						run: ({ event }) => handler(event),
					},
					...(extra && extraCommand
						? [
								{
									name: extraCommand,
									context: viewMode,
									category: "Panel",
									title: extra.title,
									desc: `${extra.title} from focused panel.`,
									footer: extra.key === "enter" ? "Enter" : extra.key,
									discoverable: true,
									run: ({ event }: { event: KeyEvent }) => handler(event),
								},
							]
						: []),
				],
				bindings: [
					...bindPanel(PANEL_SCROLL_KEYS, command, viewMode, "j/k"),
					...bindPanel(PANEL_HALF_PAGE_KEYS, halfPageCommand, viewMode, "d/u"),
					...bindPanel(PANEL_EDGE_KEYS, edgeCommand, viewMode, "g/G"),
					{
						key: "J",
						cmd: switchCommand,
						context: viewMode,
						category: "Navigation",
						footer: "J/K",
						discoverable: true,
					},
					{
						key: "K",
						cmd: switchCommand,
						context: viewMode,
						category: "Navigation",
						footer: "J/K",
						discoverable: true,
					},
					...(extra && extraCommand
						? [
								{
									key: extra.key,
									cmd: extraCommand,
									context: viewMode,
									category: "Panel",
									footer: extra.key === "enter" ? "Enter" : extra.key,
									discoverable: true,
								},
							]
						: []),
				],
			}),
		);
	}

	disposers.push(
		keymap.registerLayer({
			name: "Worktree manager",
			priority: WORKTREE_PRIORITY,
			shutdown: false,
			activeModal: "none",
			worktreeManager: true,
			commands: [
				{
					name: "worktree-manager.handle",
					context: "worktree",
					category: "Workflow",
					title: "Worktree manager",
					desc: "Handle worktree manager keyboard input.",
					discoverable: false,
					run: ({ event }) =>
						handleWorktreeManagerKeys(
							withSequence(event),
							deps.stores,
							deps.actions,
							deps.ctx,
						),
				},
			],
			bindings: bindAll("worktree-manager.handle", "worktree"),
		}),
	);

	return () => {
		for (const dispose of [...disposers].reverse()) dispose();
	};
}
