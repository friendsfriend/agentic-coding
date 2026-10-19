// Settings → Browser (`add-agent-browser-sessions`, task 2.1).
//
// Two things are checked here and nothing else: the effective `browser.*`
// bounds are resolved with safe fallbacks, and the section renders the install
// state so the only download path in the application is visible, explicit and
// off until it is activated.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserStatusResponse } from "../src/contracts/browser.ts";
import { browserStatusResponseSchema } from "../src/contracts/browser.ts";
import { decodeContract } from "../src/contracts/decode.ts";
import {
	BUNDLED_CHROMIUM_REVISION,
	BUNDLED_PLAYWRIGHT_VERSION,
} from "../src/server/browser/bundled-playwright.generated.ts";
import {
	BrowserInstaller,
	displayAvailable,
	expectedChromiumRevision,
	findInstalledChromium,
	INSTALL_COMPLETE_MARKER,
	installChildEnvironment,
	installCommand,
	isCompleteInstall,
	systemChromeCandidates,
} from "../src/server/browser/install.ts";
import { settingsItems } from "../src/tui/settings/items.ts";
import {
	DEFAULT_BROWSER_MAX_SESSIONS,
	DEFAULT_BROWSER_VIEWPORT,
	resolvedBrowserSettings,
	type WorkflowConfig,
} from "../src/workflow/effects.ts";

function settings(config: {
	max_sessions?: number;
	idle_ttl_minutes?: number;
	viewport?: { width?: number; height?: number };
}) {
	return resolvedBrowserSettings({
		browser: config,
	} as unknown as WorkflowConfig);
}

describe("browser bounds", () => {
	test("defaults apply when nothing is configured", () => {
		const resolved = settings({});
		expect(resolved.maxSessions).toBe(DEFAULT_BROWSER_MAX_SESSIONS);
		expect(resolved.idleTtlMs).toBe(15 * 60_000);
		expect(resolved.viewport).toEqual({ ...DEFAULT_BROWSER_VIEWPORT });
	});

	test("an unusable value falls back instead of disabling the lifecycle", () => {
		const resolved = settings({
			max_sessions: 0,
			idle_ttl_minutes: -5,
		});
		expect(resolved.maxSessions).toBe(DEFAULT_BROWSER_MAX_SESSIONS);
		expect(resolved.idleTtlMs).toBe(15 * 60_000);
	});

	test("a configured value wins and a viewport is clamped to something readable", () => {
		const resolved = settings({
			max_sessions: 6,
			idle_ttl_minutes: 3,
			viewport: { width: 9000, height: 10 },
		});
		expect(resolved.maxSessions).toBe(6);
		expect(resolved.idleTtlMs).toBe(3 * 60_000);
		expect(resolved.viewport).toEqual({ width: 4096, height: 200 });
	});
});

