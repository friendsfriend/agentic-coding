import { actionRunDisplayLabel } from "@devenv/types";
import {
	Badge,
	formatProfileLabel,
	GenericModal,
	type Highlight,
	highlightColor,
	PanelBox,
	ScrollableContent,
	statusAnimationIntentForText,
	statusAnimationModel,
	uiColors,
} from "@devenv/ui";
/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import {
	createEffect,
	createMemo,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type {
	ActionRunStore,
	ActionTreeNode,
} from "../stores/action-run-store";

export function actionModalHelpText(focusedPanel: 0 | 1) {
	return focusedPanel === 0
		? [
				{ key: "J/K", action: "Panel" },
				{ key: "j/k", action: "Scroll/select" },
				{ key: "n/p", action: "Action" },
				{ key: "Enter", action: "Collapse" },
				{ key: "y", action: "Copy subtree" },
				{ key: "g/G", action: "Top/bottom" },
				{ key: "Esc", action: "Close" },
			]
		: [
				{ key: "J/K", action: "Panel" },
				{ key: "j/k", action: "Scroll" },
				{ key: "d/u", action: "Half page" },
				{ key: "g/G", action: "Top/bottom" },
				{ key: "Esc", action: "Close" },
			];
}

export function actionNodeAnimationEnabled(
	node: ActionTreeNode,
	collapsed: boolean,
): boolean {
	return node.kind !== "loadOlder" && (!node.hasChildren || collapsed);
}

export function actionNodeStep(node: ActionTreeNode | null | undefined) {
	if (node?.kind === "step") return node.step;
	if (node?.kind !== "action") return undefined;
	const steps = node.run.steps;
	if (steps.length === 1) return steps[0];
	// Prefer the first step that actually has commands attached.
	// Composite root steps never hold commands themselves, so skip
	// to the first child with a command to show real log content.
	const withCommands = steps.find((s) => s.commands && s.commands.length > 0);
	if (withCommands) return withCommands;
	// Fallback: start-application root or first top-level step.
	return (
		steps.find(
			(step) => !step.parentId && /^Start application: /.test(step.label),
		) ?? steps[0]
	);
}

export function ActionRunModal(props: {
	store: ActionRunStore;
	onClose: () => void;
}) {
	const icon = (status: string) =>
		status === "completed"
			? "✓"
			: status === "failed" || status === "canceled"
				? "✗"
				: status === "active"
					? "…"
					: "○";
	const statusHighlight = (status: string): Highlight =>
		status === "completed"
			? "positive"
			: status === "failed" || status === "canceled"
				? "negative"
				: status === "active"
					? "primary"
					: "secondary";
	const statusColor = (status: string) =>
		highlightColor(statusHighlight(status));
	const statusAnimation = (status: string, label: string) =>
		status === "active"
			? statusAnimationModel(statusAnimationIntentForText(label))
			: undefined;
	const transitionHighlight = (status: string, label: string) =>
		statusAnimation(status, label)?.tone ??
		statusAnimation(status, label)?.highlights?.[0] ??
		statusHighlight(status);
	const runLabel = (run: NonNullable<ReturnType<ActionRunStore["run"]>>) =>
		actionRunDisplayLabel(run, formatProfileLabel);
	const helpText = () => actionModalHelpText(props.store.focusedPanel());

	onMount(() => {
		props.store.openModal();
		createEffect(() => {
			void props.store.loadLogsForNode(props.store.selectedNode());
		});
	});
	onCleanup(() => props.store.closeModal());

	// Collect descendant command groups to show in the log panel.
	const logSteps = createMemo(() => {
		const node = props.store.selectedNode();
		if (!node || node.kind === "loadOlder")
			return [] as import("@devenv/types").ActionStep[];
		if (node.kind === "step") return [node.step];
		// Action or composite: show all steps with commands in tree order.
		const allSteps = node.run.steps;
		const childrenOf = new Map<string, string[]>();
		for (const s of allSteps) {
			if (s.parentId) {
				const kids = childrenOf.get(s.parentId) ?? [];
				kids.push(s.id);
				childrenOf.set(s.parentId, kids);
			}
		}
		const byId = new Map(allSteps.map((s) => [s.id, s]));
		const roots = allSteps.filter((s) => !s.parentId).map((s) => s.id);
		const result: import("@devenv/types").ActionStep[] = [];
		const visit = (id: string) => {
			const step = byId.get(id);
			if (!step) return;
			if (step.commands && step.commands.length > 0) result.push(step);
			for (const kid of childrenOf.get(id) ?? []) visit(kid);
		};
		for (const r of roots) visit(r);
		return result;
	});

	const logTitle = () => {
		const node = props.store.selectedNode();
		if (!node) return "waiting";
		return node.kind === "action"
			? runLabel(node.run)
			: node.kind === "step"
				? node.step.label
				: "older actions";
	};

	createEffect(() => {
		const key = props.store.focusedTreeKey();
		const ref = props.store.treeScrollBoxRef;
		if (key && ref) ref.scrollChildIntoView(`action-node-${key}`);
	});

	return (
		<GenericModal
			hideHeader
			title={props.store.run()?.title ?? "Action"}
			helpText={helpText()}
			widthPercent={0.9}
			heightPercent={0.9}
			onBackdropClick={props.onClose}
		>
			<box
				backgroundColor={uiColors.bgMantle}
				style={{
					width: "100%",
					height: "100%",
					flexDirection: "column",
					minHeight: 0,
				}}
			>
				<box
					backgroundColor={uiColors.bgBase}
					style={{
						width: "100%",
						flexGrow: 1,
						flexDirection: "row",
						minHeight: 0,
					}}
				>
					<box
						backgroundColor={uiColors.bgBase}
						style={{ width: "38%", height: "100%", flexDirection: "column" }}
					>
						<PanelBox title="Steps" active={props.store.focusedPanel() === 0}>
							<ScrollableContent
								axes={["y"]}
								keyboardAxes={["y"]}
								viewportCulling
								style={{ width: "100%", flexGrow: 1, minHeight: 0 }}
								onScrollBoxReady={(ref) => {
									props.store.treeScrollBoxRef = ref;
								}}
							>
								<For each={props.store.visibleNodes()}>
									{(node) => {
										const activeSelection = () =>
											node.key === props.store.focusedTreeKey() &&
											props.store.focusedPanel() === 0;
										const status = () =>
											node.kind === "action"
												? node.run.status
												: node.kind === "step"
													? node.step.status
													: "pending";
										const collapsed = () =>
											node.kind === "action"
												? node.run.collapsed
												: node.kind === "step"
													? node.step.collapsed
													: false;
										const animationEnabled = () =>
											actionNodeAnimationEnabled(node, collapsed() ?? false);
										const label = () => {
											if (node.kind === "action") return runLabel(node.run);
											if (node.kind !== "step")
												return "Load actions from last 24 hours";
											const prefix = node.step.sharedReference ? "↳ " : "";
											const suffix =
												node.step.outcome === "already-running"
													? " (already running)"
													: node.step.sharedReference
														? " (shared)"
														: "";
											return `${prefix}${node.step.label}${suffix}`;
										};
										const rowLabel = () =>
											node.kind === "loadOlder"
												? `+ ${label()}`
												: `${icon(status()) || " "} ${label()}`;
										const animation = () =>
											animationEnabled()
												? statusAnimation(status(), label())
												: undefined;
										const nodeHighlight = () =>
											node.kind === "loadOlder"
												? ("secondary" as const)
												: (animation()?.tone ??
													animation()?.highlights?.[0] ??
													statusHighlight(status()));
										return (
											<box
												id={`action-node-${node.key}`}
												onMouseUp={() => {
													props.store.focusTreeNode(node);
													props.store.setFocusedPanel(0);
												}}
												backgroundColor={
													activeSelection() ? uiColors.bgSurface0 : undefined
												}
												style={{
													width: "100%",
													height: 1,
													flexDirection: "row",
												}}
											>
												<box
													backgroundColor={
														activeSelection()
															? highlightColor("highlight")
															: undefined
													}
													style={{ width: 1, height: "100%", flexShrink: 0 }}
												/>
												<box
													style={{
														flexGrow: 1,
														flexDirection: "row",
														paddingRight: 1,
														minWidth: 0,
													}}
												>
													<text fg={statusColor(status())}>
														{node.kind === "loadOlder"
															? "  "
															: `${"  ".repeat(node.depth)}${node.hasChildren ? (collapsed() ? "▸" : "▾") : " "} `}
													</text>
													<Badge
														text={rowLabel()}
														appearance="text"
														highlight={nodeHighlight()}
														animatedTone={animation()?.tone}
														animatedHighlights={animation()?.highlights}
														attributes={
															status() === "active" && animationEnabled()
																? TextAttributes.BOLD
																: 0
														}
														transitionKey={`action-tree:${node.key}`}
													/>
												</box>
											</box>
										);
									}}
								</For>
							</ScrollableContent>
						</PanelBox>
					</box>
					<box
						backgroundColor={uiColors.bgBase}
						style={{ width: "62%", height: "100%", flexDirection: "column" }}
					>
						<box
							onMouseUp={() => props.store.setFocusedPanel(1)}
							style={{
								width: "100%",
								height: "100%",
								flexDirection: "column",
								minHeight: 0,
							}}
						>
							<PanelBox
								title={`Log: ${logTitle()}`}
								active={props.store.focusedPanel() === 1}
							>
								<ScrollableContent
									axes={["x", "y"]}
									keyboardAxes={["x"]}
									stickyScroll
									stickyStart="bottom"
									viewportCulling
									style={{ width: "100%", flexGrow: 1, minHeight: 0 }}
									onScrollBoxReady={(ref) => {
										props.store.logScrollBoxRef = ref;
									}}
								>
									<box
										style={{
											flexDirection: "column",
											paddingLeft: 1,
											paddingRight: 1,
										}}
									>
										<For each={logSteps()}>
											{(step, i) => (
												<box style={{ flexDirection: "column" }}>
													<Show when={i() > 0}>
														<box style={{ height: 1 }} />
													</Show>
													<box style={{ flexDirection: "row" }}>
														<text> </text>
														<Badge
															text={
																step.outcome === "already-running"
																	? `○ ${step.label} (already running)`
																	: `${icon(step.status) || " "} ${step.label}`
															}
															appearance="text"
															highlight={transitionHighlight(
																step.status,
																step.label,
															)}
															animatedTone={
																statusAnimation(step.status, step.label)?.tone
															}
															animatedHighlights={
																statusAnimation(step.status, step.label)
																	?.highlights
															}
															attributes={0}
															transitionKey={`action-log-step:${step.id}`}
														/>
													</box>
													<For each={step.commands}>
														{(command) => (
															<box style={{ flexDirection: "column" }}>
																<text
																	fg={uiColors.textPrimary}
																>{`$ ${command.command}`}</text>
																<For
																	each={command.stdout
																		.replace(/\s+$/, "")
																		.split("\n")
																		.filter(Boolean)}
																>
																	{(line) => <text>{line}</text>}
																</For>
																<For
																	each={command.stderr
																		.replace(/\s+$/, "")
																		.split("\n")
																		.filter(Boolean)}
																>
																	{(line) => (
																		<text fg={highlightColor("negative")}>
																			{line}
																		</text>
																	)}
																</For>
																<Show when={command.status === "completed"}>
																	<text
																		fg={highlightColor("positive")}
																	>{`[exit ${command.exitCode ?? 0}]`}</text>
																</Show>
																<Show when={command.status === "failed"}>
																	<text
																		fg={highlightColor("negative")}
																	>{`[exit ${command.exitCode ?? "failed"}]${command.error ? ` ${command.error}` : ""}`}</text>
																</Show>
															</box>
														)}
													</For>
												</box>
											)}
										</For>
									</box>
								</ScrollableContent>
							</PanelBox>
						</box>
					</box>
				</box>
				<box
					backgroundColor={uiColors.bgMantle}
					style={{ width: "100%", height: 1, flexShrink: 0 }}
				/>
			</box>
		</GenericModal>
	);
}
