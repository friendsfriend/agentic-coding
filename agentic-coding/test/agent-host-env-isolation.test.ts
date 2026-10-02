// durable-agent-host: "Per-run execution environment". Two runs in one host
// call `bash` to print their own `HERDR_RUN_ID`; each must see only its own
// run's environment, proving the per-conversation `env` factory keyed by
// conversation id (`DurableHost`'s `contexts` map) is genuinely isolated.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";

function tempWorkflowDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-env-isolation-"));
}
function writeRunEnv(
	dir: string,
	name: string,
	vars: Record<string, string>,
): string {
	const file = path.join(dir, name);
	fs.writeFileSync(
		file,
		Object.entries(vars)
			.map(([k, v]) => `${k}='${v}'`)
			.join("\n"),
	);
	return file;
}

/** Pull the text a `bash` tool-result entry carried, defensively: `entry.model`
 * is `Message[]`, and a tool-result message's `content` is text/image blocks. */
function toolResultText(entries: readonly unknown[]): string | undefined {
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { kind?: unknown; model?: unknown };
		if (record.kind !== "pi.tool-result" || !Array.isArray(record.model))
			continue;
		const message = record.model[0] as { content?: unknown } | undefined;
		if (!Array.isArray(message?.content)) continue;
		const text = message.content
			.filter((block: { type?: unknown }) => block?.type === "text")
			.map((block: { text?: unknown }) => String(block.text ?? ""))
			.join("");
		if (text) return text;
	}
	return undefined;
}

async function waitForToolResult(
	host: DurableHost,
	runId: string,
	attempts = 50,
): Promise<string | undefined> {
	for (let i = 0; i < attempts; i++) {
		const entries = await host.entriesForTest(runId);
		const text = toolResultText(entries);
		if (text !== undefined) return text;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return undefined;
}

describe("per-run execution environment isolation", () => {
	test("two runs calling bash each see only their own HERDR_RUN_ID", async () => {
		const dir = tempWorkflowDir();
		const layout = hostLayout(dir);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
		});
		const model = `${faux.getModel().provider}/${faux.getModel().id}`;

		const envA = writeRunEnv(dir, "run-a.env", { HERDR_RUN_ID: "run-a-id" });
		await host.ensureRun({
			runId: "run-a",
			name: "worker-a",
			cwd: dir,
			runEnvPath: envA,
			toolPolicy: "default",
			model,
		});
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: "echo $HERDR_RUN_ID" })],
				{ stopReason: "toolUse" },
			),
		]);
		faux.appendResponses([fauxAssistantMessage([fauxText("done-a")])]);
		await host.submit("run-a", "print your run id", "req-a");
		const outputA = await waitForToolResult(host, "run-a");

		const envB = writeRunEnv(dir, "run-b.env", { HERDR_RUN_ID: "run-b-id" });
		await host.ensureRun({
			runId: "run-b",
			name: "worker-b",
			cwd: dir,
			runEnvPath: envB,
			toolPolicy: "default",
			model,
		});
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: "echo $HERDR_RUN_ID" })],
				{ stopReason: "toolUse" },
			),
		]);
		faux.appendResponses([fauxAssistantMessage([fauxText("done-b")])]);
		await host.submit("run-b", "print your run id", "req-b");
		const outputB = await waitForToolResult(host, "run-b");

		expect(outputA).toContain("run-a-id");
		expect(outputA).not.toContain("run-b-id");
		expect(outputB).toContain("run-b-id");
		expect(outputB).not.toContain("run-a-id");
		await host.shutdown();
	});
});
