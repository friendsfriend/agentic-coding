// slim-agent-prompts: the static first assignment of every agent role stays
// within its family budget, and every registered agent step and role belongs to
// a family. A failure names the step, role, measured bytes and the budget.
import { describe, expect, test } from "bun:test";
import { registerBuiltins } from "../src/workflow/definitions/registerBuiltins.ts";
import { WORKFLOW_STEPS } from "../src/workflow/definitions/steps.ts";
import {
	measureInventory,
	PROMPT_BUDGETS,
	PROMPT_FAMILIES,
	PROMPT_ROLES,
	tokensForBytes,
} from "../src/workflow/prompt-inventory.ts";
import {
	STAGE_TEST_PLANNER_ROLE,
	STAGE_TEST_WIKI_ROLE,
	STAGE_TESTER_ROLE,
} from "../src/workflow/steps/stage-test.ts";
import { VERIFIER_ROLES } from "../src/workflow/steps/verification.ts";

describe("prompt inventory", () => {
	const registry = registerBuiltins();
	const rows = measureInventory(registry);

	test("covers every agent step that receives the protocol", () => {
		const covered = new Set(PROMPT_ROLES.map((entry) => entry.stepId));
		const uncovered = WORKFLOW_STEPS.filter(
			(step) =>
				step.actor === "agent" &&
				step.instructionAssets.includes("workflow-agent-protocol.md"),
		)
			.map((step) => step.id)
			.filter((id) => !covered.has(id));
		expect(uncovered).toEqual([]);
	});

	test("contains every verifier, wiki and stage role", () => {
		const roles = rows.map((row) => `${row.stepId}:${row.role}`);
		for (const role of VERIFIER_ROLES)
			expect(roles).toContain(`core.verification:${role}`);
		for (const role of ["wiki", "research-wiki", STAGE_TEST_WIKI_ROLE])
			expect(roles).toContain(`core.wiki:${role}`);
		expect(roles).toContain(`stage.plan:${STAGE_TEST_PLANNER_ROLE}`);
		expect(roles).toContain(`stage.execute:${STAGE_TESTER_ROLE}`);
	});

	test("every row reports protocol, role, envelope, total and tokens", () => {
		for (const row of rows) {
			expect(row.protocolBytes).toBeGreaterThan(0);
			expect(row.roleBytes).toBeGreaterThan(0);
			expect(row.envelopeBytes).toBeGreaterThan(0);
			// `glueBytes` is the residual (separators between the parts): it must
			// stay small and non-negative, otherwise a part is mis-measured.
			expect(row.glueBytes).toBeGreaterThanOrEqual(0);
			expect(row.glueBytes).toBeLessThan(64);
			expect(row.tokens).toBe(tokensForBytes(row.totalBytes));
		}
	});

	test("every family has a budget", () => {
		for (const family of PROMPT_FAMILIES)
			expect(PROMPT_BUDGETS[family]).toBeGreaterThan(0);
		for (const entry of PROMPT_ROLES)
			expect(PROMPT_BUDGETS[entry.family]).toBeGreaterThan(0);
	});

	test("every role's static assignment is within its family budget", () => {
		const over = rows
			.filter((row) => row.totalBytes > PROMPT_BUDGETS[row.family])
			.map(
				(row) =>
					`${row.stepId}:${row.role} measured ${row.totalBytes} B, budget ${PROMPT_BUDGETS[row.family]} B (${row.family})`,
			);
		expect(over).toEqual([]);
	});
});
