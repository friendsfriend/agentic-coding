import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("redirecting writes share one deadline, retain uncertain issuance and release owned resources after timeout", async () => {
	const socket = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response(""),
		}),
		port = socket.port;
	socket.stop(true);
	const source = `const http=require('node:http'),fs=require('node:fs');http.createServer((q,s)=>{q.resume();q.on('end',()=>{fs.appendFileSync(process.env.CONFIG_DIR+'/requests',q.url+'\\n');if(q.url==='/never'){s.end('unexpected');return;}setTimeout(()=>{s.writeHead(307,{location:q.url==='/slow1'?'/slow2':'/never'});s.end();},6000);});}).listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('READY'));`;
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
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
								environment: { PORT: String(port) },
								endpoints: { web: `http://127.0.0.1:${port}` },
							},
						],
					},
				],
			}),
		);
	});
	const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
	let transcript = "";
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("env_http_request", {
			app: "api",
			endpoint: "web",
			path: "/slow1",
			method: "POST",
			body: "bounded-write",
			allowWrite: true,
			followRedirects: true,
		}),
		(messages) => {
			transcript = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "env_http_request",
				),
			);
			return fauxAssistantMessage(
				"Observed the timeout, not a rolled-back write",
			);
		},
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Endpoint POST: api/web");
	await approve(app, task, "Endpoint POST: api/web");
	await app.harness.waitForTask(task as TaskId, context);
	expect(
		fs.readFileSync(path.join(config.configDir, "requests"), "utf8"),
	).not.toContain("/never");
	expect(transcript).toContain("failed or was interrupted");
	const summary = await app.environments.snapshot();
	expect(summary.httpOperations[0]).toMatchObject({
		state: "issued",
		method: "POST",
	});
	expect(summary.runs.every((run) => run.state === "exited")).toBe(true);
}, 25000);
