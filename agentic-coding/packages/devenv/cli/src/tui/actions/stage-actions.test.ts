import { describe, expect, test } from "bun:test";
import type {
	StageAppStatus,
	StageStatus,
	StagesStatusResponse,
} from "@devenv/core";
import { createStageActions } from "./stage-actions.ts";

// The stage picker's behaviour (`open-stage-from-environments`): the catalog is
// read once, the chosen stage's UI application is handed to the injected opener
// exactly as configured, and a failing read or launch is said rather than
// swallowed. No test here may launch a browser: every case injects the opener.

function stage(
	overrides: Partial<StageStatus> & Pick<StageStatus, "ident">,
	apps: StageAppStatus[] = [],
): StageStatus {
	return {
		displayName: overrides.ident,
		environment: "stage",
		system: "portal",
		access: "read-only",
		planApproval: "when-writing",
		exclusive: false,
		origins: ["https://stage.example.test"],
		readOnlyExceptions: [],
		limits: {
			maxSessions: 1,
			maxActionsPerMinute: 10,
			maxWaitSeconds: 30,
			maxScreenshots: 5,
			maxRecordingMinutes: 1,
			maxLoginHandoffSeconds: 60,
		},
		identityCache: {
			enabled: true,
			ttlMinutes: 30,
			maxEntries: 1,
			refreshSeconds: 60,
		},
		data: {},
		wiki: { processes: [] },
		diagnostics: [],
		...overrides,
		apps,
	} as StageStatus;
}

function uiApp(
	key: string,
	label: string,
	url: string,
	app?: string,
): StageAppStatus {
	return {
		key,
		label,
		url,
		kind: "ui",
		roles: [],
		...{ app },
	} as StageAppStatus;
}

function catalog(stages: StageStatus[], excluded: string[] = []) {
	return {
		configDir: "/tmp/stages",
		stages,
		excluded: excluded.map((file) => ({ file, diagnostics: ["denied host"] })),
	} satisfies StagesStatusResponse;
}

/** The picker's slice of the UI store, as plain state: the actions only ever see
 * getters and setters, so a renderer is not needed. */
function createStore() {
	const state = {
		showStagePicker: false,
		stages: [] as StageStatus[],
		loading: false,
		error: null as string | null,
		query: "",
		filterActive: false,
		index: 0,
		step: "stages" as "stages" | "apps",
		stage: null as StageStatus | null,
		apps: [] as StageAppStatus[],
		appIndex: 0,
	};
	const notifications: Array<{ message: string; type?: string }> = [];
	const next = <T>(value: T | ((previous: T) => T), previous: T): T =>
		typeof value === "function" ? (value as (p: T) => T)(previous) : value;
	const store = {
		showStagePicker: () => state.showStagePicker,
		setShowStagePicker: (open: boolean) => {
			state.showStagePicker = open;
		},
		stagePickerStages: () => state.stages,
		setStagePickerStages: (stages: StageStatus[]) => {
			state.stages = stages;
		},
		stagePickerLoading: () => state.loading,
		setStagePickerLoading: (loading: boolean) => {
			state.loading = loading;
		},
		stagePickerError: () => state.error,
		setStagePickerError: (error: string | null) => {
			state.error = error;
		},
		stagePickerQuery: () => state.query,
		setStagePickerQuery: (query: string) => {
			state.query = query;
		},
		stagePickerFilterActive: () => state.filterActive,
		setStagePickerFilterActive: (active: boolean) => {
			state.filterActive = active;
		},
		stagePickerIndex: () => state.index,
		setStagePickerIndex: (index: number | ((previous: number) => number)) => {
			state.index = next(index, state.index);
		},
		stagePickerStep: () => state.step,
		setStagePickerStep: (step: "stages" | "apps") => {
			state.step = step;
		},
		stagePickerStage: () => state.stage,
		setStagePickerStage: (chosen: StageStatus | null) => {
			state.stage = chosen;
		},
		stagePickerApps: () => state.apps,
		setStagePickerApps: (apps: StageAppStatus[]) => {
			state.apps = apps;
		},
		stagePickerAppIndex: () => state.appIndex,
		setStagePickerAppIndex: (
			index: number | ((previous: number) => number),
		) => {
			state.appIndex = next(index, state.appIndex);
		},
		setNotification: (
			message: string,
			type?: "info" | "success" | "warning" | "error",
		) => {
			notifications.push({ message, ...(type ? { type } : {}) });
		},
	};
	return { state, notifications, store };
}

