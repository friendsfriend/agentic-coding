// Real durable storage/control-socket regressions for keyed ownership and
// overlapping ensure/watch acquisition, following agent-host-watch.test.ts.
import { expect, spyOn, test } from "bun:test";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { HostClient } from "../src/agent-host/client.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { encodeFrame } from "../src/agent-host/protocol.ts";

function fixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-ownership-"));
	const layout = hostLayout(dir);
	fs.mkdirSync(layout.root, { recursive: true });
	const runEnvPath = path.join(dir, "run.env");
	fs.writeFileSync(runEnvPath, "");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return {
		dir,
		layout,
		models,
		options: { layout, settings: {}, globalAgentDir: dir, models },
		input: {
			cwd: dir,
			runEnvPath,
			toolPolicy: "default" as const,
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		},
	};
}

async function openHost(options: Parameters<typeof DurableHost.open>[0]) {
	let captured: Harness | undefined;
	const original = Harness.open;
	const open = spyOn(Harness, "open").mockImplementation(async (...args) => {
		captured = await original(...args);
		return captured;
	});
	try {
		const host = await DurableHost.open(options);
		if (!captured) throw new Error("harness was not opened");
		return { host, harness: captured };
	} finally {
		open.mockRestore();
	}
}

async function waitFor(predicate: () => boolean) {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("ownership test timed out");
}

test("concurrent duplicate ensures and fresh role reuse converge across live watch and restart", async () => {
	const f = fixture();
	const { host: first, harness } = await openHost(f.options);
	let restarted: DurableHost | undefined;
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const roleGate = Promise.withResolvers<void>();
	let acquisitionGate = gate.promise;
	const ensures = spyOn(first, "ensureRun");
	const original = harness.createConversation.bind(harness);
	const create = spyOn(harness, "createConversation").mockImplementation(
		async (...args) => {
			const conversation = await original(...args);
			entered.resolve();
			await acquisitionGate;
			return conversation;
		},
	);
	try {
		await first.listen();
		const client = new HostClient(f.layout.socketPath, 10_000);
		const requests = Array.from({ length: 12 }, () =>
			client.ensureRun({ ...f.input, runId: "duplicate", name: "worker" }),
		);
		await entered.promise;
		// Do not release the first create until all socket requests have entered
		// ensureRun. This forces overlap instead of relying on I/O timing.
		await waitFor(() => ensures.mock.calls.length === 12);
		expect(create).toHaveBeenCalledTimes(1);
		gate.resolve();
		const replies = await Promise.all(requests);
		expect(new Set(replies.map((reply) => reply.conversationId)).size).toBe(1);
		expect(create).toHaveBeenCalledTimes(1);
		acquisitionGate = roleGate.promise;
		const roleRequests = ["role-run-1", "role-run-2"].map((runId) =>
			client.ensureRun({ ...f.input, runId, name: "fresh-role" }),
		);
		await waitFor(
			() => ensures.mock.calls.length === 14 && create.mock.calls.length >= 2,
		);
		expect(create).toHaveBeenCalledTimes(2);
		roleGate.resolve();
		const reused = await Promise.all(roleRequests);
		expect(new Set(reused.map((reply) => reply.conversationId)).size).toBe(1);
		expect(create).toHaveBeenCalledTimes(2);
		const conversationId = replies[0]?.conversationId;
		if (!conversationId) throw new Error("missing ensure reply");
		const frames: unknown[] = [];
		const stop = await client.watch(
			"duplicate",
			(value) => frames.push(value),
			{ conversationId },
		);
		stop();
		expect(frames.length).toBeGreaterThan(0);
		create.mockRestore();
		await first.shutdown();
		restarted = await DurableHost.open(f.options);
		await restarted.listen();
		const recovered = new HostClient(f.layout.socketPath, 10_000);
		for (const [runId, hint] of [
			["duplicate", conversationId],
			["role-run-1", reused[0]?.conversationId],
			["role-run-2", reused[1]?.conversationId],
		] as const) {
			const values: unknown[] = [];
			const end = await recovered.watch(runId, (value) => values.push(value), {
				conversationId: hint,
			});
			end();
			expect(values.length).toBeGreaterThan(0);
		}
	} finally {
		gate.resolve();
		roleGate.resolve();
		ensures.mockRestore();
		create.mockRestore();
		await restarted?.shutdown();
		await first.shutdown();
		fs.rmSync(f.dir, { recursive: true, force: true });
	}
});

test("failed ensure releases its run and role single-flight for a subsequent retry", async () => {
	const f = fixture();
	const { host, harness } = await openHost(f.options);
	const create = spyOn(harness, "createConversation").mockRejectedValueOnce(
		new Error("creation failed"),
	);
	try {
		const input = { ...f.input, runId: "retry", name: "worker" };
		const first = host.ensureRun(input);
		const duplicate = host.ensureRun(input);
		expect(first).toBe(duplicate);
		await expect(first).rejects.toThrow(/creation failed/);
		await expect(duplicate).rejects.toThrow(/creation failed/);
		const result = await host.ensureRun(input);
		expect(Number(result.conversationId)).toBeGreaterThan(0);
	} finally {
		create.mockRestore();
		await host.shutdown();
		fs.rmSync(f.dir, { recursive: true, force: true });
	}
});

