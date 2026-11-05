import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { Runtime } from "../src/runtime.ts";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const fixtures = createFixtures();
afterEach(fixtures.cleanup);

test("uncertain promotion blocks retries across reopen until explicit acknowledgement, without rewriting the destination", async () => {
	const { config, fake } = await fixtures.fixture(false, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const live = path.join(config.configDir, "environments.json"),
		content = JSON.stringify({ version: 1, projects: [] }),
		models = createModels(),
		storagePath = path.join(config.stateDir, "uncertainty-native");
	models.setProvider(fake.provider);
	const native = await openNodeJsonlStorage(storagePath, context, {
		fsync: true,
	});
	let armed = false;
	// One public storage fault: reject receipt persistence after the filesystem
	// publication. All native data reads/writes otherwise use real JSONL storage.
	const commit: Storage["commit"] = async (writes, ctx) => {
		if (
			armed &&
			fs.existsSync(live) &&
			fs.readFileSync(live, "utf8") === content
		) {
			armed = false;
			throw new Error("Injected receipt persistence failure");
		}
		return native.commit(writes, ctx);
	};
	const storage = new Proxy(native, {
		get(target, property) {
			if (property === "commit") return commit;
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	let app = await Runtime.open(config, models, storage);
	let host = serve(app);
	const api = (suffix: string, body?: unknown) =>
		fetch(new URL(`/api/environments/drafts${suffix}`, host.url), {
			method: body ? "POST" : "GET",
			headers: {
				Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
		});
	try {
		const draft = await (await api("", { requestId: "draft", content })).json(),
			body = {
				requestId: "publish",
				id: draft.id,
				revision: 1,
				digest: draft.digest,
				approve: draft.digest,
			};
		armed = true;
		expect((await api("/promote", body)).status).toBe(400);
		expect(fs.readFileSync(live, "utf8")).toBe(content);
		host.stop();
		await expect(app.close()).rejects.toThrow("Session failed");
		app = await Runtime.open(
			config,
			models,
			await openNodeJsonlStorage(storagePath, context, { fsync: true }),
		);
		fixtures.apps.push(app);
		host = serve(app);
		expect(await (await api("/promotions")).json()).toEqual([]);
		const attempts = await (await api("/promotion-attempts")).json();
		expect(attempts).toHaveLength(1);
		expect(attempts[0].status).toBe("pending");
		const external = '{"version":1,"projects":[],"external":"observed"}';
		fs.writeFileSync(live, external);
		expect((await api("/promote", body)).status).toBe(400);
		expect(
			(await api("/promote", { ...body, requestId: "other" })).status,
		).toBe(400);
		expect(await (await api("/promotion-attempts")).json()).toEqual(attempts);
		const ack = {
			requestId: "operator-inspected",
			id: attempts[0].id,
			acknowledge: true,
		};
		expect(
			(
				await api("/promotion-attempts/acknowledge", {
					...ack,
					acknowledge: false,
				})
			).status,
		).toBe(400);
		const acknowledged = await (
			await api("/promotion-attempts/acknowledge", ack)
		).json();
		expect(acknowledged).toEqual({
			id: attempts[0].id,
			status: "acknowledged",
		});
		expect(
			await (await api("/promotion-attempts/acknowledge", ack)).json(),
		).toEqual(acknowledged);
		expect(
			(
				await api("/promotion-attempts/acknowledge", {
					...ack,
					requestId: "changed",
				})
			).status,
		).toBe(400);
		expect((await api("/promote", body)).status).toBe(400);
		// Clearing uncertainty doesn't refresh an old draft's destination base.
		expect(
			(await api("/promote", { ...body, requestId: "fresh-but-stale-base" }))
				.status,
		).toBe(400);
		expect(fs.readFileSync(live, "utf8")).toBe(external);
		expect(await (await api("/promotions")).json()).toEqual([]);
		const fresh = await (
			await api("", { requestId: "fresh-draft", content })
		).json();
		expect(
			(
				await api("/promote", {
					requestId: "fresh-exact",
					id: fresh.id,
					revision: 1,
					digest: fresh.digest,
					approve: fresh.digest,
				})
			).status,
		).toBe(200);
		expect(fs.readFileSync(live, "utf8")).toBe(content);
	} finally {
		host.stop();
	}
});
