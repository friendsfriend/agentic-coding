import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("HTTPS diagnostics verify certificate IPs and reject a changed approved public CA without sending the GET", async () => {
	const listeners = [
			Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: () => new Response(""),
			}),
			Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: () => new Response(""),
			}),
		],
		ports = listeners.map((server) => server.port);
	for (const server of listeners) server.stop(true);
	const source = `const https=require('node:https'),fs=require('node:fs'),path=require('node:path');let ready=0;for(const [port,name]of [[process.env.PORT,'good'],[process.env.BAD_PORT,'bad']])https.createServer({cert:fs.readFileSync(path.join(process.env.CONFIG_DIR,name+'.pem')),key:fs.readFileSync(path.join(process.env.CONFIG_DIR,name+'.key'))},(q,s)=>{fs.appendFileSync(path.join(process.env.CONFIG_DIR,'tls-requests'),q.url+'\\n');s.setHeader('content-type','text/plain');s.end('tls-ready');}).listen(Number(port),'127.0.0.1',()=>{if(++ready===2)console.log('TLS READY')});`;
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir, { recursive: true });
		for (const [name, ip] of [
			["good", "127.0.0.1"],
			["bad", "127.0.0.2"],
		]) {
			const settings = path.join(config.configDir, `${name}.cnf`);
			fs.writeFileSync(
				settings,
				`[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=Disposable fixture\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${ip}\n`,
			);
			execFileSync(
				"openssl",
				[
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-nodes",
					"-days",
					"1",
					"-config",
					settings,
					"-keyout",
					path.join(config.configDir, `${name}.key`),
					"-out",
					path.join(config.configDir, `${name}.pem`),
				],
				{ stdio: "ignore" },
			);
			fs.chmodSync(path.join(config.configDir, `${name}.key`), 0o600);
		}
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
								id: "tls",
								action: "run",
								runtime: "shell",
								command: `node -e '${source.replaceAll("'", `'\\''`)}'`,
								readyText: "TLS READY",
								environment: {
									PORT: String(ports[0]),
									BAD_PORT: String(ports[1]),
								},
								endpoints: {
									web: `https://127.0.0.1:${ports[0]}`,
									untrusted: `https://127.0.0.1:${ports[0]}`,
									bad: `https://127.0.0.1:${ports[1]}`,
								},
								endpointCaRefs: { web: "good.pem", bad: "bad.pem" },
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
		() => call("env_http_get", { app: "api", endpoint: "untrusted" }),
		() => call("env_http_get", { app: "api", endpoint: "bad" }),
		() => call("env_http_get", { app: "api", endpoint: "web", path: "/good" }),
		() =>
			call("env_http_get", { app: "api", endpoint: "web", path: "/changed" }),
		(messages) => {
			transcript = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "env_http_get",
				),
			);
			return fauxAssistantMessage("Done");
		},
	]);
	const task = await app.startTask(invocation),
		log = path.join(config.configDir, "tls-requests");
	await pendingReview(app, task);
	await approve(app, task);
	await pendingReview(app, task, "Endpoint GET: api/untrusted");
	await approve(app, task, "Endpoint GET: api/untrusted");
	await pendingReview(app, task, "Endpoint GET: api/bad");
	await approve(app, task, "Endpoint GET: api/bad");
	await pendingReview(app, task, "Endpoint GET: api/web");
	expect(fs.existsSync(log)).toBe(false);
	await approve(app, task, "Endpoint GET: api/web");
	await pendingReview(app, task, "Endpoint GET: api/web");
	expect(fs.readFileSync(log, "utf8")).toBe("/good\n");
	fs.appendFileSync(path.join(config.configDir, "good.pem"), "\n");
	await approve(app, task, "Endpoint GET: api/web");
	await app.harness.waitForTask(task as TaskId, context);
	await eventually(
		() => app.environments.snapshot(),
		(state) => state.runs.every((run) => run.state === "exited"),
	);
	expect(fs.readFileSync(log, "utf8")).toBe("/good\n");
	expect(transcript).toContain("https-verified");
	expect(transcript).toContain("tls-ready");
	expect(transcript.match(/"isError":true/g)).toHaveLength(3);
	expect(transcript).not.toContain("BEGIN CERTIFICATE");
	expect(transcript).not.toContain("PRIVATE KEY");
}, 20000);
