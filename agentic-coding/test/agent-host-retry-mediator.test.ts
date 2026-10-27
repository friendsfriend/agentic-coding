import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import {
	createHostIdentity,
	hostIdentityPaths,
} from "../src/agent-host/host-identity.ts";
import {
	encodeFrame,
	FrameReader,
	type HostRequest,
} from "../src/agent-host/protocol.ts";
import {
	hostRetryCapabilityForLaunch,
	hostRetryTargetFor,
	registerHostRetryTarget,
	releaseHostRetryCapability,
	replaceHostRetryCapabilityForLaunch,
	unregisterHostRetryTarget,
} from "../src/agent-host/retry-authority.ts";
import { retryAgentTaskAsOperator } from "../src/agent-host/retry-mediator.ts";
import type { AgentTaskRetryRequest } from "../src/contracts/actions.ts";

const request: AgentTaskRetryRequest = {
	runId: "run-1",
	conversationId: "17",
	taskId: "7",
	generation: 3,
};

describe("operator retry mediator", () => {
	test("returns a bounded refusal when no launcher authority is registered", async () => {
		await expect(retryAgentTaskAsOperator(request)).resolves.toEqual({
			taskId: "7",
			status: "refused",
			reason: "host recovery authority is unavailable",
		});
	});

	test("a late stop cannot unregister a newer retry target", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-retry-lease-"));
		const socketPath = path.join(dir, "host.sock");
		let capability = "";
		try {
			capability = hostRetryCapabilityForLaunch(socketPath);
			const olderLease = registerHostRetryTarget(
				request.runId,
				request.conversationId,
				socketPath,
			);
			const newerLease = registerHostRetryTarget(
				request.runId,
				request.conversationId,
				socketPath,
			);
			if (!olderLease || !newerLease)
				throw new Error("retry target registration did not return a lease");

			unregisterHostRetryTarget(
				request.runId,
				request.conversationId,
				olderLease,
			);
			expect(hostRetryTargetFor(request.runId, request.conversationId)).toEqual(
				{
					socketPath,
					capability: hostRetryCapabilityForLaunch(socketPath),
				},
			);
			unregisterHostRetryTarget(
				request.runId,
				request.conversationId,
				newerLease,
			);
			expect(
				hostRetryTargetFor(request.runId, request.conversationId),
			).toBeUndefined();
		} finally {
			if (capability) releaseHostRetryCapability(socketPath, capability);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("live retry authorities are not capacity-evicted and stale exits cannot remove a replacement", () => {
		const targets: Array<{
			socket: string;
			lease: string | undefined;
			capability: string;
		}> = [];
		try {
			for (let index = 0; index < 300; index++) {
				const socket = path.join(
					os.tmpdir(),
					`retry-live-${index}`,
					"host.sock",
				);
				const capability = hostRetryCapabilityForLaunch(socket);
				const lease = registerHostRetryTarget(
					`capacity-${index}`,
					"17",
					socket,
				);
				targets.push({ socket, lease, capability });
			}
			const first = targets[0];
			if (!first) throw new Error("missing first target");
			expect(hostRetryTargetFor("capacity-0", "17")?.capability).toBe(
				first.capability,
			);
			const replacement = replaceHostRetryCapabilityForLaunch(first.socket);
			releaseHostRetryCapability(first.socket, first.capability);
			expect(hostRetryTargetFor("capacity-0", "17")?.capability).toBe(
				replacement,
			);
			first.capability = replacement;
		} finally {
			for (const [index, target] of targets.entries()) {
				unregisterHostRetryTarget(`capacity-${index}`, "17", target.lease);
				releaseHostRetryCapability(target.socket, target.capability);
			}
		}
	});

	test("sends the private capability only over the pinned TLS host connection", async () => {
		const dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "agent-retry-mediator-")),
		);
		const socketPath = path.join(dir, "host.sock");
		const tlsPaths = hostIdentityPaths(socketPath);
		const identity = createHostIdentity();
		fs.writeFileSync(tlsPaths.certificate, identity.cert, { mode: 0o600 });
		const capability = hostRetryCapabilityForLaunch(socketPath);
		let receivedCapability: unknown;
		let rawConnections = 0;
		const rawServer = net.createServer((socket) => {
			rawConnections++;
			socket.resume();
		});
		const authenticatedServer = tls.createServer(
			{ key: identity.key, cert: identity.cert, minVersion: "TLSv1.3" },
			(socket) => {
				const reader = new FrameReader();
				socket.setEncoding("utf8");
				socket.on("data", (chunk: string) => {
					for (const line of reader.push(chunk)) {
						const retry = JSON.parse(line) as HostRequest;
						if (retry.type !== "retryTask") continue;
						receivedCapability = retry.recoveryCapability;
						socket.write(
							encodeFrame({
								type: "retryTask",
								runId: retry.runId,
								taskId: retry.taskId,
								status: "retried",
							}),
						);
					}
				});
			},
		);
		const listen = (server: net.Server, endpoint: string) =>
			new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(endpoint, resolve);
			});
		let lease: string | undefined;
		try {
			await Promise.all([
				listen(rawServer, socketPath),
				listen(authenticatedServer, tlsPaths.socket),
			]);
			lease = registerHostRetryTarget(
				request.runId,
				request.conversationId,
				socketPath,
			);
			expect(lease).toBeString();
			const result = await retryAgentTaskAsOperator(request);
			expect(receivedCapability).toBe(capability);
			expect(result).toEqual({
				taskId: "7",
				status: "retried",
				reason:
					"external effects may repeat; exactly-once execution is not guaranteed",
			});
			expect(rawConnections).toBe(0);
			expect(JSON.stringify(result)).not.toContain(capability);
			// A connected TLS peer with the wrong identity receives no retry frame.
			fs.writeFileSync(tlsPaths.certificate, createHostIdentity().cert, {
				mode: 0o600,
			});
			receivedCapability = undefined;
			expect(await retryAgentTaskAsOperator(request)).toMatchObject({
				status: "refused",
			});
			expect(receivedCapability).toBeUndefined();
			expect(rawConnections).toBe(0);
		} finally {
			unregisterHostRetryTarget(request.runId, request.conversationId, lease);
			releaseHostRetryCapability(socketPath, capability);
			await Promise.all([
				new Promise<void>((resolve) => rawServer.close(() => resolve())),
				new Promise<void>((resolve) =>
					authenticatedServer.close(() => resolve()),
				),
			]);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