describe("browser install detection", () => {
	test("a system Chrome is preferred and needs no download", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-install-"));
		const chrome = path.join(dir, "chrome");
		fs.writeFileSync(chrome, "x");
		const installer = new BrowserInstaller({
			configDir: dir,
			chromeCandidates: [chrome],
		});
		const status = installer.status();
		expect(status.available).toBe(true);
		expect(status.source).toBe("system-chrome");
		expect(status.install.phase).toBe("idle");
		expect(installer.resolveLaunch()).toMatchObject({
			headless: true,
			channel: "chrome",
			executablePath: chrome,
		});
	});

	/** One `chromium-<revision>` directory with a binary in it. */
	function installChromium(
		browsers: string,
		revision: number,
		options: { readonly complete?: boolean } = {},
	): string {
		const binary = path.join(
			browsers,
			`chromium-${revision}`,
			"chrome-mac-arm64",
			"Google Chrome for Testing.app",
			"Contents",
			"MacOS",
		);
		fs.mkdirSync(binary, { recursive: true });
		const executable = path.join(binary, "Google Chrome for Testing");
		fs.writeFileSync(executable, "x");
		if (options.complete !== false)
			fs.writeFileSync(
				path.join(browsers, `chromium-${revision}`, INSTALL_COMPLETE_MARKER),
				"",
			);
		return executable;
	}

	test("an installed Chromium is found under the config directory", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-install-"));
		const browsers = path.join(dir, "browsers");
		const executable = installChromium(browsers, 1248);
		expect(findInstalledChromium(browsers)).toBe(executable);
		const installer = new BrowserInstaller({
			configDir: dir,
			chromeCandidates: [],
		});
		expect(installer.status()).toMatchObject({
			available: true,
			source: "installed-chromium",
		});
	});

	test("a revision this build does not expect is not silently launched", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-install-"));
		const browsers = path.join(dir, "browsers");
		installChromium(browsers, 998);
		// A complete install of a *different* revision is not this build's browser:
		// the answer is "install it", not "launch the older one".
		expect(findInstalledChromium(browsers, 1248)).toBeUndefined();
		expect(findInstalledChromium(browsers, 998)).toBe(
			path.join(
				browsers,
				"chromium-998",
				"chrome-mac-arm64",
				"Google Chrome for Testing.app",
				"Contents",
				"MacOS",
				"Google Chrome for Testing",
			),
		);
	});

	test("an interrupted install is not read as an installed browser", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-install-"));
		const browsers = path.join(dir, "browsers");
		// No `INSTALLATION_COMPLETE`: the archive was half-extracted.
		installChromium(browsers, 1248, { complete: false });
		expect(isCompleteInstall(path.join(browsers, "chromium-1248"))).toBe(false);
		expect(findInstalledChromium(browsers)).toBeUndefined();
		const installer = new BrowserInstaller({
			configDir: dir,
			chromeCandidates: [],
		});
		expect(installer.status()).toMatchObject({
			available: false,
			source: "none",
		});
		expect(() => installer.resolveLaunch()).toThrow(/no browser is available/);
	});

	test("a headed install is told apart from a headless-only one", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-install-"));
		const browsers = path.join(dir, "browsers");
		const installer = new BrowserInstaller({
			configDir: dir,
			chromeCandidates: [],
			// The host's own display is not what this test is about.
			display: () => true,
		});
		// Nothing installed: neither the headless tools nor a window.
		expect(installer.status()).toMatchObject({
			available: false,
			headed: false,
		});
		expect(installer.headedAvailability()).toEqual({
			ok: false,
			reason: "headless-only-browser",
		});
		expect(() => installer.resolveLaunch({ headed: true })).toThrow(
			/no browser that can show a window is installed/,
		);

		// The full build is what a window is launched from.
		const full = installChromium(browsers, 1248);
		expect(installer.status()).toMatchObject({ available: true, headed: true });
		expect(installer.resolveLaunch({ headed: true })).toMatchObject({
			headless: false,
			executablePath: full,
		});
		// The headless path is unchanged.
		expect(installer.resolveLaunch()).toMatchObject({ headless: true });
	});

	test("a system Chrome is a headed browser even with nothing downloaded", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-install-"));
		const chrome = path.join(dir, "fake-chrome");
		fs.writeFileSync(chrome, "#!/bin/sh\n");
		const installer = new BrowserInstaller({
			configDir: dir,
			chromeCandidates: [chrome],
			display: () => true,
		});
		expect(installer.status()).toMatchObject({
			headed: true,
			source: "system-chrome",
		});
		expect(installer.headedAvailability()).toEqual({ ok: true });
	});

	test("a machine with a browser but no display cannot show a hand-off window", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-install-"));
		const chrome = path.join(dir, "fake-chrome");
		fs.writeFileSync(chrome, "#!/bin/sh\n");
		const installer = new BrowserInstaller({
			configDir: dir,
			chromeCandidates: [chrome],
			display: () => false,
		});
		// The refusal is its own reason, so the message can tell the developer to
		// move the server rather than to install anything.
		expect(installer.status()).toMatchObject({ headed: false });
		expect(installer.headedAvailability()).toEqual({
			ok: false,
			reason: "no-display",
		});
	});

	test("the opt-in install downloads a browser that can show a window", async () => {
		// A `chromium-headless-shell` only install would be a browser the hand-off
		// can never use, so the command must never ask for the shell.
		const command = await installCommand("/usr/local/bin/bun");
		expect(command).toBeDefined();
		expect(command?.slice(-2)).toEqual(["install", "chromium"]);
		expect(command).not.toContain("--only-shell");
		expect(command).not.toContain("chromium-headless-shell");
		expect(await installCommand(null)).toBeUndefined();
	});

	test("a platform without a display cannot show a hand-off window", () => {
		// Only Linux can lack one, and the check happens before any launch.
		expect(displayAvailable("linux", {})).toBe(false);
		expect(displayAvailable("linux", { DISPLAY: ":0" })).toBe(true);
		expect(displayAvailable("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe(
			true,
		);
		expect(displayAvailable("darwin", {})).toBe(true);
	});

	test("the revision Playwright expects wins, and revisions order numerically", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-install-"));
		const browsers = path.join(dir, "browsers");
		const old = installChromium(browsers, 998);
		const newer = installChromium(browsers, 1000);
		// Without a known expected revision, the numeric highest wins: a string
		// sort would have picked 998.
		expect(findInstalledChromium(browsers)).toBe(newer);
		expect(findInstalledChromium(browsers, 998)).toBe(old);
		// A revision this build does not expect is not a fallback: `none`, so the
		// operator installs the expected one.
		expect(findInstalledChromium(browsers, 12345)).toBeUndefined();
	});

	test("an install child gets paths and a home, never the server's secrets", () => {
		const child = installChildEnvironment("/tmp/browsers", "linux", {
			PATH: "/usr/bin",
			HOME: "/home/dev",
			TMPDIR: "/tmp/dev",
			OPENCODE_API_KEY: "secret-provider-key",
			GITHUB_TOKEN: "secret-token",
		});
		expect(child).toEqual({
			PLAYWRIGHT_BROWSERS_PATH: "/tmp/browsers",
			PATH: "/usr/bin",
			HOME: "/home/dev",
			TMPDIR: "/tmp/dev",
		});
		expect(JSON.stringify(child)).not.toContain("secret");
	});

	test("nothing installed is reported as unavailable and the launch refuses", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-install-"));
		const installer = new BrowserInstaller({
			configDir: dir,
			chromeCandidates: [],
		});
		expect(installer.status()).toMatchObject({
			available: false,
			source: "none",
			browsersPath: path.join(dir, "browsers"),
		});
		expect(() => installer.resolveLaunch()).toThrow(/no browser is available/);
	});

	test("the build records the Playwright revision it pins", () => {
		// The artifact cannot read `playwright-core`'s manifest at run time, so these
		// generated values are what the install guard and the install command pin in
		// a packaged executable. A source checkout must agree with them, or the
		// generated file is stale.
		expect(BUNDLED_PLAYWRIGHT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
		expect(BUNDLED_CHROMIUM_REVISION).toBeGreaterThan(0);
		expect(expectedChromiumRevision()).toBe(BUNDLED_CHROMIUM_REVISION);
	});

	test("the platform candidates are absolute paths, not bare names", () => {
		for (const candidate of systemChromeCandidates("linux", {}))
			expect(candidate.startsWith("/")).toBe(true);
		for (const candidate of systemChromeCandidates("darwin", {
			HOME: "/home/x",
		}))
			expect(candidate.startsWith("/")).toBe(true);
	});
});

