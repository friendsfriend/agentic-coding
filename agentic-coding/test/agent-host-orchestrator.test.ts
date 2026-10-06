// Orchestrator host mode (`agent host --orchestrator`): the host serves only
// the orchestrator policy, offers the orchestrator's workflow tools, and calls
// the unified server with the orchestrator capability from the run env.
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
import {
	ORCHESTRATOR_TOKEN_ENV,
	ORCHESTRATOR_URL_ENV,
} from "../src/agent-host/orchestrator-env.ts";
import { orchestratorTokenFor } from "../src/server/auth.ts";
import type { ServerOperations } from "../src/server/handlers.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";

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

describe("orchestrator host mode", () => {
	test("serves only the orchestrator policy and calls the server with its capability", async () => {
		const observed: unknown[] = [];
		const server = await startWorkflowServer({
			operations: {
				runObservation: async (request: unknown) => {
					observed.push(request);
					return [
						{
							ident: "shop",
							name: "Shop",
							path: "/repos/shop",
							openspec: true,
							available: true,
						},
					];
				},
			} as unknown as ServerOperations,
		});
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-host-"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout: hostLayout(dir),
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
			orchestrator: true,
		});
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(
				runEnvPath,
				`${ORCHESTRATOR_URL_ENV}='${server.url}'\n${ORCHESTRATOR_TOKEN_ENV}='${orchestratorTokenFor(server.token)}'\n`,
			);
			const model = `${faux.getModel().provider}/${faux.getModel().id}`;
			const base = {
				runId: "orchestrator",
				name: "orchestrator",
				cwd: dir,
				runEnvPath,
				model,
			};
			await expect(
				host.ensureRun({ ...base, toolPolicy: "default" }),
			).rejects.toThrow("only serves the orchestrator session");
			await host.ensureRun({ ...base, toolPolicy: "orchestrator" });

			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("list_projects", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[fauxToolCall("bash", { command: "echo shell-ran-here" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxText("done")]),
			]);
			await host.submit("orchestrator", "what can I work on?", "req-1");
			const results = await waitForResults(host, "orchestrator", 2);
			expect(observed).toEqual([{ kind: "projects" }]);
			expect(results[0]).toContain("/repos/shop");
			// No shell: the call is refused instead of running.
			expect(results[1]).toContain("Tool bash is not available");
			expect(results[1]).not.toContain("shell-ran-here");
		} finally {
			await host.shutdown();
			await server.stop();
		}
	});
});
