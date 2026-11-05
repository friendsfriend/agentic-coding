import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../src/config.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup, apps } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
function standalone(config: Config, partialStartup = false, port?: number) {
	fs.mkdirSync(config.configDir);
	fs.writeFileSync(
		path.join(config.configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			projects: ["api", "worker"].map((id) => {
				const server =
					id === "api" && port
						? `Bun.serve({hostname:'127.0.0.1',port:${port},fetch(){fs.appendFileSync(process.env.REQUESTS,'request\\n');return new Response('fixture')}});`
						: "";
				const source = `const fs=require('node:fs');fs.appendFileSync(process.env.STARTS,'start\\n');${server}console.log('${partialStartup && id === "worker" ? "ROOT_BOOTING" : "ROOT_READY"}');setInterval(()=>{},1000)`;
				return {
					id,
					kind: "app",
					repository: config.repositories[0],
					targets: [
						{
							id: "serve",
							action: "run",
							runtime: "shell",
							timeoutMs: 10000,
							readyText: "ROOT_READY",
							command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`,
							environment: {
								STARTS: path.join(config.configDir, `${id}-starts`),
								REQUESTS: path.join(config.configDir, "requests"),
							},
							...(id === "api"
								? {
										telemetry: {
											protocol: "otlp-http-json",
											listen: "127.0.0.1:0",
										},
									}
								: {}),
							...(id === "api" && port
								? { endpoints: { web: `http://127.0.0.1:${port}` } }
								: {}),
						},
					],
				};
			}),
		}),
	);
}

test("stopping a partially started independent acquisition rolls back every root; replay cannot stop a fresh generation and task cancellation joins partial startup", async () => {
	const { app, fake, invocation } = await fixture(false, (config) =>
		standalone(config, true),
	);
	fake.setResponses([
		call("env_start", {
			apps: ["api", "worker"],
			lifetime: "independent-roots-v1",
		}),
		call("request_review", { path: ".", title: "After interrupted startup" }),
		call("env_start", {
			apps: ["api", "worker"],
			lifetime: "independent-roots-v1",
		}),
	]);
	const owner = await app.startTask(invocation);
	async function partial() {
		const state = await eventually(
			() => app.environments.snapshot(),
			(state) => {
				const held = state.runs.filter(
					(run) =>
						run.owner === owner &&
						(run.state === "running" || run.state === "reserved"),
				);
				return (
					held.length === 2 &&
					held.every((run) => !!run.pid) &&
					held.some((run) => run.state === "running") &&
					held.some((run) => run.state === "reserved")
				);
			},
		);
		await eventually(
			() => app.environments.logs("worker", owner),
			(logs) => JSON.stringify(logs).includes("ROOT_BOOTING"),
		);
		return state.runs.filter(
			(run) => run.state === "running" || run.state === "reserved",
		);
	}
	await approve(app, owner);
	const first = await partial();
	expect(first.every((run) => run.idle.lastActivityAt === null)).toBe(true);
	const stopped = await app.environments.stopOnce(
		"stop-partial-independent",
		owner,
		["worker"],
	);
	expect(new Set(stopped)).toEqual(new Set(first.map((run) => run.id)));
	await pendingReview(app, owner, "After interrupted startup");
	expect(
		(await app.environments.snapshot()).runs.every(
			(run) => run.state === "exited",
		),
	).toBe(true);
	for (const run of first)
		expect(() => process.kill(-(run.pid ?? 0), 0)).toThrow();
	await approve(app, owner, "After interrupted startup");
	await approve(app, owner);
	const second = await partial();
	expect(
		second.every(
			(run) => !stopped.includes(run.id) && run.idle.lastActivityAt === null,
		),
	).toBe(true);
	expect(
		await app.environments.stopOnce("stop-partial-independent", owner, [
			"worker",
		]),
	).toEqual(stopped);
	for (const run of second)
		expect(() => process.kill(-(run.pid ?? 0), 0)).not.toThrow();
	await app.cancel(owner);
	const ended = await app.harness.waitForTask(owner as TaskId, context);
	expect(ended.state.outcome?.status).toBe("aborted");
	expect(
		(await app.environments.snapshot()).runs.every(
			(run) => run.state === "exited" && run.idle.lastActivityAt === null,
		),
	).toBe(true);
	for (const run of second)
		expect(() => process.kill(-(run.pid ?? 0), 0)).toThrow();
}, 15000);

