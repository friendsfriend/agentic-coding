import { afterEach, expect, test } from "bun:test";
import { serve } from "../src/server/index.ts";
import {
	ClientConnection,
	CommandUncertain,
} from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("authenticated client reads/subscribes, configures its native session and deletes timing without stale approval", async () => {
	const { app, invocation, open } = await fixture(true);
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
		expect(state?.sessions[0]?.title).toBe("Orchestrator");
		const id = Number(app.home.id);
		expect(await client.call("session.read", { id })).toMatchObject({
			id,
			thinking: "off",
		});
		expect(
			await client.call("session.configure", { id, profile: "test" }),
		).toEqual({ configured: true });
		await expect(
			client.call("session.configure", { id, profile: "foreign" }),
		).rejects.toThrow();
		await expect(client.call("session.read", { id: 999999 })).rejects.toThrow();
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
		client.reconnectNow();
		expect(await outcome).toBeInstanceOf(CommandUncertain);
		barrier.resolve();
		await eventually(async () => applied, Boolean);
		await eventually(
			async () => client.status,
			(status) => status === "connected",
		);
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
