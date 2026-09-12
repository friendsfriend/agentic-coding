import { afterEach, describe, expect, test } from "bun:test";
import {
	__resetExitForTests,
	exitApp,
	registerGracefulShutdownHandler,
	setExitRenderer,
} from "../exit";
import { handleGlobalKeys } from "./global-keys";
import type {
	KeyboardActions,
	KeyboardContext,
	KeyboardEvent,
	KeyboardStores,
} from "./types";

const signalStore = (overrides: Record<string, unknown> = {}) =>
	new Proxy(overrides, {
		get(target, prop: string) {
			if (prop in target) return target[prop];
			return () => false;
		},
	});

const stores = (appOverrides: Record<string, unknown> = {}): KeyboardStores =>
	({
		appStore: signalStore({
			viewMode: () => "table",
			showFirstSteps: () => false,
			isShuttingDown: () => false,
			...appOverrides,
		}),
		issueStore: signalStore(),
		logStore: signalStore(),
		changeRequestStore: signalStore(),
		providerStore: signalStore(),
		uiStore: signalStore(),
		agentStore: signalStore(),
		appDetailStore: signalStore(),
	}) as unknown as KeyboardStores;

const actions = (exit: () => void): KeyboardActions =>
	({
		appActions: signalStore({ exitApp: exit }),
		issueActions: signalStore(),
		logActions: signalStore(),
		crActions: signalStore(),
		dockerActions: signalStore(),
		gitActions: signalStore(),
		providerActions: signalStore(),
		agentActions: signalStore(),
		utilActions: signalStore(),
		pipelineActions: signalStore(),
		helpActions: signalStore(),
	}) as unknown as KeyboardActions;

const ctx = (): KeyboardContext =>
	({
		renderer: {
			console: { visible: false },
			getSelection: () => null,
		},
		client: {},
		getSelectedApp: () => undefined,
		launchPi: () => {},
		getSelectableRows: () => [],
		showError: () => {},
	}) as unknown as KeyboardContext;

const key = (event: Partial<KeyboardEvent>): KeyboardEvent =>
	event as KeyboardEvent;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	__resetExitForTests();
});

describe("global quit keys", () => {
	test("confirmed q routes through graceful exit instead of immediate renderer destroy", async () => {
		let gracefulRuns = 0;
		let destroyed = 0;
		setExitRenderer({
			destroy: () => {
				destroyed += 1;
			},
		});
		registerGracefulShutdownHandler(() => {
			gracefulRuns += 1;
		});
		const a = actions(() => {
			void exitApp();
		});
		const s = stores();

		expect(await handleGlobalKeys(key({ name: "q" }), s, a, ctx())).toBe(true);
		expect(await handleGlobalKeys(key({ name: "q" }), s, a, ctx())).toBe(true);
		await flush();

		expect(gracefulRuns).toBe(1);
		expect(destroyed).toBe(0);
	});

	test("confirmed Ctrl+C routes through graceful exit when no selection exists", async () => {
		let gracefulRuns = 0;
		registerGracefulShutdownHandler(() => {
			gracefulRuns += 1;
		});
		const a = actions(() => {
			void exitApp();
		});
		const s = stores();

		expect(
			await handleGlobalKeys(key({ name: "c", ctrl: true }), s, a, ctx()),
		).toBe(true);
		expect(
			await handleGlobalKeys(key({ name: "c", ctrl: true }), s, a, ctx()),
		).toBe(true);
		await flush();

		expect(gracefulRuns).toBe(1);
	});

	test("shutdown guard consumes normal keys without actions", async () => {
		let exited = false;
		const handled = await handleGlobalKeys(
			key({ name: "q" }),
			stores({ isShuttingDown: () => true }),
			actions(() => {
				exited = true;
			}),
			ctx(),
		);

		expect(handled).toBe(true);
		expect(exited).toBe(false);
	});
});
