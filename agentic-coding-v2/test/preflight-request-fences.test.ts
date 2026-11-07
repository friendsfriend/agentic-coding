import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { serve } from "../src/server/index.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// Preflight routing is identity-only: malformed or ambiguous requests are
// refused before any observation, unknown reports stay unknown, and history
// reads reject query parameters. Proofs run against the HTTP boundary.
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
const unknownDraft = `draft-${"0".repeat(64)}`;
const digest = "0".repeat(64);
test("preflight writes refuse malformed, ambiguous and off-mode requests", async () => {
	const { app, host, post } = await setup();
	try {
		const base = {
			requestId: "preflight",
			id: unknownDraft,
			revision: 1,
			digest,
		};
		const unknownField = await post("/api/environments/drafts/preflight", {
			...base,
			publish: true,
		});
		expect(unknownField.status).toBe(400);
		expect(await unknownField.text()).toContain("Unsupported preflight field");
		const twoModes = await post("/api/environments/drafts/preflight", {
			...base,
			useStagedSource: true,
			validateStagedCandidate: true,
		});
		expect(twoModes.status).toBe(400);
		expect(await twoModes.text()).toContain("Choose exactly one");
		const falseMode = await post("/api/environments/drafts/preflight", {
			...base,
			useStagedSource: false,
		});
		expect(falseMode.status).toBe(400);
		expect(await falseMode.text()).toContain("Choose exactly one");
		const offModeSelection = await post("/api/environments/drafts/preflight", {
			...base,
			app: "api",
			target: "stack",
		});
		expect(offModeSelection.status).toBe(400);
		expect(await offModeSelection.text()).toContain(
			"Only selected-source modes",
		);
		const retainedOffTree = await post("/api/environments/drafts/preflight", {
			...base,
			useStagedSource: true,
			retainStagedTree: true,
		});
		expect(retainedOffTree.status).toBe(400);
		expect(await retainedOffTree.text()).toContain("Retaining a staged tree");
		const malformedId = await post("/api/environments/drafts/preflight", {
			...base,
			id: "draft-nope",
		});
		expect(malformedId.status).toBe(400);
		expect(await malformedId.text()).toContain("Invalid definition draft ID");
		const malformedDigest = await post("/api/environments/drafts/preflight", {
			...base,
			digest: "nope",
		});
		expect(malformedDigest.status).toBe(400);
		expect(await malformedDigest.text()).toContain(
			"exact draft revision and digest",
		);
		const zeroRevision = await post("/api/environments/drafts/preflight", {
			...base,
			revision: 0,
		});
		expect(zeroRevision.status).toBe(400);
		expect(await zeroRevision.text()).toContain(
			"exact draft revision and digest",
		);
		const query = await post("/api/environments/drafts/preflight?x=1", base);
		expect(query.status).toBe(400);
		expect(await query.text()).toContain("query parameters");
	} finally {
		host.stop();
		await app.close();
	}
});
test("unknown preflight reports stay unknown and history reads reject query parameters", async () => {
	const { app, host, headers } = await setup();
	try {
		const unknown = await fetch(
			new URL("/api/environments/drafts/preflight?id=preflight-0", host.url),
			{ headers },
		);
		expect(unknown.status).toBe(400);
		const repeated = await fetch(
			new URL("/api/environments/drafts/preflight?id=a&id=b", host.url),
			{ headers },
		);
		expect(repeated.status).toBe(400);
		expect(await repeated.text()).toContain("exactly one report ID");
		const historyQuery = await fetch(
			new URL("/api/environments/drafts/preflights?x=1", host.url),
			{ headers },
		);
		expect(historyQuery.status).toBe(400);
		expect(await historyQuery.text()).toContain("query parameters");
		const history = await fetch(
			new URL("/api/environments/drafts/preflights", host.url),
			{ headers },
		);
		expect(history.status).toBe(200);
		expect(await history.json()).toEqual([]);
	} finally {
		host.stop();
		await app.close();
	}
});
