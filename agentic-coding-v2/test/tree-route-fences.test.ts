import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// Tree cleanup, release and source-removal routes are fenced receipts: query
// parameters are refused, unknown attempts stay unknown, acknowledgements
// require exact pending IDs, and releases are addressed by recorded digests.
// Proofs run against the HTTP boundary.
const setup = async () => {
	const { app } = await fixture(true, (config) => {
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
	return { app, host, headers, post };
};
const unknownCleanup = `tree-cleanup-${"0".repeat(64)}`;
const unknownDigest = "0".repeat(64);
test("tree routes reject query parameters", async () => {
	const { app, host, post } = await setup();
	try {
		for (const route of [
			"/api/environments/drafts/tree-cleanup/acknowledge?x=1",
			"/api/environments/drafts/tree/temporary-release?x=1",
			"/api/environments/drafts/tree/release?x=1",
			"/api/environments/drafts/source/remove?x=1",
		]) {
			const response = await post(route, {});
			expect(response.status).toBe(400);
			expect(await response.text()).toContain("query parameters");
		}
	} finally {
		host.stop();
		await app.close();
	}
});
test("cleanup acknowledgement requires an exact pending attempt", async () => {
	const { app, host, post } = await setup();
	try {
		const unknown = await post(
			"/api/environments/drafts/tree-cleanup/acknowledge",
			{
				requestId: "ack-unknown",
				id: unknownCleanup,
				revision: 1,
				acknowledge: true,
			},
		);
		expect(unknown.status).toBe(400);
		expect(await unknown.text()).toContain("Unknown cleanup attempt");
		const malformed = await post(
			"/api/environments/drafts/tree-cleanup/acknowledge",
			{
				requestId: "ack-malformed",
				id: "tree-cleanup-nope",
				revision: 1,
				acknowledge: true,
			},
		);
		expect(malformed.status).toBe(400);
		expect(await malformed.text()).toContain("Explicit true acknowledgement");
		const unconfirmed = await post(
			"/api/environments/drafts/tree-cleanup/acknowledge",
			{
				requestId: "ack-unconfirmed",
				id: unknownCleanup,
				revision: 1,
				acknowledge: false,
			},
		);
		expect(unconfirmed.status).toBe(400);
		expect(await unconfirmed.text()).toContain("Explicit true acknowledgement");
		const zeroRevision = await post(
			"/api/environments/drafts/tree-cleanup/acknowledge",
			{
				requestId: "ack-zero",
				id: unknownCleanup,
				revision: 0,
				acknowledge: true,
			},
		);
		expect(zeroRevision.status).toBe(400);
		expect(await zeroRevision.text()).toContain(
			"Explicit true acknowledgement",
		);
		const extra = await post(
			"/api/environments/drafts/tree-cleanup/acknowledge",
			{
				requestId: "ack-extra",
				id: unknownCleanup,
				revision: 1,
				acknowledge: true,
				publish: true,
			},
		);
		expect(extra.status).toBe(400);
		expect(await extra.text()).toContain(
			"Unsupported cleanup acknowledgement field",
		);
	} finally {
		host.stop();
		await app.close();
	}
});
test("retained-tree release is addressed by recorded digest and staged-source removal by exact binding", async () => {
	const { app, host, post } = await setup();
	try {
		const release = await post("/api/environments/drafts/tree/release", {
			requestId: "release-unknown",
			name: unknownDigest,
		});
		expect(release.status).toBe(400);
		const malformed = await post("/api/environments/drafts/tree/release", {
			requestId: "release-malformed",
			name: "nope",
		});
		expect(malformed.status).toBe(400);
		expect(await malformed.text()).toContain("recorded tree digest");
		const extra = await post("/api/environments/drafts/tree/release", {
			requestId: "release-extra",
			name: unknownDigest,
			publish: true,
		});
		expect(extra.status).toBe(400);
		expect(await extra.text()).toContain(
			"Unsupported retained-tree release field",
		);
		const removal = await post("/api/environments/drafts/source/remove", {
			requestId: "remove-unknown",
			id: `draft-${unknownDigest}`,
			revision: 1,
			app: "api",
			target: "stack",
		});
		expect(removal.status).toBe(400);
		expect(await removal.text()).toContain("Unknown definition draft");
		const removalBoth = await post("/api/environments/drafts/source/remove", {
			requestId: "remove-both",
			id: `draft-${unknownDigest}`,
			revision: 1,
			app: "api",
			target: "stack",
			bindingDigest: unknownDigest,
		});
		expect(removalBoth.status).toBe(400);
		expect(await removalBoth.text()).toContain(
			"Choose a binding digest or app/target, not both",
		);
		const removalExtra = await post("/api/environments/drafts/source/remove", {
			requestId: "remove-extra",
			id: `draft-${unknownDigest}`,
			revision: 1,
			app: "api",
			target: "stack",
			publish: true,
		});
		expect(removalExtra.status).toBe(400);
		expect(await removalExtra.text()).toContain(
			"Unsupported staged source removal field",
		);
	} finally {
		host.stop();
		await app.close();
	}
});
