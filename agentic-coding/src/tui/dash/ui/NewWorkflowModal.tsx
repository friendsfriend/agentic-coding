/** @jsxImportSource @opentui/solid */

import { basename } from "node:path";
import type {
	InputRenderable,
	KeyEvent,
	TextareaRenderable,
} from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import {
	focusSoon,
	GenericModal,
	ListViewModal,
	ProgressModal,
	uiColors,
} from "@ui";
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
	discoverChanges,
	discoverProjects,
	type ProjectOption,
} from "../../data/workflow.ts";
import type { WorkflowLaunchContext, WorkflowLaunchInput } from "../launch.ts";
import { workflowTypesForContext } from "../launch.ts";
import {
	discoverChangesLocal,
	PRESET_CONFIG_DEFAULTS,
	PUBLIC_WORKFLOW_CATALOG,
} from "../live.ts";

/** Task-driven registry types: the wizard renders and submits the task step for
 * these, and `openspec` runs the classifier-routed plan-first graph. Every
 * other type (`openspec-apply`) selects an existing OpenSpec change instead
 * and keeps its task-free field set. The task itself stays optional except
 * where `canSubmit` requires it (wiki, research, quick, no-openspec). */
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

/** One entry of the current step: the plain value every other step submits, or
 * a repository entry the repository step resolves itself. */
type StepEntry = string | RepoEntry;

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
	return typeof item === "string" ? `value:${item}` : repoEntryKey(item);
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
	/** Why the entry the cursor is on cannot be started. Transient: the next
	 * cursor move or step change drops it. */
	const [refusal, setRefusal] = createSignal<string | undefined>();
	const notice = () => refusal() ?? catalogNotice();
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

	// Configured applications/libraries come from the same catalog the
	// environment pages read, over the dashboard port. Without a port the picker
	// still offers the directory this form was opened with and a custom path;
	// this effect re-runs once the composition root installs the gateway after
	// first paint.
	createEffect(() => {
		if (!pathTarget() || !gatewayReady()) {
			setConfiguredProjects([]);
			setCatalogNotice(undefined);
			return;
		}
		const controller = new AbortController();
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
						"Configured projects could not be read: the read was superseded by a configuration change. Enter a custom path or use the current directory.",
					);
					return;
				}
				setConfiguredProjects(projects);
				setCatalogNotice(undefined);
			} catch (error) {
				if (controller.signal.aborted) return;
				setCatalogNotice(
					`Configured projects could not be read: ${
						error instanceof Error ? error.message : String(error)
					}. Enter a custom path or use the current directory.`,
				);
			}
		})();
		onCleanup(() => controller.abort());
	});

	const isProposal = (type: string) =>
		type === "openspec-propose" || type === "openspec-fusion-propose";
	const isRepositoryBacked = (type: string) =>
		isProposal(type) || type === "wiki";
	/** Context-restricted type set; `undefined` means the whole registry. */
	const allowedTypes = () => workflowTypesForContext(props.context);
	const workflowTypeChoices = () => {
		const allowed = allowedTypes();
		return (
			PUBLIC_WORKFLOW_CATALOG.map((item) => item.alias ?? item.id) as string[]
		).filter((choice) => !allowed || allowed.includes(choice));
	};
	const fields = (): (keyof WorkflowLaunchInput)[] => {
		const head: (keyof WorkflowLaunchInput)[] = [
			...(pathTarget() ? (["repo"] as const) : []),
			"workflowType",
			"preset",
			"ticket",
			"workflowId",
		];
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
		ticket: "Ticket identifier optional",
		workflowId: "Workflow ID",
		task: "Task required for wiki, research, no OpenSpec, and solo",
		mode: "Checkout mode",
	};

	const workflowTypeEntry = (choice: string) =>
		PUBLIC_WORKFLOW_CATALOG.find(
			(item) => item.id === choice || item.alias === choice,
		);

	const choices = (): string[] => {
		const f = field();
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

	/** The entries of the current step. */
	const entries = (): StepEntry[] =>
		field() === "repo" ? repoEntries() : choices();

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
		return index >= 0 ? index : 0;
	};

	const listStep = () => {
		const f = field();
		// The repository step is the picker until the user asks for a custom path.
		if (f === "repo") return !editingRepoPath();
		return (
			f === "workflowType" ||
			f === "preset" ||
			(f === "workflowId" && values().workflowType === "openspec-apply") ||
			f === "mode"
		);
	};

	const confirmStep = () => step() === fields().length;
	const canSubmit = () =>
		!["wiki", "research", "quick", "no-openspec", "solo"].includes(
			values().workflowType,
		) || Boolean(values().task?.trim());
	const totalSteps = () => fields().length + 1;
	const field = () => fields()[step()];
	const targetSummary = () =>
		props.context.kind === "project"
			? { label: "Project", value: props.context.name }
			: props.context.kind === "path"
				? { label: "Repository", value: values().repo || "—" }
				: { label: "Target", value: "Independent (no repository)" };
	const summary = () => [
		targetSummary(),
		...fields().map((key) => ({
			label: fieldLabels[key],
			value: values()[key] || "—",
		})),
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
			await props.onComplete(values());
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
			if (name === "return" || name === "enter") {
				if (!canSubmit()) {
					setStep(fields().indexOf("task"));
					setCursor(undefined);
					setFilter("");
					setFiltering(false);
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
									fieldLabel={fieldLabels[field()]}
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
								fieldLabel={fieldLabels[field()]}
								summary={summary()}
								items={entries()}
								selectedIndex={selectedIndex()}
								step={step()}
								total={totalSteps()}
								filterPlaceholder="filter"
								filterActive={filtering()}
								filterQuery={filter()}
								itemHeight={
									field() === "workflowType" || field() === "repo" ? 2 : 1
								}
								reservedHeight={3}
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
						title="Confirm workflow"
						summary={summary()}
						summaryOnly
						step={step()}
						total={totalSteps()}
						helpSections={false}
						help={[
							{ key: "Enter", action: "Create workflow" },
							{ key: "Esc", action: "Back" },
						]}
					>
						<box />
					</GenericModal>
				</Show>
			</Show>
		</>
	);
}
