/** @jsxImportSource @opentui/solid */

import type { KeyEvent, TextareaRenderable } from "@opentui/core";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { discoverChanges } from "../data";
import { PRESET_CONFIG_DEFAULTS } from "../engine";
import { uiColors } from "./colors";
import { GenericModal } from "./GenericModal";
import { ListViewModal } from "./ListViewModal";
import { ProgressModal } from "./ProgressModal";

export type NewWorkflowInput = {
	repo: string;
	ticket: string;
	change: string;
	task?: string;
	mode: string;
	workflowType: string;
	preset: string;
};
type Project = { name: string; path: string; openspec: boolean };
export function NewWorkflowModal(props: {
	projects: Project[];
	presets?: string[];
	onCancel: () => void;
	onComplete: (input: NewWorkflowInput) => Promise<void>;
	onKeyReady: (handler: (key: KeyEvent) => boolean) => void;
}) {
	const [step, setStep] = createSignal(0);
	const [creating, setCreating] = createSignal(false);
	const [selected, setSelected] = createSignal(0);
	const [filter, setFilter] = createSignal("");
	const [filtering, setFiltering] = createSignal(false);
	const [values, setValues] = createSignal<NewWorkflowInput>({
		repo: "",
		ticket: "",
		change: "",
		mode: "",
		workflowType: "standard",
		preset: PRESET_CONFIG_DEFAULTS,
	});
	const [showCustomRepo, setShowCustomRepo] = createSignal(false);
	let taskInput: TextareaRenderable | undefined;
	const projects = () =>
		props.projects.filter((project) =>
			project.name.toLowerCase().includes(filter().toLowerCase()),
		);

	const fields = (): (keyof NewWorkflowInput)[] => {
		const base: (keyof NewWorkflowInput)[] = [
			"repo",
			"workflowType",
			"preset",
			"ticket",
			"change",
			"mode",
		];
		if (
			values().workflowType === "standard" ||
			values().workflowType === "quick" ||
			values().workflowType === "plan-fusion"
		) {
			return [
				"repo",
				"workflowType",
				"preset",
				"ticket",
				"change",
				"task",
				"mode",
			];
		}
		return base;
	};

	const fieldLabels: Record<string, string> = {
		repo: "Repository",
		workflowType: "Workflow type",
		preset: "Agent preset",
		ticket: "Ticket identifier (optional)",
		change: "Change ID",
		task: "Task",
		mode: "Checkout mode",
	};

	const workflowTypeChoices = [
		"standard",
		"direct-apply",
		"quick",
		"plan-fusion",
	];
	const workflowTypeDisplay: Record<string, string> = {
		standard: "Standard",
		"direct-apply": "Apply",
		quick: "Quick Implementation",
		"plan-fusion": "Plan Fusion",
	};

	const choices = (): string[] => {
		const f = field();
		if (f === "repo")
			return [
				...projects().map((p) => `${p.openspec ? "●" : "○"} ${p.name}`),
				`Current Directory (${process.cwd().split("/").pop()})`,
				"Custom path…",
			];
		if (f === "workflowType")
			return workflowTypeChoices.filter((item) =>
				item.includes(filter().toLowerCase()),
			);
		if (f === "preset")
			return [PRESET_CONFIG_DEFAULTS, ...(props.presets ?? [])].filter((item) =>
				item.toLowerCase().includes(filter().toLowerCase()),
			);
		if (f === "change" && values().workflowType === "direct-apply")
			return discoverChanges(values().repo);
		if (f === "mode")
			return ["worktree", "checkout"].filter((item) =>
				item.includes(filter().toLowerCase()),
			);
		return [];
	};

	const listStep = () => {
		const f = field();
		return (
			f === "repo" ||
			f === "workflowType" ||
			f === "preset" ||
			(f === "change" && values().workflowType === "direct-apply") ||
			f === "mode"
		);
	};

	const confirmStep = () => step() === fields().length;
	const totalSteps = () => fields().length + 1;
	const field = () => fields()[step()];
	const summary = () =>
		fields().map((key) => ({
			label: fieldLabels[key],
			value: values()[key] || "—",
		}));

	const updateCurrent = (value: string) => {
		const key = field();
		if (!key) return;
		setValues((current) => ({ ...current, [key]: value }));
	};
	const back = () => {
		if (step() === 0) props.onCancel();
		else {
			setStep((i) => Math.max(0, i - 1));
			setSelected(0);
			setFilter("");
			setFiltering(false);
		}
	};
	const next = (value: string) => {
		const key = field();
		if (!key) return;
		setValues((current) => ({ ...current, [key]: value }));
		setStep((i) => Math.min(i + 1, fields().length));
		setSelected(0);
		setFilter("");
		setFiltering(false);
	};

	const submit = async () => {
		setCreating(true);
		try {
			await props.onComplete(values());
		} finally {
			setCreating(false);
		}
	};

	const handler = (key: KeyEvent) => {
		if (creating()) return true;
		const name = key.name.toLowerCase();
		if (showCustomRepo()) {
			if (name === "escape") {
				setShowCustomRepo(false);
				return true;
			}
			if (name === "backspace") {
				setValues((v) => ({ ...v, repo: v.repo.slice(0, -1) }));
				return true;
			}
			if (name === "return" || name === "enter") {
				setShowCustomRepo(false);
				setStep(1);
				setSelected(0);
				setFilter("");
				setFiltering(false);
				return true;
			}
			if (key.sequence.length === 1 && key.sequence >= " ") {
				setValues((v) => ({ ...v, repo: v.repo + key.sequence }));
				return true;
			}
			return true;
		}
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
			if (name === "return" || name === "enter") void submit();
			return true;
		}
		if (!listStep()) {
			const keyName = field();
			if (!keyName) return true;
			if (keyName === "task") {
				if ((name === "return" || name === "enter") && key.meta)
					next(values().task || "");
				else taskInput?.handleKeyPress(key);
				return true;
			}
			if (name === "backspace") {
				setValues((current) => ({
					...current,
					[keyName]: (current[keyName] as string)?.slice(0, -1) || "",
				}));
				return true;
			}
			if (name === "return" || name === "enter") {
				next((values()[keyName] as string) || "");
				return true;
			}
			if (key.sequence.length === 1 && key.sequence >= " ") {
				setValues((current) => ({
					...current,
					[keyName]: ((current[keyName] as string) || "") + key.sequence,
				}));
				return true;
			}
			return true;
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
			if (!choice) return true;
			if (step() === 0 && selected() === projects().length) {
				next(process.cwd());
				return true;
			}
			if (step() === 0 && selected() === projects().length + 1) {
				setShowCustomRepo(true);
				return true;
			}
			if (choice)
				next(step() === 0 ? (projects()[selected()]?.path ?? "") : choice);
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
			<Show when={!creating() && showCustomRepo()}>
				<GenericModal
					title="New workflow"
					fieldLabel="Custom repository path"
					summary={summary()}
					step={0}
					total={totalSteps()}
					help={[
						{ key: "Enter", action: "Next" },
						{ key: "Esc", action: "Back" },
					]}
				>
					<input
						focused
						value={values().repo}
						placeholder="/absolute/path/to/repo"
						onInput={(v: string) =>
							setValues((current) => ({ ...current, repo: v }))
						}
						onSubmit={() => {
							setShowCustomRepo(false);
							setStep(1);
							setSelected(0);
							setFilter("");
							setFiltering(false);
						}}
						onKeyDown={(event: KeyEvent) => {
							if (event.name.toLowerCase() === "escape")
								setShowCustomRepo(false);
						}}
						focusedBackgroundColor={uiColors.bgBase}
						focusedTextColor={uiColors.textPrimary}
					/>
				</GenericModal>
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
									fieldLabel={fieldLabels[field()]}
									summary={summary()}
									step={step()}
									total={totalSteps()}
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
											<input
												focused
												value={(values()[field()] as string) || ""}
												placeholder={field() === "ticket" ? "optional" : ""}
												onInput={updateCurrent}
												onSubmit={() =>
													next((values()[field()] as string) || "")
												}
												onKeyDown={(event: KeyEvent) => {
													if (event.name.toLowerCase() === "escape") back();
												}}
												focusedBackgroundColor={uiColors.bgBase}
												focusedTextColor={uiColors.textPrimary}
											/>
										}
									>
										<textarea
											ref={taskInput}
											focused
											width="100%"
											height="100%"
											initialValue={values().task || ""}
											wrapMode="word"
											onContentChange={() =>
												updateCurrent(taskInput?.plainText || "")
											}
											onSubmit={() => next(values().task || "")}
											focusedBackgroundColor={uiColors.bgBase}
											focusedTextColor={uiColors.textPrimary}
										/>
									</Show>
								</GenericModal>
							}
						>
							<ListViewModal
								title="New workflow"
								fieldLabel={fieldLabels[field()]}
								summary={summary()}
								items={choices()}
								selectedIndex={selected()}
								step={step()}
								total={totalSteps()}
								filterActive={filtering() || filter().length > 0}
								filterQuery={filter()}
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
								renderItem={(item, active) => {
									const display =
										field() === "workflowType"
											? workflowTypeDisplay[item] || item
											: item;
									return (
										<text
											fg={active ? uiColors.primary : uiColors.textSecondary}
										>
											{display}
										</text>
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
