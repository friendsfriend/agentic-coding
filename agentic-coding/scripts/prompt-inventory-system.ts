// System-side rows of the prompt inventory: what a durable run's first model
// request carries besides the assignment — the system prompt sections, and the
// tool definitions with their parameter schemas. Measured from a real
// `DurableHost` on in-memory storage with a faux provider, in temporary
// directories only (see `prompt-inventory.ts`).
import fs from "node:fs";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";

interface SystemMessage {
	role: string;
	sections?: Record<string, unknown>;
	toolsAdded?: unknown;
}

const bytes = (value: unknown): number =>
	Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));

const GROUPS: ReadonlyArray<readonly [string, RegExp]> = [
	["stage_*", /^stage_/],
	["browser_*", /^browser_/],
	["env_*", /^env_/],
	["debug_*", /^debug_/],
	["evidence_*", /^evidence_/],
];

function groupOf(name: string): string {
	for (const [group, pattern] of GROUPS) if (pattern.test(name)) return group;
	return name;
}

export interface CapturedSystem {
	/** The system prompt sections by name (preamble, cwd, context, codemode). */
	sections: Record<string, unknown>;
	/** The tool definitions the first request carried. */
	tools: Array<Record<string, unknown>>;
}

/** Opens a `DurableHost` in `scratch` with `codemode` enabled in the temporary
 * pi settings (as a developer's own settings do) and captures the system
 * message of one faux-provider request. */
export async function captureSystem(scratch: string): Promise<CapturedSystem> {
	const work = path.join(scratch, "work");
	const globalAgentDir = path.join(scratch, "pi");
	fs.mkdirSync(work, { recursive: true });
	fs.mkdirSync(globalAgentDir, { recursive: true });
	fs.writeFileSync(
		path.join(globalAgentDir, "settings.json"),
		JSON.stringify({ defaultTools: ["+codemode"] }),
	);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await DurableHost.open({
		layout: hostLayout(work),
		settings: {},
		globalAgentDir,
		storage: new MemoryStorage(),
		models,
	});
	try {
		const runEnvPath = path.join(work, "run.env");
		fs.writeFileSync(runEnvPath, "HERDR_RUN_ID='inventory'\n");
		await host.ensureRun({
			runId: "inventory",
			name: "inventory-worker",
			cwd: work,
			runEnvPath,
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		let captured: { messages?: SystemMessage[] } = {};
		faux.setResponses([
			(context: { messages: SystemMessage[] }) => {
				captured = context;
				return fauxAssistantMessage([fauxText("ok")]);
			},
		]);
		await host.submit("inventory", "hello", "req-1");
		for (let i = 0; i < 100; i++) {
			if ((await host.status("inventory")).status === "idle") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const system = (captured.messages ?? []).find(
			(message) => message.role === "system",
		);
		return {
			sections: system?.sections ?? {},
			tools: Array.isArray(system?.toolsAdded)
				? (system.toolsAdded as Array<Record<string, unknown>>)
				: [],
		};
	} finally {
		await host.shutdown();
	}
}

/** Markdown rows for the system side of a first request: every system prompt
 * section (preamble, cwd, context, `codemode`) and the tool definitions by
 * group, each as description bytes plus parameter-schema bytes. */
export async function measureSystem(scratch: string): Promise<string> {
	const { sections, tools } = await captureSystem(scratch);
	const lines = ["| Block | Bytes | ≈ tokens |", "|---|---|---|"];
	const row = (name: string, size: number) =>
		lines.push(`| ${name} | ${size} | ${Math.ceil(size / 4)} |`);
	for (const [name, value] of Object.entries(sections))
		row(`system section: ${name}`, bytes(value));
	const byGroup = new Map<string, { description: number; schema: number }>();
	for (const tool of tools) {
		const group = groupOf(String(tool.name ?? ""));
		const entry = byGroup.get(group) ?? { description: 0, schema: 0 };
		entry.description += bytes(tool.description ?? "");
		entry.schema += bytes(tool.parameters ?? tool.inputSchema ?? "");
		byGroup.set(group, entry);
	}
	let description = 0;
	let schema = 0;
	for (const [group, entry] of byGroup) {
		row(`tools ${group}: descriptions`, entry.description);
		row(`tools ${group}: parameter schemas`, entry.schema);
		description += entry.description;
		schema += entry.schema;
	}
	row("tools total: descriptions", description);
	row("tools total: parameter schemas", schema);
	return lines.join("\n");
}