test("ensure and recovery address only requested constant-size associations after many retired runs", async () => {
	const f = fixture();
	const { host: first, harness } = await openHost(f.options);
	let restarted: DurableHost | undefined;
	let snapshots = spyOn(harness, "snapshot");
	try {
		let conversationId = "";
		for (let i = 0; i < 128; i++) {
			const runId = `historical-${i}`;
			conversationId = (
				await first.ensureRun({ ...f.input, runId, name: "worker" })
			).conversationId;
			await first.stopRun(runId);
		}
		snapshots.mockClear();
		await first.ensureRun({ ...f.input, runId: "new-run", name: "worker" });
		// One keyed managed-role fence plus run/role associations; no history scan.
		expect(snapshots).toHaveBeenCalledTimes(3);
		const reads = await Promise.all(
			snapshots.mock.results.map((result) => result.value),
		);
		expect(reads).toEqual([
			undefined,
			undefined,
			{ identity: "worker", conversationId: Number(conversationId) },
		]);
		await first.shutdown();
		snapshots.mockRestore();
		const recovered = await openHost(f.options);
		restarted = recovered.host;
		snapshots = spyOn(recovered.harness, "snapshot");
		for (const runId of ["historical-0", "historical-127"]) {
			snapshots.mockClear();
			const values: unknown[] = [];
			const stop = await restarted.watchRun(
				runId,
				(value) => values.push(value),
				conversationId,
			);
			stop();
			expect(values.length).toBeGreaterThan(0);
			// Recovery reads the keyed ownership association and the keyed
			// persisted runtime-failure document used by the watch augmentation.
			// Both are constant-size; neither scans retired run history.
			expect(snapshots).toHaveBeenCalledTimes(2);
			expect(await snapshots.mock.results[0]?.value).toEqual({
				identity: runId,
				conversationId: Number(conversationId),
			});
			expect(await snapshots.mock.results[1]?.value).toBeUndefined();
		}
	} finally {
		snapshots.mockRestore();
		await restarted?.shutdown();
		await first.shutdown();
		fs.rmSync(f.dir, { recursive: true, force: true });
	}
});

