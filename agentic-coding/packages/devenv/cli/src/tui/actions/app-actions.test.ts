import { expect, test } from "bun:test";
import type { AppStatus } from "@devenv/types";
import { createActionRunStore } from "../stores/action-run-store";
import { createAppDetailStore } from "../stores/app-detail-store";
import { createAppStore } from "../stores/app-store";
import { createAppActions, handleActionStarted } from "./app-actions";

test("action trigger opens actions view", () => {
	const store = createActionRunStore();
	let view = "table";
	handleActionStarted(
		{
			pushModal: (next: string) => {
				view = next;
			},
		},
		store,
		{
			run: { id: "r1", title: "Run", status: "active", steps: [] },
		},
	);
	expect(view).toBe("actions");
	expect(store.run()?.id).toBe("r1");
});

test("completed action keeps operation status until refreshed runtime snapshot arrives", async () => {
	const appStore = createAppStore();
	appStore.setApps([
		{
			ident: "api",
			displayName: "API",
			localDirectoryPath: "/repo",
			repositoryPath: "/repo",
			branch: "main",
			appType: "APP",
			containerBaseName: "api",
			status: "Running",
			operationStatus: {
				operation: "stop",
				status: "active",
				message: "Stopping...",
			},
		},
	]);
	let resolveStatus!: (value: AppStatus[]) => void;
	const status = new Promise<AppStatus[]>((resolve) => {
		resolveStatus = resolve;
	});
	const actionRunStore = createActionRunStore();
	const actions = createAppActions(
		appStore,
		createAppDetailStore(),
		{} as unknown as Parameters<typeof createAppActions>[2],
		{
			getActionHistory: async () => [],
			getStatus: () => status,
			subscribeToEvents: async function* () {
				yield {
					type: "action.started",
					properties: {
						run: {
							id: "r1",
							appIdent: "api",
							title: "Stop API",
							status: "active",
							steps: [],
						},
					},
				};
				yield {
					type: "action.completed",
					properties: { runId: "r1", status: "completed" },
				};
			},
		} as unknown as Parameters<typeof createAppActions>[3],
		() => {},
		actionRunStore,
	);

	await actions.subscribeToUpdates();
	expect(appStore.apps()[0].operationStatus?.message).toBe("Stopping...");

	resolveStatus([
		{
			ident: "api",
			status: "Stopped",
			dockerInfo: { Status: "exited", ContainerID: "", Ports: "" },
		},
	]);
	await Promise.resolve();
	await Promise.resolve();
	expect(appStore.apps()[0].status).toBe("Stopped");
	expect(appStore.apps()[0].operationStatus).toBeUndefined();
});

test("completed infrastructure action clears stale stopping overlay", async () => {
	const appStore = createAppStore();
	appStore.setInfraServices([
		{
			ident: "db",
			displayName: "Database",
			type: "docker",
			status: "running",
			operationStatus: {
				operation: "stop",
				status: "active",
				message: "Stopping...",
			},
		},
	]);
	const actions = createAppActions(
		appStore,
		createAppDetailStore(),
		{} as unknown as Parameters<typeof createAppActions>[2],
		{
			getStatus: async () => [],
			getInfraServices: async () => [
				{
					ident: "db",
					displayName: "Database",
					type: "docker",
					status: "stopped",
				},
			],
			subscribeToEvents: async function* () {
				yield {
					type: "action.completed",
					properties: {
						runId: "r1",
						appIdent: "db",
						resourceKind: "infrastructure",
						status: "completed",
					},
				};
			},
		} as unknown as Parameters<typeof createAppActions>[3],
		() => {},
	);

	await actions.subscribeToUpdates();
	await Promise.resolve();
	await Promise.resolve();
	expect(appStore.infraServices()[0].status).toBe("stopped");
	expect(appStore.infraServices()[0].operationStatus).toBeUndefined();
});

test("status snapshot preserves Kubernetes status over missing container status", async () => {
	const appStore = createAppStore();
	appStore.setApps([
		{
			ident: "api",
			displayName: "API",
			localDirectoryPath: "/repo",
			repositoryPath: "/repo",
			branch: "main",
			appType: "APP",
			containerBaseName: "api",
		},
	]);
	const actions = createAppActions(
		appStore,
		createAppDetailStore(),
		{} as unknown as Parameters<typeof createAppActions>[2],
		{
			getStatus: async () => [
				{
					ident: "api",
					dockerInfo: { Status: "not found" },
					status: "running (1/1 pods)",
				},
			],
		} as unknown as Parameters<typeof createAppActions>[3],
		() => {},
	);

	await actions.fetchStatus();
	expect(appStore.apps()[0].status).toBe("running (1/1 pods)");
});
