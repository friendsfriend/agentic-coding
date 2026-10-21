// Standalone CI runner for a compiled flow/suite (`add-stage-flow-replay`,
// design D7/D8, tasks 10.1-10.3): `scripts/stage-flow-run.ts` reuses the same
// generated spec, launcher and suite orchestration as the agent-facing route,
// but never opens a workflow and never requires an approved plan.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stagePaths } from "../src/server/stages/catalog.ts";
import { generateFlow } from "../src/stage-blocks/flow-generator.ts";
import { flowSourceFromStagePlan } from "../src/stage-blocks/flow-source.ts";
import {
	blockPlanFromRoute,
	validateStageBlockPlan,
} from "../src/stage-blocks/plan.ts";
import { stageBlockRegistry } from "../src/stage-blocks/registry.ts";
import { installedChromium } from "./support/browser.ts";

const PACKAGE_ROOT = path.join(import.meta.dir, "..");
const FLOW_ID = "ci-smoke-open";

function linkPackage(worktree: string): void {
	for (const name of ["src", "node_modules", "package.json"]) {
		const target = path.join(PACKAGE_ROOT, name);
		const link = path.join(worktree, name);
		if (!fs.existsSync(link)) fs.symlinkSync(target, link);
	}
	fs.writeFileSync(
		path.join(worktree, "biome.json"),
		JSON.stringify({
			formatter: { enabled: true, indentStyle: "tab" },
			linter: { enabled: false },
			vcs: { enabled: false },
		}),
	);
}

async function seedCiFlow(worktree: string): Promise<void> {
	const stagePlan = {
		ticketSummary: "CI smoke",
		knowledgeStatus: "none" as const,
		flowId: FLOW_ID,
		inputs: { path: "/customers/C-2002" },
		expectations: [
			{
				id: "E1",
				statement: "The page opens",
				source: "ticket" as const,
				priority: "high" as const,
			},
		],
		knowledgeUsed: [],
		route: [
			{
				id: "open",
				application: "crm",
				action: "open the customer",
				expected: "detail visible",
				capture: [],
				expectationIds: ["E1"],
				block: {
					id: "crm.ui.open",
					args: { path: "{{ inputs.path }}", readyTestId: "customer-detail" },
				},
			},
		],
		asyncWaits: [],
		createsData: false,
		dataCreated: [],
		notTested: [],
	};
	const projected = blockPlanFromRoute(
		stagePlan.route as unknown as Parameters<typeof blockPlanFromRoute>[0],
		{
			planId: "ci-smoke-r1",
			flowId: FLOW_ID,
			revision: 1,
			inputs: stagePlan.inputs,
		},
	);
	const validated = validateStageBlockPlan(projected.plan, {
		registry: stageBlockRegistry,
		policy: {
			stage: "ci-stage",
			access: "read-only",
			writeAllowed: false,
			apps: { crm: { roles: [] } },
		},
	});
	if (validated.plan === undefined)
		throw new Error(JSON.stringify(validated.issues));
	const generated = await generateFlow({
		root: worktree,
		registry: stageBlockRegistry,
		source: flowSourceFromStagePlan({
			stagePlan,
			plan: validated.plan,
			stage: "ci-stage",
			planId: "ci-smoke-r1",
			revision: 1,
		}),
	});
	if (generated.manifest === undefined)
		throw new Error(JSON.stringify(generated.issues));
}

function configRoot(appUrl: string): string {
	const configDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "stage-flow-ci-cfg-"),
	);
	const defsDir = stagePaths(configDir).defsDir;
	fs.mkdirSync(defsDir, { recursive: true });
	fs.writeFileSync(
		path.join(defsDir, "ci-stage.json"),
		JSON.stringify({
			ident: "ci-stage",
			displayName: "CI stage",
			environment: "integration",
			system: "crm",
			access: "read-only",
			apps: { crm: { label: "CRM", url: appUrl, kind: "ui", roles: {} } },
			limits: { maxSessions: 2, maxActionsPerMinute: 60 },
		}),
	);
	return configDir;
}

