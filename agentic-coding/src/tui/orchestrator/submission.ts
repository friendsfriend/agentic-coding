import type { AgentSessionBlock } from "../dash/agent-session.ts";

/** The effective selection read from the orchestrator conversation's `pi.agent`
 * document, including defaults applied when the conversation was opened. */
export interface OrchestratorSelection {
	readonly model?: string;
	readonly thinking?: string;
}

export type OrchestratorSelectionGate =
	| { readonly ready: true }
	| {
			readonly ready: false;
			readonly missing: readonly ("model" | "thinking")[];
			readonly message: string;
	  };

/** Missing model/thinking selections are a UI-only gate for the Home
 * Orchestrator. Workflow runs have their own model presets and never use it. */
export function orchestratorSelectionGate(
	selection: OrchestratorSelection,
): OrchestratorSelectionGate {
	const missing: ("model" | "thinking")[] = [];
	if (!selection.model?.trim()) missing.push("model");
	if (!selection.thinking?.trim()) missing.push("thinking");
	if (missing.length === 0) return { ready: true };
	if (missing.length === 2)
		return {
			ready: false,
			missing,
			message:
				"No model and no thinking level are selected for the orchestrator. Select a model with /model and a thinking level with /thinking, then send your message again.",
		};
	if (missing[0] === "model")
		return {
			ready: false,
			missing,
			message:
				"No model selected for the orchestrator. Select one with /model, then send your message again.",
		};
	return {
		ready: false,
		missing,
		message:
			"No thinking level selected for the orchestrator. Select one with /thinking, then send your message again.",
	};
}

/** Refresh or clear only the local gate error as session selections change.
 * The blocked user message remains in the transcript after the gate clears. */
export function refreshOrchestratorGateBlocks(
	blocks: readonly AgentSessionBlock[],
	selection: OrchestratorSelection,
): AgentSessionBlock[] {
	const gate = orchestratorSelectionGate(selection);
	return blocks.flatMap((block) => {
		if (
			block.kind !== "error" ||
			!block.id.startsWith("local:orchestrator-model-gate:")
		)
			return [block];
		if (gate.ready) return [];
		return [{ ...block, text: gate.message }];
	});
}

export interface OrchestratorSubmitHandlers {
	readonly onSubmit: (text: string) => void;
	readonly onBlocked: (blocks: readonly AgentSessionBlock[]) => void;
}

/** Submit an ordinary orchestrator prompt only when its conversation has an
 * effective model and thinking level. A blocked prompt is retained as a user
 * row followed by the same red error row used by other transcript failures. */
export function guardOrchestratorSubmit(
	text: string,
	selection: OrchestratorSelection,
	blockId: string,
	handlers: OrchestratorSubmitHandlers,
): boolean {
	const gate = orchestratorSelectionGate(selection);
	if (gate.ready) {
		handlers.onSubmit(text);
		return true;
	}
	handlers.onBlocked([
		{
			id: `${blockId}:message`,
			kind: "user",
			text,
			tone: "accent",
		},
		{
			id: `${blockId}:error`,
			kind: "error",
			text: gate.message,
			tone: "error",
		},
	]);
	return false;
}
