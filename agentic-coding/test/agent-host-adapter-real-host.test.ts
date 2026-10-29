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
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { ensureHostRunning, HostClient } from "../src/agent-host/client.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import {
	releaseHostRetryCapability,
	replaceHostRetryCapabilityForLaunch,
} from "../src/agent-host/retry-authority.ts";
import type { Assignment, ResolvedProfile } from "../src/contracts/workflow.ts";
import { PiDurableAdapter } from "../src/workflow/adapters.ts";
import type { RenderedAssignment } from "../src/workflow/assignment.ts";

function tempDir(prefix: string): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
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
		// A production launcher retains this private authority before starting
		// the host. Mirror that contract so launch does not restart this fixture.
		const retryCapability = replaceHostRetryCapabilityForLaunch(
			layout.socketPath,
		);
		const host = await DurableHost.open({
			layout,
			retryCapability,
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
			releaseHostRetryCapability(layout.socketPath, retryCapability);
		}
	});

	test("fresh launcher processes admit repeated simultaneous verifiers while a surviving host is busy", async () => {
		const dir = tempDir("launch-process-cwd-");
		const runtimeDir = tempDir("launch-process-runtime-");
		const layout = hostLayout(runtimeDir);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = `${faux.getModel().provider}/${faux.getModel().id}`;
		const host = await DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
		});
		await host.listen();
		try {
			const envPath = path.join(dir, "busy.env");
			fs.writeFileSync(envPath, "");
			await host.ensureRun({
				runId: "busy",
				name: "busy",
				cwd: dir,
				runEnvPath: envPath,
				toolPolicy: "default",
				model,
			});
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 5" })], {
					stopReason: "toolUse",
				}),
			]);
			await host.submit("busy", "fixture turn", "busy-request");
			for (
				let i = 0;
				i < 100 && (await host.status("busy")).status !== "working";
				i++
			)
				await new Promise((resolve) => setTimeout(resolve, 10));
			expect((await host.status("busy")).status).toBe("working");
			const client = new HostClient(layout.socketPath);
			const before = fs.statSync(layout.socketPath).ino;
			const modulePath = path.resolve(
				import.meta.dir,
				"../src/workflow/adapters.ts",
			);
			for (let cycle = 0; cycle < 2; cycle++) {
				const runIds = [0, 1, 2].map((index) => `verifier-${cycle}-${index}`);
				const script = `import { Effect } from 'effect'; import { PiDurableAdapter } from ${JSON.stringify(modulePath)}; const adapter = new PiDurableAdapter(); const handles = await Promise.all(${JSON.stringify(runIds)}.map(runId => Effect.runPromise(adapter.launch({ profile: ${JSON.stringify(fakeProfile(model))}, assignment: {runId}, rendered: {prompt:'fixture verification',digest:'fixture',bytes:20}, cwd:${JSON.stringify(dir)},runDirectory:${JSON.stringify(runtimeDir)},name:runId,environment:{HERDR_RUN_ID:runId}})))); if(handles.some(handle => handle.retryTargetLease)) throw new Error('unexpected private retry registration in fresh process'); console.log(JSON.stringify(handles.map(handle => handle.sessionId)));`;
				const child = Bun.spawn([process.execPath, "--eval", script], {
					cwd: path.resolve(import.meta.dir, ".."),
					stdout: "pipe",
					stderr: "pipe",
				});
				const [output, error, code] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect({ code, error }).toEqual({ code: 0, error: "" });
				expect(JSON.parse(output)).toEqual(runIds);
				for (const runId of runIds)
					expect((await client.status(runId)).status).not.toBe("unknown");
			}
			// Explicit privileged recovery still refuses rather than interrupting
			// work, even though ordinary admission above succeeds without it.
			await expect(
				ensureHostRunning(
					layout,
					{ command: process.execPath, args: [], cwd: dir },
					{ requireRetryAuthority: true },
				),
			).rejects.toThrow("active");
			expect(fs.statSync(layout.socketPath).ino).toBe(before);
		} finally {
			await host.shutdown();
		}
	}, 30000);

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
