/** @jsxImportSource @opentui/solid */
// `agentic-coding` TUI entry — one process, one renderer. Modes:
//   --home / manager   long-lived launcher: receiver on 4318 + workflow list + observability
//   --repo P --workflow-id W  per-workflow dashboard pane: no receiver (manager owns it), file-based traces
//   --profile test     interactive dummy data
//   --json             dump dashboard JSON and exit (headless/CI)

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import { render } from "@opentui/solid";
import {
	isResearchWorkflowTarget,
	isWikiWorkflowTarget,
} from "../workflow/runtime";
import { copyToClipboard } from "./clipboard";
import { listWorkflows, loadDashboard, testDashboard } from "./dash/data";
import { setupKeymap } from "./dash/keymap-setup";
import { notify } from "./dash/notifications";
import { setGlobalSelectionMouseUpHandler } from "./dash/selectionCopy";
import {
	applyTheme as applyDashTheme,
	loadThemeName as loadDashThemeName,
} from "./dash/theme-settings";
import {
	buildSystemTheme,
	captureTerminalColors,
} from "./dash/ui/terminal-colors";
import { setSystemTheme } from "./dash/ui/theme";
import {
	beginShutdown,
	beginStartup,
	finishStartup,
	isShutdownRequested,
	registerStopSequence,
	requestShutdown,
	setStepActive,
	setStepDone,
	setStepError,
} from "./lifecycle";
import { LifecycleModal } from "./lifecycle/LifecycleModal";
import { App as OtelApp } from "./otel/app/App";
import { discoverProjectRepos, TraceDb } from "./otel/model/db";
import { LogStore } from "./otel/model/logStore";
import { MetricStore } from "./otel/model/metricStore";
import { TopologyStore } from "./otel/model/topologyStore";
import { TraceStore } from "./otel/model/traceStore";
import type { LogData, MetricData, SpanData } from "./otel/model/types";
import {
	routeReceiverRequest,
	startPrometheusScraper,
	startStatsDListener,
} from "./otel/receiver/index";

const usage = `Usage: agentic-coding dash|home|manager [options]
  --repo PATH              Repository root (default: cwd)
  --workflow-id ID         Workflow id (dash mode)
  --home / manager         Workflow list + observability (long-lived)
  --profile test           Interactive dummy data
  --json                   Dump dashboard JSON and exit
  --http-port N            OTLP HTTP JSON port (default 4318 in home/manager mode)
  --grpc-port N            OTLP gRPC port (sidecar)
  --zipkin-port N          Zipkin HTTP port
  --datadog-port N         Datadog HTTP port
  --prom-target HOST:PORT  Prometheus scrape target(s)
  --prom-interval N        Prometheus scrape interval seconds (default: 15)
  --statsd-port N          StatsD UDP port
  --demo-db                Use separate demo database with sample data
  --traces-only            Hide metrics/logs/topology tabs
  --help                   Show this help`;

function arg(name: string) {
	const idx = process.argv.indexOf(name);
	return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function portArg(name: string): number | undefined {
	if (!process.argv.includes(name)) return undefined;
	const port = Number(arg(name));
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error(`${name} requires a port from 1 to 65535`);
		process.exit(1);
	}
	return port;
}

function intervalArg(name: string, fallback: number): number {
	const value = arg(name);
	if (value === undefined) return fallback;
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		console.error(`${name} requires a positive number of seconds`);
		process.exit(1);
	}
	return seconds * 1000;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 34));
const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Everything the stop sequence must reach; partially filled during startup. */
export interface ServerStack {
	servers: Array<{ stop: (closeActiveConnections?: boolean) => void }>;
	grpcSidecar?: {
		kill(): void;
		once(event: string, listener: (...args: unknown[]) => void): unknown;
	};
	stopPrometheus?: () => void;
	stopStatsD?: () => void;
}

/**
 * Stop the server stack and exit: HTTP receivers → gRPC sidecar (bounded wait
 * for exit) → Prometheus scraper → StatsD listener → db close → renderer
 * destroy → one paint tick → exit. Every component is optional, so a quit
 * during startup stops only what already started.
 */
