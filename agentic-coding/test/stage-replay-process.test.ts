// End-to-end rehearsal of the separate replay process (`add-stage-flow-replay`,
// task 3/4): generate a spec, run it with the real Playwright fixture against a
// local application, and read back the bounded result. No server browser session
// and no model participates.
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runReplayProcess } from "../src/server/browser/stage-replay.ts";
import { STAGE_JOURNAL_FILE } from "../src/server/evidence/journal.ts";
import type { FlowSource } from "../src/stage-blocks/flow.ts";
import { canonicalInputsHash } from "../src/stage-blocks/flow.ts";
import { generateFlow } from "../src/stage-blocks/flow-generator.ts";
import { validateStageBlockPlan } from "../src/stage-blocks/plan.ts";
import { stageBlockRegistry } from "../src/stage-blocks/registry.ts";
import { installedChromium } from "./support/browser.ts";

const ROOT = path.join(import.meta.dir, "..");
const FLOW_ID = "test-replay-green";
let worktree = "";

afterAll(() => {
	if (worktree !== "") fs.rmSync(worktree, { recursive: true, force: true });
});

function source(): FlowSource {
	const inputs = { path: "/customers/C-2001" };
	const validated = validateStageBlockPlan(
		{
			planId: "stage-test-replay-r1",
			flowId: FLOW_ID,
			revision: 1,
			inputs,
			steps: [
				{
					id: "open",
					block: "crm.ui.open",
					args: { path: "{{ inputs.path }}", readyTestId: "ready" },
				},
			],
		},
		{
			registry: stageBlockRegistry,
			policy: {
				stage: "crm-int",
				access: "read-only",
				writeAllowed: false,
				role: "clerk",
				apps: { crm: { roles: ["clerk"] } },
			},
		},
	);
	if (validated.plan === undefined)
		throw new Error(JSON.stringify(validated.issues));
	return {
		flowId: FLOW_ID,
		title: "Replay green",
		stage: "crm-int",
		planId: "stage-test-replay-r1",
		revision: 1,
		inputs,
		steps: validated.plan.steps,
		routeMeta: [
			{
				id: "open",
				application: "crm",
				role: "clerk",
				expectationIds: [],
				captures: [],
			},
		],
		expectations: [],
	};
}

function packageCheckout(root: string): void {
	for (const name of ["src", "node_modules", "package.json"])
		fs.symlinkSync(path.join(ROOT, name), path.join(root, name));
	fs.writeFileSync(
		path.join(root, "biome.json"),
		JSON.stringify({
			formatter: { enabled: true, indentStyle: "tab" },
			linter: { enabled: false },
			vcs: { enabled: false },
		}),
	);
}

describe("compiled replay process", () => {
	test("runs a generated spec in a separate Playwright process", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname !== "/customers/C-2001")
					return new Response("not found", { status: 404 });
				return new Response(
					'<!doctype html><html><body><h1 data-testid="ready">Customer</h1></body></html>',
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		try {
			worktree = fs.mkdtempSync(
				path.join(os.tmpdir(), "stage-replay-process-"),
			);
			packageCheckout(worktree);
			const generated = await generateFlow({
				root: worktree,
				source: source(),
				registry: stageBlockRegistry,
				typeCheck: true,
			});
			expect(generated.issues).toEqual([]);
			if (generated.specPath === undefined)
				throw new Error("generator returned no spec path");
			const manifest = generated.manifest;
			if (manifest === undefined)
				throw new Error("generator returned no manifest");
			const result = await runReplayProcess({
				root: worktree,
				specPath: path.join(worktree, generated.specPath),
				flowId: FLOW_ID,
				stage: "crm-int",
				role: "clerk",
				apps: { crm: `http://127.0.0.1:${server.port}` },
				inputs: manifest.inputExamples[0] as Record<string, never>,
				planId: "stage-test-replay-r1",
				revision: 1,
				routeHash: manifest.routeHash,
				inputsHash: canonicalInputsHash(manifest.inputExamples[0] ?? {}),
				writeAllowed: false,
				dataRoot: worktree,
				...(installedChromium() === undefined
					? {}
					: { executablePath: installedChromium() }),
				credentials: {},
				secretNames: [],
			});
			expect(result.timedOut).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(fs.existsSync(result.resultPath)).toBe(true);
			const run = JSON.parse(fs.readFileSync(result.resultPath, "utf8")) as {
				status: string;
				flowId: string;
				steps: { routeStepId: string; status: string }[];
				events: { subStep: string; status: string }[];
			};
			expect(run.flowId).toBe(FLOW_ID);
			expect(run.status).toBe("passed");
			expect(run.steps[0]?.routeStepId).toBe("open");
			expect(run.steps[0]?.status).toBe("passed");
			expect(run.events[0]?.subStep).toBe("open the application path");
			expect(run.events[0]?.status).toBe("passed");
			// `add-stage-flow-replay` task 4.7: the replay process only ever
			// writes its own bounded `stage-run.json`; ingestion into
			// `stage-journal.jsonl` happens later, only at the server boundary,
			// and only through the journal writer — never from inside the
			// process this test just ran.
			const writtenFiles = fs.readdirSync(worktree, {
				recursive: true,
				encoding: "utf8",
			});
			expect(
				writtenFiles.some((entry) => entry.endsWith(STAGE_JOURNAL_FILE)),
			).toBe(false);
		} finally {
			server.stop(true);
		}
	}, 120_000);
});
