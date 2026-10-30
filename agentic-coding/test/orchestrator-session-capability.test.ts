import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { hostLayout } from "../src/agent-host/layout.ts";
import {
	openOrchestratorSession,
	orchestratorRuntimeDir,
	recoverScheduledOrchestrator,
} from "../src/agent-host/orchestrator-session.ts";
import {
	decodeFrame,
	encodeFrame,
	FrameReader,
	type HostRequest,
} from "../src/agent-host/protocol.ts";
import {
	authorizeOrchestratorConversation,
	createInstanceAuthority,
} from "../src/server/auth.ts";
import { parseRunEnvFile } from "../src/workflow/run-env.ts";

let root: string;
let server: net.Server;
let hostId: string;
let rejectRecovery: boolean;
let requests: Array<{ request: HostRequest; env?: Record<string, string> }>;
const authority = createInstanceAuthority("test", "fake-instance-key");

beforeEach(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-capability-"));
	const layout = hostLayout(orchestratorRuntimeDir(root));
	fs.mkdirSync(layout.root, { recursive: true });
	// Recovery requires existing durable storage and must not create it.
	fs.writeFileSync(layout.storagePath, "fake-storage");
	hostId = "durable-test-host";
	rejectRecovery = false;
	requests = [];
	server = net.createServer((socket) => {
		const reader = new FrameReader();
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			for (const line of reader.push(chunk)) {
				const decoded = decodeFrame(line);
				if (!decoded.ok) throw new Error("invalid test request");
				const request = decoded.value as HostRequest;
				requests.push({
					request,
					...("runEnvPath" in request
						? {
								env: parseRunEnvFile(
									fs.readFileSync(request.runEnvPath, "utf8"),
								),
							}
						: {}),
				});
				const response =
					request.type === "scheduledIdentity"
						? { type: "scheduledIdentity", hostId }
						: request.type === "ensureRun" || request.type === "recoverRun"
							? request.type === "recoverRun" && rejectRecovery
								? {
										type: "error",
										code: "ownership",
										message: "conversation changed",
									}
								: {
										type: "ensureRun",
										runId: request.runId,
										conversationId:
											request.type === "recoverRun"
												? request.expectedConversationId
												: request.runId,
									}
							: { type: "ok" };
				socket.write(encodeFrame(response as never));
			}
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(layout.socketPath, resolve),
	);
});
afterEach(async () => {
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	fs.rmSync(root, { recursive: true, force: true });
});

function identity(env: Record<string, string> | undefined) {
	return authorizeOrchestratorConversation(
		new Request("http://127.0.0.1/", {
			headers: { authorization: `Bearer ${env?.AGENTIC_ORCHESTRATOR_TOKEN}` },
		}),
		authority,
	);
}
function open(fresh = false) {
	return openOrchestratorSession({
		configDir: root,
		fresh,
		serverUrl: "http://127.0.0.1:1",
		serverToken: authority.token,
	});
}

test("bootstrap establishes durable identity before provisioning a conversation capability", async () => {
	const session = await open();
	const initial = requests.find(({ request }) => request.type === "ensureRun");
	const recovery = requests.find(
		({ request }) => request.type === "recoverRun",
	);
	expect(initial?.env?.AGENTIC_ORCHESTRATOR_TOKEN).toBeUndefined();
	expect(identity(recovery?.env)).toEqual({
		hostId,
		conversationId: session.conversationId,
	});
	expect(recovery?.request).toMatchObject({
		runId: session.runId,
		expectedConversationId: session.conversationId,
		toolPolicy: "orchestrator",
	});
	expect(JSON.stringify(requests)).not.toContain(authority.token);
});

test("reopen retains identity while a fresh session receives distinct custody", async () => {
	const first = await open();
	const firstEnv = requests.find(
		({ request }) => request.type === "recoverRun",
	)?.env;
	requests = [];
	expect((await open()).conversationId).toBe(first.conversationId);
	expect(
		requests.find(({ request }) => request.type === "recoverRun")?.env
			?.AGENTIC_ORCHESTRATOR_TOKEN,
	).toBe(firstEnv?.AGENTIC_ORCHESTRATOR_TOKEN);
	requests = [];
	const next = await open(true);
	expect(next.conversationId).not.toBe(first.conversationId);
	expect(
		identity(requests.find(({ request }) => request.type === "recoverRun")?.env)
			.conversationId,
	).toBe(next.conversationId);
});

test("scheduled recovery pins the host and conversation rather than the current visible session", async () => {
	const layout = hostLayout(orchestratorRuntimeDir(root));
	const target = {
		hostId,
		hostSocket: layout.socketPath,
		conversationId: "old-conversation",
		runId: "old-run",
	};
	await recoverScheduledOrchestrator(target, {
		configDir: root,
		serverUrl: "http://127.0.0.1:1",
		serverToken: authority.token,
	});
	expect(requests.some(({ request }) => request.type === "ensureRun")).toBe(
		false,
	);
	expect(
		identity(
			requests.find(({ request }) => request.type === "recoverRun")?.env,
		),
	).toEqual({ hostId, conversationId: target.conversationId });
	requests = [];
	hostId = "replacement-host";
	await expect(
		recoverScheduledOrchestrator(target, {
			configDir: root,
			serverUrl: "http://127.0.0.1:1",
			serverToken: authority.token,
		}),
	).rejects.toThrow("identity changed");
	expect(requests.some(({ request }) => request.type === "recoverRun")).toBe(
		false,
	);
});

test("an ownership mismatch fails bootstrap instead of returning a misbound session", async () => {
	rejectRecovery = true;
	await expect(open()).rejects.toThrow("conversation changed");
});
