/** @jsxImportSource @opentui/solid */
// Dashboard-only presentation root (isolate-workflow-dashboard-mode, task 3.1):
// the shapes the shell used to provide around the dashboard (tab row,
// breadcrumb, destination pages, location picker, observability bodies and the
// shell key layer) must not exist here, and the workflow-scoped operational
// controls must still work.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { DashboardRoot } from "../../src/tui/app/DashboardRoot.tsx";
import { setupKeymap } from "../../src/tui/dash/keymap-setup.ts";
import {
	acquiredResources,
	isShutdownRequested,
	registerStopSequence,
	resetLifecycle,
	resetResources,
} from "../../src/tui/lifecycle.ts";
import { renderUntil } from "./support/terminal.ts";

type Test = Awaited<ReturnType<typeof testRender>>;

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
	resetLifecycle();
	resetResources();
});

function TestRoot() {
	const renderer = useRenderer();
	const keymap = createDefaultOpenTuiKeymap(renderer);
	const dispose = setupKeymap(keymap);
	onCleanup(dispose);
	return (
		<DashboardRoot
			repo="/demo"
			workflowId="demo-optional-realisation-date"
			profile="test"
			keymap={keymap}
		/>
	);
}

/** The demo fixture opens a plan review; postpone it to see the bare dashboard. */
async function dashboardReady(t: Test) {
	expect(await renderUntil(t, "Plan review")).toBe(true);
	t.mockInput.pressEscape();
	await new Promise((resolve) => setTimeout(resolve, 80));
	expect(await renderUntil(t, (frame) => !frame.includes("Plan review"))).toBe(
		true,
	);
}

/** Chrome the feature shell renders around a body; none of it belongs here. */
const SHELL_CHROME = [
	"Choose a destination",
	"Ctrl+P",
	"Locations",
	"Topology",
	"Observability",
];

test("dash renders the dashboard without shell chrome or destinations", async () => {
	const t = await testRender(() => <TestRoot />, { width: 140, height: 40 });
	await dashboardReady(t);

	const frame = t.captureCharFrame();
	// The dashboard's own panels, header and footer are present.
	expect(frame).toContain("Change");
	expect(frame).toContain("Agents");
	expect(frame).toContain("J/K/H/L panels");
	expect(frame).toContain("Enter approve");
	// No full-application chrome: no breadcrumb, destination list, picker or
	// observability body is rendered.
	for (const chrome of SHELL_CHROME) expect(frame).not.toContain(chrome);

	t.renderer.destroy();
});

test("shell-only keys and clicks invoke no navigation handler", async () => {
	const t = await testRender(() => <TestRoot />, { width: 140, height: 40 });
	await dashboardReady(t);

	// Former shell shortcuts: location picker (Ctrl+P), the retired structural
	// parent alias (Alt/⌥+Up, delivered as meta) and focus-region cycling (Tab).
	t.mockInput.pressKey("p", { ctrl: true });
	await t.renderOnce();
	t.mockInput.pressKey("up", { meta: true });
	await t.renderOnce();
	t.mockInput.pressKey("tab");
	await t.renderOnce();
	// A click where the breadcrumb row used to sit.
	await t.mockMouse.click(3, 2);
	await t.renderOnce();

	const frame = t.captureCharFrame();
	for (const chrome of SHELL_CHROME) expect(frame).not.toContain(chrome);
	// Still the same dashboard surface, still the same panel footer.
	expect(frame).toContain("Change");
	expect(frame).toContain("J/K/H/L panels");

	t.renderer.destroy();
});

test("`?` help lists only dashboard commands", async () => {
	const t = await testRender(() => <TestRoot />, { width: 140, height: 40 });
	await dashboardReady(t);

	t.mockInput.pressKey("?");
	const help = await t.waitForFrame((frame) =>
		frame.includes("Dashboard keybindings"),
	);
	expect(help).toContain("Move between panels");
	expect(help).toContain("View selected verifier result");
	// Shell catalog entries (destination lists, picker, structural parent) are
	// not part of this surface's help.
	expect(help).not.toContain("parent page");
	expect(help).not.toContain("select destination");
	expect(help).not.toContain("locations");

	t.renderer.destroy();
});

