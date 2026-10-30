/** @jsxImportSource @opentui/solid */

import { basename } from "node:path";
import {
	focusSoon,
	GenericModal,
	ListViewModal,
	ProgressModal,
	uiColors,
	useKeyDispatch,
} from "@agentic-coding/ui";
import type {
	InputRenderable,
	KeyEvent,
	TextareaRenderable,
} from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import {
	createEffect,
	createSignal,
	onCleanup,
	onMount,
	Show,
	untrack,
} from "solid-js";
import { gatewayOrUndefined, gatewayReady } from "../../data/index.ts";
import {
	type BranchOptions,
	discoverBranches,
	discoverChanges,
	discoverProjects,
	type ProjectOption,
} from "../../data/workflow.ts";
import { workflowLaunchKeybindCatalog } from "../keybinds.ts";
import type { WorkflowLaunchContext, WorkflowLaunchInput } from "../launch.ts";
import { workflowTypesForContext } from "../launch.ts";
import {
	discoverBranchesLocal,
	discoverChangesLocal,
	PRESET_CONFIG_DEFAULTS,
	PUBLIC_WORKFLOW_CATALOG,
} from "../live.ts";
import {
	clearStageCatalogSnapshot,
	refreshStageCatalog,
	STAGE_CATALOG_EMPTY,
	type StageChoice,
	stageCatalogSnapshot,
	stageChoiceRefusal,
	stageChoiceSelectable,
	stageChoices,
} from "../stage-catalog.ts";

/** Task-driven registry types: the wizard renders and submits the task step for
 * these, and `openspec` runs the classifier-routed plan-first graph. Every
 * other type (`openspec-apply`) selects an existing OpenSpec change instead
 * and keeps its task-free field set, while `rebase` replaces the task and
 * checkout steps with its two branch pickers and `verify` has neither a task
 * nor a checkout choice. The task itself stays optional except where
 * `canSubmit` requires it (wiki, research, quick, no-openspec). */
const TASK_TYPES = new Set([
	"openspec",
	"quick",
	"openspec-fusion",
	"openspec-propose",
	"openspec-fusion-propose",
	"wiki",
	"research",
	"no-openspec",
	"solo",
	"stage-test",
]);

/** One repository-step entry: a configured application/library, the directory
 * this form was opened with, or the free-path editor. A project that cannot be
 * started keeps its entry together with the reason, so the picker reports why
 * it is unusable instead of hiding it. */
type RepoEntry =
	| {
			kind: "project";
			/** Configured project identity; unique in the catalog. */
			ident: string;
			name: string;
			path: string;
			reason?: string;
	  }
	| { kind: "current"; path: string }
	| { kind: "custom" };

/** One entry of the current step: the plain value every other step submits, a
 * repository entry the repository step resolves itself, or a stage entry the
 * stage step resolves itself (an allow-listed stage, or a refused file kept
 * visible with its reason). */
type StepEntry = string | RepoEntry | StageChoice;

/** How many times a superseded catalog read is retried before the picker
 * reports it. */
const CATALOG_READ_ATTEMPTS = 3;

/** Identity of a repository entry. The catalog read inserts entries between the
 * picker's fixed entries, so the cursor is held by identity and never by a
 * position that moves under the user. */
function repoEntryKey(entry: RepoEntry): string {
	return entry.kind === "project" ? `project:${entry.ident}` : entry.kind;
}

/** The identity of any step's entry, used as the cursor's anchor. */
function entryKey(item: StepEntry): string {
	if (typeof item === "string") return `value:${item}`;
	if ("kind" in item && item.kind === "stage") return item.key;
	return repoEntryKey(item);
}

/** Why a configured project cannot be started, or `undefined` when it can. */
function projectBlockReason(project: ProjectOption): string | undefined {
	if (!project.path) return project.detail ?? "no checkout path is known";
	if (project.available) return undefined;
	return project.detail ?? `checkout is ${project.availability}`;
}

/** Whether a repository entry matches the active filter query: both the label
 * and the path are searched, so a partial name and a partial directory address
 * narrow the same list. */
function repoEntryMatches(entry: RepoEntry, query: string): boolean {
	if (!query) return true;
	if (entry.kind === "custom") return "custom path".includes(query);
	if (entry.kind === "current")
		return `current directory ${entry.path}`.toLowerCase().includes(query);
	return `${entry.name} ${entry.path}`.toLowerCase().includes(query);
}

/** Entry label. A project is named by its configured display name, so the list
 * never asks the user to recognize a checkout by its path alone. */
function repoEntryLabel(entry: RepoEntry): string {
	if (entry.kind === "custom") return "Custom path…";
	if (entry.kind === "current")
		return `Current directory (${basename(entry.path)})`;
	return entry.name;
}

/** Second line of an entry: where it points, or why it cannot be used. An
 * unusable entry leads with its reason, so a narrow row shows the reason
 * instead of a checkout path that eats the whole line. */
function repoEntryDetail(entry: RepoEntry): string {
	if (entry.kind === "custom") return "Enter any directory";
	if (entry.kind === "current") return entry.path;
	if (!entry.reason) return entry.path;
	return entry.path ? `${entry.reason} — ${entry.path}` : entry.reason;
}

export type NewWorkflowInput = WorkflowLaunchInput;

/**
 * Contextual creation form (launch-workflows-from-project-and-wiki-pages,
 * task 1.2; environment selection in the repository step). The launch context
 * is immutable and comes from the page the user started on: a configured
 * project and Wiki need no target step at all, while Home's own-directory
 * launch keeps a repository step whose picker offers the configured
 * applications/libraries, the directory the form was opened with, and a free
 * custom path. The remaining steps are the workflow type, preset, ticket,
 * workflow-id, task and checkout options. Supported types come from the
 * workflow registry catalog; the context only restricts the permitted target
 * set.
 */