test("independent roots lose clocks and diagnostic authority after SIGKILL; replay, fresh approval, expiry and cancellation never adopt or stop survivors", async () => {
	const probe = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(""),
	});
	const port = probe.port;
	probe.stop(true);
	const state = await fixture(true, (config) =>
		standalone(config, false, port),
	);
	await state.app.close();
	apps.splice(apps.indexOf(state.app), 1);
	const inputFile = path.join(state.config.stateDir, "independent-host.json"),
		readyFile = path.join(state.config.stateDir, "independent-ready.json");
	fs.writeFileSync(
		inputFile,
		JSON.stringify({
			config: state.config,
			invocation: state.invocation,
			readyFile,
			apps: ["api", "worker"],
			lifetime: "independent-roots-v1",
		}),
	);
	const host = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "fixtures/environment-host.ts"),
			inputFile,
		],
		{
			cwd: state.invocation.repository,
			env: { PATH: process.env.PATH, HOME: state.config.stateDir },
			stdout: "ignore",
			stderr: "inherit",
		},
	);
	const ownedPids: number[] = [];
	try {
		await eventually(async () => fs.existsSync(readyFile), Boolean);
		const ready = JSON.parse(fs.readFileSync(readyFile, "utf8")) as {
			id: number;
			runs: Awaited<ReturnType<typeof state.app.environments.snapshot>>["runs"];
		};
		expect(ready.runs).toHaveLength(2);
		for (const run of ready.runs) {
			if (!run.pid) throw new Error("Missing live fixture PID");
			ownedPids.push(run.pid); // Captured from our live host, never from reopened records.
			expect(run.state).toBe("running");
			expect(run.idle.lastActivityAt).not.toBeNull();
		}
		host.kill("SIGKILL");
		await host.exited;
		let transcript = "",
			diagnosticsRefused = false;
		state.fake.setResponses([
			call("env_start", {
				apps: ["api", "worker"],
				lifetime: "independent-roots-v1",
			}),
			call("env_http_get", { app: "api", endpoint: "web" }),
			call("otel_query", { app: "api" }),
			(messages) => {
				const diagnostics = messages.messages.filter(
					(message) =>
						message.role === "toolResult" &&
						(message.toolName === "env_http_get" ||
							message.toolName === "otel_query"),
				);
				diagnosticsRefused =
					diagnostics.length === 2 &&
					diagnostics.every(
						(message) => message.role === "toolResult" && message.isError,
					);
				transcript = JSON.stringify(
					messages.messages.filter((message) => message.role === "toolResult"),
				);
				return call("request_review", {
					path: ".",
					title: "Recovery evidence",
				});
			},
		]);
		const restored = await state.open();
		const quarantine = (await restored.environments.snapshot()).runs;
		expect(quarantine).toHaveLength(2);
		expect(
			quarantine.every(
				(run) =>
					run.state === "interrupted" &&
					run.idle.scope === "independent-native-root" &&
					run.idle.lastActivityAt === null &&
					run.idle.remainingMs === null &&
					Object.keys(run.endpoints).length === 0,
			),
		).toBe(true);
		const first = ready.runs[0];
		if (!first) throw new Error("No original acquisition");
		expect(
			(
				await restored.environments.receipt(
					first.batch,
					ready.id,
					first.request,
				)
			)?.every((run) => run.state === "interrupted"),
		).toBe(true);
		await expect(
			restored.environments.stopOnce("deny-saved-independent-stop", ready.id, [
				"worker",
			]),
		).rejects.toThrow("saved PID");
		await approve(restored, ready.id, "Keep crash fixture alive");
		await approve(restored, ready.id);
		await pendingReview(restored, ready.id, "Recovery evidence");
		expect(transcript).toContain(
			"Release your existing app batch before acquiring another",
		);
		expect(transcript).toContain("saved receipts grant no network authority");
		expect(diagnosticsRefused).toBe(true);
		await restored.tick(Date.now() + 60 * 60_000);
		expect(
			(await restored.environments.snapshot()).runs.every(
				(run) =>
					run.state === "interrupted" && run.idle.lastActivityAt === null,
			),
		).toBe(true);
		await restored.cancel(ready.id);
		const ended = await restored.harness.waitForTask(
			ready.id as TaskId,
			context,
		);
		expect(ended.state.outcome).toMatchObject({
			status: "aborted",
			reason: expect.stringContaining("Resources remain quarantined"),
		});
		for (const pid of ownedPids)
			expect(() => process.kill(-pid, 0)).not.toThrow();
		for (const id of ["api", "worker"])
			expect(
				fs.readFileSync(
					path.join(state.config.configDir, `${id}-starts`),
					"utf8",
				),
			).toBe("start\n");
		expect(fs.existsSync(path.join(state.config.configDir, "requests"))).toBe(
			false,
		);
	} finally {
		if (host.exitCode === null) {
			host.kill("SIGTERM");
			await host.exited;
		}
		for (const pid of ownedPids) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* Our isolated fixture may already have exited. */
			}
		}
	}
}, 15000);
