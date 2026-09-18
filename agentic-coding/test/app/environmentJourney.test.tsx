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
import { advance, pressEscapeAndSettle, renderUntil } from "./support/terminal";

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
	// The Kubernetes category reads its cluster status on mount. Without a stub
	// the read 404s, the body raises its error dialog and that dialog owns input —
	// the journey would then be testing the dialog, not the page.
	"/api/kubernetes/cluster": {
		clusterName: "stub",
		contextName: "stub",
		provider: "docker",
		exists: false,
		reachable: false,
		state: "unknown",
		nodes: [],
		namespaces: [],
		pods: { total: 0, running: 0, pending: 0, failed: 0 },
		releases: [],
	},
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
	let shellKeymap: ReturnType<typeof createDefaultOpenTuiKeymap> | undefined;
	const t = await testRender(
		() => {
			const renderer = useRenderer();
			const keymap = createDefaultOpenTuiKeymap(renderer);
			shellKeymap = keymap;
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
	return {
		t,
		db,
		keymap: () => {
			if (!shellKeymap) throw new Error("shell keymap is not mounted");
			return shellKeymap;
		},
	};
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

		// The hosted body draws no outer gutter of its own: the shell chrome owns
		// the blank row above and below the content, so the page keeps exactly one.
		{
			const rows = t.captureCharFrame().split("\n");
			const footer = rows.reduce(
				(acc, line, index) => (line.slice(0, 90).trim() ? index : acc),
				0,
			);
			expect((rows[2] ?? "").trim()).toBe("");
			expect((rows[footer - 1] ?? "").slice(0, 90).trim()).toBe("");
		}

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

test("every environment category opens from the list cursor and keeps the shell keys", async () => {
	stubEnvironmentServer();
	const { t, db, keymap } = await renderShell();
	const activeTab = (): unknown => keymap().getData?.("app.activeTab");
	const categories = [
		"Applications",
		"Libraries",
		"Infrastructure",
		"Scripts",
		"Kubernetes",
	];
	try {
		// Home → Environments: the category list, whose cursor is the only
		// keyboard way into the five environment destinations.
		t.mockInput.pressEnter();
		await renderUntil(t, (frame) => crumbOf(frame) === "Home › Environments");
		await advance(t, 6);

		for (const [index, label] of categories.entries()) {
			// The list cursor is remembered per page, so walk back to its first row
			// before counting down to the wanted one.
			for (let step = 0; step < 6; step += 1) {
				t.mockInput.pressKey("k");
				await advance(t, 2);
			}
			for (let step = 0; step < index; step += 1) {
				t.mockInput.pressKey("j");
				await advance(t, 2);
			}
			t.mockInput.pressEnter();
			const page = `Home › Environments › ${label}`;
			await renderUntil(t, (frame) => crumbOf(frame) === page, 30);
			await advance(t, 8);
			// The cursor's row is the page that opens, and the body is told which
			// category it is showing (a stale report used to drag the shell back to
			// the previous category).
			expect(crumbOf(t.captureCharFrame())).toBe(page);
			expect(activeTab()).toBe(label.toLowerCase());

			// The shell owns its globals on this page: `?` is the shared help
			// catalog (the body does not open its own help page over it) and
			// Ctrl+P the one location picker.
			t.mockInput.pressKey("?");
			await renderUntil(t, (frame) => frame.includes("Keybindings"), 20);
			expect(t.captureCharFrame()).toContain("Keybindings");
			await pressEscapeAndSettle(t, (frame) => !frame.includes("Keybindings"));
			t.mockInput.pressKey("p", { ctrl: true });
			await renderUntil(t, (frame) => frame.includes("Locations"), 20);
			expect(t.captureCharFrame()).toContain("Locations");
			await pressEscapeAndSettle(t, (frame) => !frame.includes("Locations"));
			await advance(t, 4);

			// Back to the list for the next category.
			await pressEscapeAndSettle(
				t,
				(frame) => crumbOf(frame) === "Home › Environments",
			);
			await advance(t, 6);
		}
	} finally {
		t.renderer.destroy();
		db.close();
	}
}, 60_000);

test("an empty environment keeps the shell keys over its first-start dialog", async () => {
	// No configured entries: the body's first-start dialog is open over the empty
	// table, and the feature's own dialog layers must not take the shell's globals
	// (`?` help and Ctrl+P locations) for the whole surface.
	stubEnvironmentServer([]);
	const { t, db } = await renderShell();
	const dialogVisible = () =>
		t.captureCharFrame().includes("Welcome to DevEnv");
	try {
		t.mockInput.pressEnter();
		await renderUntil(t, (frame) => crumbOf(frame) === "Home › Environments");
		await advance(t, 6);
		t.mockInput.pressEnter();
		await renderUntil(
			t,
			(frame) => crumbOf(frame) === "Home › Environments › Applications",
		);
		await advance(t, 10);
		console.log(
			`DIALOG frame:\n` +
				t
					.captureCharFrame()
					.split("\n")
					.slice(0, 14)
					.map(
						(line, index) =>
							`${index + 1}:${JSON.stringify(line.slice(0, 80))}`,
					)
					.join("\n"),
		);
		expect(dialogVisible()).toBe(true);

		// `?` is the shared help catalog, not the environment's own help page: the
		// page must not move and the dialog comes back when the overlay closes.
		t.mockInput.pressKey("?");
		await renderUntil(t, (frame) => frame.includes("Keybindings"), 20);
		expect(crumbOf(t.captureCharFrame())).toBe(
			"Home › Environments › Applications",
		);
		await pressEscapeAndSettle(t, (frame) => !frame.includes("Keybindings"));
		expect(dialogVisible()).toBe(true);

		// The one location picker works over the dialog too.
		t.mockInput.pressKey("p", { ctrl: true });
		await renderUntil(t, (frame) => frame.includes("Locations"), 20);
		expect(t.captureCharFrame()).toContain("Locations");
		await pressEscapeAndSettle(t, (frame) => !frame.includes("Locations"));
		expect(dialogVisible()).toBe(true);

		// Escape still closes the dialog without leaving the page.
		await pressEscapeAndSettle(
			t,
			(frame) => !frame.includes("Welcome to DevEnv"),
		);
		expect(crumbOf(t.captureCharFrame())).toBe(
			"Home › Environments › Applications",
		);
	} finally {
		t.renderer.destroy();
		db.close();
	}
}, 60_000);

test("a hidden body's modal state cannot park the environment dialog", async () => {
	// The dashboard and the wiki write the shared `modal.active` field while
	// their body is hidden behind the environment page, and every environment
	// layer requires it to be "none". With one shared field that write parked the
	// whole feature: the dialog went inert, Escape stepped the page up instead of
	// dismissing it, and the surface looked like it had no keybindings left. The
	// environment owns its own field now, so a foreign write is inert.
	stubEnvironmentServer([]);
	const { t, db, keymap } = await renderShell();
	const dialogVisible = () =>
		t.captureCharFrame().includes("Welcome to DevEnv");
	try {
		t.mockInput.pressEnter();
		await renderUntil(t, (frame) => crumbOf(frame) === "Home › Environments");
		await advance(t, 6);
		t.mockInput.pressEnter();
		await renderUntil(
			t,
			(frame) => crumbOf(frame) === "Home › Environments › Applications",
		);
		await advance(t, 8);
		expect(dialogVisible()).toBe(true);
		expect(keymap().getData?.("modal.active.environments")).toBe("first-steps");

		// A hidden body writes its own modal field.
		keymap().setData("modal.active", "none");
		await advance(t, 6);

		// The dialog still owns its keys: Enter opens the selected step.
		t.mockInput.pressEnter();
		await renderUntil(t, (frame) => frame.includes("Add Provider"), 20);
		expect(t.captureCharFrame()).toContain("Add Provider");

		// Escape closes that step and returns to the dialog, without leaving the
		// page.
		await pressEscapeAndSettle(t, (frame) =>
			frame.includes("Welcome to DevEnv"),
		);
		expect(dialogVisible()).toBe(true);
		expect(crumbOf(t.captureCharFrame())).toBe(
			"Home › Environments › Applications",
		);

		// And the dialog itself still closes on Escape.
		await pressEscapeAndSettle(
			t,
			(frame) => !frame.includes("Welcome to DevEnv"),
		);
		expect(dialogVisible()).toBe(false);
		expect(crumbOf(t.captureCharFrame())).toBe(
			"Home › Environments › Applications",
		);
	} finally {
		t.renderer.destroy();
		db.close();
	}
}, 60_000);

test("the keybind diagnostics report the live keymap state on an environment page", async () => {
	// Support tooling, and the check for this whole class of bug: the shell must
	// answer on an environment page even though the body owns the keyboard, and
	// the report names every field the feature layers gate on.
	stubEnvironmentServer();
	const { t, db } = await renderShell();
	try {
		t.mockInput.pressEnter();
		await renderUntil(t, (frame) => crumbOf(frame) === "Home › Environments");
		await advance(t, 6);
		t.mockInput.pressEnter();
		await renderUntil(
			t,
			(frame) => crumbOf(frame) === "Home › Environments › Applications",
		);
		await advance(t, 8);

		t.mockInput.pressKey("d", { meta: true });
		await renderUntil(t, (frame) => frame.includes("Keybind diagnostics"), 20);
		const frame = t.captureCharFrame();
		expect(frame).toContain("Keybind diagnostics");
		expect(frame).toContain("shell.feature");
		expect(frame).toContain('"environments"');
		expect(frame).toContain("modal.active.environments");
		expect(frame).toContain("env table bindings");
	} finally {
		t.renderer.destroy();
		db.close();
	}
}, 60_000);
