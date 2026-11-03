import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures } from "./fixtures/runtime.ts";
import { certificate } from "./fixtures/tls.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("approved HTTPS writes preserve bounded same-origin redirect semantics and frozen credentials, never foreign or caller credentials", async () => {
	let foreignRequests = 0;
	const foreign = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => {
				foreignRequests++;
				return new Response("foreign");
			},
		}),
		reservation = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response(""),
		}),
		port = reservation.port;
	reservation.stop(true);
	try {
		const token = "disposable-original-bearer-token",
			user = "disposable-original-user",
			password = "disposable-original-password",
			basic = Buffer.from(`${user}:${password}`).toString("base64");
		const source = `const https=require('node:https'),fs=require('node:fs'),path=require('node:path'),root=process.env.CONFIG_DIR;https.createServer({cert:fs.readFileSync(path.join(root,'local.pem')),key:fs.readFileSync(path.join(root,'local.key'))},(q,s)=>{let body='';q.on('data',chunk=>body+=chunk);q.on('end',()=>{const auth=q.headers.authorization||'',bearer=auth==='Bearer '+process.env.TOKEN,basic=auth==='Basic '+Buffer.from(process.env.USERNAME+':'+process.env.PASSWORD).toString('base64');fs.appendFileSync(path.join(root,'requests'),JSON.stringify({url:q.url,method:q.method,body,bearer,basic})+'\\n');s.setHeader('content-type','application/json');if(q.url==='/bounce307'||q.url==='/bounce303'){s.writeHead(q.url==='/bounce307'?307:303,{location:'/echo'});s.end('ignored');return;}if(q.url==='/foreign'){s.writeHead(302,{location:process.env.FOREIGN});s.end();return;}if(q.url==='/loop'){s.writeHead(302,{location:'/loop'});s.end();return;}if(q.url==='/changed-ca'){fs.appendFileSync(path.join(root,'local.pem'),'\\n');s.writeHead(302,{location:'/never'});s.end();return;}s.end(JSON.stringify({method:q.method,body,authorization:auth,bearer,basic}));});}).listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('TLS READY'));`;
		const { app, config, fake, invocation } = await fixture(false, (config) => {
			fs.mkdirSync(config.configDir);
			certificate(config.configDir, "local");
			fs.writeFileSync(
				path.join(config.configDir, ".env"),
				`TOKEN_REF=${token}\nUSER_REF=${user}\nPASS_REF=${password}\n`,
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
									id: "tls",
									action: "run",
									runtime: "shell",
									command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`,
									readyText: "TLS READY",
									environment: {
										PORT: String(port),
										FOREIGN: `http://127.0.0.1:${foreign.port}/stolen`,
									},
									secretRefs: {
										TOKEN: "TOKEN_REF",
										USERNAME: "USER_REF",
										PASSWORD: "PASS_REF",
									},
									endpoints: {
										bearer: `https://127.0.0.1:${port}`,
										basic: `https://127.0.0.1:${port}`,
									},
									endpointCaRefs: { bearer: "local.pem", basic: "local.pem" },
									endpointAuthRefs: {
										bearer: { type: "bearer", variable: "TOKEN" },
										basic: {
											type: "basic",
											usernameVariable: "USERNAME",
											passwordVariable: "PASSWORD",
										},
									},
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
				endpoint: "bearer",
				path: "/forbidden-write",
				method: "POST",
				body: "not sent",
			}),
			call("env_http_request", {
				app: "api",
				endpoint: "bearer",
				path: "/bounce307",
				method: "POST",
				allowWrite: true,
				followRedirects: true,
				authenticate: true,
				headers: { "content-type": "application/json" },
				body: '{"change":1}',
			}),
			call("env_http_request", {
				app: "api",
				endpoint: "basic",
				path: "/bounce303",
				method: "POST",
				allowWrite: true,
				followRedirects: true,
				authenticate: true,
				body: "second-write",
			}),
			call("env_http_request", {
				app: "api",
				endpoint: "bearer",
				path: "/foreign",
				followRedirects: true,
				authenticate: true,
			}),
			call("env_http_request", {
				app: "api",
				endpoint: "bearer",
				path: "/loop",
				followRedirects: true,
			}),
			call("env_http_request", {
				app: "api",
				endpoint: "bearer",
				path: "/changed-ca",
				followRedirects: true,
				authenticate: true,
			}),
			call("env_http_request", {
				app: "api",
				endpoint: "bearer",
				headers: { Authorization: "never-forward-this" },
			}),
			(messages) => {
				transcript = JSON.stringify(
					messages.messages.filter(
						(message) =>
							message.role === "toolResult" &&
							message.toolName === "env_http_request",
					),
				);
				return call("request_review", {
					path: ".",
					title: "Hold HTTP operation",
				});
			},
		]);
		const task = await app.startTask(invocation),
			journal = path.join(config.configDir, "requests");
		await approve(app, task);
		const first = await pendingReview(app, task, "Endpoint POST: api/bearer");
		expect(fs.existsSync(journal)).toBe(false);
		expect(first.snapshot).toContain('"change');
		expect(first.snapshot).not.toContain(token);
		expect(first.snapshot).not.toContain(basic);
		fs.writeFileSync(
			path.join(config.configDir, ".env"),
			"TOKEN_REF=rotated-token\nUSER_REF=rotated-user\nPASS_REF=rotated-password\n",
		);
		await approve(app, task, "Endpoint POST: api/bearer");
		await pendingReview(app, task, "Endpoint POST: api/basic");
		await approve(app, task, "Endpoint POST: api/basic");
		await pendingReview(app, task, "Endpoint GET: api/bearer");
		await approve(app, task, "Endpoint GET: api/bearer");
		await pendingReview(app, task, "Endpoint GET: api/bearer");
		await approve(app, task, "Endpoint GET: api/bearer");
		await pendingReview(app, task, "Endpoint GET: api/bearer");
		await approve(app, task, "Endpoint GET: api/bearer");
		await pendingReview(app, task, "Hold HTTP operation");
		const requests = fs
			.readFileSync(journal, "utf8")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						url: string;
						method: string;
						body: string;
						bearer: boolean;
						basic: boolean;
					},
			);
		expect(requests.slice(0, 4)).toMatchObject([
			{ url: "/bounce307", method: "POST", body: '{"change":1}', bearer: true },
			{ url: "/echo", method: "POST", body: '{"change":1}', bearer: true },
			{ url: "/bounce303", method: "POST", body: "second-write", basic: true },
			{ url: "/echo", method: "GET", body: "", basic: true },
		]);
		expect(requests.filter((request) => request.url === "/loop")).toHaveLength(
			4,
		);
		expect(requests.some((request) => request.url === "/forbidden-write")).toBe(
			false,
		);
		expect(requests.some((request) => request.url === "/never")).toBe(false);
		const summary = await app.environments.snapshot("api");
		expect(summary.httpOperationsTotal).toBe(5);
		expect(
			summary.httpOperations.filter(
				(operation) => operation.state === "completed",
			),
		).toHaveLength(2);
		expect(
			summary.httpOperations.filter(
				(operation) => operation.state === "issued",
			),
		).toHaveLength(3);
		expect(JSON.stringify(summary.httpOperations)).not.toContain(
			"second-write",
		);
		expect(foreignRequests).toBe(0);
		expect(transcript).toContain("allowWrite");
		expect(transcript).toContain("cannot leave the approved origin");
		expect(transcript).toContain("redirect limit exceeded");
		expect(transcript).toContain("[REDACTED]");
		expect(transcript).not.toContain(token);
		expect(transcript).not.toContain(password);
		expect(transcript).not.toContain(basic);
		expect(transcript).not.toContain("never-forward-this");
		await app.cancel(task);
		expect(
			(await app.environments.snapshot()).runs.every(
				(run) => run.state === "exited",
			),
		).toBe(true);
	} finally {
		foreign.stop(true);
	}
}, 20000);
