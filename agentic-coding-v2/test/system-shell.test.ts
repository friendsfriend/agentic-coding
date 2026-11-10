import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { serve } from "../src/server/index.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
for (const runtime of ["shell", "systemshell"] as const)
	test(`native ${runtime} selection preserves interpreter authority, exact review, ready/log scope, reuse and original-group cancellation`, async () => {
		const { app, config, fake, invocation } = await fixture(false, (config) => {
			fs.mkdirSync(config.configDir);
			fs.chmodSync(config.stateDir, 0o700);
			const bin = path.join(config.configDir, "bin");
			fs.mkdirSync(bin);
			fs.writeFileSync(
				path.join(bin, "sh"),
				`#!${process.execPath}\nimport fs from 'node:fs';import{spawnSync}from'node:child_process';fs.appendFileSync(process.env.SYS_RECEIPT,JSON.stringify({pid:process.pid,args:process.argv.slice(2),cwd:process.cwd()})+'\\n',{mode:0o600});const result=spawnSync('/bin/sh',process.argv.slice(2),{stdio:'inherit',env:process.env});process.exit(result.status??1);\n`,
				{ mode: 0o700 },
			);
			fs.writeFileSync(
				path.join(config.configDir, ".env"),
				"TEST_SYSTEM_TOKEN=disposable-system-interpreter-secret\n",
				{ mode: 0o600 },
			);
			const code =
					"console.log('NATIVE READY '+process.env.TOKEN);setInterval(()=>{},1000)",
				command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
			fs.writeFileSync(
				path.join(config.configDir, "environments.json"),
				JSON.stringify({
					version: 1,
					projects: [
						{
							id: "api",
							kind: "app",
							repository: config.repositories[0],
							targets: ["shell", "systemshell"].map((runtime) => ({
								id: `run-${runtime}`,
								action: "run",
								runtime,
								profile: "default",
								readyText: "NATIVE READY",
								command,
								environment: {
									PATH: `${bin}:${process.env.PATH ?? ""}`,
									SYS_RECEIPT: path.join(config.configDir, "system.jsonl"),
								},
								secretRefs: { TOKEN: "TEST_SYSTEM_TOKEN" },
							})),
						},
					],
				}),
			);
		});
		fake.setResponses([
			call("env_start", { apps: ["api"], runtime }),
			call("env_start", { apps: ["api"], runtime }),
			call("request_review", { title: "Hold original interpreter", path: "." }),
		]);
		const task = await app.startTask(invocation),
			review = await pendingReview(app, task),
			disclosure = JSON.parse(review.snapshot);
		if (runtime === "systemshell")
			expect(disclosure.systemShellScope).toContain("displayed/frozen PATH");
		else expect(disclosure.systemShellScope).toBeUndefined();
		const receipt = path.join(config.configDir, "system.jsonl");
		expect(fs.existsSync(receipt)).toBe(false);
		expect((await app.environments.snapshot("api")).runs).toHaveLength(0);
		await approve(app, task);
		await approve(app, task);
		await pendingReview(app, task, "Hold original interpreter");
		const runs = (await app.environments.snapshot("api")).runs;
		expect(runs).toHaveLength(1);
		expect(runs[0]?.plan.runtime).toBe(runtime);
		expect(runs[0]?.ready).toBe(true);
		const logs = JSON.stringify(await app.environments.logs("api", task));
		expect(logs).toContain("NATIVE READY");
		expect(logs).not.toContain("disposable-system-interpreter-secret");
		const pid = runs[0]?.pid;
		if (!pid) throw new Error("Missing owned interpreter PID");
		if (runtime === "systemshell") {
			const rows = fs
				.readFileSync(receipt, "utf8")
				.trim()
				.split("\n")
				.map((row) => JSON.parse(row));
			expect(rows).toHaveLength(1);
			expect(rows[0].pid).toBe(pid);
			expect(rows[0].cwd).toBe(runs[0]?.plan.cwd);
			expect(rows[0].args[0]).toBe("-c");
			expect(rows[0].args[1]).toBe(runs[0]?.plan.command);
		} else expect(fs.existsSync(receipt)).toBe(false);
		await app.cancel(task);
		await eventually(
			async () => (await app.environments.snapshot("api")).runs,
			(runs) => runs.every((run) => run.state === "exited"),
		);
		expect(() => process.kill(pid, 0)).toThrow();
	}, 15000);

