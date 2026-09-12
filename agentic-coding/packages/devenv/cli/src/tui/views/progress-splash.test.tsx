/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { AppStore, ShutdownState, StartupState } from "../stores";
import { ShutdownSplash } from "./shutdown-splash";
import { StartupSplash } from "./startup-splash";

const makeStore = (startup: StartupState, shutdown: ShutdownState): AppStore =>
	({
		startupState: () => startup,
		shutdownState: () => shutdown,
	}) as unknown as AppStore;

describe("lifecycle splash rendering", () => {
	test("startup splash keeps existing startup copy and status rows", async () => {
		const store = makeStore(
			{
				phase: "server-ready",
				message: "Loading initial data...",
				error: null,
			},
			{ phase: "idle", message: "", error: null },
		);
		const view = await testRender(() => <StartupSplash appStore={store} />, {
			width: 100,
			height: 30,
		});
		await view.renderOnce();
		const frame = view.captureCharFrame();
		view.renderer.destroy();

		expect(frame).toContain("DevEnv Startup");
		expect(frame).toContain("Loading initial data...");
		expect(frame).toContain("✓ Connecting to server");
		expect(frame).toContain("Server ready");
	});

	test("shutdown splash uses same status row styling with shutdown copy", async () => {
		const store = makeStore(
			{ phase: "complete", message: "Ready", error: null },
			{
				phase: "stopping-input",
				message: "Stopping input handlers...",
				error: null,
			},
		);
		const view = await testRender(() => <ShutdownSplash appStore={store} />, {
			width: 100,
			height: 30,
		});
		await view.renderOnce();
		const frame = view.captureCharFrame();
		view.renderer.destroy();

		expect(frame).toContain("DevEnv Shutdown");
		expect(frame).toContain("Stopping input handlers...");
		expect(frame).toContain("✓ Preparing shutdown");
		expect(frame).toContain("✓ Canceling background work");
		expect(frame).toContain("Stopping input");
	});
});
