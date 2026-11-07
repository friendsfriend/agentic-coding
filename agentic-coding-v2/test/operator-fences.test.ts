import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { serve } from "../src/server/index.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// Operator revocation, release and action routes are fenced: malformed
// requests are refused, unknown runs stay unknown, revocation identities are
// exact, and release requires confirmed inspection. Proofs run against the
// HTTP boundary.
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
	return { app, host, post };
};
test("revocation refuses malformed requests and unknown runs", async () => {
	const { app, host, post } = await setup();
	try {
		const extra = await post("/api/environments/revoke", {
			requestId: "revoke-extra",
			runId: "env-1:api",
			revision: 1,
			reason: "inspect",
			publish: true,
		});
		expect(extra.status).toBe(400);
		expect(await extra.text()).toContain(
			"Unexpected environment revocation field",
		);
		const fractional = await post("/api/environments/revoke", {
			requestId: "revoke-fractional",
			runId: "env-1:api",
			revision: 1.5,
			reason: "inspect",
		});
		expect(fractional.status).toBe(400);
		expect(await fractional.text()).toContain("integer run revision");
		const unknown = await post("/api/environments/revoke", {
			requestId: "revoke-unknown",
			runId: "env-1:api",
			revision: 1,
			reason: "inspect",
		});
		expect(unknown.status).toBe(400);
		expect(await unknown.text()).toContain("Unknown environment run");
		const mismatch = await post("/api/environments/revoke", {
			requestId: "revoke-unknown",
			runId: "env-1:api",
			revision: 1,
			reason: "different",
		});
		expect(mismatch.status).toBe(400);
		expect(await mismatch.text()).toContain("Unknown environment run");
	} finally {
		host.stop();
		await app.close();
	}
});
test("release requires confirmed inspection and actions require known operations", async () => {
	const { app, host, post } = await setup();
	try {
		const unconfirmed = await post("/api/environments/release", {
			id: "env-1:api",
			revision: 1,
		});
		expect(unconfirmed.status).toBe(400);
		expect(await unconfirmed.text()).toContain("Confirm inspection");
		const malformed = await post("/api/environments/release", {
			id: "nope",
			revision: 1,
			inspectionConfirmed: true,
		});
		expect(malformed.status).toBe(400);
		expect(await malformed.text()).toContain("Invalid environment run ID");
		const unknown = await post("/api/environments/release", {
			id: "env-1:api",
			revision: 1,
			inspectionConfirmed: true,
		});
		expect(unknown.status).toBe(400);
		const action = await post("/api/environments/actions", { action: "nope" });
		expect(action.status).toBe(400);
	} finally {
		host.stop();
		await app.close();
	}
});
