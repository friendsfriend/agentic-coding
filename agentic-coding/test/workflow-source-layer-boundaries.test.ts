// Source-layer boundary and pure-domain guardrails
// (enforce-source-layer-boundaries). Runs the static architecture checks
// from scripts/workflow-architecture.ts against the real src tree and against
// isolated positive/negative fixtures that pin each scenario from the
// source-layer-boundaries spec. See docs/workflow-architecture.md for the
// enforced layer matrix, exception policy, covered import forms, and the
// bounded static-analysis limitations.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
	type ArchitectureIssue,
	checkExceptionUsage,
	checkLayerOwnership,
	checkPureDomain,
	checkUnresolvedRuntimeTargets,
	findRuntimeCycle,
	type LayerException,
} from "../scripts/workflow-architecture.ts";

const SRC_ROOT = path.join(import.meta.dir, "..", "src");
const FIXTURES = path.join(
	import.meta.dir,
	"..",
	"test",
	"fixtures",
	"source-layer-boundaries",
);
const fixtureRoot = (...parts: string[]) =>
	path.join(FIXTURES, ...parts, "src");
const rel = (root: string, file: string) =>
	path.relative(root, file).split(path.sep).join("/");

const NO_EXCEPTIONS = new Map<string, LayerException>();

function messages(issues: ArchitectureIssue[]): string[] {
	return issues.map((issue) => issue.message);
}