export function NewWorkflowModal(props: {
	context: WorkflowLaunchContext;
	presets?: string[];
	presetsForRepository?: (repository: string) => string[];
	onCancel: () => void;
	onComplete: (input: WorkflowLaunchInput) => Promise<void>;
	onKeyReady: (handler: (key: KeyEvent) => boolean) => void;
}) {
	const [step, setStep] = createSignal(0);
	const [attachHome, setAttachHome] = createSignal(false);
	const [creating, setCreating] = createSignal(false);
	/** The cursor, held as the identity of the entry it points at (`undefined` is
	 * the step's first entry). Two list steps fill in asynchronously — the
	 * configured catalog and the OpenSpec change list — and an index would come
	 * to rest on another entry the moment one landed. */
	const [cursor, setCursor] = createSignal<string | undefined>(undefined);
	const [filter, setFilter] = createSignal("");
	const [filtering, setFiltering] = createSignal(false);
	/** Repository step: the picker opens the free-path editor on demand, so the
	 * step stays a list until the user asks for a path the catalog does not
	 * know. */
	const [editingRepoPath, setEditingRepoPath] = createSignal(false);
	/** Configured applications/libraries the repository step offers. */
	const [configuredProjects, setConfiguredProjects] = createSignal<
		ProjectOption[]
	>([]);
	/** Why the picker has no configured entries: the catalog read failed or kept
	 * being superseded. Only the read effect sets and clears it, so a cursor move
	 * can never erase the one explanation for an otherwise empty picker. */
	const [catalogNotice, setCatalogNotice] = createSignal<string | undefined>();
	/** Whether the configured-catalog read is still in flight: the app step must
	 * not claim nothing is configured before the read has answered. */
	const [catalogLoading, setCatalogLoading] = createSignal(false);
	/** Why the entry the cursor is on cannot be started. Transient: the next
	 * cursor move or step change drops it. */
	const [refusal, setRefusal] = createSignal<string | undefined>();
	/** The app step's own empty state: with nothing configured there is no app to
	 * draft for, and the generic "No items" placeholder would leave the user
	 * without the remedy the other steps give. */
	const appNotice = () =>
		field() === "app" &&
		choices().length === 0 &&
		!filter() &&
		!catalogLoading()
			? "No configured applications are available — configure an application or library first; an environment setup workflow drafts for one configured app."
			: undefined;
	/** The stage catalog the stage step picks from, and its own loading/failure
	 * state (`add-stage-test-launch`). A stage test runs on one allow-listed
	 * stage, so the step reads the catalog instead of asking for a free ident. */
	const [stageCatalog, setStageCatalog] = createSignal<
		ReturnType<typeof stageCatalogSnapshot>
	>(stageCatalogSnapshot());
	const [stageLoading, setStageLoading] = createSignal(false);
	const [stageReadError, setStageReadError] = createSignal<
		string | undefined
	>();
	/** The stage step's own empty state: with nothing configured there is no
	 * stage to test, and the generic "No items" placeholder would leave the
	 * developer without the remedy the other steps give. A read that has not
	 * answered yet is not an empty catalog, so nothing is claimed before it does. */
	const stageNotice = () =>
		field() === "stage" &&
		stageChoices(stageCatalog()).length === 0 &&
		!filter() &&
		!stageLoading()
			? stageReadError()
				? `Stages could not be read: ${stageReadError()}. Press Esc and re-enter this step to retry.`
				: stageCatalog() === undefined
					? undefined
					: STAGE_CATALOG_EMPTY
			: undefined;
	// The configured-project catalog explains the repository and app steps only: a
	// stale project-read failure must never be shown as the reason the stage step
	// is empty. The catalog read's own failure outranks the app step's "nothing is
	// configured" notice: the remedy differs, and only one of the two is true.
	const notice = () =>
		refusal() ??
		branchNotice() ??
		(pathTarget() || field() === "app" ? catalogNotice() : undefined) ??
		appNotice() ??
		stageNotice();
	const repository = () =>
		props.context.kind === "project" || props.context.kind === "path"
			? props.context.repository
			: "";
	/** Home's entry: the target is a directory this form lets the user edit. */
	const pathTarget = () => props.context.kind === "path";
	const [values, setValues] = createSignal<WorkflowLaunchInput>({
		repo: repository(),
		ticket: "",
		workflowId: "",
		mode: "",
		workflowType:
			props.context.kind === "independent" ? "research" : "openspec",
		preset: PRESET_CONFIG_DEFAULTS,
	});
	let currentInput: InputRenderable | undefined;
	let taskInput: TextareaRenderable | undefined;

	// OpenSpec change ids are fetched through the typed backend API; the
	// completion list updates once the async read resolves.
	const [availableChanges, setAvailableChanges] = createSignal<string[]>([]);
	createEffect(() => {
		const repo = values().repo;
		const type = values().workflowType;
		if (field() !== "workflowId" || type !== "openspec-apply") return;
		const controller = new AbortController();
		void discoverChanges(repo, controller.signal)
			.then((changes) => setAvailableChanges(changes ?? []))
			.catch(() => setAvailableChanges([]));
		onCleanup(() => controller.abort());
	});

	// The rebase type's branch lists come from the repository the form selected.
	// The read resolves after the workflow-type step, so the two pickers fill in
	// while the user is still on the earlier steps; a failure is reported in the
	// picker rather than shown as a repository with no branches.
	const [branchOptions, setBranchOptions] = createSignal<
		BranchOptions | undefined
	>();
	const [branchNotice, setBranchNotice] = createSignal<string | undefined>();
	/** The repository the current branch list belongs to: a different repository
	 * replaces both selections instead of submitting refs the new checkout does
	 * not have. */
	const [branchRepo, setBranchRepo] = createSignal<string | undefined>();
	createEffect(() => {
		const repo = values().repo;
		if (!usesBranchPicker(values().workflowType) || !repo) {
			setBranchOptions(undefined);
			setBranchNotice(undefined);
			return;
		}
		const controller = new AbortController();
		void (async () => {
			try {
				const options = gatewayOrUndefined()
					? await discoverBranches(repo, controller.signal)
					: discoverBranchesLocal(repo);
				if (controller.signal.aborted) return;
				if (!options) {
					setBranchNotice(
						"Branches could not be read: the read was superseded by a change. Reopen the form to retry.",
					);
					return;
				}
				setBranchOptions(options);
				setBranchNotice(undefined);
				// First read for this repository: the target opens on the repository's
				// default branch and the source on the branch that is checked out. A
				// later read for the same repository leaves both choices alone, so a
				// refresh cannot undo what the user picked.
				if (untrack(() => branchRepo()) === repo) return;
				setBranchRepo(repo);
				setValues((current) => ({
					...current,
					...(!isDebug(current.workflowType)
						? { targetBranch: options.default }
						: {}),
					sourceBranch: isDebug(current.workflowType)
						? options.local.includes(options.current)
							? options.current
							: options.default
						: options.local.includes(options.current)
							? options.current
							: "",
				}));
			} catch (error) {
				if (controller.signal.aborted) return;
				setBranchOptions(undefined);
				setBranchNotice(
					`Branches could not be read: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		})();
		onCleanup(() => controller.abort());
	});

	// Configured applications/libraries come from the same catalog the
	// environment pages read, over the dashboard port. Without a port the picker
	// still offers the directory this form was opened with and a custom path;
	// this effect re-runs once the composition root installs the gateway after
	// first paint.
	// The catalog is read for the steps that offer configured entries: the
	// repository picker of a path target and the env-setup app step, which offers
	// every configured app whatever the launch context.
	const needsCatalog = () => pathTarget() || field() === "app";
	createEffect(() => {
		if (!needsCatalog() || !gatewayReady()) {
			setConfiguredProjects([]);
			setCatalogNotice(undefined);
			setCatalogLoading(false);
			return;
		}
		const controller = new AbortController();
		setCatalogLoading(true);
		void (async () => {
			try {
				let projects = await discoverProjects(controller.signal);
				// The data layer answers `undefined` for a read its key moved on under
				// (an event emptied the cache mid-read), which is not an environment
				// without configured projects: retry it, and report it rather than
				// publishing an empty picker.
				for (
					let attempt = 1;
					projects === undefined && attempt < CATALOG_READ_ATTEMPTS;
					attempt++
				)
					projects = await discoverProjects(controller.signal);
				if (controller.signal.aborted) return;
				if (projects === undefined) {
					setCatalogNotice(
						field() === "app"
							? "Configured applications could not be read: the read was superseded by a configuration change. Reopen the form to retry."
							: "Configured projects could not be read: the read was superseded by a configuration change. Enter a custom path or use the current directory.",
					);
					return;
				}
				setConfiguredProjects(projects);
				setCatalogNotice(undefined);
			} catch (error) {
				if (controller.signal.aborted) return;
				setCatalogNotice(
					field() === "app"
						? `Configured applications could not be read: ${
								error instanceof Error ? error.message : String(error)
							}. Reopen the form to retry.`
						: `Configured projects could not be read: ${
								error instanceof Error ? error.message : String(error)
							}. Enter a custom path or use the current directory.`,
				);
			}
		})();
		onCleanup(() => controller.abort());
	});

	// The stage step offers only what the stage catalog allow-lists
	// (`add-stage-test-launch`): the picker is read when the step is entered, so a
	// stage added or fixed in the configuration is offered without reopening the
	// form. Refused files stay in the list with their first diagnostic, and a
	// failed read is reported instead of an empty picker.
	createEffect(() => {
		if (!(field() === "stage" && isStageTest(values().workflowType))) {
			setStageLoading(false);
			setStageReadError(undefined);
			return;
		}
		let disposed = false;
		setStageLoading(true);
		void (async () => {
			const read = await refreshStageCatalog();
			if (disposed) return;
			setStageCatalog(read.snapshot);
			setStageReadError(read.error);
			setStageLoading(false);
		})();
		onCleanup(() => {
			disposed = true;
		});
	});
	onCleanup(() => clearStageCatalogSnapshot());

	const isProposal = (type: string) =>
		type === "openspec-propose" || type === "openspec-fusion-propose";
	const isRepositoryBacked = (type: string) =>
		isProposal(type) ||
		type === "wiki" ||
		type === "rebase" ||
		isVerify(type) ||
		isEnvSetup(type);
	/** The environment-setup type drafts definitions for one configured app, so
	 * it needs that app's identity and no checkout-mode choice of its own. */
	const isEnvSetup = (type: string) => type === "env-setup";
	/** The rebase type's two extra steps: the branch that gets rebased and the
	 * ref it is rebased onto, both chosen from the repository's branch list. */
	const isRebase = (type: string) => type === "rebase";
	/** The debug type investigates one selected branch in a detached worktree:
	 * it needs that branch and a task, and forces the worktree mode itself. */
	const isDebug = (type: string) => type === "debug";
	/** Types whose repository needs a branch list read for their pickers. */
	const usesBranchPicker = (type: string) => isRebase(type) || isDebug(type);
	/** The verify-only type needs no input beyond the repository: it verifies the
	 * branch that is already checked out against the configured base branch, so it
	 * has neither a task step nor a checkout-mode choice. */
	const isVerify = (type: string) => type === "verify";
	/** The stage-test type plans and executes a verification on one allow-listed
	 * hosted stage (`add-stage-test-launch`): it needs that stage and the ticket
	 * text as its task, and no branch, worktree or checkout mode. */
	const isStageTest = (type: string) => type === "stage-test";
	/** Context-restricted type set; `undefined` means the whole registry. */
	const allowedTypes = () => workflowTypesForContext(props.context);
	const workflowTypeChoices = () => {
		const allowed = allowedTypes();
		return (
			PUBLIC_WORKFLOW_CATALOG.map((item) => item.alias ?? item.id) as string[]
		).filter((choice) => !allowed || allowed.includes(choice));
	};
	const fields = (): (keyof WorkflowLaunchInput)[] => {
		// The stage-test type names the allow-listed stage it runs on before the
		// ticket text (the task): a stage test is repository-independent, so it has
		// no checkout-mode step of its own.
		if (isStageTest(values().workflowType))
			return [
				...(pathTarget() ? (["repo"] as const) : []),
				"workflowType",
				"preset",
				"stage",
				"ticket",
				"workflowId",
				"task",
			];
		// The rebase type replaces the task and checkout steps with its two branch
		// pickers: it needs no task and forces the checkout mode itself.
		if (isRebase(values().workflowType))
			return [
				...(pathTarget() ? (["repo"] as const) : []),
				"workflowType",
				"preset",
				"ticket",
				"workflowId",
				"sourceBranch",
				"targetBranch",
			];
		// The debug type selects one branch and a task, and runs in worktree mode.
		if (isDebug(values().workflowType))
			return [
				...(pathTarget() ? (["repo"] as const) : []),
				"workflowType",
				"preset",
				"ticket",
				"workflowId",
				"sourceBranch",
				"task",
			];
		const head: (keyof WorkflowLaunchInput)[] = [
			...(pathTarget() ? (["repo"] as const) : []),
			"workflowType",
			"preset",
			"ticket",
			"workflowId",
		];
		if (isVerify(values().workflowType)) return head;
		// Environment setup names the app it drafts for before anything else.
		if (isEnvSetup(values().workflowType)) return [...head, "app", "task"];
		if (!TASK_TYPES.has(values().workflowType)) return [...head, "mode"];
		// Repository-backed workflows and independent research own their checkout
		// behavior, so only the remaining types show the explicit choice.
		return isRepositoryBacked(values().workflowType) ||
			values().workflowType === "research"
			? [...head, "task"]
			: [...head, "task", "mode"];
	};

	const fieldLabels: Record<string, string> = {
		repo: "Repository path",
		workflowType: "Workflow type",
		preset: "Agent preset",
		ticket: "Ticket reference optional",
		workflowId: "Workflow ID",
		task: "Task required for debug, wiki, research, no OpenSpec, and solo",
		mode: "Checkout mode",
		sourceBranch: "Branch to rebase",
		targetBranch: "Branch to rebase onto",
		app: "Configured app to set up",
		stage: "Stage to test",
	};
	/** The field's label, with the two type-specific renames: the debug branch
	 * picker selects the branch to investigate (not to rebase), and a stage test's
	 * task is the ticket text the developer pasted, not a generic task. */
	const labelFor = (key: keyof WorkflowLaunchInput | undefined): string =>
		key === "sourceBranch" && isDebug(values().workflowType)
			? "Branch to investigate"
			: key === "task" && isStageTest(values().workflowType)
				? "Ticket text (the task)"
				: ((key ? fieldLabels[key] : undefined) ?? "");

	/** Why the confirmation refused, in one short line. The field labels are whole
	 * sentences for some types, so they cannot be spliced into a sentence: each
	 * field that can be missing at the confirmation gets its own phrase. */
	const missingRequirement = (
		key: keyof WorkflowLaunchInput | undefined,
	): string => {
		if (key === "task")
			return isStageTest(values().workflowType)
				? "The ticket text is required before the workflow can start."
				: "The task is required before the workflow can start.";
		if (key === "stage")
			return "A stage to test is required before the workflow can start.";
		if (key === "sourceBranch")
			return isDebug(values().workflowType)
				? "The branch to investigate is required before the workflow can start."
				: "The branch to rebase is required before the workflow can start.";
		if (key === "targetBranch")
			return "The branch to rebase onto is required before the workflow can start.";
		return "A required value is still empty; go back to it before starting.";
	};

	const workflowTypeEntry = (choice: string) =>
		PUBLIC_WORKFLOW_CATALOG.find(
			(item) => item.id === choice || item.alias === choice,
		);

	/** The selected branch step, when the current field is one of the two the
	 * rebase type adds. */
	const branchField = (): "sourceBranch" | "targetBranch" | undefined => {
		const f = field();
		return f === "sourceBranch" || f === "targetBranch" ? f : undefined;
	};

	const localBranches = (): string[] => branchOptions()?.local ?? [];

	/** The target may name a remote ref (the common "rebase onto `origin/main`")
	 * while the source must be a local branch: a rebase checks out and rewrites
	 * an existing local ref. */
	const branchChoices = (): string[] => {
		if (field() === "sourceBranch") return localBranches();
		if (field() === "targetBranch")
			return [...localBranches(), ...(branchOptions()?.remote ?? [])];
		return [];
	};

	const choices = (): string[] => {
		const f = field();
		if (branchField()) {
			const query = filter().toLowerCase();
			return branchChoices().filter((item) =>
				item.toLowerCase().includes(query),
			);
		}
		if (f === "workflowType")
			return workflowTypeChoices().filter((item) =>
				item.includes(filter().toLowerCase()),
			);
		if (f === "preset") {
			const presets = props.presetsForRepository
				? props.presetsForRepository(values().repo)
				: (props.presets ?? []);
			return [PRESET_CONFIG_DEFAULTS, ...presets].filter((item) =>
				item.toLowerCase().includes(filter().toLowerCase()),
			);
		}
		if (f === "workflowId" && values().workflowType === "openspec-apply")
			// With a gateway configured the prefetched list (read through the data
			// layer) is the source; a transport-less run reads the checkout.
			return gatewayOrUndefined()
				? availableChanges()
				: discoverChangesLocal(values().repo);
		if (f === "mode")
			return ["worktree", "checkout"].filter((item) =>
				item.includes(filter().toLowerCase()),
			);
		if (f === "app") {
			// The launch context's own app is always offered and opens first: a
			// setup workflow started from an application page is about that
			// application, and the catalog read may not have resolved yet.
			const contextIdent =
				props.context.kind === "project" ? props.context.ident : undefined;
			const idents = [
				...(contextIdent ? [contextIdent] : []),
				...configuredProjects().map((project) => project.ident),
			].filter(
				(ident, index, all) =>
					all.indexOf(ident) === index &&
					ident.includes(filter().toLowerCase()),
			);
			return idents;
		}
		return [];
	};

	/** Repository-step entries: the directory this form was opened with, every
	 * configured application/library, and the free-path editor. The opened
	 * directory stays first and the free-path editor last, so the cursor's own
	 * identity — not its position — keeps it on the entry the user highlighted
	 * when the catalog read lands between them. */
	const repoEntries = (): RepoEntry[] => {
		const query = filter().trim().toLowerCase();
		const opened = repository();
		const entries: RepoEntry[] = [
			{ kind: "current", path: opened },
			...configuredProjects()
				.filter((project) => project.path !== opened)
				.map((project) => {
					const reason = projectBlockReason(project);
					return {
						kind: "project" as const,
						ident: project.ident,
						name: project.name || project.ident,
						path: project.path,
						...(reason ? { reason } : {}),
					};
				}),
			{ kind: "custom" },
		];
		return entries.filter((entry) => repoEntryMatches(entry, query));
	};

	/** The stage step's entries: the allow-listed stages, then the refused files
	 * with their first diagnostic. The filter searches the label, the ident and
	 * the detail line, so a stage is findable by ident, name or environment. */
	const stageEntries = (): StageChoice[] => {
		const query = filter().trim().toLowerCase();
		return stageChoices(stageCatalog()).filter((entry) =>
			`${entry.label} ${entry.ident} ${entry.detail}`
				.toLowerCase()
				.includes(query),
		);
	};

	/** The entries of the current step. */
	// Pointer parity: a tap selects an option; a second tap on the selected
	// option dispatches the wizard's own plain `Enter` (advance/create).
	const dispatch = useKeyDispatch();
	const entries = (): StepEntry[] => {
		const f = field();
		if (f === "repo") return repoEntries();
		if (f === "stage") return stageEntries();
		return choices();
	};

	/** Where the cursor is now. A cursor identity the current list does not hold
	 * (a filter hid it, or the list shrank) falls back to the first entry, so the
	 * highlight and Enter always agree on one entry. */
	const selectedIndex = (): number => {
		const items = entries();
		const key = cursor();
		const index =
			key === undefined
				? -1
				: items.findIndex((item) => entryKey(item) === key);
		if (index >= 0) return index;
		// A branch step opens on the value it preselected as long as the user has
		// not moved the cursor, so the highlight and Enter agree on the default
		// the summary already shows.
		const branch = branchField();
		if (branch) {
			const chosen = values()[branch];
			const at = chosen === undefined ? -1 : items.indexOf(chosen);
			if (at >= 0) return at;
		}
		return 0;
	};

	const listStep = () => {
		const f = field();
		// The repository step is the picker until the user asks for a custom path.
		if (f === "repo") return !editingRepoPath();
		return (
			f === "workflowType" ||
			f === "preset" ||
			f === "app" ||
			f === "stage" ||
			(f === "workflowId" && values().workflowType === "openspec-apply") ||
			f === "mode" ||
			branchField() !== undefined
		);
	};

	const confirmStep = () => step() === fields().length;
	/** The step a refused submit sends the cursor to: the first required field the
	 * form is still missing, so the confirm step never becomes a dead end. */
	const firstMissingStep = (): number => {
		if (isRebase(values().workflowType)) {
			if (!values().sourceBranch) return fields().indexOf("sourceBranch");
			return fields().indexOf("targetBranch");
		}
		if (isDebug(values().workflowType)) {
			if (!values().sourceBranch) return fields().indexOf("sourceBranch");
			return fields().indexOf("task");
		}
		if (isStageTest(values().workflowType)) {
			if (!values().stage) return fields().indexOf("stage");
			return fields().indexOf("task");
		}
		return fields().indexOf("task");
	};
	const canSubmit = () => {
		if (isDebug(values().workflowType))
			return Boolean(values().sourceBranch && values().task?.trim());
		if (isRebase(values().workflowType))
			// Both refs are the whole input of a rebase, and neither has a fallback
			// the workflow could pick on its own.
			return Boolean(values().sourceBranch && values().targetBranch);
		// A stage test names its stage and its ticket text: neither has a fallback
		// the workflow could pick on its own, and a stage is never guessed.
		if (isStageTest(values().workflowType))
			return Boolean(values().stage && values().task?.trim());
		return (
			!["wiki", "research", "quick", "no-openspec", "solo"].includes(
				values().workflowType,
			) || Boolean(values().task?.trim())
		);
	};
	const totalSteps = () => fields().length + 1;
	const field = () => fields()[step()];
	const targetSummary = () =>
		props.context.kind === "project"
			? { label: "Project", value: props.context.name }
			: props.context.kind === "path"
				? { label: "Repository", value: values().repo || "—" }
				: { label: "Target", value: "Independent (no repository)" };
	/** The stage row of the confirmation: the picker's own label and its
	 * environment · access marker, which is what says whether the run may change
	 * the hosted system. The bare ident is the fallback for a stage the catalog no
	 * longer holds. */
	const stageSummary = (ident: string | undefined) => {
		if (!ident) return "—";
		const picked = stageChoices(stageCatalog()).find(
			(candidate) => candidate.ident === ident,
		);
		return picked ? `${picked.label} — ${picked.detail}` : ident;
	};
	const summary = () => [
		targetSummary(),
		...fields().map((key) => ({
			label: labelFor(key),
			value:
				(key === "stage" ? stageSummary(values().stage) : values()[key]) || "—",
		})),
		// Confirming a form that cannot start sends the developer back to the
		// missing step; naming it here keeps that bounce from reading as a lost
		// keypress.
		...(canSubmit()
			? []
			: [
					{
						label: "Still required",
						value: labelFor(fields()[Math.max(0, firstMissingStep())]),
					},
				]),
	];

	/** One field's editor value, addressed by the field it renders rather than
	 * by the current step, so a leaked key can never write another field. */
	const updateField = (key: keyof WorkflowLaunchInput, value: string) => {
		setValues((current) => ({ ...current, [key]: value }));
	};
	/** Leaving a text step: OpenTUI removes a portaled editor without destroying
	 * it, and a removed-but-focused editor keeps receiving keys and writing into
	 * whatever step is current. Blurring it first ends its key subscription. */
	const blurEditors = () => {
		currentInput?.blur();
		taskInput?.blur();
	};
	/** Return from the free-path editor to the repository picker without leaving
	 * the step, with the cursor parked on the entry that opened the editor. */
	const leaveCustomPath = () => {
		blurEditors();
		setEditingRepoPath(false);
		setCursor(repoEntryKey({ kind: "custom" }));
		setRefusal(undefined);
	};
	const back = () => {
		if (step() === 0) props.onCancel();
		else {
			blurEditors();
			setStep((i) => Math.max(0, i - 1));
			setEditingRepoPath(false);
			setRefusal(undefined);
			setCursor(undefined);
			setFilter("");
			setFiltering(false);
		}
	};
	/** Esc: dismiss an active filter first, then leave the free-path editor for
	 * the picker, and only then navigate out of the step. */
	const escapeStep = () => {
		if (filtering()) {
			setFiltering(false);
			return;
		}
		if (editingRepoPath()) {
			leaveCustomPath();
			return;
		}
		back();
	};
	const next = (value: string) => {
		const key = field();
		if (!key) return;
		blurEditors();
		setValues((current) => ({
			...current,
			[key]: value,
			...(key === "workflowType" && isRepositoryBacked(value)
				? { mode: "checkout" }
				: {}),
			...(key === "workflowType" && isDebug(value) ? { mode: "worktree" } : {}),
		}));
		setStep((i) => Math.min(i + 1, fields().length));
		setEditingRepoPath(false);
		setRefusal(undefined);
		setCursor(undefined);
		setFilter("");
		setFiltering(false);
	};
	/** Move the cursor by `delta` entries. A move parks it on the identity of the
	 * entry it lands on, so a list that fills in afterwards keeps the highlight
	 * where the user put it; an empty list leaves the cursor on the first entry
	 * rather than on a position no entry holds. */
	const moveCursor = (delta: number) => {
		const items = entries();
		if (items.length === 0) {
			setCursor(undefined);
			return;
		}
		const index = Math.max(
			0,
			Math.min(selectedIndex() + delta, items.length - 1),
		);
		const target = items[index];
		setCursor(target === undefined ? undefined : entryKey(target));
		setRefusal(undefined);
	};
	/** Selecting a stage entry: an allow-listed stage submits its ident, and a
	 * refused file is kept visible with the reason it cannot be selected rather
	 * than silently launching a start the server would refuse. */
	const selectStageEntry = (entry: StageChoice) => {
		if (!stageChoiceSelectable(entry)) {
			setRefusal(stageChoiceRefusal(entry));
			return;
		}
		next(entry.ident);
	};

	/** Selecting a repository entry: a usable project or the opened directory
	 * submits its path, `custom` opens the free-path editor, and a project that
	 * cannot be started is refused with its reason instead of launching work
	 * somewhere that is not there. */
	const selectRepoEntry = (entry: RepoEntry) => {
		if (entry.kind === "custom") {
			setRefusal(undefined);
			setEditingRepoPath(true);
			return;
		}
		if (entry.kind === "project" && entry.reason) {
			setRefusal(
				`${entry.name} is unavailable: ${entry.reason}. Enter a custom path or pick another entry.`,
			);
			return;
		}
		next(entry.path);
	};

	const submit = async () => {
		if (!canSubmit()) return;
		setCreating(true);
		try {
			// Yield one macrotask so the progress modal paints before the
			// completion callback can block the event loop.
			await new Promise((resolve) => setTimeout(resolve, 0));
			await props.onComplete({
				...values(),
				...(attachHome() ? { clarificationHome: "selected" as const } : {}),
			});
		} finally {
			setCreating(false);
		}
	};

	const handler = (key: KeyEvent) => {
		if (creating()) return true;
		const name = key.name.toLowerCase();
		if (name === "escape") {
			escapeStep();
			return true;
		}
		if (confirmStep()) {
			if (["j", "k", "up", "down"].includes(name)) {
				setAttachHome(!attachHome());
				return true;
			}
			if (name === "return" || name === "enter") {
				if (!canSubmit()) {
					// Send the cursor to the field that is actually missing: the task for
					// the task-required types, the unset branch for a rebase.
					const missing = fields()[Math.max(0, firstMissingStep())];
					setStep(Math.max(0, firstMissingStep()));
					setCursor(undefined);
					setFilter("");
					setFiltering(false);
					// The step change alone would look like the form bouncing: name the
					// field that is missing instead. The text steps render it above the
					// editor, the list steps in their header.
					setRefusal(missingRequirement(missing));
				} else void submit();
				return true;
			}
			return true;
		}
		if (!listStep()) {
			// Native OpenTUI editors are the sole owner of text editing. Returning
			// false lets the keymap fall through without preventing the editor's
			// focused key handler. Enter/Alt+Enter are delivered to onSubmit, while
			// plain Enter in the textarea remains a newline.
			return false;
		}
		const items = entries();
		// While a filter is active, '/' is a literal query character; only start
		// filtering when not already filtering.
		if (name === "/" && !filtering()) {
			// Resume editing any retained query rather than wiping it.
			setFiltering(true);
			setCursor(undefined);
			return true;
		}
		if (filtering()) {
			if (name === "backspace") {
				setFilter((value) => value.slice(0, -1));
				setCursor(undefined);
				return true;
			}
			if (name === "return" || name === "enter") {
				setFiltering(false);
				return true;
			}
			if (key.sequence.length === 1 && key.sequence >= " ") {
				setFilter((value) => value + key.sequence);
				setCursor(undefined);
				return true;
			}
		}
		if (name === "j" || name === "down") {
			moveCursor(1);
			return true;
		}
		if (name === "k" || name === "up") {
			moveCursor(-1);
			return true;
		}
		if (name === "d") {
			moveCursor(8);
			return true;
		}
		if (name === "u") {
			moveCursor(-8);
			return true;
		}
		if (name === "return" || name === "enter") {
			const choice = items[selectedIndex()];
			if (!choice) return true;
			if (typeof choice === "string") next(choice);
			else if (choice.kind === "stage") selectStageEntry(choice);
			else selectRepoEntry(choice);
			return true;
		}
		return true;
	};

	createEffect(() => {
		const maxIdx = fields().length;
		if (step() > maxIdx) setStep(maxIdx);
	});

	onMount(() => props.onKeyReady(handler));
	onCleanup(() => props.onKeyReady(() => true));

	return (
		<>
			<Show when={creating()}>
				<ProgressModal message="Starting workspace and agents…" />
			</Show>
			<Show when={!creating()}>
				<Show
					when={confirmStep()}
					fallback={
						<Show
							when={listStep()}
							fallback={
								<GenericModal
									dismissKind="new-workflow"
									title="New workflow"
									customHeader={
										pathTarget() ? (
											<box width="100%" flexDirection="column">
												<text attributes={TextAttributes.BOLD}>
													New workflow
												</text>
												<text fg={uiColors.textMuted}>{repository()}</text>
											</box>
										) : undefined
									}
									fieldLabel={labelFor(field())}
									summary={summary()}
									step={step()}
									total={totalSteps()}
									helpSections={false}
									help={
										field() === "task"
											? [
													{ key: "Enter", action: "New line" },
													{ key: "Alt+Enter", action: "Next" },
													{ key: "Esc", action: "Back" },
												]
											: [
													{ key: "Enter", action: "Next" },
													{ key: "Esc", action: "Back" },
												]
									}
								>
									{/* The refusal a bounce carries is the only notice this step has: a text
									    step has no list header to put it in, so it is shown above the editor. */}
									<Show when={refusal()}>
										<box width="100%" height={2} flexShrink={0}>
											<text fg={uiColors.warning} wrapMode="word">
												{refusal()}
											</text>
										</box>
									</Show>
									<Show
										when={field() === "task"}
										fallback={
											// Keyed by field: each text step owns its editor instance, so its
											// value and callbacks stay bound to the field it was created for.
											<Show when={field()} keyed>
												{(key) => (
													<input
														ref={currentInput}
														focused
														value={(values()[key] as string) || ""}
														placeholder={key === "ticket" ? "optional" : ""}
														onInput={(value: string) => updateField(key, value)}
														onSubmit={() =>
															next(currentInput?.value ?? values()[key] ?? "")
														}
														onKeyDown={(event: KeyEvent) => {
															if (event.name.toLowerCase() === "escape")
																escapeStep();
														}}
														focusedBackgroundColor={uiColors.bgBase}
														focusedTextColor={uiColors.textPrimary}
													/>
												)}
											</Show>
										}
									>
										<textarea
											ref={(input) => {
												taskInput = input;
												focusSoon(input);
											}}
											focused
											width="100%"
											height="100%"
											initialValue={untrack(() => values().task || "")}
											wrapMode="word"
											onContentChange={() =>
												updateField("task", taskInput?.plainText ?? "")
											}
											onSubmit={() =>
												next(taskInput?.plainText ?? values().task ?? "")
											}
											focusedBackgroundColor={uiColors.bgBase}
											focusedTextColor={uiColors.textPrimary}
										/>
									</Show>
								</GenericModal>
							}
						>
							<ListViewModal
								sizing="cap"
								title="New workflow"
								dismissKind="new-workflow"
								onSelect={(index) => {
									const entry = entries()[index];
									if (entry) setCursor(entryKey(entry));
								}}
								onActivate={(index) => {
									const entry = entries()[index];
									if (entry) setCursor(entryKey(entry));
									// The wizard's own plain Enter stays the only activation.
									dispatch("Enter");
								}}
								fieldLabel={labelFor(field())}
								summary={summary()}
								items={entries()}
								selectedIndex={selectedIndex()}
								step={step()}
								total={totalSteps()}
								filterPlaceholder="filter"
								filterActive={filtering()}
								filterQuery={filter()}
								itemHeight={
									field() === "workflowType" ||
									field() === "repo" ||
									field() === "app" ||
									field() === "stage"
										? 2
										: 1
								}
								reservedHeight={3}
								{...((field() === "app" || field() === "stage") &&
								entries().length === 0 &&
								(field() === "stage"
									? stageLoading() || filter()
									: catalogLoading() || filter())
									? {
											// The header notice owns the "nothing configured" and "could not be
											// read" reasons; the list only explains the two states the header
											// stays quiet about, so one state never gets two explanations.
											emptyContent: (
												field() === "stage"
													? stageLoading()
													: catalogLoading()
											) ? (
												// The read is in flight: saying nothing is configured
												// would be false (and no animated reader, so the surface
												// stays still while it lands).
												<text fg={uiColors.textMuted}>
													{field() === "stage"
														? "Reading the configured stages…"
														: "Reading configured applications…"}
												</text>
											) : (
												<text fg={uiColors.warning}>
													{field() === "stage"
														? `No stage matches "${filter()}"`
														: `No application matches "${filter()}"`}
												</text>
											),
										}
									: {})}
								header={
									notice() ? (
										// Three wrapped rows in the content column (a fixed row is cut at
										// the dialog edge) so the reason and the way out of it are readable
										// even beside the summary table.
										<box
											style={{
												width: "100%",
												height: 3,
												flexShrink: 0,
												overflow: "hidden",
											}}
										>
											<text fg={uiColors.warning} wrapMode="word">
												{notice()}
											</text>
										</box>
									) : undefined
								}
								helpSections={false}
								help={
									filtering()
										? [
												{ key: "Type", action: "Filter query" },
												{ key: "/", action: "Literal /" },
												{ key: "Enter", action: "Done filtering" },
												{ key: "Esc", action: "Dismiss filter" },
											]
										: [
												{ key: "j/k", action: "Navigate" },
												{ key: "/", action: "Filter" },
												{ key: "Enter", action: "Select" },
												{ key: "Esc", action: "Back" },
											]
								}
								renderItem={(item, isActive) => {
									const active = isActive;
									// A stage entry carries the ident it submits and the diagnostic that
									// keeps a refused file out of the allow-list, so it renders its own
									// two lines: what the stage is, and how it is reached.
									if (typeof item !== "string" && item.kind === "stage")
										return (
											<box
												width="100%"
												flexShrink={0}
												flexDirection="column"
												height={2}
												overflow="hidden"
											>
												<text
													height={1}
													flexShrink={0}
													fg={
														item.reason
															? uiColors.textMuted
															: active()
																? uiColors.primary
																: uiColors.textSecondary
													}
												>
													{item.label}
												</text>
												<text
													height={1}
													flexShrink={0}
													fg={
														item.reason ? uiColors.warning : uiColors.textMuted
													}
												>
													{item.detail}
												</text>
											</box>
										);
									// A repository entry carries the path it submits, so it renders its
									// own two lines: what the entry is, and where it points.
									if (typeof item !== "string")
										return (
											<box
												width="100%"
												flexShrink={0}
												flexDirection="column"
												height={2}
												overflow="hidden"
											>
												<text
													height={1}
													flexShrink={0}
													fg={
														active() ? uiColors.primary : uiColors.textSecondary
													}
												>
													{repoEntryLabel(item)}
												</text>
												<text height={1} flexShrink={0} fg={uiColors.textMuted}>
													{repoEntryDetail(item)}
												</text>
											</box>
										);
									if (field() === "app") {
										// The configured *name* is what the rest of the TUI shows for
										// this application; the ident stays the submitted value.
										const project = configuredProjects().find(
											(candidate) => candidate.ident === item,
										);
										return (
											<box
												width="100%"
												flexShrink={0}
												flexDirection="column"
												height={2}
												overflow="hidden"
											>
												<text
													height={1}
													flexShrink={0}
													fg={
														active() ? uiColors.primary : uiColors.textSecondary
													}
												>
													{project?.name && project.name !== ""
														? project.name
														: item}
												</text>
												<text height={1} flexShrink={0} fg={uiColors.textMuted}>
													{item}
												</text>
											</box>
										);
									}
									if (field() !== "workflowType")
										return (
											<text
												fg={
													active() ? uiColors.primary : uiColors.textSecondary
												}
											>
												{item}
											</text>
										);
									const workflow = workflowTypeEntry(item);
									return (
										<box
											width="100%"
											flexShrink={0}
											flexDirection="column"
											height={2}
											overflow="hidden"
										>
											<text
												height={1}
												flexShrink={0}
												fg={
													active() ? uiColors.primary : uiColors.textSecondary
												}
											>
												{workflow?.label ?? item}
											</text>
											<text height={1} flexShrink={0} fg={uiColors.textMuted}>
												{workflow?.description ?? ""}
											</text>
										</box>
									);
								}}
							/>
						</Show>
					}
				>
					<GenericModal
						dismissKind="new-workflow"
						title="Confirm workflow"
						summary={summary()}
						step={step()}
						total={totalSteps()}
						helpSections={false}
						help={workflowLaunchKeybindCatalog()[0]?.keybinds.filter((entry) =>
							["j/k", "Enter", "Esc"].includes(entry.key),
						)}
					>
						<box flexDirection="column" gap={1}>
							<Show when={values().stage}>
								{(stage) => <text>{stageSummary(stage())}</text>}
							</Show>
							<Show when={!canSubmit()}>
								<text fg={uiColors.textMuted}>
									Still required:{" "}
									{labelFor(fields()[Math.max(0, firstMissingStep())])}
								</text>
							</Show>
							<text>
								Clarification Home (review and login approvals stay separate)
							</text>
							<text fg={!attachHome() ? uiColors.primary : uiColors.textMuted}>
								{!attachHome() ? "› " : "  "}Leave unassigned · attach later
								from the workflow dashboard
							</text>
							<text fg={attachHome() ? uiColors.primary : uiColors.textMuted}>
								{attachHome() ? "› " : "  "}Attach selected shell Home ·
								explicit clarification custody
							</text>
						</box>
					</GenericModal>
				</Show>
			</Show>
		</>
	);
}
