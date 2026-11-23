import { expect, test } from "bun:test";
import type { UiCapabilityApi } from "../src/ui/capability-api.ts";
import { createEnvironmentUiController } from "../src/ui/controller.ts";

test("UI controller derives typed input from the capability schema and shows the result", async () => {
	const calls: { name: string; input: unknown }[] = [];
	const api: UiCapabilityApi = {
		async list() {
			return [
				{
					name: "env_wait",
					label: "Wait for operation",
					description: "Bounded wait",
					annotations: {},
					inputSchema: {
						type: "object",
						properties: {
							operationId: { type: "string" },
							waitSec: { type: "integer", default: 30 },
						},
						required: ["operationId"],
						additionalProperties: false,
					},
				},
			];
		},
		async invoke(name, input) {
			calls.push({ name, input });
			return { state: "completed" };
		},
	};
	const controller = createEnvironmentUiController(api);
	await controller.load();
	expect(controller.getSnapshot().view).toBe("list");
	controller.openSelected();
	expect(controller.getSnapshot().values).toEqual({
		operationId: "",
		waitSec: "30",
	});
	controller.setValue("operationId", "00000000-0000-4000-8000-000000000000");
	await controller.submit();
	expect(calls).toEqual([
		{
			name: "env_wait",
			input: {
				operationId: "00000000-0000-4000-8000-000000000000",
				waitSec: 30,
			},
		},
	]);
	expect(controller.getSnapshot().view).toBe("result");
	expect(controller.getSnapshot().result).toContain('"completed"');
});

test("UI controller prefills an exact-review request id", async () => {
	const controller = createEnvironmentUiController({
		async list() {
			return [
				{
					name: "env_execute",
					label: "Prepare execution",
					description: "Exact review",
					annotations: {},
					inputSchema: {
						type: "object",
						properties: {
							app: { type: "string" },
							requestId: { type: "string" },
						},
						required: ["app", "requestId"],
					},
				},
			];
		},
		async invoke() {
			return {};
		},
	});
	await controller.load();
	controller.openSelected();
	expect(controller.getSnapshot().values.requestId).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
});

test("UI controller refuses a missing required field before invoking", async () => {
	let invocations = 0;
	const controller = createEnvironmentUiController({
		async list() {
			return [
				{
					name: "env_logs",
					label: "Show owned logs",
					description: "Recent logs",
					annotations: {},
					inputSchema: {
						type: "object",
						properties: {
							app: { type: "string" },
							tail: { type: "integer", default: 200 },
						},
						required: ["app"],
					},
				},
			];
		},
		async invoke() {
			invocations++;
			return {};
		},
	});
	await controller.load();
	controller.openSelected();
	await controller.submit();
	expect(controller.getSnapshot().message).toBe("Required: app");
	expect(controller.getSnapshot().view).toBe("form");
	expect(invocations).toBe(0);
});

test("UI controller renders telemetry trace trees as a terminal tree", async () => {
	const controller = createEnvironmentUiController({
		async list() {
			return [
				{
					name: "env_telemetry",
					label: "Run telemetry",
					description: "Read captured telemetry",
					annotations: {},
					inputSchema: {
						type: "object",
						properties: {
							app: { type: "string" },
							traceId: { type: "string" },
						},
						required: ["app"],
					},
				},
			];
		},
		async invoke() {
			return {
				app: "api",
				trace: {
					traceId: "a".repeat(32),
					spans: [{}, {}],
					tree: [
						{
							spanId: "b".repeat(16),
							name: "request",
							status: "1",
							durationMs: 12,
							children: [
								{
									spanId: "c".repeat(16),
									name: "database",
									status: "2",
									durationMs: 3,
									children: [],
								},
							],
						},
					],
				},
			};
		},
	});
	await controller.load();
	controller.openSelected();
	controller.setValue("app", "api");
	await controller.submit();
	const result = controller.getSnapshot().result ?? "";
	expect(controller.getSnapshot().view).toBe("result");
	expect(result).toContain("Telemetry trace");
	expect(result).toContain("▸ request · 12ms · ok");
	expect(result).toContain("└─ database · 3ms · error");
	expect(result).not.toContain('"trace"');
});

test("UI controller browses telemetry traces and opens the selected trace tree", async () => {
	const calls: { name: string; input: Record<string, unknown> }[] = [];
	const traceId = "b".repeat(32);
	const controller = createEnvironmentUiController({
		async list() {
			return [
				{
					name: "env_telemetry",
					label: "Run telemetry",
					description: "Read captured telemetry",
					annotations: {},
					inputSchema: {
						type: "object",
						properties: {
							app: { type: "string" },
							traceId: { type: "string" },
						},
						required: ["app"],
					},
				},
			];
		},
		async invoke(name, input) {
			const value = input as Record<string, unknown>;
			calls.push({ name, input: value });
			if (typeof value.traceId === "string")
				return {
					app: "api",
					trace: {
						traceId,
						spans: [{}],
						tree: [
							{
								name: "request",
								status: "1",
								durationMs: 5,
								children: [],
							},
						],
					},
				};
			return {
				app: "api",
				transport: "tls-host-gateway-v1",
				bytes: 42,
				logs: [],
				traces: [
					{
						traceId,
						root: "request",
						spanCount: 1,
						errors: 0,
					},
					{
						traceId: "c".repeat(32),
						root: "other",
						spanCount: 2,
						errors: 1,
					},
				],
			};
		},
	});
	await controller.load();
	controller.openSelected();
	controller.setValue("app", "api");
	await controller.submit();
	expect(controller.getSnapshot().view).toBe("traces");
	expect(controller.getSnapshot().traceIndex).toBe(0);
	expect(controller.getSnapshot().traces?.[0]).toMatchObject({
		traceId,
		root: "request",
	});
	controller.moveTrace(1);
	expect(controller.getSnapshot().traceIndex).toBe(1);
	await controller.openTrace();
	expect(calls.at(-1)).toEqual({
		name: "env_telemetry",
		input: { app: "api", traceId: "c".repeat(32) },
	});
	expect(controller.getSnapshot().view).toBe("result");
	expect(controller.getSnapshot().result).toContain("Telemetry trace");
	controller.back();
	expect(controller.getSnapshot().view).toBe("traces");
	controller.back();
	expect(controller.getSnapshot().view).toBe("list");
});
