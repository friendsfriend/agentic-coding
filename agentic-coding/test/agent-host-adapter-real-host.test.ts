// add-pi-durable-runtime task 5.5: `PiDurableAdapter` against a real
// `DurableHost` over the actual control socket (not a stub adapter and not
// a fake socket server). A real `DurableHost` is pre-started and listening
// on the adapter's own computed layout before `launch()` runs, so the
// adapter's `ensureHostRunning` finds it reachable on the first `hello` and
// never needs to self-exec-spawn a new process (which `bun test` cannot do
// correctly here, since `Bun.main` is the test runner, not `src/cli.ts`; the
// real spawn path is covered by the compiled-binary smoke tests instead).
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import type { Assignment, ResolvedProfile } from "../src/contracts/workflow.ts";
import { PiDurableAdapter } from "../src/workflow/adapters.ts";
import type { RenderedAssignment } from "../src/workflow/assignment.ts";

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeProfile(model: string): ResolvedProfile {
	return {
		name: "durable-test",
		runtime: "pi-durable",
		executable: "pi-durable",
		model,
		tools: [],
		extensions: [],
		readOnly: false,
		capabilities: ["prompt", "run-environment", "observe"],
		digest: "digest",
	};
}

function fakeAssignment(runId: string): Assignment {
	return { runId } as unknown as Assignment;
}

describe("PiDurableAdapter against a real DurableHost", () => {
	test("launch/prompt/observe/stop round-trip through the real control socket", async () => {
		const dir = tempDir("agent-host-adapter-cwd-");
		// The adapter computes its runtime directory as `ctx.runDirectory ??
		// path.join(ctx.cwd, ".herdr-workflow")` (matching `writeAgentRunEnv`'s own
		// default); passing it explicitly here keeps the pre-started host's layout
		// and the adapter's computed layout provably the same directory instead of
		// relying on both sides reimplementing the same default identically.
		const runtimeDir = tempDir("agent-host-adapter-runtime-");
		const layout = hostLayout(runtimeDir);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
		});
		// Pre-started and listening on the exact layout the adapter computes from
		// `ctx.cwd`/`ctx.runDirectory`, so `ensureHostRunning` finds it reachable
		// immediately and the adapter's own spawn path is never exercised here.
		await host.listen();
		try {
			const adapter = new PiDurableAdapter();
			const profile = fakeProfile(
				`${faux.getModel().provider}/${faux.getModel().id}`,
			);
			const assignment = fakeAssignment("adapter-run-1");
			const rendered: RenderedAssignment = {
				prompt: "do the thing",
				digest: "d",
				bytes: 10,
			};

			faux.setResponses([fauxAssistantMessage([fauxText("working on it")])]);
			const handle = await Effect.runPromise(
				adapter.launch({
					profile,
					assignment,
					rendered,

					cwd: dir,
					runDirectory: runtimeDir,
					name: "adapter-worker",
					environment: { HERDR_RUN_ID: "adapter-run-1" },
				}),
			);
			expect(handle.runtime).toBe("pi-durable");
			expect(handle.hostSocket).toBe(layout.socketPath);
			expect(handle.sessionId).toBe("adapter-run-1");
			expect(handle.conversationId).toBeTruthy();

			let observation = await Effect.runPromise(adapter.observe(handle));
			for (let i = 0; i < 50 && observation.status === "working"; i++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				observation = await Effect.runPromise(adapter.observe(handle));
			}
			expect(observation.status).toBe("idle");

			faux.setResponses([fauxAssistantMessage([fauxText("following up")])]);
			await Effect.runPromise(adapter.prompt(handle, "one more thing"));
			const afterPrompt = await host.status("adapter-run-1");
			expect(["working", "idle"]).toContain(afterPrompt.status);

			await Effect.runPromise(adapter.stop(handle));
		} finally {
			await host.shutdown();
		}
	});

	test("preflight does not look up an executable and enforces runtime identity", () => {
		const adapter = new PiDurableAdapter();
		expect(() =>
			adapter.preflight(fakeProfile("faux/faux-1"), []),
		).not.toThrow();
		expect(() =>
			adapter.preflight(fakeProfile("faux/faux-1"), ["read-only"]),
		).not.toThrow();
		// A profile routed to another adapter is refused; with one runtime left,
		// the mismatch can only be constructed structurally.
		expect(() =>
			adapter.preflight(
				{ ...fakeProfile("faux/faux-1"), runtime: "opencode" as never },
				[],
			),
		).toThrow();
	});
});
