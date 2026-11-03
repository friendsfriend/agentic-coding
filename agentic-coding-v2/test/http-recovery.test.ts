import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup, apps } = createFixtures();
afterEach(cleanup);
test("SIGKILL after HTTP write dispatch retains uncertain issuance and native replay never resends or adopts the app", async () => {
	let requests = 0,
		startedFile = "",
		hold = true,
		release = () => {};
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			requests++;
			const body = await request.text();
			fs.writeFileSync(startedFile, body);
			if (hold)
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			return new Response("write accepted", {
				headers: { "content-type": "text/plain" },
			});
		},
	});
	try {
		const state = await fixture(true, (config) => {
			fs.mkdirSync(config.configDir);
			const source = `const fs=require('node:fs');console.log('READY');setInterval(()=>{try{fs.writeSync(1,'.')}catch{fs.writeFileSync(process.env.CONFIG_DIR+'/self-reaped','ok');process.exit(0)}},10);`;
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
									id: "serve",
									action: "run",
									runtime: "shell",
									command: `exec node -e ${JSON.stringify(source)}`,
									readyText: "READY",
									endpoints: { web: `http://127.0.0.1:${server.port}` },
								},
							],
						},
					],
				}),
			);
		});
		await state.app.close();
		apps.splice(apps.indexOf(state.app), 1);
		startedFile = path.join(state.config.configDir, "dispatched");
		const readyFile = path.join(state.config.stateDir, "http-ready.json"),
			inputFile = path.join(state.config.stateDir, "http-host.json");
		fs.writeFileSync(
			inputFile,
			JSON.stringify({
				config: state.config,
				invocation: state.invocation,
				readyFile,
				http: { startedFile },
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
		try {
			await eventually(async () => fs.existsSync(readyFile), Boolean);
			const ready = JSON.parse(fs.readFileSync(readyFile, "utf8")) as {
				id: number;
			};
			expect(fs.readFileSync(startedFile, "utf8")).toBe("mutate-once");
			expect(requests).toBe(1);
			host.kill("SIGKILL");
			await host.exited;
			hold = false;
			release();
			await eventually(
				async () =>
					fs.existsSync(path.join(state.config.configDir, "self-reaped")),
				Boolean,
			);
			let transcript = "";
			state.fake.setResponses([
				(messages) => {
					transcript = JSON.stringify(
						messages.messages.filter(
							(message) =>
								message.role === "toolResult" &&
								message.toolName === "env_http_request",
						),
					);
					return fauxAssistantMessage("Recovered without replaying the write");
				},
			]);
			const restored = await state.open();
			await restored.harness.waitForTask(ready.id as TaskId, context);
			const snapshot = await restored.environments.snapshot();
			expect(snapshot.httpOperations).toHaveLength(1);
			expect(snapshot.httpOperations[0]).toMatchObject({
				state: "issued",
				owner: ready.id,
				method: "POST",
			});
			expect(snapshot.runs[0]).toMatchObject({
				state: "interrupted",
				endpoints: {},
			});
			expect(transcript).toContain("will not be resent");
			expect(requests).toBe(1);
			await expect(
				restored.environments.stopOnce("refuse-http-crash-adoption", ready.id, [
					"api",
				]),
			).rejects.toThrow();
			expect(requests).toBe(1);
		} finally {
			if (host.exitCode === null) {
				host.kill("SIGTERM");
				await host.exited;
			}
		}
	} finally {
		hold = false;
		release();
		server.stop(true);
	}
}, 20000);