for (const mode of ["build", "container", "mixed-ready"] as const)
	test(`authenticated native staging refuses system interpreter ${mode} before process effects`, async () => {
		const { app, config } = await fixture(false, (config) => {
			fs.mkdirSync(config.configDir);
			fs.chmodSync(config.stateDir, 0o700);
		});
		const host = serve(app);
		try {
			const target = {
				id: "system",
				action: mode === "build" ? "build" : "run",
				runtime: "systemshell",
				command: "echo private-source-marker",
				...(mode === "container"
					? {
							container: {
								image: "fixture:latest",
								socket: path.join(config.stateDir, "absent.sock"),
							},
						}
					: {}),
				...(mode === "mixed-ready"
					? { readyText: "READY", readyUrl: "http://127.0.0.1:12345/" }
					: {}),
			};
			const post = (route: string, body: unknown) =>
				fetch(new URL(route, host.url), {
					method: "POST",
					headers: {
						Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				});
			const staged = await (
				await post("/api/environments/drafts", {
					requestId: "create",
					content: JSON.stringify({
						version: 1,
						projects: [
							{
								id: "api",
								kind: "app",
								repository: config.repositories[0],
								targets: [target],
							},
						],
					}),
				})
			).json();
			const checked = await (
				await post("/api/environments/drafts/preflight", {
					requestId: "check",
					id: staged.id,
					revision: staged.revision,
					digest: staged.digest,
				})
			).json();
			expect(checked.schemaAccepted).toBeNull();
			expect(checked.completed).toBe(false);
			expect(JSON.stringify(checked)).not.toContain("private-source-marker");
			expect((await app.environments.snapshot()).runs).toHaveLength(0);
		} finally {
			host.stop();
		}
	});

for (const accepted of [true, false])
	test(`native system interpreter approval ${accepted ? "permits process-start only, not service health" : "rejection prevents all process effects"}`, async () => {
		const { app, config, fake, invocation } = await fixture(false, (config) => {
			fs.mkdirSync(config.configDir);
			const code = `require('node:fs').writeFileSync(${JSON.stringify(path.join(config.configDir, "started"))},'fixture');setInterval(()=>{},1000)`;
			fs.writeFileSync(
				path.join(config.configDir, "environments.json"),
				JSON.stringify({
					version: 1,
					projects: [
						{
							id: "api",
							kind: "app",
							repository: config.repositories[0],
							targets: [
								{
									id: "system",
									action: "run",
									runtime: "systemshell",
									command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`,
								},
							],
						},
					],
				}),
			);
		});
		fake.setResponses([
			call("env_start", {
				apps: ["api"],
				runtime: "systemshell",
				lifetime: "independent-roots-v1",
			}),
			call("request_review", { title: "Observe approval result", path: "." }),
		]);
		const task = await app.startTask(invocation),
			review = await pendingReview(app, task);
		expect(fs.existsSync(path.join(config.configDir, "started"))).toBe(false);
		expect(JSON.parse(review.snapshot).idleScope).toContain(
			"Explicit independent-roots-v1",
		);
		await app.decide(
			review.id,
			review.revision,
			accepted ? "approved" : "rejected",
			"Isolated native system interpreter decision",
		);
		await pendingReview(app, task, "Observe approval result");
		if (accepted) {
			const runs = (await app.environments.snapshot("api")).runs;
			expect(runs).toHaveLength(1);
			expect(runs[0]?.state).toBe("running");
			expect(runs[0]?.ready).toBeNull();
			expect(runs[0]?.plan.lifetime).toBe("independent-roots-v1");
		} else
			expect((await app.environments.snapshot("api")).runs).toHaveLength(0);
		if (accepted)
			await eventually(
				() =>
					Promise.resolve(
						fs.existsSync(path.join(config.configDir, "started")),
					),
				Boolean,
			);
		else
			expect(fs.existsSync(path.join(config.configDir, "started"))).toBe(false);
		await app.cancel(task);
	});