describe("workflow source-layer boundaries (enforce-source-layer-boundaries)", () => {
	test("src has no runtime import cycle (including .tsx, dynamic, require)", () => {
		expect(findRuntimeCycle(SRC_ROOT)).toBeNull();
	});

	test("src satisfies the documented layer ownership matrix", () => {
		const issues = checkLayerOwnership(SRC_ROOT, NO_EXCEPTIONS);
		expect(issues).toEqual([]);
	});

	test("src pure domain modules satisfy the purity guardrails", () => {
		const issues = checkPureDomain(SRC_ROOT, NO_EXCEPTIONS);
		expect(issues).toEqual([]);
	});

	test("src has no unresolved project-relative runtime targets", () => {
		expect(checkUnresolvedRuntimeTargets(SRC_ROOT)).toEqual([]);
	});

	test("src exception allowlist has no unused entries", () => {
		expect(checkExceptionUsage(SRC_ROOT, NO_EXCEPTIONS)).toEqual([]);
	});

	test("a value import through a .tsx module that closes a runtime cycle fails with the source dependency path", () => {
		const root = fixtureRoot("negative", "tsx-cycle");
		const cycle = findRuntimeCycle(root);
		expect(cycle).not.toBeNull();
		expect(cycle).toContain("tui/dash/a.tsx");
		expect(cycle).toContain("tui/dash/b.tsx");
	});

	test("a cycle of type-only references is not reported as a runtime cycle", () => {
		const root = fixtureRoot("negative", "type-only-cycle");
		expect(findRuntimeCycle(root)).toBeNull();
	});

	test("a core module importing presentation types is rejected without a runtime cycle", () => {
		const root = fixtureRoot("negative", "type-edge");
		expect(findRuntimeCycle(root)).toBeNull();
		const issues = checkLayerOwnership(root, NO_EXCEPTIONS);
		expect(issues).toHaveLength(1);
		expect(rel(root, issues[0].file)).toBe("workflow/runtime/view.ts");
		expect(issues[0].message).toContain("depends on TUI presentation");
		expect(issues[0].message).toContain("tui/dash/panel.ts");
	});

	test("literal dynamic import() and require() crossing a boundary are both reported", () => {
		const root = fixtureRoot("negative", "dynamic-boundary");
		const issues = checkLayerOwnership(root, NO_EXCEPTIONS);
		expect(issues).toHaveLength(2);
		const text = messages(issues).join("\n");
		expect(text).toContain("workflow/cli.ts");
		expect(text).toContain("workflow/cli/run.ts");
		for (const issue of issues)
			expect(issue.message).toContain("application-operations boundary");
	});

	test("an unresolved project-relative runtime target fails with source and specifier", () => {
		const root = fixtureRoot("negative", "unresolved-target");
		const issues = checkUnresolvedRuntimeTargets(root);
		expect(issues).toHaveLength(1);
		expect(issues[0].message).toContain("workflow/runtime/broken.ts");
		expect(issues[0].message).toContain("'./missing.ts'");
	});

	test("a dashboard module importing CLI orchestration fails and identifies the application boundary", () => {
		const root = fixtureRoot("negative", "dashboard-cli");
		const issues = checkLayerOwnership(root, NO_EXCEPTIONS);
		expect(issues).toHaveLength(1);
		expect(rel(root, issues[0].file)).toBe("tui/dash/engine.ts");
		expect(issues[0].message).toContain("application-operations boundary");
		expect(issues[0].message).toContain("workflow/cli.ts");
	});

	test("a shared TUI primitive importing a dashboard feature fails with the reversed edge", () => {
		const root = fixtureRoot("negative", "shared-imports-feature");
		const issues = checkLayerOwnership(root, NO_EXCEPTIONS);
		expect(issues).toHaveLength(1);
		expect(issues[0].message).toContain("dependency direction is reversed");
		expect(issues[0].message).toContain("tui/dash/ui/feature.ts");
	});

	test("pure step behavior importing a transitive I/O helper fails with the dependency path", () => {
		const root = fixtureRoot("negative", "pure-transitive");
		const issues = checkPureDomain(root, NO_EXCEPTIONS);
		expect(issues).toHaveLength(2);
		expect(
			messages(issues).some((message) =>
				message.includes(
					"workflow/steps/pure-a.ts -> workflow/steps/pure-b.ts -> workflow/runtime/persistence.ts",
				),
			),
		).toBe(true);
		for (const issue of issues) expect(issue.rule).toBe("pure:reachability");
	});

	test("a pure hook invoking recognized ambient I/O/clock globals fails with source locations", () => {
		const root = fixtureRoot("negative", "pure-globals");
		const issues = checkPureDomain(root, NO_EXCEPTIONS);
		const globals = issues.filter((issue) => issue.rule === "pure:global");
		const labels = globals.map((issue) => issue.message);
		expect(labels).toHaveLength(5);
		for (const expected of [
			"Bun.spawnSync",
			"fetch",
			"Date.now",
			"new Date()",
			"process.cwd",
		])
			expect(labels.some((label) => label.includes(expected))).toBe(true);
		for (const issue of globals) {
			expect(issue.line).toBeGreaterThan(0);
			expect(issue.column).toBeGreaterThan(0);
		}
	});

	test("computed module loading in a guarded pure module is rejected", () => {
		const root = fixtureRoot("negative", "pure-computed");
		const issues = checkPureDomain(root, NO_EXCEPTIONS).filter(
			(issue) => issue.rule === "pure:computed-loading",
		);
		expect(issues).toHaveLength(2);
		for (const issue of issues)
			expect(issue.message).toContain("escapes static resolution");
	});

	test("a guarded pure module importing an I/O builtin is rejected", () => {
		const root = fixtureRoot("negative", "pure-fs-builtin");
		const issues = checkPureDomain(root, NO_EXCEPTIONS);
		expect(issues).toHaveLength(1);
		expect(issues[0].rule).toBe("pure:io-builtin");
		expect(issues[0].message).toContain("node:fs");
	});

	test("an exception whose edge no longer exists fails as stale", () => {
		const root = fixtureRoot("negative", "exceptions-stale");
		const exceptions = new Map<string, LayerException>([
			[
				"workflow/steps/x.ts -> workflow/runtime/persistence.ts",
				{
					rationale: "fixture edge removed by refactor",
					removalCondition: "removed",
				},
			],
		]);
		const issues = checkExceptionUsage(root, exceptions);
		expect(issues).toHaveLength(1);
		expect(issues[0].rule).toBe("exception:unused");
		expect(issues[0].message).toContain(
			"workflow/steps/x.ts -> workflow/runtime/persistence.ts",
		);
	});

	test("a different forbidden edge beside an approved exception fails independently", () => {
		const root = fixtureRoot("negative", "exceptions-beside");
		const exceptions = new Map<string, LayerException>([
			[
				"workflow/steps/x.ts -> workflow/runtime/persistence.ts",
				{
					rationale: "approved persistence edge for fixture demo",
					removalCondition: "fixture refactor",
				},
			],
		]);
		const layer = checkLayerOwnership(root, exceptions);
		expect(layer).toHaveLength(1);
		expect(layer[0].message).toContain("workflow/cli/run.ts");
		expect(layer[0].message).not.toContain("persistence.ts");
		const pure = checkPureDomain(root, exceptions);
		expect(pure).toHaveLength(1);
		expect(pure[0].message).toContain("workflow/cli/run.ts");
		expect(pure[0].message).not.toContain("persistence.ts");
	});

	test("positive fixtures pass every check (evidence/time inputs, application calls, type contracts, wrappers, composition)", () => {
		const root = fixtureRoot("positive", "all");
		expect(findRuntimeCycle(root)).toBeNull();
		expect(checkUnresolvedRuntimeTargets(root)).toEqual([]);
		expect(checkLayerOwnership(root, NO_EXCEPTIONS)).toEqual([]);
		expect(checkPureDomain(root, NO_EXCEPTIONS)).toEqual([]);
	});
});
