import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