export async function stopServerStack(
	stack: ServerStack,
	db: { close(): void },
	renderer: { destroy(): void },
	exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
	beginShutdown([
		{ id: "receiver", label: "Stopping telemetry receiver" },
		{ id: "sidecar", label: "Stopping gRPC sidecar" },
		{ id: "collectors", label: "Stopping metric collectors" },
		{ id: "db", label: "Closing database" },
	]);
	setStepActive("receiver");
	for (const server of stack.servers) server.stop(true);
	setStepDone("receiver");
	await tick();
	setStepActive("sidecar");
	if (stack.grpcSidecar) {
		const exited = new Promise<void>((resolve) =>
			stack.grpcSidecar?.once("exit", () => resolve()),
		);
		stack.grpcSidecar.kill();
		await Promise.race([exited, sleep(2000)]);
	}
	setStepDone("sidecar");
	await tick();
	setStepActive("collectors");
	stack.stopPrometheus?.();
	stack.stopStatsD?.();
	setStepDone("collectors");
	await tick();
	setStepActive("db");
	db.close();
	setStepDone("db");
	await tick();
	renderer.destroy();
	await tick();
	exit(0);
}

export async function main(): Promise<void> {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		console.log(usage);
		process.exit(0);
	}

	const profile = arg("--profile");
	const home =
		process.argv.includes("--home") || process.argv.includes("manager");
	const isTest = profile === "test";
	const repoArg = arg("--repo");
	const workflowId = arg("--workflow-id");
	if (!home && !isTest && (!repoArg || !workflowId)) {
		console.error(
			"usage: agentic-coding home|manager\n       agentic-coding dash --repo PATH --workflow-id ID [--json]\n       agentic-coding dash --profile test [--json]",
		);
		process.exit(2);
	}
	const repo =
		repoArg &&
		(isResearchWorkflowTarget(repoArg) || isWikiWorkflowTarget(repoArg))
			? repoArg
			: repoArg
				? resolve(repoArg)
				: "/demo";
	const resolvedWorkflowId = workflowId ?? "demo-optional-realisation-date";
	if (process.argv.includes("--json")) {
		console.log(
			JSON.stringify(
				home
					? listWorkflows()
					: isTest
						? testDashboard()
						: loadDashboard(repo, resolvedWorkflowId),
				null,
				2,
			),
		);
		process.exit(0);
	}

	// ---- Observability stores + DB (the shell owns them for the process lifetime) ----
	const useDemoDb = process.argv.includes("--demo-db");
	const explicitHttp = process.argv.includes("--http-port");
	const httpPort = explicitHttp
		? portArg("--http-port")
		: home && !useDemoDb
			? 4318
			: undefined;
	const grpcPort = portArg("--grpc-port");
	const zipkinPort = portArg("--zipkin-port");
	const datadogPort = portArg("--datadog-port");
	const promTargets = (arg("--prom-target") ?? "")
		.split(",")
		.filter(Boolean)
		.map((target) => {
			const [host, rawPort] = target.split(":");
			const port = rawPort === undefined ? 9090 : Number(rawPort);
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				console.error(`--prom-target has invalid port: ${target}`);
				process.exit(1);
			}
			return { host: host || "127.0.0.1", port };
		});
	const promInterval = intervalArg("--prom-interval", 15_000);
	const statsdPort = portArg("--statsd-port");
	const tracesOnly = process.argv.includes("--traces-only");

	const traceStore = new TraceStore();
	const metricStore = new MetricStore();
	const logStore = new LogStore();
	const topologyStore = new TopologyStore();

	const signalRouter = {
		pushTraces: (spans: SpanData[]) => traceStore.pushBatch(spans),
		pushMetrics: (metrics: MetricData[]) => metricStore.pushBatch(metrics),
		pushLogs: (logs: LogData[]) => logStore.pushBatch(logs),
	};

	const repos = Array.from(new Set([repo, ...discoverProjectRepos()]));
	// Demo DB is async; non-demo construction is cheap. The scan/load itself
	// happens in startServerStack (render-first so the startup modal shows).
	let db: TraceDb;
	let demoSpans: SpanData[] = [];
	if (useDemoDb) {
		const {
			db: demoDb,
			spans,
			metrics,
			logs,
		} = await import("./otel/model/demoDb").then((m) => m.createDemoDb());
		db = demoDb;
		demoSpans = spans;
		traceStore.loadFile(spans);
		metricStore.load(metrics);
		logStore.load(logs);
	} else {
		db = new TraceDb();
	}

	if (!home) {
		// Dash/test mode has no startup modal: keep the old synchronous bootstrap
		// so the observability views snapshot real data at first render (and the
		// deferred path never touches db after a signal-triggered close).
		if (!useDemoDb) {
			for (const r of repos) db.scanAllWorkspaces(r);
			db.cleanupOlderThan();
			traceStore.loadFile(db.loadSpans());
		}
		topologyStore.load(
			useDemoDb ? demoSpans : traceStore.spanCount_ > 0 ? db.loadSpans() : [],
		);
	}

	/** Partial stack the stop sequence reaches; filled by startServerStack. */
	const stack: ServerStack = { servers: [] };

	// ---- Render app first; the startup modal covers the bootstrap below ----
	// Capture the terminal's configured palette (OSC queries) so a persisted
	// `system` theme selection resolves here, before the OpenTUI renderer takes
	// over stdin. Capture is a no-op on non-TTY/headless runs; when it fails,
	// no `system` entry is registered and the saved name falls back to default.
	const systemTheme = await captureTerminalColors();
	if (systemTheme.ok) setSystemTheme(buildSystemTheme(systemTheme.palette));
	applyDashTheme(loadDashThemeName());
	process.env.FORCE_COLOR = "3";
	const renderer = await createCliRenderer({
		targetFps: 30,
		exitOnCtrlC: false,
		useKittyKeyboard: {},
		exitSignals: [],
	});
	globalThis.__renderer = renderer;

	// Always catch async exceptions: an uncaught throw inside the input/render
	// loops would otherwise kill key and mouse handling entirely. Log to stderr;
	// AGENTIC_CODING_TRACE additionally captures them to a file.
	const traceFile = process.env.AGENTIC_CODING_TRACE;
	const append = (msg: string) => {
		if (traceFile) {
			try {
				require("node:fs").appendFileSync(traceFile, `${Date.now()} ${msg}\n`);
			} catch {
				/* noop */
			}
		} else {
			console.error(`[agentic-coding] ${msg}`);
		}
	};
	process.on("uncaughtException", (error) =>
		append(`UNCAUGHT: ${error?.stack ?? String(error)}`),
	);
	process.on("unhandledRejection", (reason) =>
		append(`UNHANDLED_REJECTION: ${String(reason)}`),
	);
	// Registered before the keymap: empirically, an extra early keypress listener
	// changes input dispatch on some terminals (Ghostty+herdr). Kept while the
	// interaction is investigated; harmless either way.
	renderer.keyInput.on("keypress", () => {
		/* noop */
	});
	if (traceFile) {
		append("startup: renderer created");
		const heartbeat = setInterval(() => append("alive"), 2000);
		const cleanupTrace = () => {
			clearInterval(heartbeat);
		};
		process.on("exit", cleanupTrace);
	}

	const cleanup = () => {
		stack.grpcSidecar?.kill();
		stack.stopPrometheus?.();
		stack.stopStatsD?.();
		db.close();
		renderer.destroy();
	};
	if (home) {
		registerStopSequence(() => stopServerStack(stack, db, renderer));
		globalThis.__requestShutdown = requestShutdown;
		process.on("SIGINT", requestShutdown);
		process.on("SIGTERM", requestShutdown);
		process.on("SIGHUP", requestShutdown);
	} else {
		// Dash/test mode: no receiver stack, keep the direct cleanup path.
		process.on("SIGINT", cleanup);
		process.on("SIGTERM", cleanup);
		process.on("SIGHUP", cleanup);
	}

	const clearSelectionCopy = setGlobalSelectionMouseUpHandler(() => {
		const text = renderer.getSelection()?.getSelectedText();
		if (text) {
			if (copyToClipboard(text)) notify("Copied", "success");
			else notify("Copy failed", "error");
			renderer.clearSelection();
		}
	});
	const keymap = createDefaultOpenTuiKeymap(renderer);
	const disposeKeymap = setupKeymap(keymap);
	keymap.setData("app.view", home ? "home" : "detail");
	keymap.setData("modal.active", "none");

	if (home) {
		beginStartup([
			{ id: "history", label: "Loading workspace history" },
			{ id: "receiver", label: "Starting telemetry receiver" },
			{ id: "sidecar", label: "Starting gRPC sidecar" },
			{ id: "collectors", label: "Starting metric collectors" },
		]);
	}

	await render(
		() => (
			<KeymapProvider keymap={keymap}>
				<OtelApp
					repos={repos}
					db={db}
					traceStore={traceStore}
					metricStore={metricStore}
					logStore={logStore}
					topologyStore={topologyStore}
					tracesOnly={tracesOnly}
					dashboard={{
						mode: home ? "home" : "dash",
						repo: home ? undefined : repo,
						change: home ? undefined : resolvedWorkflowId,
						profile: isTest ? "test" : undefined,
						keymap,
					}}
				/>
				<LifecycleModal />
			</KeymapProvider>
		),
		renderer,
	);

	// ---- Server-stack bootstrap (after first paint; modal shows progress) ----
	void startServerStack(home);
	await new Promise<void>((done) => renderer.once("destroy", done));
	clearSelectionCopy();
	disposeKeymap();

	// ---- Server-stack start sequence ----
	async function startServerStack(homeMode: boolean): Promise<void> {
		let activeStep = "history";
		const mark = (id: string) => {
			activeStep = id;
			setStepActive(id);
		};
		try {
			mark("history");
			if (homeMode && !useDemoDb) {
				// Home mode loads history deferred (behind the startup modal); dash/test
				// already loaded it synchronously pre-render.
				for (const r of repos) db.scanAllWorkspaces(r);
				db.cleanupOlderThan();
				traceStore.loadFile(db.loadSpans());
			}
			setStepDone("history");
			await tick();
			if (isShutdownRequested()) return;

			mark("receiver");
			if (httpPort || zipkinPort || datadogPort) {
				const hostname = "127.0.0.1";
				const ports: number[] = [];
				if (httpPort) ports.push(httpPort);
				if (zipkinPort && zipkinPort !== httpPort) ports.push(zipkinPort);
				if (
					datadogPort &&
					datadogPort !== httpPort &&
					datadogPort !== zipkinPort
				)
					ports.push(datadogPort);

				for (const port of ports) {
					stack.servers.push(
						Bun.serve({
							hostname,
							port,
							fetch: (request) =>
								routeReceiverRequest(request, signalRouter) ??
								new Response("not found", { status: 404 }),
						}),
					);
				}
			}
			setStepDone("receiver");
			await tick();
			if (isShutdownRequested()) return;

			mark("sidecar");
			if (grpcPort && httpPort) {
				// Compiled binaries embed no source files; the sidecar is a second executable
				// built next to this one. Source runs spawn the script via bun.
				const compiled =
					import.meta.url.includes("/$bunfs/") ||
					import.meta.url.includes("B:/~BUN/");
				const sidecarScript = compiled
					? join(dirname(process.execPath), "agentic-coding-grpc-sidecar")
					: new URL("./otel/receiver/otlp-grpc-sidecar.ts", import.meta.url)
							.pathname;
				const sidecar = spawn(
					compiled ? sidecarScript : "bun",
					[
						sidecarScript,
						"--port",
						String(grpcPort),
						"--forward",
						`http://127.0.0.1:${httpPort}`,
					],
					{
						stdio: ["ignore", "inherit", "inherit"],
					},
				);
				sidecar.on("error", (error) =>
					console.warn(`gRPC sidecar unavailable: ${error.message}`),
				);
				stack.grpcSidecar = sidecar;
			} else if (grpcPort) {
				console.warn("gRPC sidecar requires --http-port");
			}
			setStepDone("sidecar");
			await tick();
			if (isShutdownRequested()) return;

			mark("collectors");
			if (promTargets.length) {
				stack.stopPrometheus = startPrometheusScraper(
					promTargets,
					promInterval,
					signalRouter,
				);
			}
			if (statsdPort) {
				const statsd = startStatsDListener(
					statsdPort,
					`statsd-${statsdPort}`,
					signalRouter,
				);
				stack.stopStatsD = statsd.stop;
			}
			setStepDone("collectors");
			await tick();
			if (isShutdownRequested()) return;

			// Build topology from loaded spans (dash/test: already loaded pre-render)
			if (homeMode) {
				topologyStore.load(
					useDemoDb
						? demoSpans
						: traceStore.spanCount_ > 0
							? db.loadSpans()
							: [],
				);
				finishStartup();
			}
		} catch (error) {
			// Stop whatever already started so a failed bootstrap leaks no port or sidecar.
			for (const server of stack.servers) server.stop(true);
			stack.grpcSidecar?.kill();
			stack.stopPrometheus?.();
			stack.stopStatsD?.();
			if (homeMode) {
				setStepError(activeStep, String(error));
				// Hold so the user sees the failure behind the modal, then exit.
				await sleep(1000);
			} else {
				console.error(`Cannot start server stack: ${String(error)}`);
			}
			process.exit(1);
		}
	}
}

if (import.meta.main) {
	await main();
}
