import { expect, test } from "bun:test";
import fs from "node:fs";
import {
	createCapabilities,
	type EnvironmentCapabilities,
} from "../src/interface/capabilities.ts";
import { describeAction } from "../src/interface/descriptors.ts";
import { mcpToolSurface } from "../src/mcp/tool-surface.ts";
import { createUiCapabilityApi } from "../src/ui/capability-api.ts";

const fakeCatalog = { list: () => ({ mode: "fixture" }) } as never;
const fakeOperations = {
	admit: async () => ({ id: "operation" }),
	read: async () => ({ id: "operation" }),
	history: async () => ({ operations: [], total: 0, nextOffset: null }),
} as never;
const fakeExecution = {
	admit: async () => ({ id: "operation" }),
	execute: async () => ({ receipt: null }),
	wait: async () => ({ receipt: null }),
	status: async () => ({ owned: [] }),
	stop: async () => ({ stopped: [] }),
	logs: async () => ({ output: "" }),
	history: async () => ({ operations: [], total: 0, nextOffset: null }),
} as never;

function fixture(): EnvironmentCapabilities {
	return createCapabilities({
		catalog: fakeCatalog,
		operations: fakeOperations,
		execution: fakeExecution,
	});
}

test("MCP and UI expose exactly the same capabilities from one registry", async () => {
	const capabilities = fixture();
	const mcp = mcpToolSurface(capabilities);
	const ui = createUiCapabilityApi(capabilities);
	const actions = await ui.list();
	const names = capabilities.list().map((capability) => capability.name);
	expect(mcp.map((tool) => tool.name)).toEqual(names);
	expect(actions.map((action) => action.name)).toEqual(names);
	expect(new Set(names).size).toBe(names.length);
	expect(names.some((name) => /approve|decision/.test(name))).toBe(false);
	for (const tool of mcp) {
		const capability = capabilities
			.list()
			.find((item) => item.name === tool.name);
		const action = actions.find((item) => item.name === tool.name);
		expect(action).toBeDefined();
		if (!capability || !action) throw new Error("Missing parity fixture");
		expect(tool.config.inputSchema).toBe(capability.inputSchema);
		expect(action.inputSchema).toEqual(describeAction(capability).inputSchema);
		expect(action.label.length).toBeGreaterThan(0);
	}
});

test("the UI layer has no server, MCP or service-construction dependency", () => {
	const directory = new URL("../src/ui/", import.meta.url);
	const files = fs
		.readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
	expect(files.length).toBeGreaterThan(0);
	for (const file of files) {
		const source = fs.readFileSync(new URL(file.name, directory), "utf8");
		expect(source).not.toMatch(
			/from "\.\.\/(mcp|services|operator|persistence)\//,
		);
		expect(source).not.toContain("Bun.serve");
		expect(source).not.toContain("createExecutionService");
	}
});

test("entry points do not carry their own action tables", () => {
	for (const file of [
		"src/mcp/create-server.ts",
		"src/mcp/tool-surface.ts",
		"src/ui/capability-api.ts",
	]) {
		const source = fs.readFileSync(
			new URL(`../${file}`, import.meta.url),
			"utf8",
		);
		expect(source).not.toMatch(/"env_[a-z_]+"/);
	}
	expect(
		fs.readFileSync(
			new URL("../src/mcp/create-server.ts", import.meta.url),
			"utf8",
		),
	).toContain("mcpToolSurface");
	expect(
		fs.readFileSync(
			new URL("../src/ui/capability-api.ts", import.meta.url),
			"utf8",
		),
	).toContain("capabilities.list()");
});
