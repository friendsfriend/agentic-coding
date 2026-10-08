/** @jsxImportSource @opentui/solid */
/** Workflow graph dialog (custom-workflow-presentation): the pinned
 * definition's steps in walk order with their outcome edges, the current step
 * marked, and the routing/triage/gate steps the engine inserts dimmed so the
 * developer reads the logical graph first. The graph itself is projected by the
 * read model (`workflow/runtime/view.ts`); this dialog only lays it out, and
 * the row projection below is pure so a test can pin the order without a
 * terminal. */
import { TextAttributes } from "@opentui/core";
import { GenericModal, uiColors } from "@ui";
import { createMemo, For, Show } from "solid-js";
import {
	decodeWorkflowDefinitionGraph,
	type WorkflowDefinitionGraph,
	type WorkflowDefinitionOrigin,
} from "../../../contracts/workflow.ts";

/** The definition fields the dialog titles itself with (the state's pinned
 * definition, narrowed to what the title renders). */
export interface WorkflowGraphDefinition {
	readonly label: string;
	readonly version: number;
}

/** One rendered line of the dialog: a step row, or one of its outcome edges. */
export type WorkflowGraphRow =
	| {
			readonly kind: "step";
			readonly id: string;
			readonly label: string;
			readonly actor: string;
			readonly inserted: boolean;
			readonly current: boolean;
	  }
	| {
			readonly kind: "edge";
			readonly from: string;
			readonly outcome: string;
			readonly to: string;
			readonly toLabel: string;
			readonly maxAttempts?: number;
			/** Dimmed with its owning step, so an inserted step's edges read as
			 * machinery too. */
			readonly inserted: boolean;
	  };

/** The dialog's lines in graph order: every step from the projected walk,
 * immediately followed by the edges that leave it. Edges are listed under their
 * source because that is the order the graph is read in: a step's transitions
 * sit under the step that owns them, and its inbound edges are visible as the
 * outcomes of the steps that lead to it. */
export function workflowGraphRows(
	graph: WorkflowDefinitionGraph,
	currentStep: string,
): WorkflowGraphRow[] {
	const labels = new Map(graph.steps.map((step) => [step.id, step.label]));
	const outbound = new Map<
		string,
		WorkflowDefinitionGraph["edges"][number][]
	>();
	for (const edge of graph.edges) {
		const edges = outbound.get(edge.from);
		if (edges) edges.push(edge);
		else outbound.set(edge.from, [edge]);
	}
	return graph.steps.flatMap((step) => [
		{
			kind: "step" as const,
			id: step.id,
			label: step.label,
			actor: step.actor,
			inserted: step.inserted,
			current: step.id === currentStep,
		},
		...(outbound.get(step.id) ?? []).map((edge) => ({
			kind: "edge" as const,
			from: step.id,
			outcome: edge.outcome,
			to: edge.to,
			toLabel: labels.get(edge.to) ?? edge.to,
			...(edge.loop ? { maxAttempts: edge.loop.maxAttempts } : {}),
			inserted: step.inserted,
		})),
	]);
}

/** The compact dialog title keeps the custom/built-in origin visible even
 * when the definition label is long; the label and version render in the body. */
export function workflowGraphTitle(
	origin: WorkflowDefinitionOrigin | undefined,
): string {
	const source =
		origin?.kind === "custom"
			? `custom · ${origin.origin}`
			: origin?.kind === "built-in"
				? "built-in"
				: "origin unavailable";
	return `Workflow graph · ${source}`;
}

export function WorkflowGraphModal(props: {
	readonly definition: WorkflowGraphDefinition;
	readonly origin?: WorkflowDefinitionOrigin;
	readonly graph?: WorkflowDefinitionGraph;
	readonly currentStep: string;
	readonly offset: number;
	readonly lines: number;
}) {
	// The aggregate dashboard observation is decoded as Schema.Unknown; validate
	// the one graph this dialog consumes before projecting rows, so malformed or
	// oversized presentation data degrades to the explicit empty state.
	const safeGraph = createMemo(() =>
		props.graph ? decodeWorkflowDefinitionGraph(props.graph) : undefined,
	);
	const rows = () => {
		const graph = safeGraph();
		return graph ? workflowGraphRows(graph, props.currentStep) : [];
	};
	// The window is clamped here as well as in the key handler: a refresh that
	// shrinks the graph must not leave the dialog scrolled past its own end.
	const start = () =>
		Math.max(
			0,
			Math.min(props.offset, rows().length - Math.max(1, props.lines)),
		);
	const visible = () =>
		rows().slice(start(), start() + Math.max(1, props.lines));
	return (
		<GenericModal
			title={workflowGraphTitle(props.origin)}
			widthPercent={0.72}
			heightPercent={0.78}
			help={[
				{ key: "j/k", action: "Scroll" },
				{ key: "Esc", action: "Close" },
			]}
		>
			<box width="100%" flexDirection="column" overflow="hidden">
				<box width="100%" height={1} flexShrink={0} overflow="hidden">
					<text
						fg={uiColors.textSecondary}
						flexGrow={1}
						minWidth={0}
						wrapMode="none"
						truncate
					>
						{`${props.definition.label} · v${props.definition.version}`}
					</text>
				</box>
				<Show
					when={rows().length > 0}
					fallback={
						<text fg={uiColors.textMuted} flexShrink={0}>
							No compiled graph is available for this definition.
						</text>
					}
				>
					<For each={visible()}>
						{(row) =>
							row.kind === "step" ? (
								<box flexDirection="row" flexShrink={0}>
									<text
										fg={row.current ? uiColors.primary : uiColors.textMuted}
										attributes={row.current ? TextAttributes.BOLD : 0}
										flexShrink={0}
									>
										{row.current ? "▸ " : "  "}
									</text>
									<text
										fg={
											row.inserted
												? uiColors.textMuted
												: row.current
													? uiColors.primary
													: uiColors.textPrimary
										}
										attributes={row.current ? TextAttributes.BOLD : 0}
										flexGrow={1}
										minWidth={0}
										wrapMode="none"
										truncate
									>
										{`${row.label} (${row.id} · ${row.actor})`}
									</text>
								</box>
							) : (
								<box flexDirection="row" flexShrink={0}>
									<text fg={uiColors.textMuted} flexShrink={0}>
										{"    "}
									</text>
									<text
										fg={
											row.inserted ? uiColors.textMuted : uiColors.textPrimary
										}
										flexGrow={1}
										minWidth={0}
										wrapMode="none"
										truncate
									>
										{`${row.outcome} → ${row.toLabel}${
											row.maxAttempts === undefined
												? ""
												: ` ↻${row.maxAttempts}`
										}`}
									</text>
								</box>
							)
						}
					</For>
				</Show>
			</box>
		</GenericModal>
	);
}
