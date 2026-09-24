/** @jsxImportSource @opentui/solid */

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
import { gatewayOrUndefined } from "../../data/index.ts";
import { discoverChanges } from "../../data/workflow.ts";
import type { WorkflowLaunchContext, WorkflowLaunchInput } from "../launch.ts";
import { workflowTypesForContext } from "../launch.ts";
import {
	discoverChangesLocal,
	PRESET_CONFIG_DEFAULTS,
	PUBLIC_WORKFLOW_CATALOG,
} from "../live.ts";

/** Types whose task is a required field; everything else (openspec-apply)
 * selects an existing change instead. */
const TASK_TYPES = new Set([
	"openspec-full",
	"quick",
	"openspec-fusion-full",
	"openspec-propose",
	"openspec-fusion-propose",
	"wiki",
	"research",
	"no-openspec",
]);

export type NewWorkflowInput = WorkflowLaunchInput;

/**
 * Contextual creation form (launch-workflows-from-project-and-wiki-pages,
 * task 1.2). The launch context is immutable and comes from the page the user
 * started on, so the form has no repository, custom-path or standalone-target
 * selector at all: it keeps the workflow type, preset, ticket, workflow-id,
 * task and checkout options. Supported types come from the workflow registry
 * catalog; the context only restricts the permitted target set.
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
	const [selected, setSelected] = createSignal(0);
	const [filter, setFilter] = createSignal("");
	const [filtering, setFiltering] = createSignal(false);
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
			props.context.kind === "independent" ? "research" : "openspec-full",
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
		task: "Task required for wiki, research, and no OpenSpec",
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

	const listStep = () => {
		const f = field();
		return (
			f === "workflowType" ||
			f === "preset" ||
			(f === "workflowId" && values().workflowType === "openspec-apply") ||
			f === "mode"
		);
	};

	const confirmStep = () => step() === fields().length;
	const canSubmit = () =>
		!["wiki", "research", "quick", "no-openspec"].includes(
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
	const back = () => {
		if (step() === 0) props.onCancel();
		else {
			blurEditors();
			setStep((i) => Math.max(0, i - 1));
			setSelected(0);
			setFilter("");
			setFiltering(false);
		}
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
		setSelected(0);
		setFilter("");
		setFiltering(false);
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
			// Esc while filtering first dismisses the filter, keeping the wizard
			// step; a second Esc navigates back.
			if (filtering()) {
				setFiltering(false);
				return true;
			}
			back();
			return true;
		}
		if (confirmStep()) {
			if (name === "return" || name === "enter") {
				if (!canSubmit()) {
					setStep(fields().indexOf("task"));
					setSelected(0);
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
		const items = choices();
		// While a filter is active, '/' is a literal query character; only start
		// filtering when not already filtering.
		if (name === "/" && !filtering()) {
			// Resume editing any retained query rather than wiping it.
			setFiltering(true);
			setSelected(0);
			return true;
		}
		if (filtering()) {
			if (name === "backspace") {
				setFilter((value) => value.slice(0, -1));
				setSelected(0);
				return true;
			}
			if (name === "return" || name === "enter") {
				setFiltering(false);
				return true;
			}
			if (key.sequence.length === 1 && key.sequence >= " ") {
				setFilter((value) => value + key.sequence);
				setSelected(0);
				return true;
			}
		}
		if (name === "j" || name === "down") {
			setSelected((i) => Math.min(i + 1, items.length - 1));
			return true;
		}
		if (name === "k" || name === "up") {
			setSelected((i) => Math.max(i - 1, 0));
			return true;
		}
		if (name === "d") {
			setSelected((i) => Math.min(i + 8, items.length - 1));
			return true;
		}
		if (name === "u") {
			setSelected((i) => Math.max(i - 8, 0));
			return true;
		}
		if (name === "return" || name === "enter") {
			const choice = items[selected()];
			if (choice) next(choice);
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
															if (event.name.toLowerCase() === "escape") back();
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
								items={choices()}
								selectedIndex={selected()}
								step={step()}
								total={totalSteps()}
								filterActive={filtering() || filter().length > 0}
								filterQuery={filter()}
								itemHeight={field() === "workflowType" ? 2 : 1}
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
