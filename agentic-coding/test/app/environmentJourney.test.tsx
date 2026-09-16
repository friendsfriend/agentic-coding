/** @jsxImportSource @opentui/solid */
// Embedded environment body inside the real shell: the page journey the
// environment feature drives (Home → Environments → Applications → resource)
// and the first-start dialog an unconfigured installation shows there.
//
// The devenv body takes its category and view from the shell route and reports
// its own moves back, so failures used to hide here: Escape closing the
// resource view was immediately reopened by the route request the route still
// named, the category page's Enter was claimed by the environment's table layer
// (whose runtime state still matched the last page the body was shown on)
// instead of opening the Applications destination, and the shell's mirrored
// dialog entry overwrote the body's own `modal.active` name, leaving the
// first-start dialog with no active key layer at all.
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
import { advance, renderUntil } from "./support/terminal";

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

const responses = (
	apps: readonly (typeof APPS)[number][],
): Readonly<Record<string, unknown>> => ({
	"/api/health": { status: "ok" },
	"/api/action-registry/status": {
		available: true,
		actionsCount: 0,
		version: "1",
	},
	"/api/apps": { apps },
	"/api/status": {
		statuses: apps.map((app) => ({
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
	"/api/providers": [],
	"/api/actions/history": [],
});

let restoreFetch: (() => void) | undefined;

afterEach(() => {
	restoreFetch?.();
	restoreFetch = undefined;
});

/** Serve the environment body's startup reads, so the journeys run offline. */
function stubEnvironmentServer(
	apps: readonly (typeof APPS)[number][] = APPS,
): void {
	const table = responses(apps);
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
		if (url.pathname in table) return json(table[url.pathname]);
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
	await advance(t, 12, 80);
	return { t, db };
}

test("the environment page journey keeps one hierarchy step per key", async () => {
	stubEnvironmentServer();
	const { t, db } = await renderShell();
	const expectCrumb = async (want: string) => {
		await renderUntil(t, (frame) => crumbOf(frame) === want, 10);
		await advance(t, 4);
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

test("the first-start dialog keeps its keys on an unconfigured install", async () => {
	stubEnvironmentServer([]);
	const { t, db } = await renderShell();
	const dialogVisible = () =>
		t.captureCharFrame().includes("Welcome to DevEnv");
	const pressEscapeKey = async () => {
		t.mockInput.pressEscape();
		await new Promise((resolve) => setTimeout(resolve, 150));
		await advance(t, 6);
	};
	const openApplications = async () => {
		await renderUntil(t, (frame) => crumbOf(frame) === "Home › Environments");
		await advance(t, 4);
		t.mockInput.pressEnter();
		await renderUntil(
			t,
			(frame) => crumbOf(frame) === "Home › Environments › Applications",
		);
		await advance(t, 10);
	};

	try {
		// An unconfigured installation offers its first steps over the empty
		// application list.
		t.mockInput.pressEnter();
		await openApplications();
		expect(dialogVisible()).toBe(true);

		// A shell overlay parks the body's layers and hands the dialog back when
		// it closes: the dialog still owns Escape instead of the shell.
		t.mockInput.pressKey("p", { ctrl: true });
		await renderUntil(t, (frame) => frame.includes("Locations"));
		await pressEscapeKey();
		expect(t.captureCharFrame()).not.toContain("Locations");
		expect(dialogVisible()).toBe(true);

		// Escape closes the dialog without leaving the page.
		await pressEscapeKey();
		expect(dialogVisible()).toBe(false);
		expect(crumbOf(t.captureCharFrame())).toBe(
			"Home › Environments › Applications",
		);
	} finally {
		t.renderer.destroy();
		db.close();
	}
}, 30_000);
