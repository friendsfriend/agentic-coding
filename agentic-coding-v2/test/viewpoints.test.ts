import { afterEach, expect, test } from "bun:test";
import type { UiView } from "../src/protocol/viewpoints.ts";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { readViewpoints } from "../src/viewpoints.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("authenticated durable viewpoints store only bounded UI state, refuse stale edits/deletion and never admit work", async () => {
	const { app, open } = await fixture(true),
		host = serve(app),
		client = new ClientConnection(host.client);
	const id = crypto.randomUUID(),
		followId = crypto.randomUUID(),
		resourceId = crypto.randomUUID(),
		view: UiView = {
			page: "tasks",
			resource: "missing-task",
			selection: 0,
			filter: "",
			sort: "default",
			expanded: [],
			scroll: 3,
			focus: "content",
			workspace: { mode: "permanent", side: "right" },
		};
	const resourceView: UiView = {
		...view,
		page: "environments",
		resource: "missing-app",
		filter: "web",
		resourcePreferences: {
			category: "app",
			order: "identity",
			pins: ["missing-app", "web"],
			pinnedOnly: true,
		},
	};
	let revision = 0;
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		const before = await app.snapshot();
		for (const workspace of [
			null,
			[],
			{},
			{ mode: "permanent" },
			{ mode: "permanent", side: "up" },
			{ mode: ["permanent"], side: "left" },
			{ mode: "permanent", side: "left", execute: true },
			{ mode: "permanent", side: "left", filter: null },
			{ mode: "permanent", side: "left", filter: "" },
			{ mode: "permanent", side: "left", filter: "running" },
			{ mode: "permanent", side: "left", filter: ["active"] },
			{ mode: "permanent", side: "left", filter: { state: "active" } },
			{ mode: "permanent", side: "left", filter: "active", execute: true },
		]) {
			await expect(
				client.call("viewpoints.save", {
					id: crypto.randomUUID(),
					name: "Invalid workspace",
					revision: 0,
					view: { ...view, workspace } as unknown as UiView,
				}),
			).rejects.toThrow("Native operation refused");
		}
		expect(await client.call("viewpoints.read", {})).toEqual([]);
		const saved = await client.call("viewpoints.save", {
			id,
			name: "Task position",
			revision: 0,
			view,
		});
		revision = saved.revision;
		expect(saved.view).toEqual(view);
		expect(
			await client.call("viewpoints.save", {
				id,
				name: "Task position",
				revision: 0,
				view,
			}),
		).toEqual(saved);
		expect(await client.call("viewpoints.read", {})).toEqual([saved]);
		for (const mode of ["expanding", "permanent"] as const) {
			for (const side of ["left", "right"] as const) {
				const layout = await client.call("viewpoints.save", {
					id,
					name: "Task position",
					revision,
					view: { ...view, workspace: { mode, side } },
				});
				revision = layout.revision;
				expect(layout.view.workspace).toEqual({ mode, side });
				for (const filter of ["active", "attention", "all"] as const) {
					const filtered = await client.call("viewpoints.save", {
						id,
						name: "Task position",
						revision,
						view: { ...view, workspace: { mode, side, filter } },
					});
					revision = filtered.revision;
					expect(filtered.view.workspace).toEqual({ mode, side, filter });
				}
			}
		}
		expect(JSON.stringify(saved)).not.toContain("draft");
		for (const extra of [
			{ draft: "private prompt" },
			{ detail: { approval: "approve:digest", logs: "private output" } },
			{ execute: true },
		]) {
			await expect(
				client.call("viewpoints.save", {
					id: crypto.randomUUID(),
					name: "Forbidden",
					revision: 0,
					view: { ...view, ...extra },
				}),
			).rejects.toThrow("Native operation refused");
		}
		await expect(
			client.call("viewpoints.save", {
				id,
				name: "Changed",
				revision: 0,
				view,
			}),
		).rejects.toThrow("Native operation refused");
		const changed = await client.call("viewpoints.save", {
			id,
			name: "Updated task position",
			revision,
			view: {
				...view,
				scroll: 4,
				workspace: { mode: "permanent", side: "right", filter: "attention" },
			},
		});
		revision = changed.revision;
		await expect(
			client.call("viewpoints.remove", { id, revision: saved.revision }),
		).rejects.toThrow("Native operation refused");
		await expect(
			client.call("viewpoints.save", {
				id: crypto.randomUUID(),
				name: "Oversized",
				revision: 0,
				view: { ...view, filter: "x".repeat(257) },
			}),
		).rejects.toThrow("Native operation refused");
		const legacyView = { ...view };
		delete legacyView.workspace;
		const disposable = crypto.randomUUID(),
			removed = await client.call("viewpoints.save", {
				id: disposable,
				name: "Disposable",
				revision: 0,
				view: legacyView,
			});
		expect(removed.view.workspace).toBeUndefined();
		await client.call("viewpoints.remove", {
			id: disposable,
			revision: removed.revision,
		});
		const recreated = await client.call("viewpoints.save", {
			id: disposable,
			name: "Recreated",
			revision: 0,
			view,
		});
		expect(recreated.revision).toBeGreaterThan(removed.revision);
		await expect(
			client.call("viewpoints.remove", {
				id: disposable,
				revision: removed.revision,
			}),
		).rejects.toThrow("Native operation refused");
		await client.call("viewpoints.remove", {
			id: disposable,
			revision: recreated.revision,
		});
		const followView: UiView = {
			...view,
			page: "orchestrator",
			resource: null,
			transcriptFollow: { id: 99, following: true },
		};
		const followSaved = await client.call("viewpoints.save", {
			id: followId,
			name: "Follow position",
			revision: 0,
			view: followView,
		});
		expect(followSaved.view).toEqual(followView);
		const held = await client.call("viewpoints.save", {
			id: followId,
			name: "Follow position",
			revision: followSaved.revision,
			view: { ...followView, transcriptFollow: { id: 99, following: false } },
		});
		expect(held.view.transcriptFollow).toEqual({ id: 99, following: false });
		await expect(
			client.call("viewpoints.remove", {
				id: followId,
				revision: followSaved.revision,
			}),
		).rejects.toThrow("Native operation refused");
		for (const transcriptFollow of [
			null,
			[],
			{},
			{ id: 99 },
			{ id: 99, following: "true" },
			{ id: 0, following: true },
			{ id: 1.5, following: true },
			{ id: 99, following: true, execute: true },
		]) {
			await expect(
				client.call("viewpoints.save", {
					id: crypto.randomUUID(),
					name: "Invalid follow",
					revision: 0,
					view: { ...followView, transcriptFollow } as unknown as UiView,
				}),
			).rejects.toThrow("Native operation refused");
		}
		for (const invalidScope of [
			{ page: "pi", resource: "99" },
			{ page: "tasks", resource: null },
			{ page: "session", resource: "98" },
			{ page: "session", resource: null },
		] as const) {
			await expect(
				client.call("viewpoints.save", {
					id: crypto.randomUUID(),
					name: "Wrong UI scope",
					revision: 0,
					view: { ...followView, ...invalidScope },
				}),
			).rejects.toThrow("Native operation refused");
		}
		for (const resourcePreferences of [
			null,
			[],
			{},
			{
				category: null,
				order: "identity",
				pins: [],
				pinnedOnly: true,
				execute: true,
			},
			{
				category: "app",
				order: "identity",
				pins: ["web", "web"],
				pinnedOnly: false,
			},
			{
				category: "x".repeat(65),
				order: "identity",
				pins: [],
				pinnedOnly: false,
			},
			{
				category: null,
				order: "inventory",
				pins: ["x".repeat(257)],
				pinnedOnly: false,
			},
			{
				category: null,
				order: "inventory",
				pins: [{ id: "web", owner: 1 }],
				pinnedOnly: false,
			},
			{ category: null, order: "inventory", pins: [] },
			{ category: null, order: "newest", pins: [], pinnedOnly: false },
			{ category: null, order: "inventory", pins: [""], pinnedOnly: false },
			{ category: null, order: "inventory", pins: [" web"], pinnedOnly: false },
			{
				category: null,
				order: "inventory",
				pins: ["web\n"],
				pinnedOnly: false,
			},
			{
				category: null,
				order: "inventory",
				pins: Array.from({ length: 65 }, (_, i) => `app-${i}`),
				pinnedOnly: false,
			},
			{ category: null, order: "inventory", pins: [], pinnedOnly: "true" },
			{
				category: null,
				order: "inventory",
				pins: [],
				pinnedOnly: false,
				approval: "approve:digest",
			},
		]) {
			await expect(
				client.call("viewpoints.save", {
					id: crypto.randomUUID(),
					name: "Invalid resource preferences",
					revision: 0,
					view: { ...resourceView, resourcePreferences } as unknown as UiView,
				}),
			).rejects.toThrow("Native operation refused");
		}
		for (const page of ["tasks", "orchestrator", "pi", "settings"] as const)
			await expect(
				client.call("viewpoints.save", {
					id: crypto.randomUUID(),
					name: "Wrong resource scope",
					revision: 0,
					view: { ...resourceView, page },
				}),
			).rejects.toThrow("Native operation refused");
		const resourceSaved = await client.call("viewpoints.save", {
			id: resourceId,
			name: "Resource display",
			revision: 0,
			view: resourceView,
		});
		expect(resourceSaved.view).toEqual(resourceView);
		const bounded = await client.call("viewpoints.save", {
			id: resourceId,
			name: "Resource display",
			revision: resourceSaved.revision,
			view: {
				...resourceView,
				resourcePreferences: {
					category: null,
					order: "inventory",
					pins: Array.from({ length: 64 }, (_, i) =>
						i === 0 ? "x".repeat(256) : `missing-${i}`,
					),
					pinnedOnly: false,
				},
			},
		});
		expect(bounded.view.resourcePreferences?.pins).toHaveLength(64);
		expect(bounded.view.resourcePreferences?.pins[0]?.length).toBe(256);
		const scheduleDisplay = await client.call("viewpoints.save", {
			id: resourceId,
			name: "Resource display",
			revision: bounded.revision,
			view: {
				...resourceView,
				page: "schedules",
				resourcePreferences: {
					category: null,
					order: "inventory",
					pins: ["missing-schedule"],
					pinnedOnly: false,
				},
			},
		});
		expect(scheduleDisplay.view.resourcePreferences?.pins).toEqual([
			"missing-schedule",
		]);
		await expect(
			client.call("viewpoints.save", {
				id: resourceId,
				name: "Resource display",
				revision: resourceSaved.revision,
				view: resourceView,
			}),
		).rejects.toThrow("Native operation refused");
		const restoredResources = await client.call("viewpoints.save", {
			id: resourceId,
			name: "Resource display",
			revision: scheduleDisplay.revision,
			view: resourceView,
		});
		expect(restoredResources.view.resourcePreferences).toEqual(
			resourceView.resourcePreferences,
		);
		expect((await app.snapshot()).tasks).toEqual(before.tasks);
		expect((await app.snapshot()).schedules).toEqual(before.schedules);
	} finally {
		client.close();
		await host.stop();
	}
	await app.close();
	const reopened = await open();
	const retained = await readViewpoints(reopened);
	expect(retained).toHaveLength(3);
	expect(retained).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: resourceId,
				name: "Resource display",
				view: resourceView,
			}),
			expect.objectContaining({
				id,
				revision,
				name: "Updated task position",
				view: {
					...view,
					scroll: 4,
					workspace: { mode: "permanent", side: "right", filter: "attention" },
				},
			}),
			expect.objectContaining({
				id: followId,
				name: "Follow position",
				view: {
					...view,
					page: "orchestrator",
					resource: null,
					transcriptFollow: { id: 99, following: false },
				},
			}),
		]),
	);
	expect((await reopened.snapshot()).tasks).toEqual([]);
});
