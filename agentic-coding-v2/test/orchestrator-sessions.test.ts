import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

/** A created orchestrator is an ownerless sibling conversation with its own
 * directory: it must appear beside the reserved root, be reachable as a session,
 * and never be invented from a path the host cannot work in. */
test("a created orchestrator is a sibling conversation in its own directory", async () => {
	const { app } = await fixture();
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "acv2-orchestrator-"),
	);
	const host = serve(app),
		client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(
			async () => client.stateFresh,
			(fresh) => fresh === true,
		);
		const before = await client.call("orchestrator.read", {});
		expect(before.orchestrators).toHaveLength(1);
		expect(before.orchestrators[0]).toMatchObject({ title: "Orchestrator" });

		const created = await client.call("orchestrator.create", {
			path: directory,
			title: "Payments",
		});
		expect(created).toMatchObject({
			title: "Payments",
			path: fs.realpathSync(directory),
		});
		expect(created.id).not.toBe(before.orchestrators[0]?.id);

		const after = await client.call("orchestrator.read", {});
		expect(after.orchestrators.map((entry) => entry.title)).toEqual([
			"Orchestrator",
			"Payments",
		]);

		// It is a session too: the transcript is readable through the session
		// boundary, which is what the shell sends into.
		const context = await client.call("session.context", { id: created.id });
		expect(context).toBeTruthy();

		// The snapshot lists it as a top-level session, so the shell's tree sees
		// it without a second listing.
		const snapshot = await client.call("state.read", {});
		const session = snapshot.sessions.find((item) => item.id === created.id);
		expect(session).toMatchObject({ parent: null, title: "Payments" });
	} finally {
		client.close();
		await host.stop();
		fs.rmSync(directory, { recursive: true, force: true });
	}
}, 60_000);

test("orchestrator creation refuses a path the host cannot work in", async () => {
	const { app } = await fixture();
	const host = serve(app),
		client = new ClientConnection(host.client);
	const file = path.join(os.tmpdir(), `acv2-file-${process.pid}.txt`);
	fs.writeFileSync(file, "not a directory");
	try {
		client.connect();
		await eventually(
			async () => client.stateFresh,
			(fresh) => fresh === true,
		);
		// The client boundary sanitizes a refusal, so the assertion is the refusal
		// itself plus an unchanged catalog: no orchestrator is ever half-created.
		for (const candidate of ["relative/dir", "/nonexistent/acv2/path", file])
			await expect(
				client.call("orchestrator.create", { path: candidate }),
			).rejects.toThrow("refused");
		expect(
			(await client.call("orchestrator.read", {})).orchestrators,
		).toHaveLength(1);
	} finally {
		fs.rmSync(file, { force: true });
		client.close();
		await host.stop();
	}
}, 60_000);

/** The tree the shell draws: a task's session belongs under the orchestrator
 * that admitted it, not under the root by assumption. */
test("a child session nests under the orchestrator that admitted it", async () => {
	const { app, fake, invocation } = await fixture();
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acv2-child-"));
	const host = serve(app),
		client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(
			async () => client.stateFresh,
			(fresh) => fresh === true,
		);
		const created = await client.call("orchestrator.create", {
			path: directory,
			title: "Ledger",
		});
		fake.setResponses([fauxAssistantMessage("Observed the checkout")]);
		const task = await app.startTask(invocation, null, created.id);
		const snapshot = await eventually(
			async () => client.call("state.read", {}),
			(value) => value.sessions.some((session) => session.task === task),
		);
		const child = snapshot.sessions.find((session) => session.task === task);
		expect(child?.parent).toBe(created.id);
		// The root keeps its own identity and no task child of its own.
		const root = snapshot.sessions.find((session) => session.parent === null);
		expect(root?.title).toBe("Orchestrator");
		expect(
			snapshot.sessions.some(
				(session) => session.parent === root?.id && session.task === task,
			),
		).toBe(false);
	} finally {
		client.close();
		await host.stop();
		fs.rmSync(directory, { recursive: true, force: true });
	}
}, 120_000);

