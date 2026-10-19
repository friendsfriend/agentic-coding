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
import {
	type LoginHandoffAttention,
	type LoginHandoffAvailability,
	LoginHandoffCoordinator,
} from "./handoff.ts";
import { BrowserInstaller } from "./install.ts";
import { createPlaywrightDriver } from "./playwright-driver.ts";
import { BrowserPool } from "./pool.ts";
import type { BrowserDriver } from "./types.ts";

export interface BrowserRuntime {
	readonly installer: BrowserInstaller;
	readonly pool: BrowserPool;
	readonly settings: () => ResolvedBrowserSettings;
	/** `add-stage-interactive-login`: the one process-wide hand-off coordinator,
	 * because "one active hand-off per server" is a property of the server. */
	readonly handoff: LoginHandoffCoordinator;
}

export interface BrowserRuntimeOptions {
	readonly configDir?: string;
	/** Test seam: the driver the pool is built against. Production uses the
	 * Playwright adapter. */
	readonly driver?: BrowserDriver;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
	/** Test seam: how a launch is resolved. Production asks the installer, which
	 * is what makes this a real browser on a real machine. */
	readonly launch?: (options?: {
		readonly headed?: boolean;
	}) => ReturnType<BrowserInstaller["resolveLaunch"]>;
	/** Test seam: the headed capability. Production asks the installer, which
	 * probes the platform and the installed browsers. */
	readonly availability?: () => LoginHandoffAvailability;
	/** Test seam: the coordinator's timer. Production uses `setTimeout`. */
	readonly schedule?: (run: () => void, ms: number) => () => void;
	/** How a hand-off raises and resolves the owning run's attention record. The
	 * workflow composition supplies it; without it a hand-off still runs and
	 * still ends, but only through success, the deadline, a closed window or an
	 * agent abort — there is no *Done* to read. */
	readonly attention?: LoginHandoffAttention;
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
		launch:
			options.launch ??
			((launchOptions) => installer.resolveLaunch(launchOptions)),
		maxSessions: () => settings().maxSessions,
		idleTtlMs: () => settings().idleTtlMs,
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.log === undefined ? {} : { log: options.log }),
		// A session leaving the pool (run end, the idle sweep, a crash) is the end
		// of the hand-off that held it. The coordinator does not exist yet at this
		// point, so the callback reads it through the binding below.
		onSessionClosed: (session, cause) => {
			void handoff?.sessionClosed(session, cause);
		},
	});
	const handoff = new LoginHandoffCoordinator({
		pool,
		availability:
			options.availability ?? (() => installer.headedAvailability()),
		...(options.attention === undefined
			? {}
			: { attention: options.attention }),
		...(options.schedule === undefined ? {} : { schedule: options.schedule }),
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.log === undefined ? {} : { log: options.log }),
	});
	return { installer, pool, settings, handoff };
}

/** The runtime this process serves. One per config directory, because one
 * server owns one Chromium: two runtimes would be two browsers and two session
 * caps for the same machine. */
const runtimes = new Map<string, BrowserRuntime>();

export function browserRuntime(
	configDir: string,
	attention?: LoginHandoffAttention,
): BrowserRuntime {
	const existing = runtimes.get(configDir);
	if (existing) {
		// A runtime first built without the workflow composition (the settings and
		// operations surfaces do that) still has to read *Done* once one exists, so
		// the adapter is attached to the singleton rather than to its first caller.
		if (attention) existing.handoff.attachAttention(attention);
		return existing;
	}
	const created = createBrowserRuntime({
		configDir,
		...(attention === undefined ? {} : { attention }),
	});
	runtimes.set(configDir, created);
	return created;
}

/** Drop the process-wide runtimes. The server keeps one per config directory for
 * its whole life; this exists so a test of the composition above starts from an
 * empty registry, and it closes nothing — a caller that opened a browser closes
 * it through the pool it was handed. */
export function resetBrowserRuntimes(): void {
	runtimes.clear();
}
