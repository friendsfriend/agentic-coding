import { describe, expect, test } from "bun:test";
import type { AgentSessionBlock } from "../../../src/tui/dash/agent-session.ts";
import {
	guardOrchestratorSubmit,
	orchestratorSelectionGate,
	refreshOrchestratorGateBlocks,
} from "../../../src/tui/orchestrator/submission.ts";

const ready = { model: "provider/model", thinking: "off" };

describe("the Home Orchestrator model gate", () => {
	test("allows a message when both effective selections exist", () => {
		const submitted: string[] = [];
		let blocked = false;
		const result = guardOrchestratorSubmit("continue", ready, "local:gate:1", {
			onSubmit: (text) => submitted.push(text),
			onBlocked: () => {
				blocked = true;
			},
		});
		expect(result).toBe(true);
		expect(submitted).toEqual(["continue"]);
		expect(blocked).toBe(false);
	});

	test("blocks a message visibly when both model and thinking are missing", () => {
		const submitted: string[] = [];
		let blocks: readonly AgentSessionBlock[] = [];
		const result = guardOrchestratorSubmit(
			"please fix this",
			{},
			"local:orchestrator-model-gate:2",
			{
				onSubmit: (text) => submitted.push(text),
				onBlocked: (next) => {
					blocks = next;
				},
			},
		);
		expect(result).toBe(false);
		expect(submitted).toEqual([]);
		expect(blocks).toEqual([
			{
				id: "local:orchestrator-model-gate:2:message",
				kind: "user",
				text: "please fix this",
				tone: "accent",
			},
			{
				id: "local:orchestrator-model-gate:2:error",
				kind: "error",
				text: expect.stringContaining("No model and no thinking level"),
				tone: "error",
			},
		]);
		expect(blocks[1]?.text).toContain("/model");
		expect(blocks[1]?.text).toContain("/thinking");
		expect(blocks[1]?.text).toContain("send your message again");
		expect(refreshOrchestratorGateBlocks(blocks, ready)).toEqual([blocks[0]]);
	});

	test("keeps the blocked message and updates the error as selections change", () => {
		const blocks = [
			{
				id: "local:orchestrator-model-gate:1:message",
				kind: "user",
				text: "retry me",
				tone: "accent",
			},
			{
				id: "local:orchestrator-model-gate:1:error",
				kind: "error",
				text: "No model and no thinking level are selected for the orchestrator.",
				tone: "error",
			},
		] satisfies AgentSessionBlock[];
		const partial = refreshOrchestratorGateBlocks(blocks, {
			model: "provider/model",
		});
		expect(partial[0]?.text).toBe("retry me");
		expect(partial[1]?.text).toContain("No thinking level selected");
		expect(refreshOrchestratorGateBlocks(partial, ready)).toEqual([blocks[0]]);
	});

	test("names only the model when thinking exists", () => {
		const gate = orchestratorSelectionGate({ thinking: "high" });
		expect(gate).toMatchObject({ ready: false, missing: ["model"] });
		if (!gate.ready) {
			expect(gate.message).toContain("No model selected");
			expect(gate.message).toContain("/model");
			expect(gate.message).not.toContain("/thinking");
		}
	});

	test("names only the thinking level when a model exists", () => {
		const gate = orchestratorSelectionGate({ model: "provider/model" });
		expect(gate).toMatchObject({ ready: false, missing: ["thinking"] });
		if (!gate.ready) {
			expect(gate.message).toContain("No thinking level selected");
			expect(gate.message).toContain("/thinking");
			expect(gate.message).not.toContain("/model");
		}
	});

	test("treats whitespace-only settings as missing and clears for valid defaults", () => {
		expect(
			orchestratorSelectionGate({ model: "  ", thinking: "off" }),
		).toMatchObject({
			ready: false,
			missing: ["model"],
		});
		expect(orchestratorSelectionGate(ready)).toEqual({ ready: true });
	});
});