test("legacy issued associations migrate atomically while role-only hints remain unverifiable", async () => {
	const f = fixture();
	const legacy = defineDoc({
		kind: "agentic.runs",
		version: 1,
		scope: "session",
		checkpointWhen: () => false,
		initial: () => ({
			runs: {} as Record<string, { conversationId: number }>,
			runConversations: {} as Record<string, { conversationId: number }>,
		}),
	});
	let harness: Harness | undefined = await Harness.open(
		await openNodeSqliteStorage(f.layout.storagePath),
		{ models: f.models, registry: createRegistry() },
		BACKGROUND_CONTEXT,
	);
	let host: DurableHost | undefined;
	try {
		const conversation = await harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { cwd: f.dir } },
			BACKGROUND_CONTEXT,
		);
		const id = conversation.id as unknown as number;
		await harness.commit(async (tx) => {
			const doc = await tx.doc(legacy);
			doc.runs.worker = { conversationId: id };
			for (let i = 0; i < 32; i++)
				doc.runConversations[`legacy-${i}`] = { conversationId: id };
		}, BACKGROUND_CONTEXT);
		await harness.close(BACKGROUND_CONTEXT);
		harness = undefined;
		// Open twice: first migrates the aggregate, second uses keyed ownership.
		for (let restart = 0; restart < 2; restart++) {
			host = await DurableHost.open(f.options);
			for (const runId of ["legacy-0", "legacy-31"]) {
				const stop = await host.watchRun(runId, () => {}, String(id));
				stop();
			}
			await expect(
				host.watchRun("role-only-unknown", () => {}, String(id)),
			).rejects.toThrow(/unverified/);
			expect(
				(
					await host.ensureRun({
						...f.input,
						runId: `new-${restart}`,
						name: "worker",
					})
				).conversationId,
			).toBe(String(id));
			await host.shutdown();
		}
		harness = await Harness.open(
			await openNodeSqliteStorage(f.layout.storagePath),
			{ models: f.models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		await expect(harness.snapshot(legacy, BACKGROUND_CONTEXT)).rejects.toThrow(
			/newer version/i,
		);
		await harness.close(BACKGROUND_CONTEXT);
		// A rollback restores the whole pre-upgrade database, not empty maps.
		const backup = `${f.layout.storagePath}.pre-keyed-v2`;
		expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
		harness = await Harness.open(
			await openNodeSqliteStorage(backup),
			{ models: f.models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		const preserved = await harness.snapshot(legacy, BACKGROUND_CONTEXT);
		expect(preserved?.runs.worker?.conversationId).toBe(id);
		expect(Object.keys(preserved?.runConversations ?? {})).toHaveLength(32);
		expect(
			await harness.conversation(conversation.id, BACKGROUND_CONTEXT),
		).toBeDefined();
	} finally {
		await harness?.close(BACKGROUND_CONTEXT);
		await host?.shutdown();
		fs.rmSync(f.dir, { recursive: true, force: true });
	}
});

test("a failed backup prevents the host-store version gate or ownership migration from being installed", async () => {
	const f = fixture();
	const legacy = defineDoc<{
		runs: Record<string, { conversationId: number }>;
		runConversations: Record<string, { conversationId: number }>;
	}>({
		kind: "agentic.runs",
		version: 1,
		scope: "session",
		checkpointWhen: () => false,
		initial: () => ({ runs: {}, runConversations: {} }),
	});
	let harness = await Harness.open(
		await openNodeSqliteStorage(f.layout.storagePath),
		{ models: f.models, registry: createRegistry() },
		BACKGROUND_CONTEXT,
	);
	try {
		await harness.commit(async (tx) => {
			const doc = await tx.doc(legacy);
			doc.runs.worker = { conversationId: 7 };
			doc.runConversations.original = { conversationId: 7 };
		}, BACKGROUND_CONTEXT);
		await harness.close(BACKGROUND_CONTEXT);
		const backup = `${f.layout.storagePath}.pre-keyed-v2`;
		fs.writeFileSync(backup, "preserve an existing rollback copy");
		await expect(DurableHost.open(f.options)).rejects.toThrow(
			/backup already exists/,
		);
		harness = await Harness.open(
			await openNodeSqliteStorage(f.layout.storagePath),
			{ models: f.models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		const preserved = await harness.snapshot(legacy, BACKGROUND_CONTEXT);
		expect(preserved?.runs.worker?.conversationId).toBe(7);
		expect(preserved?.runConversations.original?.conversationId).toBe(7);
		expect(fs.readFileSync(backup, "utf8")).toBe(
			"preserve an existing rollback copy",
		);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
		fs.rmSync(f.dir, { recursive: true, force: true });
	}
});

test("a newer durable document version explicitly rejects an older reader", async () => {
	const f = fixture();
	const old = defineDoc({
		kind: "agentic.format-probe",
		version: 1,
		scope: "session",
		checkpointWhen: () => false,
		initial: () => ({ value: 1 }),
	});
	const next = defineDoc({
		kind: "agentic.format-probe",
		version: 2,
		scope: "session",
		checkpointWhen: () => false,
		initial: () => ({ value: 2 }),
		migrate: (value) => value as { value: number },
	});
	let harness = await Harness.open(
		await openNodeSqliteStorage(f.layout.storagePath),
		{ models: f.models, registry: createRegistry() },
		BACKGROUND_CONTEXT,
	);
	try {
		await harness.commit(async (tx) => {
			const doc = await tx.doc(old);
			doc.value = 1;
		}, BACKGROUND_CONTEXT);
		await harness.commit(async (tx) => {
			const doc = await tx.doc(next);
			doc.value = 2;
		}, BACKGROUND_CONTEXT);
		await harness.close(BACKGROUND_CONTEXT);
		harness = await Harness.open(
			await openNodeSqliteStorage(f.layout.storagePath),
			{ models: f.models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		await expect(harness.snapshot(old, BACKGROUND_CONTEXT)).rejects.toThrow(
			/version/i,
		);
		await expect(
			harness.commit(async (tx) => {
				const doc = await tx.doc(old);
				doc.value = 1;
			}, BACKGROUND_CONTEXT),
		).rejects.toThrow(/version/i);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
		fs.rmSync(f.dir, { recursive: true, force: true });
	}
});

for (const patch of [false, true]) {
	test(`a peer closed during ${patch ? "patch" : "full"} watch acquisition immediately stops the late subscription`, async () => {
		const f = fixture();
		const host = await DurableHost.open(f.options);
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const original = host.watchRun.bind(host);
		let stopped = 0;
		const watch = spyOn(host, "watchRun").mockImplementation(
			async (...args) => {
				// Pause after the real subscription (including timing listeners) exists,
				// but before the socket handler can register the acquired stop function.
				const stop = await original(...args);
				entered.resolve();
				await gate.promise;
				completed.resolve();
				return () => {
					stopped++;
					stop();
				};
			},
		);
		let socket: net.Socket | undefined;
		try {
			const ensured = await host.ensureRun({
				...f.input,
				runId: "late-watch",
				name: "worker",
			});
			await host.listen();
			socket = net.createConnection(f.layout.socketPath);
			await once(socket, "connect");
			socket.resume();
			socket.write(
				encodeFrame({
					type: "watch",
					runId: "late-watch",
					conversationId: ensured.conversationId,
					patch,
				}),
			);
			await entered.promise;
			const closed = once(socket, "close");
			socket.end();
			await closed;
			// Observe the server-side close independently of the acquisition gate.
			await new Promise<void>((resolve) => setImmediate(resolve));
			gate.resolve();
			await completed.promise;
			await waitFor(() => stopped === 1);
			expect(stopped).toBe(1);
		} finally {
			gate.resolve();
			socket?.destroy();
			watch.mockRestore();
			await host.shutdown();
			fs.rmSync(f.dir, { recursive: true, force: true });
		}
	});
}
