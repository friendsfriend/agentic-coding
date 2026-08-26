import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The pi telemetry bridge is loaded as a top-level-effect module by the pi
// runtime; copying it into the fake repo and importing a fresh copy per case
// runs recoverRunEnv against a scripted pointer file for each name shape.
async function runBridge(name: string, repo: string): Promise<void> {
	const savedArgv = process.argv;
	process.argv = ["pi", "--name", name];
	try {
		const module = path.join(repo, `bridge-${name}.ts`);
		fs.copyFileSync(
			path.resolve(
				import.meta.dir,
				"../../agent-definitions/bridges/pi-telemetry.ts",
			),
			module,
		);
		await import(module);
	} finally {
		process.argv = savedArgv;
	}
}

for (const name of ["planner-ab12cd34", "quality-verif-ab12cd34-12345678"]) {
	test(`pi telemetry bridge recovers run env via per-agent pointer (${name})`, async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-recover-"));
		const savedCwd = process.cwd();
		try {
			const runtimeBin = path.join(repo, ".herdr-workflow", "runtime-bin");
			fs.mkdirSync(path.join(runtimeBin, "by-agent"), { recursive: true });
			fs.mkdirSync(path.join(runtimeBin, "run-1"), { recursive: true });
			fs.mkdirSync(path.join(runtimeBin, "00000000-run-9"), {
				recursive: true,
			});
			// A decoy from an unrelated run must not win over the pointer.
			fs.writeFileSync(
				path.join(runtimeBin, "00000000-run-9", "run.env"),
				"HERDR_RUN_ID=stale\n",
				{ mode: 0o600 },
			);
			fs.writeFileSync(
				path.join(runtimeBin, "run-1", "run.env"),
				"HERDR_RUN_ID=run-1\nHERDR_STEP_ID=core.implementation\n",
				{ mode: 0o600 },
			);
			fs.writeFileSync(
				path.join(runtimeBin, "by-agent", name),
				".herdr-workflow/runtime-bin/run-1/run.env\n",
				{ mode: 0o600 },
			);
			delete process.env.HERDR_RUN_ID;
			delete process.env.HERDR_STEP_ID;
			process.chdir(repo);
			await runBridge(name, repo);
			expect(String(process.env.HERDR_RUN_ID)).toBe("run-1");
			expect(String(process.env.HERDR_STEP_ID)).toBe("core.implementation");
		} finally {
			process.chdir(savedCwd);
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
}

test("pi telemetry bridge emits usage envelope with cache, duration, tok/s", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-usage-"));
	const telemetryPath = path.join(repo, "telemetry.jsonl");
	const savedPath = process.env.HERDR_TELEMETRY_PATH;
	process.env.HERDR_TELEMETRY_PATH = telemetryPath;
	try {
		const module = path.join(repo, "bridge-usage.ts");
		fs.copyFileSync(
			path.resolve(
				import.meta.dir,
				"../../agent-definitions/bridges/pi-telemetry.ts",
			),
			module,
		);
		const handlers = new Map<string, (event: unknown) => void>();
		const pi = {
			on: (event: string, handler: (event: unknown) => void) => {
				handlers.set(event, handler);
			},
		};
		const bridge = await import(module);
		bridge.default(pi);

		handlers.get("message_start")?.({ message: { role: "assistant" } });
		// Ensure measurable wall-clock generation time (millisecond resolution).
		await Bun.sleep(5);
		handlers.get("message_end")?.({
			message: {
				role: "assistant",
				usage: {
					input: 1200,
					output: 300,
					cacheRead: 900,
					cacheWrite: 0,
					totalTokens: 1500,
					cost: { total: 0.012 },
				},
			},
		});

		const lines = fs.readFileSync(telemetryPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const envelope = JSON.parse(lines[0]) as Record<string, unknown>;
		expect(envelope.event).toBe("runtime.usage");
		expect(envelope.inputTokens).toBe(1200);
		expect(envelope.outputTokens).toBe(300);
		expect(envelope.cacheReadTokens).toBe(900);
		// An explicitly reported zero cache write must remain distinguishable from
		// unavailable cache-write telemetry.
		expect(envelope.cacheWriteTokens).toBe(0);
		expect(envelope.cost).toBe(0.012);
		expect(Number(envelope.durationMs)).toBeGreaterThan(0);
		expect(envelope.tokensPerSecond).toBeGreaterThan(0);
	} finally {
		if (savedPath === undefined) delete process.env.HERDR_TELEMETRY_PATH;
		else process.env.HERDR_TELEMETRY_PATH = savedPath;
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("embedded bridge bundle contains the pointer-based recovery", async () => {
	const { AGENT_DEFINITIONS } = await import(
		"../src/workflow/embedded.generated.ts"
	);
	const source = AGENT_DEFINITIONS["bridges/pi-telemetry.ts"];
	expect(source).toContain("by-agent");
	expect(source).not.toMatch(/8-char suffix|startsWith\(runId8\)/);
});
