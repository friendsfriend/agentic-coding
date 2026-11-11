import { afterEach, expect, test } from "bun:test";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("authenticated schedule create, pause and delete are revision-fenced operator actions on the native scheduler", async () => {
	const { app, config, invocation } = await fixture(true);
	const host = serve(app),
		client = new ClientConnection(host.client);
	const created = {
		id: "operator-hourly-audit",
		invocation: {
			topicId: invocation.topicId,
			skill: "code",
			profile: "test",
			repository: config.repositories[0] as string,
			baseRef: "HEAD",
			inputs: "Audit the tree and report drift",
			requestId: "schedule:operator-hourly-audit",
		},
		timing: {
			kind: "interval" as const,
			everyMs: 3_600_000,
			anchor: Date.now() + 60_000,
		},
		lateGraceMs: 900_000,
	};
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		// The developer's form save is the approval: no candidate digest, and no
		// task is admitted until an occurrence is due.
		const schedule = (await client.call("schedule.create", created)) as {
			id: string;
			revision: number;
			state: string;
			lateGraceMs: number | null;
		};
		expect(schedule).toMatchObject({
			id: created.id,
			state: "enabled",
			lateGraceMs: 900_000,
			revision: 1,
		});
		expect((await client.call("state.read", {})).tasks).toEqual([]);
		await eventually(
			async () =>
				client.state?.schedules.some((item) => item.id === created.id),
			Boolean,
		);
		// Uncertain fields are refused rather than ignored.
		await expect(
			client.call("schedule.create", {
				...created,
				id: "operator-invalid-timing",
				timing: { kind: "interval", everyMs: 10, anchor: Date.now() },
			}),
		).rejects.toThrow();
		await expect(
			client.call("schedule.create", {
				...created,
				id: "operator-unknown-action",
				unexpected: true,
			} as never),
		).rejects.toThrow();
		// Pause and resume carry the observed revision.
		expect(
			await client.call("schedule.state", {
				id: schedule.id,
				revision: schedule.revision,
				state: "paused",
			}),
		).toEqual({ updated: true });
		const paused = (await client.call("state.read", {})).schedules.find(
			(item) => item.id === schedule.id,
		);
		expect(paused).toMatchObject({ state: "paused", revision: 2 });
		await expect(
			client.call("schedule.state", {
				id: schedule.id,
				revision: schedule.revision,
				state: "enabled",
			}),
		).rejects.toThrow();
		expect(
			await client.call("schedule.state", {
				id: schedule.id,
				revision: 2,
				state: "enabled",
			}),
		).toEqual({ updated: true });
		// Deletion removes future timing only.
		await expect(
			client.call("schedule.delete", { id: schedule.id, revision: 1 }),
		).rejects.toThrow();
		expect(
			await client.call("schedule.delete", { id: schedule.id, revision: 3 }),
		).toEqual({ deleted: true });
		expect((await client.call("state.read", {})).schedules).toEqual([]);
	} finally {
		client.close();
		await host.stop();
	}
});
