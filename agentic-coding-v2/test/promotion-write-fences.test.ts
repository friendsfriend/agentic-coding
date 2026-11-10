import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server/index.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// Promotion writes are fenced against a changed configuration directory, a
// non-regular live destination and a held cooperative lock. The live
// destination is never adopted, converted or reclaimed: failures leave it
// untouched. Proofs run against the HTTP boundary.
const setup = async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const host = serve(app);
	const headers = {
		Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
		"Content-Type": "application/json",
	};
	const post = (route: string, body: unknown) =>
		fetch(new URL(route, host.url), {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
	const document = (targetId: string) =>
		JSON.stringify({
			version: 1,
			projects: [
				{
					id: "promoted",
					kind: "app",
					repository: config.repositories[0] ?? "",
					targets: [
						{
							id: targetId,
							action: "run",
							runtime: "compose",
							compose: {
								file: "compose.yaml",
								provider: "docker",
								socket: path.join(config.stateDir, "absent.sock"),
							},
						},
					],
				},
			],
		});
	const create = (requestId: string, content: string) =>
		post("/api/environments/drafts", { requestId, content }).then((response) =>
			response.json(),
		);
	const promote = (
		requestId: string,
		created: { id: string; digest: string },
	) =>
		post("/api/environments/drafts/promote", {
			requestId,
			id: created.id,
			revision: 1,
			digest: created.digest,
			approve: created.digest,
		});
	return { app, config, host, post, document, create, promote };
};
test("a recreated configuration directory invalidates the recorded base identity", async () => {
	const { app, config, host, document, create, promote } = await setup();
	try {
		const created = await create("identity-create", document("v1"));
		fs.rmSync(config.configDir, { recursive: true, force: true });
		fs.mkdirSync(config.configDir, { mode: 0o700 });
		const refused = await promote("identity-promote", created);
		expect(refused.status).toBe(400);
		expect(await refused.text()).toContain(
			"current configuration-directory identity",
		);
	} finally {
		host.stop();
		await app.close();
	}
});
test("a non-regular live destination is refused and left untouched", async () => {
	const { app, config, host, document, create, promote } = await setup();
	try {
		const live = path.join(config.configDir, "environments.json");
		const created = await create("irregular-create", document("v1"));
		for (const plant of ["directory", "symlink", "oversized"]) {
			fs.rmSync(live, { recursive: true, force: true });
			if (plant === "directory") fs.mkdirSync(live);
			else if (plant === "symlink")
				fs.symlinkSync(path.join(config.configDir, "elsewhere.json"), live);
			else
				fs.writeFileSync(live, `{"version":1,"pad":"${"x".repeat(262145)}"}`);
			const refused = await promote(`irregular-${plant}`, created);
			expect(refused.status).toBe(400);
			expect(await refused.text()).toContain(
				"must be a regular environments.json",
			);
			const stat = fs.lstatSync(live);
			expect(stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()).toBe(
				true,
			);
		}
	} finally {
		host.stop();
		await app.close();
	}
});
test("a held cooperative lock blocks promotion and its removal unblocks without residue", async () => {
	const { app, config, host, document, create, promote } = await setup();
	try {
		const created = await create("lock-create", document("v1"));
		const lock = path.join(config.configDir, ".environments.json.lock");
		fs.mkdirSync(lock, { mode: 0o700 });
		const blocked = await promote("lock-blocked", created);
		expect(blocked.status).toBe(400);
		expect(await blocked.text()).toContain("Promotion lock already exists");
		fs.rmdirSync(lock);
		const promoted = await promote("lock-released", created);
		expect(promoted.status).toBe(200);
		expect(await promoted.json()).toMatchObject({ outcome: "written" });
		expect(fs.existsSync(lock)).toBe(false);
	} finally {
		host.stop();
		await app.close();
	}
});
