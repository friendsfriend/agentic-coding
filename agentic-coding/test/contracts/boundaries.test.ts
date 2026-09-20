import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Contract-layer guarantees (establish-opencode-boundaries, section 1):
 *
 * 1. `src/contracts` is pure — no TUI, server, workflow-runtime, database,
 *    filesystem, process or network import, so any consumer may depend on it.
 * 2. Wire shapes have exactly one owner: TUI modules no longer define or
 *    re-export the shared records.
 * 3. Malformed payloads fail with a structured `ContractFailure`, not with an
 *    Effect `ParseError` or a silently accepted value.
 */
const CONTRACTS = "src/contracts";

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...filesUnder(full));
		else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
	}
	return out;
}

function importsOf(source: string): string[] {
	const specs: string[] = [];
	const re =
		/(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*"([^"]+)"/gs;
	for (const match of source.matchAll(re)) specs.push(match[1]);
	// literal dynamic imports are boundary crossings too
	for (const match of source.matchAll(/import\s*\(\s*"([^"]+)"\s*\)/g))
		specs.push(match[1]);
	for (const match of source.matchAll(/require\s*\(\s*"([^"]+)"\s*\)/g))
		specs.push(match[1]);
	return specs;
}

describe("contracts layer purity", () => {
	const files = filesUnder(CONTRACTS);

	test("every contract module is scanned", () => {
		expect(files.length).toBeGreaterThanOrEqual(7);
	});

	test("no contract module imports a runtime or application layer", () => {
		const forbidden = [
			/tui\//,
			/server\//,
			/workflow\/(runtime|engine|store|steps|adapters|definitions)/,
			/@ui/,
			/@devenv\//,
			/^bun/,
			/^node:(fs|path|process|child_process|net|http|https|os|sqlite)/,
			/^effect\/platform/,
		];
		const violations: string[] = [];
		for (const file of files) {
			for (const spec of importsOf(readFileSync(file, "utf8"))) {
				if (forbidden.some((re) => re.test(spec)))
					violations.push(`${relative(".", file)} -> ${spec}`);
			}
		}
		expect(violations).toEqual([]);
	});

	test("the barrel re-exports the whole layer and has no side effects", () => {
		const barrel = readFileSync(join(CONTRACTS, "index.ts"), "utf8");
		for (const mod of [
			"decode",
			"workflow",
			"telemetry",
			"actions",
			"environment",
			"integration",
			"credential",
		]) {
			expect(barrel).toContain(`export * from "./${mod}.ts";`);
		}
		// a barrel that runs code at import time is not a type layer: every
		// non-comment line must be a re-export
		const statements = barrel
			.split("\n")
			.filter((line) => line.trim() && !/^\s*(\/\*|\*|\/\/)/.test(line));
		for (const statement of statements)
			expect(statement.trim().startsWith("export * from")).toBe(true);
	});
});

describe("wire ownership", () => {
	const moved = [
		"WorkflowView",
		"WorkflowCommand",
		"WorkflowState",
		"SpanData",
		"TraceSummaryPage",
		"MetricData",
		"LogData",
		"LocalChange",
		"WorktreeGitStatus",
		"EventEnvelope",
		"RequiredUserAction",
	];

	test("no TUI module still defines a moved wire record", () => {
		const offenders: string[] = [];
		for (const dir of ["src/tui", "src/server", "packages/devenv/cli"]) {
			for (const file of filesUnder(dir)) {
				const source = readFileSync(file, "utf8");
				for (const name of moved) {
					const defines = new RegExp(
						`export\\s+(?:interface|type|class)\\s+${name}\\b`,
					);
					if (defines.test(source)) offenders.push(`${file}: ${name}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the dissected modules are gone", () => {
		expect(() => statSync("src/tui/dash/types.ts")).toThrow();
		expect(() => statSync("src/tui/otel/model/types.ts")).toThrow();
	});
});

describe("malformed payloads fail structurally", () => {
	test("a bad dashboard event is rejected with a bounded issue list", async () => {
		const { dashboardEventSchema } = await import(
			"../../src/contracts/environment.ts"
		);
		const { decodeContract, ContractFailure } = await import(
			"../../src/contracts/decode.ts"
		);
		let failure: unknown;
		try {
			decodeContract("core.dashboard-event", dashboardEventSchema, {
				instance: "server",
				sequence: -1,
				domain: "workflow",
				kind: "workflow.action",
				at: "now",
				payload: {},
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(ContractFailure);
		const issues = (failure as { issues: Array<{ path: string }> }).issues;
		expect(issues.length).toBeGreaterThan(0);
		expect(issues[0]?.path).toContain("sequence");
	});

	test("a malformed workflow action request reports its field", async () => {
		const { workflowActionRequestSchema } = await import(
			"../../src/contracts/actions.ts"
		);
		const { decodeRequest } = await import("../../src/server/protocol.ts");
		expect(() =>
			decodeRequest("server.workflow.action", workflowActionRequestSchema, {
				repo: "r",
				workflowId: "w",
				revision: "not-a-number",
				actionId: "pause",
			}),
		).toThrow(/revision/);
	});

	test("excess properties are rejected at the transport boundary", async () => {
		const { workflowViewRequestSchema } = await import(
			"../../src/contracts/workflow.ts"
		);
		const { decodeRequest } = await import("../../src/server/protocol.ts");
		expect(() =>
			decodeRequest("server.workflow.view", workflowViewRequestSchema, {
				repo: "r",
				workflowId: "w",
				smuggled: true,
			}),
		).toThrow();
	});
});