/** Ownership is decided by the conversation, not by a list of identities: every
 * orchestrator inspects environments as an orchestrator, and a task conversation
 * still resolves to its own task. */
test("a created orchestrator is not mistaken for a task owner", async () => {
	const { app, fake, invocation } = await fixture();
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acv2-owner-"));
	const host = serve(app),
		client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(
			async () => client.stateFresh,
			(fresh) => fresh === true,
		);
		const created = await client.call("orchestrator.create", {
			path: directory,
			title: "Owner fence",
		});
		// It works in its own directory, which is what the chooser promised.
		const conversation = await app.orchestrators.conversation(created.id);
		expect((await conversation.agent(context)).cwd).toBe(
			fs.realpathSync(directory),
		);
		expect(await app.taskOwnerOrNull(created.id as never)).toBeNull();
		expect(await app.taskOwnerOrNull(Number(app.home.id) as never)).toBeNull();

		fake.setResponses([fauxAssistantMessage("Observed the checkout")]);
		const task = await app.startTask(invocation);
		const snapshot = await eventually(
			async () => client.call("state.read", {}),
			(value) => value.sessions.some((session) => session.task === task),
		);
		const child = snapshot.sessions.find((session) => session.task === task);
		expect(child).toBeDefined();
		// A task conversation keeps its owner; the previous fence is unchanged.
		expect(await app.taskOwnerOrNull(child?.id as never)).not.toBeNull();
	} finally {
		client.close();
		await host.stop();
		fs.rmSync(directory, { recursive: true, force: true });
	}
}, 120_000);

/** A completion is a report to whoever asked for the task. It must reach the
 * admitting orchestrator's transcript and never be re-routed to the root. */
test("a task completion reaches the orchestrator that admitted it", async () => {
	const { app, fake, invocation } = await fixture();
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acv2-report-"));
	const host = serve(app),
		client = new ClientConnection(host.client);
	const contains = (transcript: unknown, marker: string) =>
		JSON.stringify(transcript).includes(marker);
	try {
		client.connect();
		await eventually(
			async () => client.stateFresh,
			(fresh) => fresh === true,
		);
		const created = await client.call("orchestrator.create", {
			path: directory,
			title: "Reporter",
		});
		// One response for the task's own generation, one for the orchestrator's
		// follow-up turn after the completion arrives.
		fake.setResponses([
			fauxAssistantMessage("Task finished"),
			fauxAssistantMessage("Reported to the developer"),
		]);
		const task = await app.startTask(invocation, null, created.id);
		await eventually(
			async () => (await app.taskResult(task))?.state.status,
			(status) => status === "terminal",
		);
		await app.tick();
		// The completion text is itself a JSON string inside the entry, so its
		// quotes are escaped once more by the transcript serialization.
		const marker = `\\"taskId\\":${task}`;
		const admitted = await eventually(
			async () => client.call("session.read", { id: created.id }),
			(transcript) => contains(transcript, "Task completion"),
		);
		expect(contains(admitted, marker)).toBe(true);
		const root = await client.call("session.read", {
			id: Number(app.home.id),
		});
		expect(contains(root, "Task completion")).toBe(false);
	} finally {
		client.close();
		await host.stop();
		fs.rmSync(directory, { recursive: true, force: true });
	}
}, 180_000);

/** Renaming is a catalog decision; retiring takes it out of the tree, out of
 * the session catalog and out of completion delivery, while the root and the
 * transcript stay untouched. */
