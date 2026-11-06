// Owned-pod endpoint admission: the declaration must name the one loopback port
// forward the run starts, and every dispatch re-observes the owned pod and that
// forward. The fixture cluster proves the fences, not real cluster networking.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Config } from "../src/config.ts";
import { validateProjects } from "../src/environment/catalog.ts";
import { configureLocalCluster } from "./fixtures/cluster.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { disposablePort } from "./fixtures/postgres.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
	try {
		await cleanup();
	} finally {
		for (const server of servers.splice(0)) server.stop(true);
	}
});
// Minimal Kubernetes HTTP/CLI boundary: bounded PodList, UID-preconditioned
// deletion, a log follower and a real loopback TCP proxy for the one declared
// port forward. No scheduler, container runtime or cluster networking.
const client = `import fs from "node:fs";
import net from "node:net";
const file=process.env.FIXTURE_STATE,s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{pods:{},serial:0};
const args=process.argv.slice(2);
if(args.includes("port-forward")){
const pair=args.find((value)=>/^\\d+:\\d+$/.test(value));
if(!pair)process.exit(2);
const local=Number(pair.split(":")[0]);
const server=net.createServer((socket)=>{
const upstream=net.connect(Number(process.env.FIXTURE_FORWARD_PORT),process.env.FIXTURE_FORWARD_HOST??"127.0.0.1");
socket.on("error",()=>socket.destroy());upstream.on("error",()=>upstream.destroy());
socket.pipe(upstream);upstream.pipe(socket);
});
server.listen(local,"127.0.0.1",()=>console.log("Forwarding from 127.0.0.1:"+local));
if(process.env.FIXTURE_FORWARD_EXIT_MS)setTimeout(()=>{server.close();process.exit(0);},Number(process.env.FIXTURE_FORWARD_EXIT_MS));
else setInterval(()=>{},1000);
}
else if(args.includes("logs")){const lines=JSON.parse(process.env.FIXTURE_LOG_LINES??"[]");for(const line of lines)console.log(line);if(args.includes("--follow"))setInterval(()=>{},1000);process.exitCode=0;}
else{
const method=args.find(v=>["get","create","delete"].includes(v)),uri=args[args.indexOf("--raw")+1],url=new URL(uri,"https://127.0.0.1"),name=url.pathname.split("/").at(-1);
console.error("private-api-output");let result;
if(method==="get"){const filter=url.searchParams.get("fieldSelector");if(!filter?.startsWith("metadata.name="))process.exit(2);const pod=s.pods[filter.slice("metadata.name=".length)];result={kind:"PodList",items:pod?[pod]:[]};}
else{const body=JSON.parse(fs.readFileSync(0,"utf8"));if(method==="create"){const podName=body.metadata.name;if(s.pods[podName])process.exit(1);body.metadata.uid="11111111-2222-3333-4444-"+String(++s.serial).padStart(12,"0");body.metadata.resourceVersion=String(s.serial);body.status={phase:"Running",conditions:[{type:"Ready",status:"True"}],containerStatuses:[]};s.pods[podName]=body;result=body;}
else if(method==="delete"){const pod=s.pods[name];if(!pod||body.preconditions?.uid!==pod.metadata.uid||body.preconditions?.resourceVersion!==pod.metadata.resourceVersion)process.exit(1);delete s.pods[name];result={kind:"Status",status:"Success"};}else process.exit(2);}
if(method!=="get")fs.writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify(result));}`;

