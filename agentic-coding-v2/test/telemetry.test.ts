import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type Context as ModelContext,
} from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { serve } from "../src/server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
test("approved shell telemetry authenticates ingestion, bounds observations, redacts before queries and never crosses native owners or later starts", async () => {
	const secret = "disposable-telemetry-secret",
		traceId = "11111111111111111111111111111111";
	const { app, fake, invocation } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
		fs.writeFileSync(
			path.join(config.configDir, ".env"),
			`TELEMETRY_SECRET=${secret}\n`,
			{ mode: 0o600 },
		);
		const source = `
const endpoint=process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const authorization=decodeURIComponent(process.env.OTEL_EXPORTER_OTLP_HEADERS.split('=')[1]);
const resource={attributes:[{key:'service.name',value:{stringValue:'disposable-emitter'}},{key:'ac.owner',value:{stringValue:'forged-owner'}}]};
const start=BigInt(Date.now())*1000000n;
const span=(id,name,attributes=[])=>({traceId:id,spanId:'1111111111111111',name,kind:2,startTimeUnixNano:String(start),endTimeUnixNano:String(start+1000000n),status:{code:2},attributes});
const send=async(route,payload)=>{const response=await fetch(endpoint+route,{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(payload)});if(!response.ok)throw new Error('Rejected disposable export '+response.status)};
const traces=spans=>({resourceSpans:[{resource,scopeSpans:[{spans}]}]});
const anonymous=await fetch(endpoint+'/v1/traces',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
console.log('ANONYMOUS '+anonymous.status);
for(let offset=0;offset<200;offset+=50)await send('/v1/traces',traces(Array.from({length:50},(_,i)=>span((offset+i+1).toString(16).padStart(32,'0'),'noise'))));
await send('/v1/traces',traces([span('22222222222222222222222222222222','oversize',Array.from({length:64},(_,i)=>({key:'field'+i,value:{stringValue:'中'.repeat(120)}})))]));
const main=traces([span('${traceId}','GET /'+process.env.AC_OTEL_RUN,[{key:'secret',value:{stringValue:process.env.TOKEN}}])]);
await send('/v1/traces',main);await send('/v1/traces',main);
await send('/v1/logs',{resourceLogs:[{resource,scopeLogs:[{logRecords:[{traceId:'${traceId}',spanId:'1111111111111111',severityText:'ERROR',severityNumber:17,body:{stringValue:'native-message '+process.env.TOKEN}}]}]}]});
console.log('receiver credential '+process.env.OTEL_EXPORTER_OTLP_HEADERS);
console.log('TELEMETRY READY');setInterval(()=>{},1000);
`;
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
								readyText: "TELEMETRY READY",
								telemetry: {
									protocol: "otlp-http-json",
									listen: "127.0.0.1:0",
								},
								secretRefs: { TOKEN: "TELEMETRY_SECRET" },
								command:
									JSON.stringify(process.execPath) +
									" -e " +
									JSON.stringify(source.replaceAll("\n", " ")),
							},
						],
					},
				],
			}),
		);
	});
	const observations: unknown[] = [],
		errors: string[] = [],
		logs: unknown[] = [];
	const observe = (messages: ModelContext) => {
		for (const message of messages.messages) {
			if (
				message.role !== "toolResult" ||
				!["otel_query", "env_logs"].includes(message.toolName)
			)
				continue;
			for (const part of message.content)
				if (part.type === "text") {
					if (message.isError) errors.push(part.text);
					else
						(message.toolName === "otel_query" ? observations : logs).push(
							JSON.parse(part.text),
						);
				}
		}
		return fauxAssistantMessage("Observed disposable native telemetry");
	};
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Inspect telemetry ownership" }),
	]);
	const first = await app.startTask(invocation);
	const disclosure = JSON.parse(
		(await pendingReview(app, first)).snapshot,
	).telemetryScope;
	expect(disclosure).toContain("127.0.0.1");
	expect(disclosure).toContain("OTEL_EXPORTER_OTLP_HEADERS");
	expect((await app.environments.snapshot("api")).runs).toHaveLength(0);
	await approve(app, first);
	await pendingReview(app, first, "Inspect telemetry ownership");
	expect(await app.environments.logs("api", first)).toMatchObject([
		{ state: "running" },
	]);
	const owned = (await app.environments.snapshot("api")).runs.find(
		(run) => run.owner === first && run.state === "running",
	);
	if (!owned) throw new Error("Disposable live telemetry run missing");
	const host = serve(app);
	try {
		const address = new URL(host.url);
		const token = new URLSearchParams(address.hash.slice(1)).get("token");
		if (!token) throw new Error("Disposable host omitted its private token");
		const headers = { Authorization: `Bearer ${token}` };
		const query = new URL("/api/environments/telemetry", address);
		query.search = new URLSearchParams({
			app: "api",
			run: owned.id,
			status: "error",
			limit: "1",
		}).toString();
		expect((await fetch(query)).status).toBe(401);
		const response = await fetch(query, { headers });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			scope: { app: "api", owner: first, run: owned.id },
			records: [{ traceId, spanCount: 1 }],
		});
		const byTrace = async (filters: Record<string, string>) => {
			const target = new URL(query);
			for (const [key, value] of Object.entries(filters))
				target.searchParams.set(key, value);
			if (filters.mode === "logs") target.searchParams.delete("status");
			const response = await fetch(target, { headers });
			expect(response.status).toBe(200);
			return response.json();
		};
		expect(await byTrace({ traceId, status: "success" })).toMatchObject({
			availability: "retained",
			records: [],
			selection: { matchedRetainedRecords: 0 },
		});
		expect(
			await byTrace({
				traceId: "00000000000000000000000000000001",
				status: "all",
			}),
		).toMatchObject({ availability: "evicted", records: [] });
		expect(
			await byTrace({
				traceId: "ffffffffffffffffffffffffffffffff",
				status: "all",
			}),
		).toMatchObject({ availability: "unknown", records: [] });
		expect(
			await byTrace({ traceId, mode: "logs", severity: "INFO" }),
		).toMatchObject({
			availability: "retained",
			records: [],
			selection: { matchedRetainedRecords: 0 },
		});
		query.searchParams.set("run", "stale-run-not-owned");
		expect((await fetch(query, { headers })).status).toBe(400);
		query.searchParams.set("run", owned.id);
		query.searchParams.set("mode", "logs");
		query.searchParams.delete("status");
		const logResponse = await fetch(query, { headers });
		expect(logResponse.status).toBe(200);
		const logObservation = await logResponse.json();
		expect(logObservation).toMatchObject({
			scope: { run: owned.id },
			records: [{ body: "native-message [REDACTED]" }],
		});
		expect(JSON.stringify(logObservation)).not.toContain(secret);
		query.searchParams.append("run", owned.id);
		expect((await fetch(query, { headers })).status).toBe(400);
	} finally {
		await host.stop();
	}
	fake.setResponses([call("otel_query", { app: "api" }), observe]);
	const foreign = await app.startTask({
		...invocation,
		requestId: "foreign-telemetry-reader",
	});
	await app.harness.waitForTask(foreign as TaskId, context);
	fake.setResponses([
		call("otel_query", {
			app: "api",
			limit: 1,
			status: "error",
		}),
		call("otel_query", { app: "api", traceId, name: "GET /", view: "tree" }),
		call("otel_query", {
			app: "api",
			mode: "logs",
			severity: "ERROR",
			text: "native-message",
		}),
		call("env_logs", { app: "api" }),
		call("env_stop", { apps: ["api"] }),
		call("otel_query", { app: "api" }),
		observe,
	]);
	await approve(app, first, "Inspect telemetry ownership");
	await app.harness.waitForTask(first as TaskId, context);
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("otel_query", {
			app: "api",
			limit: 1,
			status: "error",
		}),
		observe,
	]);
	const later = await app.startTask({
		...invocation,
		requestId: "later-telemetry-holder",
	});
	await approve(app, later);
	await app.harness.waitForTask(later as TaskId, context);
	expect(observations).toHaveLength(4);
	expect(observations[0]).toMatchObject({
		scope: { app: "api", owner: first },
		timeBasis: "host-receipt",
		loss: { evictedTraces: 1, droppedSpans: 1 },
		records: [{ traceId, rootKind: "server", spanCount: 1, errorCount: 1 }],
		selection: {
			matchedRetainedRecords: 200,
			returnedRecords: 1,
			limitOmitted: 199,
		},
	});
	expect(observations[1]).toMatchObject({
		scope: { owner: first },
		representation: "trace-tree-preorder-nodes",
		tree: { roots: ["1111111111111111"], retainedSpans: 1 },
		records: [
			{
				traceId,
				depth: 0,
				durationMs: 1,
				attributes: { secret: "[REDACTED]" },
			},
		],
	});
	expect(observations[2]).toMatchObject({
		scope: { owner: first },
		records: [
			{ body: "native-message [REDACTED]", severity: "ERROR", traceId },
		],
	});
	expect(observations[3]).toMatchObject({
		scope: { owner: later },
		loss: { evictedTraces: 1, droppedSpans: 1 },
		records: [{ traceId, spanCount: 1 }],
	});
	expect(errors).toHaveLength(2);
	for (const error of errors)
		expect(error).toContain("No owned live ready native telemetry run");
	expect(logs).toHaveLength(1);
	expect(JSON.stringify(logs)).toContain("ANONYMOUS 401");
	expect(JSON.stringify(logs)).toContain("Bearer%20[REDACTED]");
	expect(JSON.stringify({ observations, logs })).not.toContain(secret);
	expect(JSON.stringify(observations)).not.toContain("forged-owner");
	expect(
		(await app.environments.snapshot("api")).runs.every(
			(run) => run.state === "exited",
		),
	).toBe(true);
}, 20000);

