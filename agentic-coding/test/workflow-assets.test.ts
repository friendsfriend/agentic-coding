import { expect, test } from "bun:test";
import { AGENT_DEFINITIONS } from "../src/workflow/embedded.generated.ts";

test("embedded workflow assets stay outside skill/plugin discovery", () => {
	const names = Object.keys(AGENT_DEFINITIONS);
	expect(names.some((name) => name.includes("SKILL.md"))).toBe(false);
	// Only instructions remain embedded: the pane-hosted runtime bridges and
	// extensions are gone with the multiplexer, and the durable host implements
	// the workflow tools natively.
	expect(names.every((name) => name.startsWith("instructions/"))).toBe(true);
	expect(names).toContain("instructions/verification.md");
	expect(names).toContain("instructions/workflow-agent-protocol.md");
});

test("verification instructions require fresh findings", () => {
	const verification = AGENT_DEFINITIONS["instructions/verification.md"];
	expect(verification).toContain("Every verification run must inspect");
	expect(verification).toContain("Treat prior findings as leads, not proof");
	expect(verification).toContain("omit it when fixed");
});

test("triage instructions scope the decided roles instead of selecting them", () => {
	const triage = AGENT_DEFINITIONS["instructions/triage.md"];
	// The role set is decided by the classifier and arrives as the step input;
	// the agent's job is scoping, never widening.
	expect(triage).toContain("scoping verifier roles");
	expect(triage).toContain("locked verifier-role set");
	expect(triage).toContain("rejects a plan naming any other role");
	expect(triage).not.toContain("Select the minimum verifier roles that cover");
	// The unconstrained (classifier fail-open) round must stay actionable: the
	// catalog is still documented, and `test-verifier` is still engine-owned.
	expect(triage).toContain("No set is listed");
	expect(triage).toContain("| quality-verifier |");
	expect(triage).toContain("| migration-verifier |");
	expect(triage).toContain("`test-verifier` is never a triage role");
	expect(triage).not.toContain("| test-verifier | NEVER select");
	// Scoping requirements stay: the changed-file manifest, per-role files,
	// dropping (never emptying) the set, and prior PASS evidence reuse.
	expect(triage).toContain("changed-file manifest");
	expect(triage).toContain("drop a role only when it has no relevant");
	expect(triage).toContain("Reuse unchanged prior PASS evidence");
});
