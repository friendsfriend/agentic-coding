// durable-agent-host: "watch" request/response (protocol.ts, D3) and
// `DurableHost.watchRun`'s streaming of the conversation `viewState`.
// Exercises the real control socket end to end: `HostClient.watch()` against
// a live `DurableHost`, not a fake server.
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
import { HostClient } from "../src/agent-host/client.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";

function tempWorkflowDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-watch-"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isBusy(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const docs = isRecord(value.docs) ? value.docs : {};
	const live = isRecord(docs["pi.live"]) ? docs["pi.live"] : undefined;
	return live?.run !== undefined;
}
function entryCount(value: unknown): number {
	if (!isRecord(value) || !Array.isArray(value.entries)) return 0;
	return value.entries.length;
}

describe("watch streams the conversation view over the control socket", () => {
	test("a watcher sees an initial frame, a busy frame, and a settled frame with the transcript", async () => {
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
		await host.listen();
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(runEnvPath, "HERDR_RUN_ID='watch-run'\n");
			await host.ensureRun({
				runId: "watch-run",
				name: "watch-worker",
				cwd: dir,
				runEnvPath,
				toolPolicy: "default",
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
			});

			const client = new HostClient(layout.socketPath, 10_000);
			const frames: unknown[] = [];
			const stop = await client.watch("watch-run", (value) => {
				frames.push(value);
			});
			try {
				expect(frames.length).toBeGreaterThanOrEqual(1);
				expect(isBusy(frames[0])).toBe(false);

				faux.setResponses([
					fauxAssistantMessage([fauxToolCall("read", { path: "x.txt" })], {
						stopReason: "toolUse",
					}),
				]);
				faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
				await client.submit("watch-run", "read a file", "req-1");

				let settled =
					frames.length > 0 &&
					!isBusy(frames[frames.length - 1]) &&
					entryCount(frames[frames.length - 1]) > 0;
				for (let i = 0; i < 50 && !settled; i++) {
					await new Promise((resolve) => setTimeout(resolve, 20));
					settled =
						frames.length > 0 &&
						!isBusy(frames[frames.length - 1]) &&
						entryCount(frames[frames.length - 1]) > 0;
				}
				expect(frames.length).toBeGreaterThan(1);
				expect(isBusy(frames[frames.length - 1])).toBe(false);
				expect(entryCount(frames[frames.length - 1])).toBeGreaterThan(0);
			} finally {
				stop();
			}
		} finally {
			await host.shutdown();
		}
	});
});
