/** @jsxImportSource @opentui/solid */
// Embedded environment body inside the real shell: the page journey the
// environment feature drives (Home → Environments → Applications → resource).
//
// The devenv body takes its category and view from the shell route and reports
// its own moves back, so two failures used to hide here: Escape closing the
// resource view was immediately reopened by the route request the route still
// named, and the category page's Enter was claimed by the environment's table
// layer (whose runtime state still matched the last page the body was shown on)
// instead of opening the Applications destination.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { EnvironmentsFeature } from "../../src/tui/app/EnvironmentsFeature";
import { setupKeymap } from "../../src/tui/dash/keymap-setup";
import { App } from "../../src/tui/otel/app/App";
import { TraceDb } from "../../src/tui/otel/model/db";
import { LogStore } from "../../src/tui/otel/model/logStore";
import { MetricStore } from "../../src/tui/otel/model/metricStore";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore";
import { TraceStore } from "../../src/tui/otel/model/traceStore";
import { renderUntil } from "./support/terminal";

type Test = Awaited<ReturnType<typeof renderShell>>["t"];

const json = (value: unknown) =>
	new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
	});

const crumbOf = (frame: string): string =>
	frame
		.split("\n")
		.find((line) => line.includes("›"))
		?.trim() ?? "";

const APPS = [
	{
		ident: "shop",
		displayName: "Shop",
		repositoryPath: "https://github.com/acme/shop",
		appType: "APP",
		localDirectoryPath: "/src/shop",
		branch: "main",
		activeWorktree: "main",
	},
];

const RESPONSES: Readonly<Record<string, unknown>> = {
	"/api/health": { status: "ok" },
	"/api/action-registry/status": {
		available: true,
		actionsCount: 0,
		version: "1",
	},
	"/api/apps": { apps: APPS },
	"/api/status": {
		statuses: APPS.map((app) => ({
			ident: app.ident,
			resourceKind: "app",
			branch: "main",
			gitStatus: "clean",
			status: "stopped",
		})),
	},
	"/api/projects": [],
	"/api/infra-services": { services: [] },
	"/api/scripts": { items: [] },
	"/api/providers": { providers: [] },
	"/api/actions/history": [],
};

let restoreFetch: (() => void) | undefined;

afterEach(() => {
	restoreFetch?.();
	restoreFetch = undefined;
});

/** Serve the environment body's startup reads, so the journey runs offline. */
function stubEnvironmentServer(): void {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/events")
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(": connected\n\n"));
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		if (url.pathname in RESPONSES) return json(RESPONSES[url.pathname]);
		if (url.pathname.endsWith("/git"))
			return json({ branch: "main", status: "clean" });
		if (url.pathname.endsWith("/actions")) return json({ items: [] });
		return new Response("{}", {
			status: 404,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	restoreFetch = () => {
		globalThis.fetch = original;
	};
}

/** Let the body's async startup chain and its effects settle. */
async function settle(t: Test, ticks = 20): Promise<void> {
	for (let index = 0; index < ticks; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 80));
		await t.renderOnce();
	}
}

async function renderShell() {
	const db = new TraceDb(mkdtempSync(join(tmpdir(), "environment-journey-")));
	const t = await testRender(
		() => {
			const renderer = useRenderer();
			const keymap = createDefaultOpenTuiKeymap(renderer);
			const disposeShell = setupKeymap(keymap);
			keymap.setData("app.view", "home");
			keymap.setData("modal.active", "none");
			onCleanup(() => disposeShell());
			return (
				<KeymapProvider keymap={keymap}>
					<App
						repos={["/demo"]}
						db={db}
						traceStore={new TraceStore()}
						metricStore={new MetricStore()}
						logStore={new LogStore()}
						topologyStore={new TopologyStore()}
						environments={{ serverUrl: "http://127.0.0.1:4050" }}
						renderEnvironments={(
							onCatalog,
							active,
							onModalChange,
							destination,
							onStartWorkflow,
						) => (
							<EnvironmentsFeature
								serverUrl="http://127.0.0.1:4050"
								onKeybindCatalog={onCatalog}
								active={active}
								onModalChange={onModalChange}
								destination={destination}
								onStartWorkflow={onStartWorkflow}
							/>
						)}
						dashboard={{ mode: "home", keymap }}
					/>
				</KeymapProvider>
			);
		},
		{ width: 140, height: 40 },
	);
	await renderUntil(t, (frame) => frame.includes("›"));
	await settle(t, 12);
	return { t, db };
}

test("the environment page journey keeps one hierarchy step per key", async () => {
	stubEnvironmentServer();
	const { t, db } = await renderShell();
	const expectCrumb = async (want: string) => {
		await renderUntil(t, (frame) => crumbOf(frame) === want, 10);
		await settle(t, 4);
		expect(crumbOf(t.captureCharFrame())).toBe(want);
	};
	const pressEscapeUp = async () => {
		t.mockInput.pressEscape();
		await new Promise((resolve) => setTimeout(resolve, 120));
	};

	try {
		// Home → Environments → Applications → the resource page.
		t.mockInput.pressEnter();
		await expectCrumb("Home › Environments");
		t.mockInput.pressEnter();
		await expectCrumb("Home › Environments › Applications");
		t.mockInput.pressEnter();
		await expectCrumb("Home › Environments › Applications › shop");

		// Escape closes the resource view; the route follows the body instead of
		// reopening the view it still names.
		await pressEscapeUp();
		await expectCrumb("Home › Environments › Applications");

		// Enter opens the same resource again, then Escape walks up twice.
		t.mockInput.pressEnter();
		await expectCrumb("Home › Environments › Applications › shop");
		await pressEscapeUp();
		await expectCrumb("Home › Environments › Applications");
		await pressEscapeUp();
		await expectCrumb("Home › Environments");

		// The category page is the shell's list: Enter opens Applications again
		// (the environment's table layer must not claim the list's keys).
		t.mockInput.pressEnter();
		await expectCrumb("Home › Environments › Applications");
		t.mockInput.pressEnter();
		await expectCrumb("Home › Environments › Applications › shop");

		// Another body page behaves the same: the list cursor picks Libraries,
		// Enter opens it, Escape steps back up to the list.
		await pressEscapeUp();
		await expectCrumb("Home › Environments › Applications");
		await pressEscapeUp();
		await expectCrumb("Home › Environments");
		t.mockInput.pressKey("j");
		await t.renderOnce();
		t.mockInput.pressEnter();
		await expectCrumb("Home › Environments › Libraries");
		await pressEscapeUp();
		await expectCrumb("Home › Environments");
		t.mockInput.pressEnter();
		await expectCrumb("Home › Environments › Libraries");
	} finally {
		t.renderer.destroy();
		db.close();
	}
}, 30_000);