function cluster(
	config: Config,
	upstream: number,
	environment: Record<string, string> = {},
) {
	configureLocalCluster(config, client, {
		FIXTURE_STATE: path.join(config.configDir, "pods.json"),
		FIXTURE_FORWARD_PORT: String(upstream),
		FIXTURE_LOG_LINES: JSON.stringify(["pod line one"]),
		...environment,
	});
}
function target(port: number) {
	return {
		id: "pods",
		action: "run",
		runtime: "kubernetes",
		timeoutMs: 8000,
		kubernetes: {
			cluster: "local",
			namespace: "fixtures",
			image: "fixture:latest",
			replicas: 1,
			portForwards: [{ local: port, remote: 8080 }],
		},
		endpoints: { api: `http://127.0.0.1:${port}` },
	};
}
const document = (config: Config, value: unknown) => ({
	version: 1,
	projects: [
		{
			id: "api",
			kind: "app",
			repository: config.repositories[0],
			targets: [value],
		},
	],
});
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("an owned pod endpoint requires its declared loopback forward and re-observes both per request", async () => {
	const received: string[] = [];
	let upstream: ReturnType<typeof Bun.serve> | undefined,
		forwardPort = 0;
	const { app, fake, invocation } = await fixture(false, (config) => {
		upstream = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (request) => {
				const url = new URL(request.url);
				received.push(url.pathname);
				return Response.json({ ok: true, path: url.pathname });
			},
		});
		if (!upstream.port) throw new Error("Disposable server has no port");
		servers.push(upstream);
		cluster(config, upstream.port);
		const port = disposablePort(),
			value = target(port);
		forwardPort = port;
		expect(validateProjects(config, document(config, value))).toHaveLength(1);
		// A declaration without the exact forward, on another port, or with more
		// than one replica never becomes an endpoint binding.
		expect(() =>
			validateProjects(
				config,
				document(config, {
					...value,
					kubernetes: {
						...value.kubernetes,
						portForwards: [{ local: port + 1, remote: 8080 }],
					},
				}),
			),
		).toThrow(
			"single-replica target and exactly one declared loopback port forward",
		);
		expect(() =>
			validateProjects(
				config,
				document(config, {
					...value,
					endpoints: { api: "http://127.0.0.1:1" },
				}),
			),
		).toThrow(
			"single-replica target and exactly one declared loopback port forward",
		);
		expect(() =>
			validateProjects(
				config,
				document(config, {
					...value,
					kubernetes: { ...value.kubernetes, replicas: 2 },
				}),
			),
		).toThrow("port forwards require exactly one replica");
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify(document(config, value)),
		);
	});
	let transcript = "";
	fake.setResponses([
		call("env_start", { apps: ["api"], runtime: "kubernetes" }),
		async () => {
			// The forward is a process, not a promise of connectivity: wait for it.
			await eventually(
				async () => {
					try {
						await fetch(`http://127.0.0.1:${forwardPort}/probe`);
						return true;
					} catch {
						return false;
					}
				},
				(ready) => ready,
			);
			return call("env_http_request", {
				app: "api",
				endpoint: "api",
				path: "/hello",
			});
		},
		(messages) => {
			transcript = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "env_http_request",
				),
			);
			return call("request_review", { path: ".", title: "Hold pod HTTP" });
		},
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await approve(app, task, "Endpoint GET: api/api");
	await pendingReview(app, task, "Hold pod HTTP");
	expect(received.filter((value) => value === "/hello")).toHaveLength(1);
	const result = JSON.parse(
		(JSON.parse(transcript) as { content: { text: string }[] }[])[0]?.content[0]
			?.text ?? "{}",
	) as { body: string };
	expect(result.body).toContain('"ok":true');
	expect(result.body).toContain("/hello");
	await app.cancel(task);
	const stopped = await app.environments.snapshot();
	expect(stopped.runs.every((run) => run.state === "exited")).toBe(true);
	upstream?.stop(true);
}, 30000);

test("a pod whose declared forward has exited grants no endpoint authority", async () => {
	let received = 0;
	const { app, fake, invocation } = await fixture(false, (config) => {
		const upstream = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => {
				received++;
				return Response.json({ ok: true });
			},
		});
		if (!upstream.port) throw new Error("Disposable server has no port");
		servers.push(upstream);
		cluster(config, upstream.port, { FIXTURE_FORWARD_EXIT_MS: "400" });
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify(document(config, target(disposablePort()))),
		);
	});
	let refused = "";
	fake.setResponses([
		call("env_start", { apps: ["api"], runtime: "kubernetes" }),
		async () => {
			await Bun.sleep(900);
			return call("env_http_request", {
				app: "api",
				endpoint: "api",
				path: "/hello",
			});
		},
		(messages) => {
			refused = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" &&
						message.toolName === "env_http_request",
				),
			);
			return call("request_review", { path: ".", title: "Hold pod forward" });
		},
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Hold pod forward");
	expect(received).toBe(0);
	expect(refused).toContain(
		"single-replica pod with its declared loopback port forward",
	);
	await app.cancel(task);
}, 30000);
