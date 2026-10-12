// Browser spike (`add-agent-browser-sessions`, task 1.1).
//
// The change's riskiest assumption is that `playwright-core` under Bun can
// (a) launch a headless Chromium, (b) record video, and (c) produce an
// accessibility snapshot whose refs are immediately actionable. This script
// answers all three against the module the server actually ships, so the check
// covers the real driver and the real injected snapshot script rather than a
// scratch reproduction.
//
// Run it both ways:
//   PLAYWRIGHT_BROWSERS_PATH=<dir> bun scripts/browser-spike.ts
//   PLAYWRIGHT_BROWSERS_PATH=<dir> bun build --compile --outfile /tmp/spike scripts/browser-spike.ts && /tmp/spike
//
// The second is the one that matters: it proves the same code and the same
// bundled `playwright-core` work in the single-file artifact the application is
// packaged as (`docs/application-lifecycle.md`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findInstalledChromium } from "../src/server/browser/install.ts";
import { createPlaywrightDriver } from "../src/server/browser/playwright-driver.ts";
import { refSelector, snapshotRefs } from "../src/server/browser/snapshot.ts";

interface Report {
	executable: string;
	launched: boolean;
	pageTitle: string;
	snapshotRefs: number;
	clickedByRef: boolean;
	screenshotBytes: number;
	videoBytes: number;
	failures: string[];
	mode: "source" | "compiled";
}

const PAGE = `<!doctype html><html><head><title>Spike</title></head><body>
<h1>Browser spike</h1>
<button id="go" onclick="document.title='Clicked'">Run</button>
<input aria-label="Name" />
<a href="#done">Done</a>
</body></html>`;

const mode: Report["mode"] =
	// A compiled Bun executable reports its own embedded entrypoint path.
	process.execPath.includes("bun") && fs.existsSync(import.meta.path)
		? "source"
		: "compiled";

const browsersPath =
	process.env.PLAYWRIGHT_BROWSERS_PATH ??
	path.join(os.homedir(), ".config", "agentic-coding", "browsers");

const report: Report = {
	executable: "",
	launched: false,
	pageTitle: "",
	snapshotRefs: 0,
	clickedByRef: false,
	screenshotBytes: 0,
	videoBytes: 0,
	failures: [],
	mode,
};

try {
	const executable = findInstalledChromium(browsersPath);
	if (!executable) throw new Error(`no Chromium under ${browsersPath}`);
	report.executable = executable;

	const server = Bun.serve({
		port: 0,
		fetch: () =>
			new Response(PAGE, { headers: { "content-type": "text/html" } }),
	});
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-spike-"));
	const driver = createPlaywrightDriver();
	const browser = await driver.launch({
		headless: true,
		executablePath: executable,
	});
	report.launched = true;
	const context = await browser.newContext({
		viewport: { width: 800, height: 600 },
		recordVideo: { dir: workDir, size: { width: 800, height: 600 } },
	});
	const page = await context.page();
	await page.goto(`http://127.0.0.1:${server.port}/`, 30_000);
	report.pageTitle = await page.title();

	const snapshot = await page.snapshot();
	const refs = snapshotRefs(snapshot);
	report.snapshotRefs = refs.length;
	const button = refs[0];
	if (button) {
		await page.click(refSelector(button), 10_000);
		report.clickedByRef = (await page.title()) === "Clicked";
	}
	report.screenshotBytes = (
		await page.screenshot({ type: "jpeg", quality: 70, fullPage: false })
	).byteLength;
	const video = context.video();
	const videoPath = path.join(workDir, "spike.webm");
	await context.close();
	if (video) {
		await video.saveAs(videoPath);
		report.videoBytes = fs.statSync(videoPath).size;
	}
	await browser.close();
	fs.rmSync(workDir, { recursive: true, force: true });
	server.stop(true);
} catch (error) {
	report.failures.push(error instanceof Error ? error.message : String(error));
}

if (!report.launched) report.failures.push("launch failed");
if (report.snapshotRefs === 0) report.failures.push("no refs in the snapshot");
if (!report.clickedByRef)
	report.failures.push("click by ref did not take effect");
if (report.screenshotBytes === 0) report.failures.push("no screenshot bytes");
if (report.videoBytes === 0) report.failures.push("no video bytes");

console.log(JSON.stringify(report, null, 2));
process.exit(report.failures.length === 0 ? 0 : 1);
