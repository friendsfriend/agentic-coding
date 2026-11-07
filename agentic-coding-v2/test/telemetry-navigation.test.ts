import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { serve } from "../src/server/index.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("authenticated telemetry navigates paged trace trees and logs without granting link or cursor authority", async () => {
	const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		foreignTrace = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		secret = "disposable-navigation-secret";
	const subject = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir, { recursive: true });
		fs.writeFileSync(
			path.join(config.configDir, ".env"),
			`TRACE_SECRET=${secret}\n`,
		);
		const source = `
const fs=require('node:fs');
const endpoint=process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const authorization=decodeURIComponent(process.env.OTEL_EXPORTER_OTLP_HEADERS.split('=')[1]);
const traceId='${traceId}';
const span=(n,parent=undefined)=>({traceId,spanId:String(n).repeat(16),parentSpanId:parent,kind:2,name:'span-'+n,startTimeUnixNano:String(1000000000n+BigInt(n)*1000000n),endTimeUnixNano:String(1010000000n+BigInt(n)*1000000n)});
const root=span(1);root.events=[{name:'exception',timeUnixNano:'1002000000',attributes:[{key:'exception.message',value:{stringValue:process.env.TOKEN}}]}];root.links=[{traceId:'${foreignTrace}',spanId:'9999999999999999',attributes:[{key:'cause',value:{stringValue:process.env.TOKEN}}]}];root.droppedEventsCount=2;
const traces=spans=>({resourceSpans:[{resource:{attributes:[{key:'service.name',value:{stringValue:'navigation-service'}}]},scopeSpans:[{spans}]}]});
const logs=items=>({resourceLogs:[{scopeLogs:[{logRecords:items.map(body=>({traceId,spanId:'2222222222222222',severityText:'ERROR',body:{stringValue:body}}))}]}]});
const send=async(route,payload)=>{const response=await fetch(endpoint+route,{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(payload)});return response.status};
const child=span(2,root.spanId);child.kind=3;child.attributes=[{key:'http.request.method',value:{stringValue:'GET'}},{key:'http.route',value:{stringValue:'/nested'}}];
await send('/v1/traces',traces([child,root,span(3,'9999999999999999'),span(4,'5555555555555555'),span(5,'4444444444444444')]));
await send('/v1/traces',traces([{...span(8),traceId:'cccccccccccccccccccccccccccccccc'},{...span(9),traceId:'dddddddddddddddddddddddddddddddd'}]));
await send('/v1/logs',logs(['first','second','third']));
const malformed=span(6);malformed.events=[{name:'bad',timeUnixNano:'not-nanos'}];
console.log('MALFORMED '+await send('/v1/traces',traces([span(7),malformed])));
console.log('NAVIGATION READY');
const change=${JSON.stringify(path.join(config.configDir, "change"))};
const done=${JSON.stringify(path.join(config.configDir, "changed"))};
setInterval(async()=>{if(!fs.existsSync(change))return;fs.unlinkSync(change);await send('/v1/logs',logs(['late']));await send('/v1/traces',traces([root]));fs.writeFileSync(done,'done');},30);
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
								readyText: "NAVIGATION READY",
								telemetry: {
									protocol: "otlp-http-json",
									listen: "127.0.0.1:0",
								},
								secretRefs: { TOKEN: "TRACE_SECRET" },
								command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source.replaceAll("\n", " "))}`,
							},
						],
					},
				],
			}),
		);
	});
	subject.fake.setResponses([
		fauxAssistantMessage(fauxToolCall("env_start", { apps: ["api"] }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(
			fauxToolCall("request_review", {
				path: ".",
				title: "Inspect navigation",
			}),
			{ stopReason: "toolUse" },
		),
	]);
	const owner = await subject.app.startTask(subject.invocation);
	await approve(subject.app, owner);
	await pendingReview(subject.app, owner, "Inspect navigation");
	const run = (await subject.app.environments.snapshot()).runs.find(
		(run) => run.state === "running",
	);
	if (!run) throw new Error("Missing disposable telemetry run");
	const host = serve(subject.app);
	try {
		const address = new URL(host.url),
			token = new URLSearchParams(address.hash.slice(1)).get("token");
		if (!token) throw new Error("Missing disposable API token");
		const headers = { Authorization: `Bearer ${token}` };
		const request = (options: Record<string, string>) => {
			const url = new URL("/api/environments/telemetry", address);
			url.search = new URLSearchParams({
				app: "api",
				run: run.id,
				...options,
			}).toString();
			return fetch(url, { headers });
		};
		const read = async (options: Record<string, string>) => {
			const response = await request(options);
			expect(response.status).toBe(200);
			return response.json();
		};
		const first = await read({ traceId, view: "tree", limit: "1" });
		expect(first).toMatchObject({
			representation: "trace-tree-preorder-nodes",
			tree: {
				roots: ["1111111111111111", "3333333333333333", "4444444444444444"],
				missingParents: ["3333333333333333"],
				cycleCuts: ["4444444444444444"],
				retainedSpans: 5,
			},
			records: [
				{
					name: "span-1",
					depth: 0,
					children: ["2222222222222222"],
					events: [
						{
							name: "exception",
							attributes: { "exception.message": "[REDACTED]" },
						},
					],
					links: [
						{ traceId: foreignTrace, attributes: { cause: "[REDACTED]" } },
					],
					dropped: { events: 2 },
				},
			],
		});
		expect(JSON.stringify(first)).not.toContain(secret);
		const second = await read({
			traceId,
			view: "tree",
			limit: "1",
			cursor: first.nextCursor,
		});
		expect(second.records).toMatchObject([
			{ name: "span-2", depth: 1, traversalParent: "1111111111111111" },
		]);
		const rest = await read({
			traceId,
			view: "tree",
			cursor: second.nextCursor,
		});
		expect(rest.records.map((row: { name: string }) => row.name)).toEqual([
			"span-3",
			"span-4",
			"span-5",
		]);
		expect(rest.nextCursor).toBeNull();
		expect(
			(
				await request({
					traceId,
					view: "tree",
					cursor: first.nextCursor,
					name: "different",
				})
			).status,
		).toBe(400);
		expect(
			(await request({ mode: "logs", cursor: first.nextCursor })).status,
		).toBe(400);
		expect(await read({ traceId: foreignTrace })).toMatchObject({
			availability: "unknown",
			records: [],
		});
		expect(await read({ traceId })).toMatchObject({
			representation: "flat-spans-with-parent-ids",
			selection: { matchedRetainedRecords: 5 },
		});
		expect(
			await read({
				http: "GET /nested",
				service: "navigation-service",
				rootKind: "server",
			}),
		).toMatchObject({
			records: [
				{ traceId, spanCount: 5, eventCount: 1, linkCount: 1, durationMs: 14 },
			],
		});
		expect(
			await read({ traceId, http: "/nested", rootKind: "client" }),
		).toMatchObject({ records: [{ name: "span-2" }] });
		expect(
			await read({ mode: "logs", traceId, spanId: "2222222222222222" }),
		).toMatchObject({ selection: { matchedRetainedRecords: 3 } });
		expect(
			await read({ mode: "logs", traceId, spanId: "1111111111111111" }),
		).toMatchObject({ records: [] });
		expect((await request({ spanId: "1111111111111111" })).status).toBe(400);
		const newestTrace = await read({ limit: "1" });
		expect(newestTrace.records).toMatchObject([
			{ traceId: "dddddddddddddddddddddddddddddddd" },
		]);
		const olderTraces = await read({ cursor: newestTrace.nextCursor });
		expect(
			olderTraces.records.map((row: { traceId: string }) => row.traceId),
		).toEqual(["cccccccccccccccccccccccccccccccc", traceId]);
		const logs = await read({ mode: "logs", limit: "1" });
		expect(logs.records).toMatchObject([{ body: "third" }]);
		fs.writeFileSync(path.join(subject.config.configDir, "change"), "change");
		await eventually(
			async () => fs.existsSync(path.join(subject.config.configDir, "changed")),
			Boolean,
		);
		const older = await read({ mode: "logs", cursor: logs.nextCursor });
		expect(older.records.map((row: { body: string }) => row.body)).toEqual([
			"second",
			"first",
		]);
		expect(await read({ mode: "logs", limit: "1" })).toMatchObject({
			records: [{ body: "late" }],
		});
		// Updating the exact boundary is not permission to substitute another span.
		expect(
			(await request({ traceId, view: "tree", cursor: first.nextCursor }))
				.status,
		).toBe(400);
		expect(
			JSON.stringify(await subject.app.environments.logs("api", owner)),
		).toContain("MALFORMED 400");
		await subject.app.environments.stopOnce("stop-navigation", owner, ["api"]);
		expect(
			(await request({ mode: "logs", cursor: logs.nextCursor })).status,
		).toBe(400);
	} finally {
		await host.stop();
	}
}, 60000);
