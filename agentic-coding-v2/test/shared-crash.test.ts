import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { EnvironmentRun } from "../src/environment/state.ts";
import { serve } from "../src/server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("SIGKILL crash quarantines shared roots without adoption; inspected release precedes a fresh generation", async () => {
	const fixtureState = await fixture(true, (config) => {
		fs.mkdirSync(config.configDir);
		const node = (source: string) =>
			`${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify({
				version: 1,
				projects: [
					{
						id: "api",
						kind: "app",
						repository: config.repositories[0],
						requires: ["store"],
						targets: [
							{
								id: "serve",
								action: "run",
								runtime: "shell",
								command: node(
									"console.log('APP_READY');setInterval(()=>{},1000)",
								),
								readyText: "APP_READY",
							},
						],
					},
					{
						id: "store",
						kind: "infrastructure",
						repository: config.repositories[0],
						targets: [
							{
								id: "serve",
								action: "run",
								runtime: "shell",
								command: node(
									"console.log('STORE_READY');setInterval(()=>{},1000)",
								),
								readyText: "STORE_READY",
							},
						],
					},
				],
			}),
		);
	});
	const readyFile = path.join(
			fixtureState.config.stateDir,
			"shared-crash-ready.json",
		),
		inputFile = path.join(
			fixtureState.config.stateDir,
			"shared-crash-input.json",
		);
	fs.writeFileSync(
		inputFile,
		JSON.stringify({
			config: fixtureState.config,
			invocation: fixtureState.invocation,
			readyFile,
			apps: ["api"],
			lifetime: "shared-prerequisites-v1",
		}),
	);
	const host = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "fixtures/environment-host.ts"),
			inputFile,
		],
		{
			cwd: fixtureState.invocation.repository,
			env: { PATH: process.env.PATH, HOME: fixtureState.config.stateDir },
			stdout: "ignore",
			stderr: "inherit",
		},
	);
	try {
		await eventually(async () => fs.existsSync(readyFile), Boolean);
		const ready = JSON.parse(fs.readFileSync(readyFile, "utf8")) as {
			id: number;
			run: EnvironmentRun;
			runs: EnvironmentRun[];
		};
		expect(ready.runs).toHaveLength(2);
		expect(ready.runs.every((run) => run.state === "running")).toBe(true);
		const crashedIds = ready.runs.map((run) => run.id).sort();
		host.kill("SIGKILL");
		await host.exited;
		for (const run of ready.runs)
			if (typeof run.pid === "number")
				try {
					process.kill(run.pid, "SIGKILL");
				} catch {
					/* Leftover already exited; quarantine still requires inspection. */
				}
		const restored = await fixtureState.open();
		const quarantined = (await restored.environments.snapshot()).runs
			.filter((run) => crashedIds.includes(run.id))
			.sort((a, b) => a.id.localeCompare(b.id));
		expect(quarantined).toHaveLength(2);
		expect(quarantined.every((run) => run.state === "interrupted")).toBe(true);
		for (const run of quarantined) {
			expect(run.exitCode).toBeNull();
			expect(run.error).toMatch(/ambiguous environment effects/);
			const statuses =
				run.runtimeStatuses ?? (run.runtimeStatus ? [run.runtimeStatus] : []);
			for (const status of statuses) expect(status.state).toBe("unknown");
		}
		await expect(
			restored.environments.stopOnce("crash-stop", ready.id, ["api"]),
		).rejects.toThrow("saved PID");
		await restored.cancel(ready.id);
		const cancelled = await restored.harness.waitForTask(
			ready.id as TaskId,
			context,
		);
		expect(cancelled.state.outcome).toMatchObject({
			status: "aborted",
			reason: expect.stringContaining("quarantin"),
		});
		const server = serve(restored);
		try {
			const url = new URL(server.url),
				endpoint = `${url.origin}/api/environments/release`,
				headers = {
					Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
					"Content-Type": "application/json",
				};
			const releaseOrder = (await restored.environments.snapshot()).runs
				.filter((entry) => crashedIds.includes(entry.id))
				.sort(
					(a, b) =>
						(b.plan.requires?.length ?? 0) - (a.plan.requires?.length ?? 0),
				);
			for (const run of releaseOrder) {
				const response = await fetch(endpoint, {
					method: "POST",
					headers,
					body: JSON.stringify({
						id: run.id,
						revision: run.revision,
						inspectionConfirmed: true,
					}),
				});
				expect(response.status).toBe(200);
			}
		} finally {
			await server.stop();
		}
		fixtureState.fake.setResponses([
			call("env_start", { apps: ["api"] }),
			call("request_review", { path: ".", title: "Hold shared recovery" }),
		]);
		const fresh = await restored.startTask({
			...fixtureState.invocation,
			requestId: "task-2",
		});
		await approve(restored, fresh);
		await pendingReview(restored, fresh, "Hold shared recovery");
		const live = (await restored.environments.snapshot()).runs.filter(
			(run) => run.state === "running",
		);
		expect(live).toHaveLength(2);
		expect(live.map((run) => run.id).sort()).not.toEqual(crashedIds);
		await restored.cancel(fresh);
	} finally {
		if (host.exitCode === null) {
			host.kill("SIGTERM");
			await host.exited;
		}
	}
}, 60000);
