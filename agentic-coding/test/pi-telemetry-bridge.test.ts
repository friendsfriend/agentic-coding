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

test("embedded bridge bundle contains the pointer-based recovery", async () => {
	const { AGENT_DEFINITIONS } = await import(
		"../src/workflow/embedded.generated.ts"
	);
	const source = AGENT_DEFINITIONS["bridges/pi-telemetry.ts"];
	expect(source).toContain("by-agent");
	expect(source).not.toMatch(/8-char suffix|startsWith\(runId8\)/);
});
