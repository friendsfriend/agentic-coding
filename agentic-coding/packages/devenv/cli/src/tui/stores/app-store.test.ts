import { describe, expect, test } from "bun:test";
import {
	createAppStore,
	getShutdownPhaseStatus,
	SHUTDOWN_PHASE_ORDER,
	type ShutdownState,
	uiTestTabEnabled,
} from "./app-store";

const state = (
	phase: ShutdownState["phase"],
	failedPhase?: ShutdownState["failedPhase"],
): ShutdownState => ({
	phase,
	message: phase,
	error: phase === "failed" ? "boom" : null,
	failedPhase,
});

describe("UI test tab", () => {
	test("is only present for exact DEVENV_UI_TEST=true", () => {
		expect(uiTestTabEnabled({ DEVENV_UI_TEST: "true" })).toBe(true);
		expect(uiTestTabEnabled({ DEVENV_UI_TEST: "1" })).toBe(false);
		expect(
			createAppStore({ DEVENV_UI_TEST: "true" }).tableTabs().at(-1)?.id,
		).toBe("ui-test");
		expect(
			createAppStore({})
				.tableTabs()
				.some((tab) => tab.id === "ui-test"),
		).toBe(false);
	});
});

describe("shutdown phase status", () => {
	test("starts with first shutdown step current", () => {
		expect(getShutdownPhaseStatus(state("preparing"), "preparing")).toBe(
			"current",
		);
		expect(
			getShutdownPhaseStatus(state("preparing"), "canceling-background-work"),
		).toBe("pending");
	});

	test("marks previous phases done and next phase current", () => {
		expect(getShutdownPhaseStatus(state("stopping-input"), "preparing")).toBe(
			"done",
		);
		expect(
			getShutdownPhaseStatus(
				state("stopping-input"),
				"canceling-background-work",
			),
		).toBe("done");
		expect(
			getShutdownPhaseStatus(state("stopping-input"), "stopping-input"),
		).toBe("current");
		expect(
			getShutdownPhaseStatus(state("stopping-input"), "destroying-renderer"),
		).toBe("pending");
	});

	test("marks failed phase only as failed", () => {
		expect(
			getShutdownPhaseStatus(
				state("failed", "canceling-background-work"),
				"preparing",
			),
		).toBe("done");
		expect(
			getShutdownPhaseStatus(
				state("failed", "canceling-background-work"),
				"canceling-background-work",
			),
		).toBe("failed");
		expect(
			getShutdownPhaseStatus(
				state("failed", "canceling-background-work"),
				"stopping-input",
			),
		).toBe("pending");
	});

	test("keeps stable deterministic shutdown order", () => {
		expect(SHUTDOWN_PHASE_ORDER).toEqual([
			"preparing",
			"canceling-background-work",
			"stopping-input",
			"stopping-server",
			"destroying-renderer",
			"complete",
		]);
	});
});

describe("view route stack", () => {
	test("pushes and pops view routes", () => {
		const store = createAppStore();
		expect(store.viewMode()).toBe("table");
		store.pushView("issues");
		store.pushView("issueDetail");
		expect(store.viewStack().map((route) => route.mode)).toEqual([
			"table",
			"issues",
			"issueDetail",
		]);
		expect(store.viewMode()).toBe("issueDetail");
		expect(store.canGoBack()).toBe(true);
		expect(store.popView()).toBe("issues");
		expect(store.viewMode()).toBe("issues");
		expect(store.popView()).toBe("table");
		expect(store.viewMode()).toBe("table");
		expect(store.canGoBack()).toBe(false);
	});

	test("setViewMode remains replace-current compatibility adapter", () => {
		const store = createAppStore();
		store.pushView("issues");
		store.setViewMode("providers");
		expect(store.viewStack().map((route) => route.mode)).toEqual([
			"table",
			"providers",
		]);
		store.resetViewStack("table");
		expect(store.viewStack().map((route) => route.mode)).toEqual(["table"]);
	});

	test("main table survives issues detail escape chain", () => {
		const store = createAppStore();
		store.pushView("issues");
		store.pushView("issueDetail");
		expect(store.popView()).toBe("issues");
		expect(store.popView()).toBe("table");
		expect(store.viewStack().map((route) => route.mode)).toEqual(["table"]);
		expect(store.viewMode()).toBe("table");
	});

	test("main table survives change request detail escape chain", () => {
		const store = createAppStore();
		store.pushView("changeRequests");
		store.pushView("changeRequestDetail");
		expect(store.popView()).toBe("changeRequests");
		expect(store.popView()).toBe("table");
		expect(store.viewStack().map((route) => route.mode)).toEqual(["table"]);
	});

	test("modal stack preserves overlay open order and active modal", () => {
		const store = createAppStore();
		store.syncModalStack(["diff"]);
		store.syncModalStack(["diff", "comment"]);
		expect(store.modalStack().map((route) => route.name)).toEqual([
			"diff",
			"comment",
		]);
		expect(store.activeModal()).toBe("comment");
		store.syncModalStack(["diff"]);
		expect(store.activeModal()).toBe("diff");
		store.syncModalStack([]);
		expect(store.activeModal()).toBe("none");
	});
});
