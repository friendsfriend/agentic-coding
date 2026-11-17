import { afterEach, expect, test } from "bun:test";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("private client transport refuses invalid authentication without a snapshot, unhandled error or admission", async () => {
	const { app } = await fixture();
	const host = serve(app),
		refused = new ClientConnection({
			url: host.client.url,
			token: "disposable-invalid-credential",
		});
	try {
		refused.connect();
		await eventually(
			async () => refused.status,
			(status) => status === "reconnecting",
		);
		expect(refused.state).toBeNull();
		expect(refused.stateFresh).toBe(false);
		expect(refused.methods).toEqual([]);
		expect(refused.error).not.toContain("disposable-invalid-credential");
		await expect(refused.call("state.read", {})).rejects.toThrow(
			"Client operation unavailable",
		);
	} finally {
		refused.close();
		await host.stop();
	}
});

test("authenticated client reads/subscribes, configures its native session and deletes timing without stale approval", async () => {
	const { app, config, invocation, open } = await fixture(true);
	const original = config.profiles[0];
	if (!original) throw new Error("Fixture profile missing");
	config.profiles.push({
		...original,
		id: "alternate",
		thinking: "high",
		description: "Explicit native conversation switch fixture",
	});
	const host = serve(app);
	const client = new ClientConnection(host.client);
	try {
		const unauthorized = await fetch(host.client.url.replace("ws:", "http:"));
		expect(unauthorized.status).toBe(401);
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		const state = client.state;
		const observedProfiles = (await client.call("state.read", {})).profiles;
		expect(
			observedProfiles.map(
				({ id, provider, modelId, thinking, description }) => ({
					id,
					provider,
					modelId,
					thinking,
					description,
				}),
			),
		).toEqual(config.profiles);
		expect(
			observedProfiles.every(
				(profile) => typeof profile.available === "boolean",
			),
		).toBe(true);
		for (const profile of observedProfiles)
			expect(Object.keys(profile).sort()).toEqual([
				"available",
				"description",
				"id",
				"modelId",
				"provider",
				"thinking",
			]);
		expect(client.stateFresh).toBe(true);
		expect(
			(await client.call("session.read", { id: Number(app.home.id) })).thinking,
		).toBe("off");
		expect((await client.call("state.read", {})).tasks).toEqual([]);
		const skills = await client.call("skills.read", {});
		expect(skills).toEqual([
			{
				id: "code",
				origin: "system",
				description: "test skill",
				revision: config.skills[0]?.digest,
				readOnly: false,
			},
		]);
		const revision = skills[0]?.revision ?? "";
		expect(
			await client.call("skill.read", { id: "code", revision }),
		).toMatchObject({ id: "code", content: "Implement the task", revision });
		await expect(
			client.call("skill.read", { id: "../../README.md", revision }),
		).rejects.toThrow();
		await expect(
			client.call("skill.read", { id: "code", revision: "0".repeat(64) }),
		).rejects.toThrow();
		const unsupportedSkillRead = {
			id: "code",
			revision,
			path: config.repositories[0],
		};
		await expect(
			client.call("skill.read", unsupportedSkillRead),
		).rejects.toThrow();
		expect((await client.call("state.read", {})).tasks).toEqual([]);
		const loadedSkill = config.skills[0];
		if (!loadedSkill) throw new Error("Fixture skill missing");
		const originalInstructions = loadedSkill.content;
		loadedSkill.content = "Changed content without updating loaded digest";
		await expect(
			client.call("skill.read", { id: "code", revision }),
		).rejects.toThrow();
		loadedSkill.content = originalInstructions;
		expect(state?.sessions[0]?.title).toBe("Orchestrator");
		const id = Number(app.home.id);
		expect(await client.call("session.read", { id })).toMatchObject({
			id,
			thinking: "off",
		});
		expect(
			await client.call("session.configure", { id, profile: "alternate" }),
		).toEqual({ configured: true });
		expect(await client.call("session.read", { id })).toMatchObject({
			id,
			model: `${original.provider}/${original.modelId}`,
			thinking: "high",
		});
		expect(
			await client.call("session.configure", { id, profile: "test" }),
		).toEqual({ configured: true });
		await expect(
			client.call("session.configure", { id, profile: "foreign" }),
		).rejects.toThrow();
		await expect(client.call("session.read", { id: 999999 })).rejects.toThrow();
		await expect(
			client.call("session.configure", { id: 999999, profile: "test" }),
		).rejects.toThrow();
		expect(await client.call("session.read", { id })).toMatchObject({
			id,
			thinking: "off",
		});
		expect((await client.call("state.read", {})).profiles).toEqual(
			state?.profiles ?? [],
		);
		const schedule = await app.scheduler.create(
			invocation,
			{ kind: "once", at: Date.now() + 60000 },
			null,
			"client-test",
		);
		await eventually(
			async () =>
				client.state?.schedules.some((item) => item.id === schedule.id),
			Boolean,
		);
		await expect(
			client.call("schedule.delete", {
				id: schedule.id,
				revision: schedule.revision + 1,
			}),
		).rejects.toThrow();
		expect(
			await client.call("schedule.delete", {
				id: schedule.id,
				revision: schedule.revision,
			}),
		).toEqual({ deleted: true });
		expect((await client.call("state.read", {})).schedules).toEqual([]);
		client.close();
		const reopened = new ClientConnection(host.client);
		try {
			reopened.connect();
			await eventually(
				async () => reopened.state,
				(value) => value !== null,
			);
			expect(reopened.state?.schedules).toEqual([]);
		} finally {
			reopened.close();
		}
	} finally {
		client.close();
		await host.stop();
	}
	await app.close();
	const resumed = await open();
	await expect(
		resumed.scheduler.create(
			invocation,
			{ kind: "once", at: Date.now() + 60_000 },
			null,
			"client-test",
		),
	).rejects.toThrow("deleted");
});
