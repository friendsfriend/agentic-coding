import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import * as hostClient from "../src/agent-host/client.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { openPiDurableSession } from "../src/agent-host/pi-durable-session.ts";
import { readDurableSessionRegistry } from "../src/pi-durable-registry.ts";
import { piDurableRuntimeDir } from "../src/pi-durable-state.ts";

test("shared lifecycle retries exact native creation, pins defaults/config root and preserves newer selection across slow concurrent opens", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-lifecycle-"));
	const keys = [
		"HOME",
		"AGENTIC_CODING_CONFIG_DIR",
		"PI_CODING_AGENT_DIR",
		"HERDR_WIKI_DIR",
	] as const;
	const previous = keys.map((key) => [key, process.env[key]] as const),
		spies: { mockRestore(): void }[] = [];
	let host: DurableHost | undefined;
	try {
		process.env.HOME = root;
		process.env.AGENTIC_CODING_CONFIG_DIR = path.join(root, "foreign-config");
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.HERDR_WIKI_DIR = path.join(root, "wiki");
		fs.writeFileSync(
			path.join(root, "settings.json"),
			JSON.stringify({ defaultTools: ["+codemode"] }),
		);
		const runtimeDir = piDurableRuntimeDir(root),
			faux = fauxProvider(),
			models = createModels();
		models.setProvider(faux.provider);
		const native = await DurableHost.open({
			layout: hostLayout(runtimeDir),
			globalAgentDir: root,
			session: true,
			settings: { localPiTools: { enabled: false } },
			models,
		});
		host = native;
		const start = spyOn(hostClient, "ensureHostRunning").mockResolvedValue(
			undefined,
		);
		spies.push(start);
		const identity = spyOn(
			hostClient.HostClient.prototype,
			"scheduledIdentity",
		).mockImplementation(() => native.scheduledIdentity());
		spies.push(identity);
		const resolve = spyOn(
			hostClient.HostClient.prototype,
			"resolveSession",
		).mockImplementation((runId) => native.resolveSession(runId));
		spies.push(resolve);
		let ensures = 0;
		const ensure = spyOn(
			hostClient.HostClient.prototype,
			"ensureRun",
		).mockImplementation(async (request) => {
			ensures++;
			if (ensures === 2)
				await new Promise((resolve) => setTimeout(resolve, 50));
			return {
				type: "ensureRun" as const,
				runId: request.runId,
				...(await native.ensureRun(request)),
			};
		});
		spies.push(ensure);
		const recover = spyOn(
			hostClient.HostClient.prototype,
			"recoverRun",
		).mockImplementation(async (request) => ({
			type: "ensureRun" as const,
			runId: request.runId,
			...(await native.ensureRun(request)),
		}));
		spies.push(recover);
		const model = {
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
			thinking: "off",
		};
		const create = {
			fresh: true,
			operationId: "same-create",
			name: "Daily task digest",
			cwd: root,
			configDir: root,
			select: false,
			toolPolicy: "collection" as const,
			model,
		};
		const first = await openPiDurableSession(create),
			activeId = readDurableSessionRegistry(runtimeDir)?.activeId;
		expect(start.mock.calls[0]?.[1].env?.AGENTIC_CODING_CONFIG_DIR).toBe(root);
		expect(
			start.mock.calls[0]?.[1].env?.AGENTIC_WORKFLOW_TOKEN,
		).toBeUndefined();
		const reopened = await openPiDurableSession({
			sessionId: first.sessionId,
			configDir: root,
			select: false,
			cwd: path.join(root, "nonexistent-shell-cwd"),
			model: { model: "not-configured", thinking: "high" },
		});
		expect(reopened).toEqual(first);
		expect(await openPiDurableSession(create)).toEqual(first);
		expect(ensure).toHaveBeenCalledTimes(1);
		expect(recover).toHaveBeenCalledTimes(2);
		expect(recover.mock.calls[0]?.[0]).toMatchObject({
			cwd: root,
			model: model.model,
			thinking: "off",
			toolPolicy: "collection",
		});
		expect(readDurableSessionRegistry(runtimeDir)?.activeId).toBe(activeId);
		const [earlier, latest] = await Promise.all([
			openPiDurableSession({
				...create,
				operationId: "concurrent-first",
				select: true,
			}),
			openPiDurableSession({
				...create,
				operationId: "concurrent-last",
				select: true,
			}),
		]);
		expect(earlier.sessionId).not.toBe(latest.sessionId);
		expect(readDurableSessionRegistry(runtimeDir)?.activeId).toBe(
			latest.sessionId,
		);
		expect(ensure).toHaveBeenCalledTimes(3);
		identity.mockResolvedValue("replaced-store");
		await expect(
			openPiDurableSession({
				sessionId: first.sessionId,
				configDir: root,
				select: false,
			}),
		).rejects.toThrow("store identity changed");
		expect(ensure).toHaveBeenCalledTimes(3);
		expect(recover).toHaveBeenCalledTimes(2);
		expect(faux.state.callCount).toBe(0);
	} finally {
		for (const spy of spies.reverse()) spy.mockRestore();
		try {
			await host?.shutdown();
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			fs.rmSync(root, { force: true, recursive: true });
		}
	}
});
