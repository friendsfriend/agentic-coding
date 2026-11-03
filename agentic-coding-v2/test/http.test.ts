import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("held local endpoint GETs require exact approval, redact frozen secrets, bound responses and never follow redirects; cancellation revokes access", async () => {
	const socket = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response(""),
		}),
		port = socket.port;
	socket.stop(true);
	const source = `const http=require('node:http'),fs=require('node:fs');http.createServer((q,s)=>{fs.appendFileSync(process.env.REQUESTS,q.url+'\\n');if(q.url==='/hold')return;if(q.url==='/redirect'){s.writeHead(302,{'content-type':'text/plain',location:'http://127.0.0.1:'+process.env.PORT+'/private'});s.end('moved');return;}s.setHeader('content-type','text/plain');s.setHeader('set-cookie','hidden='+process.env.TOKEN);s.end(q.url==='/large'?'中'.repeat(21840)+process.env.TOKEN:'hello '+process.env.TOKEN);}).listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('READY'));`;
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir, { recursive: true });
		fs.writeFileSync(
			path.join(config.configDir, ".env"),
			"HTTP_SECRET=fixture-original-sensitive-token\n",
			{ mode: 0o600 },
		);
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
								id: "local",
								action: "run",
								runtime: "shell",
								command: `node -e '${source.replaceAll("'", `'\\''`)}'`,
								readyText: "READY",
								environment: {
									PORT: String(port),
									REQUESTS: path.join(config.configDir, "requests"),
								},
								secretRefs: { TOKEN: "HTTP_SECRET" },
								endpoints: { web: `http://127.0.0.1:${port}` },
							},
						],
					},
					{
						id: "other",
						kind: "app",
						repository: config.repositories[0],
						targets: [
							{
								id: "same-port",
								action: "run",
								runtime: "shell",
								command: 'printf ran > "$CONFIG_DIR/should-not-run"; sleep 60',
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
		call("env_http_get", { app: "api", endpoint: "web" }),
		() => call("env_start", { apps: ["api"] }),
		() => call("env_http_get", { app: "api", endpoint: "web", path: "/hello" }),
	]);
	const followup: Parameters<typeof fake.setResponses>[0] = [
		(messages) => {
			transcript = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "env_http_get",
				),
			);
			return call("env_http_get", {
				app: "api",
				endpoint: "web",
				path: "/redirect",
			});
		},
		(messages) => {
			transcript = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "env_http_get",
				),
			);
			return call("env_http_get", {
				app: "api",
				endpoint: "web",
				path: "/large",
			});
		},
		(messages) => {
			transcript = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "env_http_get",
				),
			);
			return call("env_http_get", {
				app: "api",
				endpoint: "web",
				path: "/hold",
			});
		},
	];
	const task = await app.startTask(invocation),
		log = path.join(config.configDir, "requests");
	await pendingReview(app, task);
	expect(fs.existsSync(log)).toBe(false);
	await approve(app, task);
	await pendingReview(app, task, "Endpoint GET: api/web");
	expect(fs.existsSync(log)).toBe(false);
	fake.setResponses([
		call("env_start", { apps: ["other"], timeoutSec: 1 }),
		fauxAssistantMessage("Done waiting"),
	]);
	const waiter = await app.startTask({
		...invocation,
		requestId: "other-port-waiter",
	});
	await pendingReview(app, waiter);
	await approve(app, waiter);
	await eventually(
		() => app.environments.snapshot(),
		(state) =>
			state.waiters.some(
				(entry) => entry.owner === waiter && entry.apps.includes("other"),
			),
	);
	await app.harness.waitForTask(waiter as TaskId, context);
	expect(fs.existsSync(path.join(config.configDir, "should-not-run"))).toBe(
		false,
	);
	fake.setResponses(followup);
	expect((await app.environments.snapshot()).runs[0]?.endpoints).toEqual({
		web: `http://127.0.0.1:${port}/`,
	});
	fs.writeFileSync(
		path.join(config.configDir, ".env"),
		"HTTP_SECRET=fixture-rotated-token\n",
	);
	for (let i = 0; i < 3; i++) {
		await approve(app, task, "Endpoint GET: api/web");
		await pendingReview(app, task, "Endpoint GET: api/web");
	}
	expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
		"/hello",
		"/redirect",
		"/large",
	]);
	expect(transcript).toContain("hello [REDACTED]");
	expect(transcript).not.toContain("fixture-original");
	expect(transcript).not.toContain("hidden=");
	expect(transcript).toContain("truncated");
	expect(transcript).toContain("65536");
	await approve(app, task, "Endpoint GET: api/web");
	await eventually(
		async () => fs.readFileSync(log, "utf8"),
		(value) => value.includes("/hold"),
	);
	await app.cancel(task);
	await app.harness.waitForTask(task as TaskId, context);
	const run = (await app.environments.snapshot()).runs[0];
	expect(run?.state).toBe("exited");
	expect(run?.endpoints).toEqual({});
}, 20000);