function createActions(options: {
	catalog?: StagesStatusResponse | Error;
	rows?: Array<{ ident: string }>;
	selectedIndex?: number;
	open?: (url: string) => Promise<{ ok: boolean; reason?: string }>;
	timeoutMs?: number;
}) {
	const { state, notifications, store } = createStore();
	const opened: string[] = [];
	const reads: Array<AbortSignal | undefined> = [];
	const rows = options.rows ?? [];
	const actions = createStageActions({
		uiStore: store,
		appStore: {
			tableFilteredApps: () => rows,
			selectedIndex: () => options.selectedIndex ?? 0,
		},
		client: {
			getStages: async (signal) => {
				reads.push(signal);
				const answer = options.catalog ?? new Error("not configured");
				if (answer instanceof Error) throw answer;
				return answer;
			},
		},
		open: async (url) => {
			opened.push(url);
			return options.open ? options.open(url) : { ok: true };
		},
		...(options.timeoutMs !== undefined
			? { timeoutMs: options.timeoutMs }
			: {}),
	});
	return { actions, state, notifications, opened, reads };
}

describe("stage actions", () => {
	test("a stage with one UI application opens exactly its configured URL", async () => {
		const portal = uiApp(
			"portal",
			"Portal",
			"https://stage.example.test/portal",
		);
		const { actions, state, notifications, opened } = createActions({
			catalog: catalog([stage({ ident: "acceptance" }, [portal])]),
		});

		await actions.openStagePicker();
		expect(state.showStagePicker).toBe(true);
		expect(state.loading).toBe(false);
		expect(actions.visibleStages().map((s) => s.ident)).toEqual(["acceptance"]);

		await actions.confirm();
		expect(opened).toEqual(["https://stage.example.test/portal"]);
		expect(notifications.at(-1)).toEqual({
			message: "Opened acceptance · Portal in the browser",
			type: "success",
		});
		expect(state.showStagePicker).toBe(false);
	});

	test("several UI applications are a second step, the linked app first", async () => {
		const portal = uiApp(
			"portal",
			"Portal",
			"https://stage.example.test/portal",
			"customer-fe",
		);
		const admin = uiApp(
			"admin",
			"Admin",
			"https://stage.example.test/admin",
			"customer-admin",
		);
		const api = {
			key: "api",
			label: "API",
			url: "https://stage.example.test/api",
			kind: "api",
			roles: [],
		} as StageAppStatus;
		const { actions, state, opened } = createActions({
			catalog: catalog([stage({ ident: "acceptance" }, [portal, api, admin])]),
			rows: [{ ident: "customer-admin" }],
		});

		await actions.openStagePicker();
		await actions.confirm();

		// The second step offers the UI applications only, the linked one first.
		expect(state.step).toBe("apps");
		expect(state.stage?.ident).toBe("acceptance");
		expect(actions.visibleApps().map((app) => app.key)).toEqual([
			"admin",
			"portal",
		]);
		expect(opened).toEqual([]);

		await actions.confirm();
		// Enter on the preselected first row opens the linked application.
		expect(opened).toEqual(["https://stage.example.test/admin"]);
	});

	test("an excluded stage is never offered and opens nothing", async () => {
		const { actions, state, opened } = createActions({
			catalog: catalog([], ["broken.stage.ts"]),
		});

		await actions.openStagePicker();
		expect(actions.visibleStages()).toEqual([]);
		await actions.confirm();
		expect(opened).toEqual([]);
		// The dialog stays open on its own empty state.
		expect(state.showStagePicker).toBe(true);
		expect(state.error).toBeNull();
	});

	test("a failed catalog read is the dialog's message and opens nothing", async () => {
		const { actions, state, opened } = createActions({
			catalog: new Error("HTTP 401 Error: invalid token"),
		});

		await actions.openStagePicker();
		expect(state.error).toBe("HTTP 401 Error: invalid token");
		expect(state.loading).toBe(false);
		expect(state.showStagePicker).toBe(true);
		await actions.confirm();
		expect(opened).toEqual([]);
	});

	test("a read that never answers ends in a message", async () => {
		const { store } = createStore();
		const actions = createStageActions({
			uiStore: store,
			appStore: { tableFilteredApps: () => [], selectedIndex: () => 0 },
			client: {
				getStages: (signal) =>
					new Promise((_, reject) => {
						signal?.addEventListener("abort", () =>
							reject(new Error("The operation was aborted")),
						);
					}),
			},
			open: async () => ({ ok: true }),
			timeoutMs: 1,
		});

		await actions.openStagePicker();
		expect(store.stagePickerError()).toBe("The operation was aborted");
		expect(store.stagePickerLoading()).toBe(false);
	});

	test("a stage without a UI application says so and opens nothing", async () => {
		const api = {
			key: "api",
			label: "API",
			url: "https://stage.example.test/api",
			kind: "api",
			roles: [],
		} as StageAppStatus;
		const { actions, notifications, opened } = createActions({
			catalog: catalog([stage({ ident: "acceptance" }, [api])]),
		});

		await actions.openStagePicker();
		await actions.confirm();
		expect(opened).toEqual([]);
		expect(notifications.at(-1)).toEqual({
			message: "No UI application configured for acceptance",
			type: "warning",
		});
	});

	test("a failed launch reports the opener's own reason", async () => {
		const portal = uiApp(
			"portal",
			"Portal",
			"https://stage.example.test/portal",
		);
		const { actions, notifications, state } = createActions({
			catalog: catalog([stage({ ident: "acceptance" }, [portal])]),
			open: async () => ({ ok: false, reason: "xdg-open: command not found" }),
		});

		await actions.openStagePicker();
		await actions.confirm();
		expect(notifications.at(-1)).toEqual({
			message: "Could not open Portal: xdg-open: command not found",
			type: "error",
		});
		expect(state.showStagePicker).toBe(false);
	});

	test("a URL that is not http(s) never reaches the opener", async () => {
		const local = uiApp("portal", "Portal", "file:///etc/passwd");
		const { actions, notifications, opened } = createActions({
			catalog: catalog([stage({ ident: "acceptance" }, [local])]),
		});

		await actions.openStagePicker();
		await actions.confirm();
		expect(opened).toEqual([]);
		expect(notifications.at(-1)?.type).toBe("error");
	});

	test("the filter narrows the list and resets the cursor", async () => {
		const prod = stage({ ident: "production", displayName: "Production" });
		const acceptance = stage({
			ident: "acceptance",
			displayName: "Acceptance",
		});
		const { actions, state } = createActions({
			catalog: catalog([prod, acceptance]),
		});

		await actions.openStagePicker();
		actions.move(1);
		expect(state.index).toBe(1);

		actions.setFilter("prod");
		expect(actions.visibleStages().map((s) => s.ident)).toEqual(["production"]);
		expect(state.index).toBe(0);

		actions.setFilter("acceptance");
		expect(actions.visibleStages().map((s) => s.ident)).toEqual(["acceptance"]);

		actions.activateFilter();
		expect(state.filterActive).toBe(true);
		expect(state.query).toBe("");
		actions.clearFilter();
		expect(state.filterActive).toBe(false);
		expect(actions.visibleStages()).toHaveLength(2);
	});

	test("the cursor clamps at both ends instead of wrapping", async () => {
		const { actions, state } = createActions({
			catalog: catalog([stage({ ident: "one" }), stage({ ident: "two" })]),
		});

		await actions.openStagePicker();
		actions.move(-1);
		expect(state.index).toBe(0);
		actions.move(1);
		actions.move(1);
		actions.move(1);
		expect(state.index).toBe(1);
	});

	test("closing forgets the stage and the second step", async () => {
		const portal = uiApp(
			"portal",
			"Portal",
			"https://stage.example.test/portal",
		);
		const admin = uiApp("admin", "Admin", "https://stage.example.test/admin");
		const { actions, state } = createActions({
			catalog: catalog([stage({ ident: "acceptance" }, [portal, admin])]),
		});

		await actions.openStagePicker();
		await actions.confirm();
		expect(state.step).toBe("apps");

		actions.close();
		expect(state.showStagePicker).toBe(false);
		expect(state.step).toBe("stages");
		expect(state.stage).toBeNull();
		expect(state.stages).toEqual([]);
	});
});
