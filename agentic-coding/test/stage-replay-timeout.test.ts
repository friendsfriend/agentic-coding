// A real replay process that exceeds its timeout is killed and reported
// `timedOut: true` rather than hanging the caller (`add-stage-flow-replay`
// task 3.8). The timeout itself is set absurdly small so the process is
// guaranteed to overrun it, keeping this test fast and deterministic without
// a deliberately slow block.
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runReplayProcess } from "../src/server/browser/stage-replay.ts";
import type { FlowSource } from "../src/stage-blocks/flow.ts";
import { canonicalInputsHash } from "../src/stage-blocks/flow.ts";
import { generateFlow } from "../src/stage-blocks/flow-generator.ts";
import { validateStageBlockPlan } from "../src/stage-blocks/plan.ts";
import { stageBlockRegistry } from "../src/stage-blocks/registry.ts";
import { installedChromium } from "./support/browser.ts";

const ROOT = path.join(import.meta.dir, "..");
const FLOW_ID = "test-replay-timeout";
let worktree = "";

afterAll(() => {
	if (worktree !== "") fs.rmSync(worktree, { recursive: true, force: true });
});

function source(): FlowSource {
	const inputs = { path: "/customers/C-2001" };
	const validated = validateStageBlockPlan(
		{
			planId: "stage-test-timeout-r1",
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
		title: "Replay timeout",
		stage: "crm-int",
		planId: "stage-test-timeout-r1",
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

describe("compiled replay process timeout (add-stage-flow-replay)", () => {
	test("a process that overruns its bound is reported timed out, not hung", async () => {
		// The target server never answers, so the one `page.goto` step cannot
		// finish before even a very small bound elapses.
		const server = Bun.serve({
			port: 0,
			fetch: () => new Promise(() => undefined),
		});
		try {
			worktree = fs.mkdtempSync(
				path.join(os.tmpdir(), "stage-replay-timeout-"),
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
				planId: "stage-test-timeout-r1",
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
				timeoutMs: 1_000,
			});
			expect(result.timedOut).toBe(true);
			expect(result.exitCode).not.toBe(0);
		} finally {
			server.stop(true);
		}
	}, 60_000);
});