test("cancelling shell startup closes and joins its telemetry listener before releasing the app", async () => {
	const { app, fake, invocation } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
		const source =
			"console.log('COLLECTOR_ENDPOINT '+process.env.OTEL_EXPORTER_OTLP_ENDPOINT);setInterval(()=>{},1000)";
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
								readyText: "NEVER_READY",
								telemetry: {
									protocol: "otlp-http-json",
									listen: "127.0.0.1:0",
								},
								command:
									JSON.stringify(process.execPath) +
									" -e " +
									JSON.stringify(source),
							},
						],
					},
				],
			}),
		);
	});
	fake.setResponses([call("env_start", { apps: ["api"] })]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	const runs = await eventually(
		() => app.environments.logs("api", task),
		(runs) => runs.some((run) => run.output?.includes("COLLECTOR_ENDPOINT ")),
	);
	const endpoint = runs
		.map((run) => run.output ?? "")
		.join("\n")
		.match(/COLLECTOR_ENDPOINT (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
	if (!endpoint) throw new Error("Disposable app omitted its receiver address");
	expect(
		(await fetch(`${endpoint}/v1/traces`, { method: "POST", body: "{}" }))
			.status,
	).toBe(401);
	await app.cancel(task);
	const stopped = await eventually(
		() => app.environments.snapshot("api"),
		(state) => state.runs.every((run) => run.state === "exited"),
	);
	expect(stopped.runs).toHaveLength(1);
	await expect(
		new Promise((resolve, reject) => {
			const socket = net.createConnection({
				host: "127.0.0.1",
				port: Number(new URL(endpoint).port),
			});
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", reject);
		}),
	).rejects.toMatchObject({ code: "ECONNREFUSED" });
}, 15000);
