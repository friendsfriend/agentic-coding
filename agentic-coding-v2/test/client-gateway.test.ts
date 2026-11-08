import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
} from "@earendil-works/pi-ai";
import { serve } from "../src/server/index.ts";
import {
	ClientConnection,
	CommandUncertain,
	dataList,
} from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("authenticated native environment staging and retained history remain explicit, bounded and ownership-fenced", async () => {
	const { app } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const host = serve(app),
		client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		expect(
			await client.call("environment.inspect", {
				operation: "drafts",
				selection: {},
			}),
		).toEqual([]);
		await expect(
			client.call("environment.inspect", {
				operation: "drafts",
				selection: { app: "not-a-list-filter", target: "not-a-list-filter" },
			}),
		).rejects.toThrow();
		const unsupported = await client.call("environment.preview", {
			operation: "save",
			body: {
				requestId: "ui-unsupported-field",
				content: "{}",
				app: "foreign",
			},
		});
		expect(
			await client.call("environment.inspect", {
				operation: "drafts",
				selection: {},
			}),
		).toEqual([]);
		await expect(
			client.call("environment.apply", {
				id: unsupported.id,
				approval: `approve:${unsupported.digest}`,
			}),
		).rejects.toThrow();
		await expect(
			client.call("environment.apply", {
				id: unsupported.id,
				approval: `approve:${unsupported.digest}`,
			}),
		).rejects.toThrow();
		const sealed = await client.call("environment.preview", {
			operation: "save",
			body: { requestId: "ui-inert-draft", content: "{}" },
		});
		expect(
			await client.call("environment.inspect", {
				operation: "drafts",
				selection: {},
			}),
		).toEqual([]);
		const changed = await client.call("environment.preview", {
			operation: "save",
			body: { requestId: "ui-edited-draft", content: '{"edited":true}' },
		});
		expect(changed.digest).not.toBe(sealed.digest);
		await expect(
			client.call("environment.apply", {
				id: changed.id,
				approval: `approve:${sealed.digest}`,
			}),
		).rejects.toThrow();
		expect(
			await client.call("environment.inspect", {
				operation: "drafts",
				selection: {},
			}),
		).toEqual([]);
		await expect(
			client.call("environment.apply", {
				id: sealed.id,
				approval: `approve:${"0".repeat(64)}`,
			}),
		).rejects.toThrow();
		await client.call("environment.apply", {
			id: sealed.id,
			approval: `approve:${sealed.digest}`,
		});
		await expect(
			client.call("environment.apply", {
				id: sealed.id,
				approval: `approve:${sealed.digest}`,
			}),
		).rejects.toThrow();
		const drafts = dataList(
			await client.call("environment.inspect", {
				operation: "drafts",
				selection: {},
			}),
		);
		expect(drafts.length).toBe(1);
		expect(
			await client.call("environment.inspect", {
				operation: "draft",
				selection: { id: drafts[0]?.id },
			}),
		).toMatchObject({ content: "{}", authority: expect.any(String) });
		await expect(
			client.call("environment.inspect", {
				operation: "telemetry",
				selection: { app: "foreign", run: "foreign", options: {} },
			}),
		).rejects.toThrow();
		expect((await client.call("state.read", {})).tasks).toEqual([]);
		await app.home.commit(async (tx) => {
			for (let index = 0; index < 55; index++)
				await tx.appendEntry(app.home.id, {
					kind: "fixture.history",
					data: { index },
				});
		}, context);
		const page = await client.call("session.history", {
			id: Number(app.home.id),
		});
		expect(page.entries.length).toBe(50);
		expect(page.cursor).not.toBeNull();
		const older = await client.call("session.history", {
			id: page.id,
			cursor: page.cursor ?? undefined,
		});
		expect(older.entries.length).toBeGreaterThan(0);
		await expect(
			client.call("session.history", {
				id: page.id,
				cursor: page.cursor ?? undefined,
			}),
		).rejects.toThrow();
		expect(
			older.entries.every(
				(entry) => !page.entries.some((recent) => recent.id === entry.id),
			),
		).toBe(true);
		await expect(
			client.call("session.history", {
				id: 999999,
				cursor: page.cursor ?? undefined,
			}),
		).rejects.toThrow();
		await expect(
			client.call("session.history", {
				id: page.id,
				cursor: "invented-cursor",
			}),
		).rejects.toThrow();
		expect((await client.call("state.read", {})).tasks).toEqual([]);
	} finally {
		client.close();
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

test("disconnect makes an in-flight native mutation uncertain; reconnect only resynchronizes", async () => {
	const { app } = await fixture();
	const host = serve(app),
		client = new ClientConnection(host.client);
	const barrier = Promise.withResolvers<void>();
	const configure = app.home.configure.bind(app.home);
	let calls = 0,
		applied = false;
	app.home.configure = async (change, context) => {
		calls++;
		await barrier.promise;
		await configure(change, context);
		applied = true;
	};
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		const outcome = client
			.call("session.configure", { id: Number(app.home.id), profile: "test" })
			.catch((error: unknown) => error);
		await eventually(
			async () => calls,
			(value) => value === 1,
		);
		expect(client.stateFresh).toBe(true);
		client.reconnectNow();
		expect(client.stateFresh).toBe(false);
		expect(await outcome).toBeInstanceOf(CommandUncertain);
		barrier.resolve();
		await eventually(async () => applied, Boolean);
		await eventually(
			async () => client.status === "connected" && client.stateFresh,
			Boolean,
		);
		expect(client.stateFresh).toBe(true);
		expect(calls).toBe(1);
		expect(
			await client.call("session.read", { id: Number(app.home.id) }),
		).toMatchObject({ thinking: "off" });
	} finally {
		barrier.resolve();
		client.close();
		await host.stop();
	}
});

test("native progress watch resynchronizes without replay or duplicate retained messages", async () => {
	const { app, fake } = await fixture(false, undefined, {
		tokensPerSecond: 30,
		tokenSize: { min: 1, max: 1 },
	});
	const release = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const response =
		"Native transcript progress remains observation, not execution authority. ".repeat(
			4,
		);
	fake.setResponses([
		async () => {
			entered.resolve();
			await release.promise;
			return fauxAssistantMessage([
				fauxThinking(
					"Native thinking streamed by a disposable faux provider. ".repeat(2),
				),
				fauxText(response),
			]);
		},
	]);
	const host = serve(app),
		client = new ClientConnection(host.client);
	const id = Number(app.home.id);
	try {
		client.selectSession(id);
		client.connect();
		await eventually(
			async () => client.observation,
			(value) => value === "watching",
		);
		expect(client.transcript?.progress.run).toBeNull();
		const admission = await client.call("session.send", {
			id,
			content: "Demonstrate native progress",
			requestId: "native-progress",
		});
		await entered.promise;
		await eventually(
			async () => client.transcript?.progress.generation,
			(value) => value != null,
		);
		expect(client.transcript?.progress.run?.inputs).toContain(
			admission.submissionId,
		);
		expect(client.transcript?.progress.generation?.message).toBeUndefined();
		release.resolve();
		await eventually(
			async () =>
				dataList(client.transcript?.progress.generation?.message?.content),
			(blocks) =>
				blocks.some(
					(block) =>
						block.type === "thinking" &&
						typeof block.thinking === "string" &&
						block.thinking.length > 0,
				),
		);
		client.reconnectNow();
		expect(client.observation).toBe("resynchronizing");
		await eventually(
			async () =>
				client.observation === "watching" &&
				dataList(client.transcript?.progress.generation?.message?.content).some(
					(block) =>
						block.type === "text" &&
						typeof block.text === "string" &&
						block.text.length > 0,
				),
			Boolean,
		);
		expect(fake.state.callCount).toBe(1);
		await app.home.waitForIdle(context);
		await eventually(
			async () => client.transcript,
			(value) =>
				value?.progress.run === null &&
				value.entries.some((entry) =>
					dataList(entry.model).some(
						(message) =>
							message.role === "assistant" &&
							dataList(message.content).some(
								(block) => block.text === response,
							),
					),
				),
		);
		expect(client.transcript?.progress.generation).toBeNull();
		const entries = client.transcript?.entries ?? [];
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
		expect(
			entries
				.flatMap((entry) => dataList(entry.model))
				.filter((message) => message.role === "assistant"),
		).toHaveLength(1);
		client.selectSession(null);
		client.selectSession(id);
		await eventually(
			async () => client.observation,
			(value) => value === "watching",
		);
		expect(client.transcript?.entries.map((entry) => entry.id)).toEqual(
			entries.map((entry) => entry.id),
		);
		expect(fake.state.callCount).toBe(1);
	} finally {
		release.resolve();
		client.close();
		await host.stop();
	}
}, 15000);
