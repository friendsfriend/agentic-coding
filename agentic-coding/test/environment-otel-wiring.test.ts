// The OTel wiring of one app run (`add-agent-debug-tools`, tasks 1.1-1.2):
// which endpoint, protocol, service name and resource attributes a run of each
// runtime receives, and which addresses the receivers bind for it.
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_OTEL_HTTP_PORT,
	otelEndpoint,
	otelResourceAttributes,
	resolveInstanceVariables,
} from "../src/server/environment/instances/variables.ts";
import { planReceiverBinds } from "../src/server/receivers/bind.ts";

describe("run variables", () => {
	test("a container reaches the receiver at the host gateway", () => {
		const variables = resolveInstanceVariables({
			owner: "workflow:wf-1",
			appDir: "/worktrees/wf-1/shop",
			app: "shop",
			runtime: "docker",
			grantId: "grant-1",
		});
		expect(variables.AC_OTEL_ENDPOINT).toBe(
			`http://host.docker.internal:${DEFAULT_OTEL_HTTP_PORT}`,
		);
		expect(variables.AC_OTEL_PROTOCOL).toBe("http/json");
		expect(variables.AC_OTEL_SERVICE_NAME).toBe("shop");
		expect(variables.AC_OTEL_RESOURCE_ATTRIBUTES).toBe(
			"ac.app=shop,ac.owner=workflow:wf-1,ac.run=grant-1",
		);
		// A container is configured by the definition it references, so the
		// standard OTLP variables are not injected behind its back.
		expect(variables.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
	});

	test("a container uses the address the receiver bound when there is one", () => {
		expect(
			resolveInstanceVariables({
				owner: "workflow:wf-1",
				appDir: "/worktrees/wf-1/shop",
				app: "shop",
				runtime: "docker",
				grantId: "grant-1",
				receiver: { httpPort: 4318, containerHost: "172.17.0.1" },
			}).AC_OTEL_ENDPOINT,
		).toBe("http://172.17.0.1:4318");
	});

	test("a script run also gets the standard OTLP variables", () => {
		const variables = resolveInstanceVariables({
			owner: "workflow:wf-1",
			appDir: "/worktrees/wf-1/shop",
			app: "shop",
			runtime: "script",
			grantId: "grant-1",
			receiver: { httpPort: 4318 },
		});
		expect(variables.AC_OTEL_ENDPOINT).toBe("http://127.0.0.1:4318");
		expect(variables.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:4318");
		expect(variables.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
		expect(variables.OTEL_SERVICE_NAME).toBe("shop");
		expect(variables.OTEL_RESOURCE_ATTRIBUTES).toBe(
			"ac.app=shop,ac.owner=workflow:wf-1,ac.run=grant-1",
		);
		expect(variables.OTEL_RESOURCE_ATTRIBUTES).toBe(
			variables.AC_OTEL_RESOURCE_ATTRIBUTES,
		);
	});

	test("a Kubernetes pod reaches the receiver at the bound host", () => {
		expect(
			otelEndpoint("kubernetes", {
				grpcPort: 4317,
				containerHost: "192.168.5.2",
			}),
		).toEqual({ endpoint: "http://192.168.5.2:4317", protocol: "grpc" });
		expect(otelEndpoint("kubernetes", {})).toEqual({
			endpoint: `http://host.docker.internal:${DEFAULT_OTEL_HTTP_PORT}`,
			protocol: "http/json",
		});
	});

	test("a definition's own OTLP setting wins", () => {
		const variables = resolveInstanceVariables({
			owner: "workflow:wf-1",
			appDir: "/worktrees/wf-1/shop",
			app: "shop",
			runtime: "script",
			grantId: "grant-1",
			receiver: { httpPort: 4318 },
			definitionEnv: {
				OTEL_SERVICE_NAME: "shop-from-definition",
				OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
			},
		});
		expect(variables.OTEL_SERVICE_NAME).toBe("shop-from-definition");
		expect(variables.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://collector:4318");
		// The `ac.*` attribution is the workflow's own and is never overridden:
		// a definition cannot opt its spans out of attribution.
		expect(variables.AC_OTEL_SERVICE_NAME).toBe("shop");
		expect(variables.AC_OTEL_RESOURCE_ATTRIBUTES).toContain("ac.run=grant-1");
	});

	test("the grant, not the address, tells two runs of one app apart", () => {
		const first = resolveInstanceVariables({
			owner: "workflow:wf-1",
			appDir: "/worktrees/wf-1/shop",
			app: "shop",
			runtime: "docker",
			grantId: "grant-1",
		});
		const second = resolveInstanceVariables({
			owner: "workflow:wf-1",
			appDir: "/worktrees/wf-1/shop",
			app: "shop",
			runtime: "docker",
			grantId: "grant-2",
		});
		expect(first.AC_OTEL_ENDPOINT).toBe(second.AC_OTEL_ENDPOINT);
		expect(first.AC_OTEL_RESOURCE_ATTRIBUTES).toBe(
			"ac.app=shop,ac.owner=workflow:wf-1,ac.run=grant-1",
		);
		expect(second.AC_OTEL_RESOURCE_ATTRIBUTES).toBe(
			"ac.app=shop,ac.owner=workflow:wf-1,ac.run=grant-2",
		);
	});

	test("a value cannot break the resource-attribute list format", () => {
		expect(
			otelResourceAttributes({
				app: "shop, inc",
				owner: "workflow:wf=1",
				grantId: "grant 1",
			}),
		).toBe("ac.app=shop_inc,ac.owner=workflow:wf_1,ac.run=grant_1");
	});
});

describe("receiver bind plan", () => {
	test("a desktop engine binds loopback only and never asks for a gateway", async () => {
		let asked = 0;
		const plan = await planReceiverBinds({
			containerBind: "auto",
			platform: "darwin",
			gateway: async () => {
				asked++;
				return "172.17.0.1";
			},
		});
		expect(plan).toEqual({ hosts: ["127.0.0.1"] });
		expect(asked).toBe(0);
	});

	test("a Linux engine also binds the container bridge gateway", async () => {
		const plan = await planReceiverBinds({
			containerBind: "auto",
			platform: "linux",
			gateway: async () => "172.17.0.1",
		});
		expect(plan).toEqual({
			hosts: ["127.0.0.1", "172.17.0.1"],
			containerHost: "172.17.0.1",
		});
	});

	test("an unknown gateway and an explicit address both behave", async () => {
		const warnings: string[] = [];
		const unknown = await planReceiverBinds({
			containerBind: "auto",
			platform: "linux",
			gateway: async () => undefined,
			warn: (message) => warnings.push(message),
		});
		expect(unknown).toEqual({ hosts: ["127.0.0.1"] });
		expect(warnings).toHaveLength(0);
		expect(
			await planReceiverBinds({ containerBind: "10.0.0.5", platform: "linux" }),
		).toEqual({ hosts: ["127.0.0.1", "10.0.0.5"], containerHost: "10.0.0.5" });
		expect(await planReceiverBinds({ containerBind: "off" })).toEqual({
			hosts: ["127.0.0.1"],
		});
	});

	test("a wildcard address is never bound", async () => {
		const warnings: string[] = [];
		for (const requested of ["0.0.0.0", "::", "[::]", "*", "any"]) {
			const plan = await planReceiverBinds({
				containerBind: requested,
				platform: "linux",
				gateway: async () => "0.0.0.0",
				warn: (message) => warnings.push(message),
			});
			expect(plan.hosts).toEqual(["127.0.0.1"]);
			expect(plan.hosts).not.toContain("0.0.0.0");
			expect(plan.containerHost).toBeUndefined();
		}
		expect(warnings.length).toBeGreaterThan(0);
	});
});