describe("the Browser settings section", () => {
	const status: BrowserStatusResponse = {
		available: false,
		source: "none",
		headed: false,
		browsersPath: "/home/x/.config/agentic-coding/browsers",
		install: { phase: "idle" },
		settings: {
			maxSessions: 4,
			idleTtlMs: 900_000,
			viewport: { width: 1280, height: 800 },
		},
	};

	type SettingsRow = ReturnType<typeof settingsItems>[number];

	function items(browser: BrowserStatusResponse | undefined) {
		return settingsItems({
			themes: ["catppuccin"],
			activeTheme: "catppuccin",
			clientSettingsPath: "/tmp/tui.json",
			section: "browser",
			agents: {
				scope: "user",
				source: "user",
				files: [],
				conflicts: [],
				profiles: [],
				presets: [],
				routing: [],
			},
			providers: { state: "ready", providers: [] },
			...(browser ? { browser } : {}),
		});
	}

	test("the install row is the only download path and names its cost", () => {
		const rows = items(status);
		const install = rows.find((row) => row.id === "browser.install");
		expect(install?.action).toEqual({ kind: "browser-install" });
		expect(install?.detail).toContain(
			"nothing is downloaded until you activate",
		);
		expect(install?.detail).toContain("browsers");
		expect(install?.value).toBe("not installed");
	});

	test("bounds are shown read-only and state their file-only source", () => {
		const rows = items(status);
		const sessions = rows.find((row) => row.id === "browser.max-sessions");
		expect(sessions?.value).toBe("4");
		expect(sessions?.editable).toBe(false);
		expect(sessions?.detail).toContain("read-only");
		expect(rows.find((row) => row.id === "browser.idle-ttl")?.value).toBe(
			"15 min",
		);
		expect(rows.find((row) => row.id === "browser.viewport")?.value).toBe(
			"1280×800",
		);
	});

	test("a running download offers cancel below an inert install row", () => {
		const rows = items({
			...status,
			install: { phase: "downloading", detail: "Downloading Chrome" },
		});
		// The install row keeps its position *and* its action kind so a held or
		// repeated Enter cannot turn into the cancel it just started: it becomes a
		// no-op row, and cancel is appended below it.
		const install = rows.find((row) => row.id === "browser.install");
		expect(install?.action).toEqual({ kind: "none" });
		// Inert, not read-only: this surface's read-only suffix means "edit the
		// config file", which is not what a temporarily disabled row is.
		expect(install?.editable).toBe(true);
		expect(rows.indexOf(install as SettingsRow)).toBeLessThan(
			rows.findIndex((row) => row.id === "browser.cancel"),
		);
		expect(rows.find((row) => row.id === "browser.cancel")?.action).toEqual({
			kind: "browser-install-cancel",
		});
	});

	test("an unread server is a retry, never a local fallback", () => {
		const rows = items(undefined);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.action).toEqual({ kind: "retry" });
	});

	test("the status the section reads decodes through the wire contract", () => {
		const decoded = decodeContract(
			"core.browser-status",
			browserStatusResponseSchema,
			status,
		);
		expect(decoded).toEqual(status);
		expect(() =>
			decodeContract("core.browser-status", browserStatusResponseSchema, {
				...status,
				install: { phase: "installing" },
			}),
		).toThrow();
	});
});