async function run(args: readonly string[]): Promise<{
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}> {
	// Async `Bun.spawn`, not `spawnSync`: the child's browser calls back into
	// this test's own `Bun.serve` fake app over HTTP, and a synchronous spawn
	// would block the very event loop that serves those requests, deadlocking
	// the whole test.
	const proc = Bun.spawn(
		[
			"bun",
			"run",
			path.join(PACKAGE_ROOT, "scripts/stage-flow-run.ts"),
			...args,
		],
		{ cwd: PACKAGE_ROOT, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

describe("scripts/stage-flow-run.ts (add-stage-flow-replay)", () => {
	test("runs one flow directly, with no workflow and no approved plan", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname !== "/customers/C-2002")
					return new Response("not found", { status: 404 });
				return new Response(
					'<!doctype html><html><body><h1 data-testid="customer-detail">Customer</h1></body></html>',
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		try {
			const worktree = fs.mkdtempSync(
				path.join(os.tmpdir(), "stage-flow-ci-wt-"),
			);
			linkPackage(worktree);
			await seedCiFlow(worktree);
			const configDir = configRoot(`http://127.0.0.1:${server.port}/`);
			const inputsFile = path.join(worktree, "inputs.json");
			fs.writeFileSync(
				inputsFile,
				JSON.stringify({ path: "/customers/C-2002" }),
			);
			const chromium = installedChromium();
			const result = await run([
				"--flow",
				FLOW_ID,
				"--stage",
				"ci-stage",
				"--root",
				worktree,
				"--config-dir",
				configDir,
				"--inputs",
				inputsFile,
				...(chromium === undefined ? [] : ["--executable-path", chromium]),
			]);
			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.stdout);
			expect(parsed).toMatchObject({
				id: FLOW_ID,
				flowId: FLOW_ID,
				status: "passed",
			});
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("runs a suite of the same flow twice with different inputs and fails for an unsaved flow", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const pathname = new URL(request.url).pathname;
				if (
					pathname !== "/customers/C-2002" &&
					pathname !== "/customers/C-3003"
				)
					return new Response("not found", { status: 404 });
				return new Response(
					'<!doctype html><html><body><h1 data-testid="customer-detail">Customer</h1></body></html>',
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		try {
			const worktree = fs.mkdtempSync(
				path.join(os.tmpdir(), "stage-flow-ci-wt-"),
			);
			linkPackage(worktree);
			await seedCiFlow(worktree);
			fs.writeFileSync(
				path.join(worktree, "stage-flows", "ci-smoke.suite.json"),
				JSON.stringify({
					version: 1,
					suiteId: "ci-smoke",
					parallel: true,
					stopOnFailure: false,
					flows: [
						{
							id: "first",
							flowId: FLOW_ID,
							inputs: { path: "/customers/C-2002" },
						},
						{
							id: "second",
							flowId: FLOW_ID,
							inputs: { path: "/customers/C-3003" },
						},
						{ id: "missing", flowId: "no-such-flow" },
					],
				}),
			);
			const configDir = configRoot(`http://127.0.0.1:${server.port}/`);
			const chromium = installedChromium();
			const result = await run([
				"--suite",
				"ci-smoke",
				"--stage",
				"ci-stage",
				"--root",
				worktree,
				"--config-dir",
				configDir,
				...(chromium === undefined ? [] : ["--executable-path", chromium]),
			]);
			expect(result.exitCode).toBe(1);
			const parsed = JSON.parse(result.stdout) as {
				status: string;
				entries: { id: string; status: string; code?: string }[];
			};
			expect(parsed.status).toBe("failed");
			const byId = Object.fromEntries(
				parsed.entries.map((entry) => [entry.id, entry]),
			);
			expect(byId.first?.status).toBe("passed");
			expect(byId.second?.status).toBe("passed");
			expect(byId.missing?.status).toBe("refused");
			expect(byId.missing?.code).toBe("flow-not-found");
		} finally {
			server.stop(true);
		}
	}, 60_000);
});
