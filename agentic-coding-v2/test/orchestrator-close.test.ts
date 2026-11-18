// The developer-visible contract of closing a session: it leaves the sidebar, it
// is not addressable any more, and the same checkout accepts a new one.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionCatalog } from "../src/server/client/handlers/sessions.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("a closed orchestrator leaves the sidebar and the checkout accepts a new one", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ac-v2-close-")),
	);
	const { app } = await fixture(false, (config) => {
		config.profiles = [];
		config.repositories = [root];
	});
	const created = await app.orchestrators.create({ path: root, title: "mine" });
	expect((await sessionCatalog(app)).map((session) => session.id)).toContain(
		created.id,
	);
	await app.orchestrators.close(created.id);
	const listed = await sessionCatalog(app);
	expect(listed.map((session) => session.id)).not.toContain(created.id);
	// Only the reserved root remains: a closure is not a hidden extra row.
	expect(listed.filter((session) => session.parent === null).length).toBe(1);
	// A closed session is finished: nothing can be asked, reported or sent to it.
	await expect(app.orchestrators.conversation(created.id)).rejects.toThrow(
		"Orchestrator is not retained",
	);
	// Idempotent close can finish cleanup after a crash or an older host closure.
	await expect(app.orchestrators.close(created.id)).resolves.toMatchObject({
		id: created.id,
	});
	// Continuing the work means creating a new orchestrator for that checkout.
	const next = await app.orchestrators.create({ path: root, title: "mine" });
	expect(next.id).not.toBe(created.id);
	expect((await sessionCatalog(app)).map((session) => session.id)).toContain(
		next.id,
	);
});
