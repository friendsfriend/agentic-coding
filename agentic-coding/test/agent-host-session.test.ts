// Standalone coding-session host mode (`agent host --session`): the host is a
// plain coding agent for the Pi Durable page. It installs the coding tools,
// `grep` and the repository prompt, never the workflow/orchestrator tool
// surface, and serves the `default` policy only.
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

function toolResults(entries: readonly unknown[]): string[] {
	const texts: string[] = [];
	for (const entry of entries) {
		const record = entry as { kind?: unknown; model?: unknown };
		if (record?.kind !== "pi.tool-result" || !Array.isArray(record.model))
			continue;
		const message = record.model[0] as { content?: unknown } | undefined;
		if (!Array.isArray(message?.content)) continue;
		texts.push(
			message.content
				.filter((block: { type?: unknown }) => block?.type === "text")
				.map((block: { text?: unknown }) => String(block.text ?? ""))
				.join(""),
		);
	}
	return texts;
}

async function waitForResults(
	host: DurableHost,
	runId: string,
	count: number,
): Promise<string[]> {
	for (let i = 0; i < 100; i++) {
		const texts = toolResults(await host.entriesForTest(runId));
		if (texts.length >= count) return texts;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return toolResults(await host.entriesForTest(runId));
}

async function openSessionHost() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-session-host-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await DurableHost.open({
		layout: hostLayout(dir),
		settings: {},
		globalAgentDir: dir,
		storage: new MemoryStorage(),
		models,
		session: true,
	});
	return { dir, faux, host };
}

describe("coding-session host mode", () => {
	test("installs the coding surface and none of the workflow tools", async () => {
		const { host } = await openSessionHost();
		try {
			const descriptions = host.toolDescriptionsForTest();
			for (const name of ["read", "write", "edit", "bash", "grep"])
				expect(descriptions[name]).toBeString();
			// No workflow dialogue, environment, stage, debug or orchestrator tool
			// reaches a plain coding session.
			for (const name of [
				"developer_question",
				"agent_ask",
				"ask_jev",
				"env_start",
				"debug_request",
				"start_workflow",
				"workflow_status",
			])
				expect(descriptions[name]).toBeUndefined();
		} finally {
			await host.shutdown();
		}
	});

	test("serves only the default policy and runs a shell turn", async () => {
		const { dir, faux, host } = await openSessionHost();
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(runEnvPath, "");
			const base = {
				runId: "pi-durable",
				name: "pi-durable",
				cwd: dir,
				runEnvPath,
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
			};
			await expect(
				host.ensureRun({ ...base, toolPolicy: "read-only" }),
			).rejects.toThrow("this host only serves the coding session");
			await expect(
				host.ensureRun({ ...base, toolPolicy: "orchestrator" }),
			).rejects.toThrow("this host only serves the coding session");
			await host.ensureRun({ ...base, toolPolicy: "default" });

			faux.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("bash", { command: "echo session-shell-ran" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxText("done")]),
			]);
			await host.submit("pi-durable", "check the shell", "req-1");
			const results = await waitForResults(host, "pi-durable", 1);
			expect(results[0]).toContain("session-shell-ran");
		} finally {
			await host.shutdown();
		}
	});
});
