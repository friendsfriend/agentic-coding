// The server's browser runtime (`add-agent-browser-sessions`).
//
// One process-wide composition of the two pieces the browser surface needs —
// the installer (opt-in acquisition) and the pool (one Chromium, contexts per
// session) — plus the settings resolver the pool and the routes read per call,
// so a `browser.*` edit applies to the next open rather than the next restart.
import { resolveConfigRoot } from "../../config-root.ts";
import {
	type ResolvedBrowserSettings,
	resolvedBrowserSettings,
} from "../../workflow/effects.ts";
import { BrowserInstaller } from "./install.ts";
import { createPlaywrightDriver } from "./playwright-driver.ts";
import { BrowserPool } from "./pool.ts";
import type { BrowserDriver } from "./types.ts";

export interface BrowserRuntime {
	readonly installer: BrowserInstaller;
	readonly pool: BrowserPool;
	readonly settings: () => ResolvedBrowserSettings;
}

export interface BrowserRuntimeOptions {
	readonly configDir?: string;
	/** Test seam: the driver the pool is built against. Production uses the
	 * Playwright adapter. */
	readonly driver?: BrowserDriver;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

export function createBrowserRuntime(
	options: BrowserRuntimeOptions = {},
): BrowserRuntime {
	const configDir = options.configDir ?? resolveConfigRoot();
	const settings = () => resolvedBrowserSettings();
	const installer = new BrowserInstaller({
		configDir,
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.log === undefined ? {} : { log: options.log }),
	});
	const pool = new BrowserPool({
		driver: options.driver ?? createPlaywrightDriver(),
		launch: () => installer.resolveLaunch(),
		maxSessions: () => settings().maxSessions,
		idleTtlMs: () => settings().idleTtlMs,
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.log === undefined ? {} : { log: options.log }),
	});
	return { installer, pool, settings };
}

/** The runtime this process serves. One per config directory, because one
 * server owns one Chromium: two runtimes would be two browsers and two session
 * caps for the same machine. */
const runtimes = new Map<string, BrowserRuntime>();

export function browserRuntime(configDir: string): BrowserRuntime {
	const existing = runtimes.get(configDir);
	if (existing) return existing;
	const created = createBrowserRuntime({ configDir });
	runtimes.set(configDir, created);
	return created;
}