test("an operational review opens, and Escape returns to the same dashboard", async () => {
	const t = await testRender(() => <TestRoot />, { width: 140, height: 40 });
	expect(await renderUntil(t, "Plan review")).toBe(true);
	// The review dialog is the workflow-operation surface: its decision controls
	// are present and it owns the footer while open.
	const review = t.captureCharFrame();
	expect(review).toContain("/ Search files");
	expect(review).toContain("f Finish review");

	t.mockInput.pressEscape();
	await new Promise((resolve) => setTimeout(resolve, 80));
	expect(await renderUntil(t, (frame) => !frame.includes("Plan review"))).toBe(
		true,
	);
	// Back on the same dashboard page with focus intact: no other page opened.
	const after = t.captureCharFrame();
	expect(after).toContain("Change");
	expect(after).toContain("Enter approve");
	for (const chrome of SHELL_CHROME) expect(after).not.toContain(chrome);

	t.renderer.destroy();
});

test("inline status and agent metrics stay on the dashboard", async () => {
	const t = await testRender(() => <TestRoot />, { width: 140, height: 40 });
	await dashboardReady(t);

	const frame = t.captureCharFrame();
	expect(frame).toContain("STATUS");
	expect(frame).toContain("tok");
	expect(frame).toContain("/s");

	t.renderer.destroy();
});

test("the dashboard root owns no server, coordinator or shutdown resources", async () => {
	resetResources();
	const t = await testRender(() => <TestRoot />, { width: 100, height: 30 });
	await t.renderOnce();
	// Presentation composes no backend: the route that owns the server acquires
	// it in the process entry, so nothing to stop or dispose is registered here.
	expect(acquiredResources()).toEqual([]);
	t.renderer.destroy();
	expect(acquiredResources()).toEqual([]);
});

test("double `q` quits the dashboard-only root", async () => {
	resetLifecycle();
	let stops = 0;
	registerStopSequence(async () => {
		stops += 1;
	});
	const t = await testRender(() => <TestRoot />, { width: 140, height: 40 });
	await dashboardReady(t);

	t.mockInput.pressKey("q");
	await t.renderOnce();
	// The first press only arms the quit; the dashboard is still running.
	expect(isShutdownRequested()).toBe(false);

	t.mockInput.pressKey("q");
	await t.renderOnce();
	expect(isShutdownRequested()).toBe(true);
	expect(stops).toBe(1);

	t.renderer.destroy();
});

test("double Ctrl+C quits the dashboard-only root", async () => {
	resetLifecycle();
	let stops = 0;
	registerStopSequence(async () => {
		stops += 1;
	});
	const t = await testRender(() => <TestRoot />, { width: 140, height: 40 });
	await dashboardReady(t);

	t.mockInput.pressKey("c", { ctrl: true });
	await t.renderOnce();
	expect(isShutdownRequested()).toBe(false);

	t.mockInput.pressKey("c", { ctrl: true });
	await t.renderOnce();
	expect(isShutdownRequested()).toBe(true);
	expect(stops).toBe(1);

	t.renderer.destroy();
});

test("a missing target repository is a bounded error, not a Home fallback", async () => {
	const root = mkdtempSync(join(tmpdir(), "agent-dash-target-"));
	roots.push(root);
	const missing = join(root, "not-a-repository");
	expect(existsSync(missing)).toBe(false);
	const result = Bun.spawnSync(
		[
			process.execPath,
			"src/cli.ts",
			"dash",
			"--repo",
			missing,
			"--workflow-id",
			"demo",
		],
		{ stdout: "pipe", stderr: "pipe", env: { ...process.env } },
	);
	expect(result.exitCode).toBe(2);
	const stderr = result.stderr.toString();
	expect(stderr).toContain("dashboard target repository does not exist");
	expect(stderr).toContain("--workflow-id");
	expect(result.stdout.toString()).toBe("");
});
