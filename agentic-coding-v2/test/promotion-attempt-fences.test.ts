import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../src/server/index.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// Promotion attempts are durable uncertainty barriers: routes reject query
// parameters, acknowledgements require an exact pending attempt, failed
// attempts stay visible but unacknowledgeable, and draft removal is an
// idempotent fenced receipt. Proofs run against the HTTP boundary.
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
	return { app, config, host, headers, post, document };
};
const unknownAttempt = `promotion-${"0".repeat(64)}`;
test("promotion, acknowledgement and removal routes reject query parameters", async () => {
	const { app, host, post } = await setup();
	try {
		for (const route of [
			"/api/environments/drafts/promote?x=1",
			"/api/environments/drafts/promotion-attempts/acknowledge?x=1",
			"/api/environments/drafts/remove?x=1",
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
test("acknowledgement requires an exact pending attempt", async () => {
	const { app, host, post } = await setup();
	try {
		const unknown = await post(
			"/api/environments/drafts/promotion-attempts/acknowledge",
			{
				requestId: "ack-unknown",
				id: unknownAttempt,
				acknowledge: true,
			},
		);
		expect(unknown.status).toBe(400);
		expect(await unknown.text()).toContain("Unknown promotion attempt");
		const malformed = await post(
			"/api/environments/drafts/promotion-attempts/acknowledge",
			{
				requestId: "ack-malformed",
				id: "promotion-nope",
				acknowledge: true,
			},
		);
		expect(malformed.status).toBe(400);
		expect(await malformed.text()).toContain("Explicit true acknowledgement");
		const unconfirmed = await post(
			"/api/environments/drafts/promotion-attempts/acknowledge",
			{
				requestId: "ack-unconfirmed",
				id: unknownAttempt,
				acknowledge: false,
			},
		);
		expect(unconfirmed.status).toBe(400);
		expect(await unconfirmed.text()).toContain("Explicit true acknowledgement");
		const extra = await post(
			"/api/environments/drafts/promotion-attempts/acknowledge",
			{
				requestId: "ack-extra",
				id: unknownAttempt,
				acknowledge: true,
				publish: true,
			},
		);
		expect(extra.status).toBe(400);
		expect(await extra.text()).toContain(
			"Unsupported attempt acknowledgement field",
		);
	} finally {
		host.stop();
		await app.close();
	}
});
test("a failed promotion attempt stays visible but cannot be acknowledged", async () => {
	const { app, config, host, headers, post, document } = await setup();
	try {
		const created = await (
			await post("/api/environments/drafts", {
				requestId: "race-create",
				content: document("v1"),
			})
		).json();
		fs.mkdirSync(config.configDir, { recursive: true });
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			'{"version":1,"projects":[]}',
		);
		const raced = await post("/api/environments/drafts/promote", {
			requestId: "race-first",
			id: created.id,
			revision: 1,
			digest: created.digest,
			approve: created.digest,
		});
		expect(raced.status).toBe(400);
		expect(
			fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
		).toBe('{"version":1,"projects":[]}');
		const attempts = await (
			await fetch(
				new URL("/api/environments/drafts/promotion-attempts", host.url),
				{
					headers,
				},
			)
		).json();
		const failed = attempts.find(
			(attempt: { draftId: string }) => attempt.draftId === created.id,
		);
		expect(failed?.status).toBe("failed-before-write");
		const ack = await post(
			"/api/environments/drafts/promotion-attempts/acknowledge",
			{
				requestId: "ack-failed",
				id: failed.id,
				acknowledge: true,
			},
		);
		expect(ack.status).toBe(400);
		expect(await ack.text()).toContain("Only an unresolved promotion attempt");
	} finally {
		host.stop();
		await app.close();
	}
});
test("draft removal is an idempotent fenced receipt and unknown IDs stay unknown", async () => {
	const { app, host, post, document } = await setup();
	try {
		const created = await (
			await post("/api/environments/drafts", {
				requestId: "remove-create",
				content: document("v1"),
			})
		).json();
		const unknown = await post("/api/environments/drafts/remove", {
			requestId: "remove-unknown",
			id: unknownAttempt.replace("promotion-", "draft-"),
			revision: 1,
		});
		expect(unknown.status).toBe(400);
		const first = await post("/api/environments/drafts/remove", {
			requestId: "remove-first",
			id: created.id,
			revision: 1,
		});
		expect(first.status).toBe(200);
		const second = await post("/api/environments/drafts/remove", {
			requestId: "remove-first",
			id: created.id,
			revision: 1,
		});
		expect(await second.json()).toEqual(await first.json());
	} finally {
		host.stop();
		await app.close();
	}
});
