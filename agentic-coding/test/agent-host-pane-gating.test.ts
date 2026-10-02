// add-pi-durable-runtime, task 5.5: a `pi-durable` launch never allocates a
// multiplexer pane. Exercises the real `agent.launch` effect handler in
// `effect-runner.ts` with a `hostsOwnProcess` test adapter double (no real
// pi-durable host is involved; `DurableHost`/`PiDurableAdapter` themselves
// are covered by the `agent-host-*` and dedicated adapter unit tests).
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { AgentHandle } from "../src/contracts/workflow.ts";
import type { AgentAdapter, LaunchContext } from "../src/workflow/adapters.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
} from "../src/workflow/effect-runner.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";
import { asPort } from "./fakes.ts";
import {
	autoRemoveRepoFixtures,
	createRepoFixture,
} from "./support/git-fixture.ts";

autoRemoveRepoFixtures();

class HostsOwnProcessAdapter implements AgentAdapter {
	readonly id = "pi-durable" as const;
	readonly hostsOwnProcess = true as const;
	launches = 0;
	context?: LaunchContext;
	preflight() {}
	launch(ctx: LaunchContext) {
		this.launches++;
		this.context = ctx;
		return Effect.succeed({
			runtime: "pi-durable" as const,
			name: ctx.name,
			paneId: "",
			hostSocket: "/tmp/fake.sock",
			sessionId: ctx.assignment.runId,
		});
	}
	prompt() {
		return Effect.void;
	}
	observe(handle: AgentHandle) {
		return Effect.succeed({
			status: "working" as const,
			paneId: handle.paneId,
		});
	}
	stop() {
		return Effect.void;
	}
}

test("a pi-durable launch never calls paneForRun and carries an empty paneId", async () => {
	const repo = fs.mkdtempSync(
		path.join(os.tmpdir(), "agent-host-pane-gating-"),
	);
	createRepoFixture(repo, {
		files: {
			"README.md": "x\n",
			"openspec/config.yaml": "schema: spec-driven\n",
		},
	});
	const profile = {
		name: "durable-worker",
		runtime: "pi-durable" as const,
		executable: "agentic-coding",
		tools: [],
		extensions: [],
		readOnly: false,
		capabilities: ["prompt", "run-environment", "observe"] as const,
		digest: "profile",
	};
	const routing = {
		defaultProfile: "pi-durable",
		routes: [{ stepId: "core.plan", role: "planner", profile }],
		diversity: [],
	};
	const registry = registerBuiltins();
	const engine = new WorkflowEngine(registry);
	engine.start({
		repo,
		workflowId: "durable-pane-gating",
		definitionId: "openspec",
		metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
		routing,
	});
	const adapter = new HostsOwnProcessAdapter();
	let paneForRunCalls = 0;
	const handlers = {
		...agentEffectHandlers(repo, engine, {
			registry,
			adapters: new Map([["pi-durable", adapter]]),
			port: asPort({
				call(...args: string[]) {
					throw new Error(
						`unexpected port call for a pane-less runtime: ${args.join(" ")}`,
					);
				},
			}),
			async paneForRun() {
				paneForRunCalls++;
				throw new Error("a pi-durable launch must never allocate a pane");
			},
		}),
		"model.classify": {
			execute: () =>
				Effect.succeed({ integration: "routing", phase: "plan", answers: {} }),
		},
	};
	await new EffectRunner(repo, engine, handlers).drain();
	expect(adapter.launches).toBe(1);
	expect(paneForRunCalls).toBe(0);
	expect(adapter.context?.paneId).toBe("");
	const runId = engine.status(repo, "durable-pane-gating").runs[0]?.id;
	const run = runId ? engine.getRun(repo, runId) : undefined;
	expect(run?.handle?.paneId).toBe("");
	expect(run?.handle?.hostSocket).toBe("/tmp/fake.sock");
});