test("an orchestrator can be renamed and retired, and the root cannot", async () => {
	const { app, fake, invocation } = await fixture();
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acv2-retire-"));
	const host = serve(app),
		client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(
			async () => client.stateFresh,
			(fresh) => fresh === true,
		);
		const created = await client.call("orchestrator.create", {
			path: directory,
			title: "Draft",
		});
		const renamed = await client.call("orchestrator.rename", {
			id: created.id,
			title: "Ledger",
		});
		expect(renamed).toMatchObject({ id: created.id, title: "Ledger" });
		const listed = await client.call("orchestrator.read", {});
		expect(listed.orchestrators.map((entry) => entry.title)).toEqual([
			"Orchestrator",
			"Ledger",
		]);

		// A task admitted by it still reports, so retiring must not lose a result.
		fake.setResponses([
			fauxAssistantMessage("Task finished"),
			fauxAssistantMessage("Reported"),
		]);
		const task = await app.startTask(invocation, null, created.id);
		await eventually(
			async () => (await app.taskResult(task))?.state.status,
			(status) => status === "terminal",
		);

		expect(
			await client.call("orchestrator.retire", { id: created.id }),
		).toEqual({
			id: created.id,
			retired: true,
		});
		const after = await client.call("orchestrator.read", {});
		expect(after.orchestrators.map((entry) => entry.title)).toEqual([
			"Orchestrator",
		]);
		const snapshot = await client.call("state.read", {});
		expect(snapshot.sessions.some((session) => session.id === created.id)).toBe(
			false,
		);
		// Its transcript is no longer a session the shell can reach.
		await expect(
			client.call("session.read", { id: created.id }),
		).rejects.toThrow("refused");
		// Retiring twice, and retiring the root, are both refused.
		await expect(
			client.call("orchestrator.retire", { id: created.id }),
		).rejects.toThrow("refused");
		await expect(
			client.call("orchestrator.retire", { id: Number(app.home.id) }),
		).rejects.toThrow("refused");
		await expect(
			client.call("orchestrator.rename", {
				id: Number(app.home.id),
				title: "Renamed root",
			}),
		).rejects.toThrow("refused");

		// The completion falls back to the root rather than disappearing.
		await app.tick();
		const root = await eventually(
			async () => client.call("session.read", { id: Number(app.home.id) }),
			(transcript) => JSON.stringify(transcript).includes("Task completion"),
		);
		expect(JSON.stringify(root)).toContain(`\\"taskId\\":${task}`);
	} finally {
		client.close();
		await host.stop();
		fs.rmSync(directory, { recursive: true, force: true });
	}
}, 180_000);

/** A repeated creation request is one orchestrator, not two: the identity the
 * caller sends is what decides, and a replay never races a second conversation
 * into existence. */
test("a repeated creation request returns the orchestrator it already made", async () => {
	const { app } = await fixture();
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acv2-idem-"));
	const host = serve(app),
		client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(
			async () => client.stateFresh,
			(fresh) => fresh === true,
		);
		const requestId = crypto.randomUUID();
		const [first, second] = await Promise.all([
			client.call("orchestrator.create", {
				path: directory,
				title: "Once",
				requestId,
			}),
			client.call("orchestrator.create", {
				path: directory,
				title: "Once",
				requestId,
			}),
		]);
		expect(second.id).toBe(first.id);
		const listed = await client.call("orchestrator.read", {});
		expect(listed.orchestrators.map((entry) => entry.title)).toEqual([
			"Orchestrator",
			"Once",
		]);
		// A different identity for the same intent is a second request, and the
		// duplicate-directory fence still refuses it.
		await expect(
			client.call("orchestrator.create", {
				path: directory,
				title: "Once",
				requestId: crypto.randomUUID(),
			}),
		).rejects.toThrow("refused");
		// A replayed request whose orchestrator was retired says so instead of
		// pretending to create and navigate to a hidden conversation.
		await client.call("orchestrator.retire", { id: first.id });
		await expect(
			client.call("orchestrator.create", {
				path: directory,
				title: "Once",
				requestId,
			}),
		).rejects.toThrow("refused");
	} finally {
		client.close();
		await host.stop();
		fs.rmSync(directory, { recursive: true, force: true });
	}
}, 120_000);
