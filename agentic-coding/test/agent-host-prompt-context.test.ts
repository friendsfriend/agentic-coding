// durable-agent-tools: "System prompt context". Unit-tests `gatherContextFiles`
// directly, then proves end to end (DurableHost + a faux-provider response
// *factory*, which receives the real `TranscriptContext.messages` pi-ai sends)
// that a repository `AGENTS.md` actually reaches the model request.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { gatherContextFiles } from "../src/agent-host/tools.ts";

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("gatherContextFiles", () => {
	test("reads AGENTS.md/CLAUDE.md from cwd up to the repo root boundary", () => {
		const root = tempDir("agent-host-context-");
		const nested = path.join(root, "packages", "app");
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(root, "AGENTS.md"), "root agents content");
		fs.writeFileSync(path.join(nested, "CLAUDE.md"), "nested claude content");
		const globalDir = tempDir("agent-host-global-agent-dir-");
		fs.writeFileSync(
			path.join(globalDir, "AGENTS.md"),
			"global agents content",
		);
		const text = gatherContextFiles(nested, root, globalDir);
		expect(text).toContain("root agents content");
		expect(text).toContain("nested claude content");
		expect(text).toContain("global agents content");
	});

	test("stops walking at the given boundary and ignores files above it", () => {
		const outer = tempDir("agent-host-outer-");
		const root = path.join(outer, "repo");
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(
			path.join(outer, "AGENTS.md"),
			"outside the repo, must not appear",
		);
		fs.writeFileSync(path.join(root, "AGENTS.md"), "inside the repo");
		const globalDir = tempDir("agent-host-global-agent-dir-");
		const text = gatherContextFiles(root, root, globalDir);
		expect(text).toContain("inside the repo");
		expect(text).not.toContain("outside the repo");
	});

	test("an absent context file contributes nothing, never throws", () => {
		const dir = tempDir("agent-host-empty-");
		expect(() => gatherContextFiles(dir, dir, dir)).not.toThrow();
		expect(gatherContextFiles(dir, dir, dir)).toBe("");
	});
});

describe("the durable system prompt reaches the model request", () => {
	test("a repository AGENTS.md appears in the system message the faux provider receives", async () => {
		const dir = tempDir("agent-host-prompt-e2e-");
		fs.writeFileSync(path.join(dir, "AGENTS.md"), "UNIQUE-AGENTS-MARKER-42");
		const layout = hostLayout(dir);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: tempDir("agent-host-global-agent-dir-"),
			storage: new MemoryStorage(),
			models,
		});
		const runEnvPath = path.join(dir, "run.env");
		fs.writeFileSync(runEnvPath, "HERDR_RUN_ID='prompt-e2e'\n");
		await host.ensureRun({
			runId: "prompt-e2e",
			name: "prompt-e2e-worker",
			cwd: dir,
			runEnvPath,
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		let capturedMessages: Message[] = [];
		faux.setResponses([
			(context: { messages: Message[] }) => {
				capturedMessages = context.messages;
				return fauxAssistantMessage([fauxText("ok")]);
			},
		]);
		await host.submit("prompt-e2e", "hello", "req-1");
		let status = await host.status("prompt-e2e");
		for (let i = 0; i < 50 && status.status !== "idle"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = await host.status("prompt-e2e");
		}
		expect(status.status).toBe("idle");
		// The system message's sections (not `content`) carry the rendered prompt
		// sections (durable-agent-tools: "System prompt context" renders
		// `createPromptExtension`'s `preamble`/`cwd`/`context` sections).
		const systemText = capturedMessages
			.filter((message) => message.role === "system")
			.map((message) =>
				JSON.stringify(
					(message as unknown as { sections?: unknown }).sections ?? {},
				),
			)
			.join("\n");
		expect(systemText).toContain("UNIQUE-AGENTS-MARKER-42");
		await host.shutdown();
	});
});
