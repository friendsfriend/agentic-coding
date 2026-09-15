/** @jsxImportSource @opentui/solid */
// `agentic-coding` TUI entry — one process, one renderer, one lifecycle owner.
// Modes:
//   (default) / --home / manager  unified shell: owned environment backend +
//                                 workflow list + observability
//   --repo P --workflow-id W      per-workflow dashboard pane: no receiver and
//                                 no owned backend, best-effort OTLP traces
//   --attach-url URL              attached shell: environment features of a
//                                 server this process does not own
//   --profile test                interactive dummy data
//   --json                        dump dashboard JSON and exit (headless/CI)
//
// Every acquired part of the mixed-runtime stack (Go backend, workflow
// application, telemetry receivers/collectors, renderer) is registered as an
// owned handle in ./lifecycle and released in reverse acquisition order, so a
// partial startup or a second quit can only stop what this process acquired.

import { resolve } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import { render } from "@opentui/solid";
import { resolveConfigDir, resolveDevenvHome } from "../backend/home";
import { ownsEnvironmentBackend } from "../backend/ownership";
import { createInstanceAuthority } from "../server/auth";
import { backendClient, configureBackendClient } from "../server/client";
import { createEnvironmentAuthority } from "../server/environment/authority";
import { createIntegrationServices } from "../server/integrations/services";
import {
	type OwnedWorkflowServer,
	startWorkflowServer,
} from "../server/lifecycle";
import { APP_VERSION } from "../version";
import {
	activeWorkflowExecutions,
	cancelActiveWorkflowExecutions,
	disposeAllExecutionCoordinators,
	disposeDashboardApplication,
	setCredentialPromptProvider,
} from "../workflow/execution-coordinator";
import { BACKEND_STARTING_ENV } from "../workflow/project-catalog";
import {
	isResearchWorkflowTarget,
	isWikiWorkflowTarget,
} from "../workflow/runtime";
import { AppShell } from "./app/AppShell";
import { copyToClipboard } from "./clipboard";
import { testDashboard } from "./dash/demo";
import { setupKeymap } from "./dash/keymap-setup";
import { notify } from "./dash/notifications";
import { listWorkflowsAsync, loadDashboardAsync } from "./dash/observations";
import { setGlobalSelectionMouseUpHandler } from "./dash/selectionCopy";
import {
	applyTheme as applyDashTheme,
	loadCustomThemes,
	loadThemeName as loadDashThemeName,
} from "./dash/theme-settings";
import { traceTui } from "./dash/tracing";
import { credentialPromptBridge } from "./dash/ui/CredentialsModal";
import { applyCapturedSystemTheme } from "./dash/ui/terminal-colors";
import {
	acquiredResources,
	acquireResource,
	beginShutdown,
	beginStartup,
	finishStartup,
	isShutdownRequested,
	registerActiveWork,
	registerStopSequence,
	releaseResources,
	requestShutdown,
	setStepActive,
	setStepDone,
	setStepError,
} from "./lifecycle";
import { LifecycleModal } from "./lifecycle/LifecycleModal";
import { QuitConfirmModal } from "./lifecycle/QuitConfirmModal";
import { discoverProjectRepos, TraceDb } from "./otel/model/db";
import { LogStore } from "./otel/model/logStore";
import { MetricStore } from "./otel/model/metricStore";
import { RemoteTelemetryDb } from "./otel/model/remote-db";
import type { TelemetryDb } from "./otel/model/telemetry-db";
import { TopologyStore } from "./otel/model/topologyStore";
import { TraceStore } from "./otel/model/traceStore";
import type { LogData, MetricData, SpanData } from "./otel/model/types";

const usage = `Usage: agentic-coding [command] [options]
  (no command)             Unified shell (default): owned environment backend + workflows + observability
  workflow                 Transactional workflow engine. Run \`agentic-coding workflow --help\`.
  home | manager           Alias of the unified shell home route
  dash                     Per-workflow dashboard pane (--repo PATH --workflow-id ID)
  server                   Start only the environment backend (headless)
  attach URL               Attach the shell to a running environment backend
  devenv ...               Thin alias of this executable (devenv spawn/attach/server)

Options:
  --repo PATH              Repository root (default: cwd)
  --workflow-id ID         Workflow id (dash mode)
  --profile test           Interactive dummy data
  --json                   Dump dashboard JSON and exit
  --http-port N            OTLP HTTP JSON port (default 4318 in managed/home mode)
  --grpc-port N            OTLP gRPC port
  --zipkin-port N          Zipkin HTTP port
  --datadog-port N         Datadog HTTP port
  --prom-target HOST:PORT  Prometheus scrape target(s)
  --prom-interval N        Prometheus scrape interval seconds (default: 15)
  --statsd-port N          StatsD UDP port
  --demo-db                Use separate demo database with sample data
  --traces-only            Hide metrics/logs/topology tabs
  --devenv-url URL         Attach to an already running environment backend (no ownership)
  --devenv-port N          Environment backend port (default 4050)
  --attach-url URL         Attached shell mode
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

/** Shutdown progress labels keyed by the resource step that owns the row. */
const SHUTDOWN_STEP_LABELS: Record<string, string> = {
	"workflow-server": "Stopping unified server",
	"workflow-application": "Cancelling workflow actions",
	telemetry: "Stopping telemetry receiver",
	db: "Closing database",
	renderer: "Restoring terminal",
};

/**
 * Terminal-facing shutdown (quit key or signal): release every owned handle
 * through the resource registry in reverse acquisition order, then destroy the
 * renderer exactly once and exit. Only resources this process acquired get a
 * progress row, so an attach or dashboard shell never claims to stop a stack it
 * does not own. Runs after active workflow work was cancelled, so nothing here
 * fabricates a workflow completion.
 */
export async function stopOwnedStack(
	exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
	const ordered: string[] = [];
	for (const resource of [...acquiredResources()].reverse()) {
		if (!ordered.includes(resource.step)) ordered.push(resource.step);
	}
	beginShutdown(
		ordered.map((id) => ({
			id,
			label: SHUTDOWN_STEP_LABELS[id] ?? id,
		})),
	);
	await releaseResources();
	await tick();
	exit(0);
}

export interface ShellMode {
	home: boolean;
	isTest: boolean;
	/** Attached shell: the environment backend is someone else's process. */
	attachUrl?: string;
	repo: string;
	workflowId: string;
}

export async function main(): Promise<void> {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		console.log(usage);
		process.exit(0);
	}

	const profile = arg("--profile");
	const attachUrl = arg("--attach-url");
	// Full-feature attach: a capability for the remote unified server. Without
	// one, attach stays environment-only (the predecessor milestone).
	const attachToken =
		arg("--attach-token") ?? process.env.AGENTIC_WORKFLOW_TOKEN;
	const remoteAttach = Boolean(attachUrl && attachToken);
	const home =
		process.argv.includes("--home") || process.argv.includes("manager");
	const isTest = profile === "test";
	const repoArg = arg("--repo");
	const workflowId = arg("--workflow-id");
	if (!home && !isTest && !attachUrl && (!repoArg || !workflowId)) {
		console.error(
			"usage: agentic-coding\n       agentic-coding home|manager\n       agentic-coding dash --repo PATH --workflow-id ID [--json]\n       agentic-coding attach URL\n       agentic-coding dash --profile test [--json]",
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

	// Resolve the backend address before any observation subprocess can start
	// (including `--json`). Explicit `--devenv-url`/`--attach-url` win and the
	// value is exported for child processes, so the shell's own catalog read and
	// the child reads can never target different backends. Only the managed
	// (default/home) route owns a backend; an explicit URL means "attach".
	const explicitUrl =
		attachUrl ??
		arg("--devenv-url") ??
		process.env.AGENTIC_DEVENV_URL ??
		process.env.DEVENV_URL;
	const devenvPort = portArg("--devenv-port") ?? 4050;
	const ownsBackend = ownsEnvironmentBackend({
		attachUrl,
		explicitUrl,
		home,
		isTest,
		json: process.argv.includes("--json"),
	});
	// The owned route binds one server at the environment address every client
	// already defaults to, and derives its capability before the first paint so
	// no request is made with a capability that does not exist yet.
	const ownedAuthority = ownsBackend ? createInstanceAuthority() : undefined;
	// The environment surface is offered when this route owns it (home binds the
	// one server at the environment address) or when the operator named one
	// explicitly. Dash owns no environment authority, so it must not point the
	// feature (or its catalog poll) at whatever happens to listen on the default
	// port — that could be a different install.
	const environmentSurfaceUrl =
		explicitUrl ?? (ownsBackend ? `http://127.0.0.1:${devenvPort}` : undefined);
	const environments =
		remoteAttach || !environmentSurfaceUrl
			? undefined
			: { serverUrl: environmentSurfaceUrl };
	// One server serves every surface, so an attached shell's environment address
	// is the attached server itself, not this machine's default port. An empty
	// value tells catalog consumers (and the child processes that inherit it)
	// that this route owns no environment surface: the read is a bounded
	// read-only invocation rather than a guess at another install's port.
	process.env.AGENTIC_DEVENV_URL = environmentSurfaceUrl ?? "";
	if (ownedAuthority) {
		process.env.AGENTIC_WORKFLOW_TOKEN = ownedAuthority.token;
		process.env.AGENTIC_DEVENV_TOKEN = ownedAuthority.token;
	} else if (remoteAttach && attachToken) {
		// The attached server's capability also authorizes the environment
		// surface it serves.
		process.env.AGENTIC_DEVENV_TOKEN = attachToken;
	}
	// Full-feature attach talks to the remote unified server through the typed
	// client.
	if (remoteAttach && attachUrl && attachToken)
		configureBackendClient({
			baseUrl: attachUrl,
			token: attachToken,
			ownerId: `attach-${process.pid}`,
		});
	// Tell catalog consumers (including the detached observation children) that
	// this process is bringing the backend up, so a read in that window waits for
	// readiness instead of spawning a second backend for one read.
	if (ownsBackend) process.env[BACKEND_STARTING_ENV] = "1";
	if (process.argv.includes("--json")) {
		// Headless read path (task 3.4): read through the typed backend client by
		// starting a short-lived in-process server, so `--json` exercises the same
		// authenticated API as the interactive shell. Test mode stays in-process.
		const jsonServer = isTest ? undefined : await startWorkflowServer({});
		if (jsonServer)
			configureBackendClient({
				baseUrl: jsonServer.url,
				token: jsonServer.token,
				ownerId: `json-${process.pid}`,
			});
		try {
			console.log(
				JSON.stringify(
					home
						? await listWorkflowsAsync()
						: isTest
							? testDashboard()
							: await loadDashboardAsync(repo, resolvedWorkflowId),
					null,
					2,
				),
			);
		} finally {
			await jsonServer?.stop();
		}
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

	const explicitRepos = Array.from(new Set([repo]));
	// Demo DB is async; non-demo construction is cheap. The scan/load itself
	// happens in startServerStack (render-first so the startup modal shows).
	let db: TelemetryDb;
	let loadedSpans: SpanData[] = [];
	if (useDemoDb) {
		const {
			db: demoDb,
			spans,
			metrics,
			logs,
		} = await import("./otel/model/demoDb").then((m) => m.createDemoDb());
		db = demoDb;
		loadedSpans = spans;
		traceStore.loadFile(spans);
		metricStore.load(metrics);
		logStore.load(logs);
	} else if (isTest) {
		// Interactive demo keeps the local database (no server in test mode).
		db = new TraceDb();
	} else {
		// Server-backed: the proxy is empty until the server snapshot loads below.
		db = new RemoteTelemetryDb();
	}

	/** The most recent phase of the bootstrap that must be unwound on failure. */
	let activeStep = "workflow-application";

	// The unified backend boundary: the TUI starts (and owns) the one Bun server
	// and reaches observations/mutations through the typed client instead of
	// in-process or subprocess backend access. On the managed route the same
	// listener also owns the environment state/catalog authority and the legacy
	// devenv surface.
	let workflowServer: OwnedWorkflowServer | undefined;
	let integrations: ReturnType<typeof createIntegrationServices> | undefined;
	let environmentAuthority:
		| ReturnType<typeof createEnvironmentAuthority>
		| undefined;

	// ---- Render app first; the startup modal covers the bootstrap below ----
	process.env.FORCE_COLOR = "3";
	const renderer = await createCliRenderer({
		targetFps: 30,
		exitOnCtrlC: false,
		useKittyKeyboard: {},
		exitSignals: [],
	});
	globalThis.__renderer = renderer;
	// Acquisition order = release order reversed: renderer, db, backend,
	// telemetry. The renderer is therefore destroyed last and the database
	// closes after the backend that owns the store is gone.
	acquireResource({
		kind: "renderer",
		label: "renderer",
		step: "renderer",
		stop: () => {
			renderer.destroy();
		},
	});
	acquireResource({
		kind: "telemetry",
		label: "trace database",
		step: "db",
		stop: () => {
			db.close();
		},
	});
	// Owned workflow application: cancelled and disposed before the backend it
	// talks to goes away, so no drain is left publishing into a dead socket.
	acquireResource({
		kind: "workflow-application",
		label: "workflow application",
		step: "workflow-application",
		stop: () => {
			cancelActiveWorkflowExecutions();
			disposeAllExecutionCoordinators();
			disposeDashboardApplication();
		},
	});
	loadCustomThemes();
	await applyCapturedSystemTheme(renderer);
	applyDashTheme(loadDashThemeName());

	// Always catch async exceptions: an uncaught throw inside the input/render
	// loops would otherwise kill key and mouse handling entirely. Report to
	// stderr and route a bounded span to the same OTLP sink the rest of the TUI
	// uses; there is no separate debug file.
	process.on("uncaughtException", (error) => {
		console.error(
			`[agentic-coding] UNCAUGHT: ${error?.stack ?? String(error)}`,
		);
		traceTui(
			"tui.process.uncaught_exception",
			{ surface: "process", action: "uncaught-exception" },
			"error",
		);
	});
	process.on("unhandledRejection", (reason) => {
		console.error(`[agentic-coding] UNHANDLED_REJECTION: ${String(reason)}`);
		traceTui(
			"tui.process.unhandled_rejection",
			{ surface: "process", action: "unhandled-rejection" },
			"error",
		);
	});
	// Registered before the keymap: empirically, an extra early keypress listener
	// changes input dispatch on some terminals (Ghostty+herdr). Kept while the
	// interaction is investigated; harmless either way.
	renderer.keyInput.on("keypress", () => {
		/* noop */
	});
	traceTui("tui.process.startup", {
		surface: "process",
		action: "renderer-created",
	});

	// Owning modes run the one shutdown flow for keys and every signal. Dash
	// (no owned stack) only releases its renderer/client resources.
	registerStopSequence(() => stopOwnedStack());
	globalThis.__requestShutdown = () => requestShutdown();
	registerActiveWork({
		describe: () => {
			const active = activeWorkflowExecutions();
			if (active.length === 0) return undefined;
			return active.length === 1
				? `A workflow action is still running in ${active[0]}.`
				: `${active.length} workflow actions are still running.`;
		},
		cancel: () => cancelActiveWorkflowExecutions(),
	});
	/** Signals are noninteractive: cancel owned work and clean up without
	 * waiting for a dialog that nobody may be able to answer. */
	const signalShutdown = () => requestShutdown({ signal: true });
	process.on("SIGINT", signalShutdown);
	process.on("SIGTERM", signalShutdown);
	process.on("SIGHUP", signalShutdown);

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
	// Root-owned credential presenter: the execution coordinator no longer
	// imports a TUI modal, so the process shell installs the bridge once and
	// keeps it live while any feature (not just the dashboard tab) is shown.
	const disposeCredentialPrompt = setCredentialPromptProvider(
		credentialPromptBridge,
	);
	keymap.setData("app.view", home ? "home" : "detail");
	keymap.setData("modal.active", "none");

	if (home) {
		// Only components this route will actually own get a progress row.
		const startupSteps = [
			...(isTest
				? []
				: [{ id: "workflow-server", label: "Starting unified server" }]),
			{ id: "workflow-application", label: "Loading workspace history" },
			...(httpPort ||
			zipkinPort ||
			datadogPort ||
			grpcPort ||
			promTargets.length > 0 ||
			statsdPort
				? [{ id: "telemetry", label: "Starting telemetry receiver" }]
				: []),
		];
		beginStartup(startupSteps);
	}

	await render(
		() => (
			<KeymapProvider keymap={keymap}>
				<AppShell
					repos={explicitRepos}
					db={db}
					traceStore={traceStore}
					metricStore={metricStore}
					logStore={logStore}
					topologyStore={topologyStore}
					tracesOnly={tracesOnly}
					environments={environments}
					attached={attachUrl !== undefined}
					attachLabel={
						remoteAttach
							? `attached ${attachUrl ?? ""} · workflow + observability · environment features unavailable`
							: attachUrl
								? `attached ${attachUrl} · environment features only · remote workflow features unavailable`
								: undefined
					}
					dashboard={
						attachUrl && !remoteAttach
							? undefined
							: {
									mode: home ? "home" : "dash",
									repo: home ? undefined : repo,
									change: home ? undefined : resolvedWorkflowId,
									profile: isTest ? "test" : undefined,
									keymap,
								}
					}
				/>
				<LifecycleModal />
				<QuitConfirmModal />
			</KeymapProvider>
		),
		renderer,
	);

	// ---- Server-stack bootstrap (after first paint; modal shows progress) ----
	void startServerStack(home);
	await new Promise<void>((done) => renderer.once("destroy", done));
	clearSelectionCopy();
	disposeCredentialPrompt();
	disposeKeymap();

	// ---- Server-stack start sequence ----
	async function startServerStack(homeMode: boolean): Promise<void> {
		await tick();
		const mark = (id: string) => {
			activeStep = id;
			setStepActive(id);
		};
		try {
			// 1. The one server. This process owns the workflow/observation API and,
			// on the managed route, the environment state/catalog authority plus the
			// whole legacy devenv surface — one listener at the environment address,
			// so no client needs a second base URL and no companion runtime exists.
			// Test mode keeps the deterministic in-process demo path with no server.
			if (!isTest && !remoteAttach) {
				mark("workflow-server");
				if (ownsBackend) {
					environmentAuthority = createEnvironmentAuthority({
						homeDir: resolveDevenvHome(),
						configDir: resolveConfigDir(),
						logger: (message) =>
							traceTui("tui.process.startup", {
								surface: "process",
								action: "environment-authority",
								instance: message,
							}),
					});
					// Git/provider families and the action/runtime engine are served from
					// the same configuration authority this server owns.
					integrations = createIntegrationServices({
						manager: environmentAuthority.manager,
						state: environmentAuthority.state,
						configDir: resolveConfigDir(),
						homeDir: resolveDevenvHome(),
						logger: (message) =>
							traceTui("tui.process.startup", {
								surface: "process",
								action: "integration-services",
								instance: message,
							}),
					});
				}
				workflowServer = await startWorkflowServer({
					version: APP_VERSION,
					// The owned route binds the environment address every client already
					// defaults to; the other routes take an ephemeral port.
					...(ownedAuthority
						? {
								port: devenvPort,
								instance: ownedAuthority.instance,
								token: ownedAuthority.token,
							}
						: {}),
					homeDir: resolveDevenvHome(),
					configDir: resolveConfigDir(),
					...(environmentAuthority
						? { environment: environmentAuthority }
						: {}),
					...(integrations ? { integrations } : {}),
					// The server owns telemetry persistence/retention; the TUI reads a
					// snapshot through the typed client instead of opening SQLite.
					ownTelemetry: !useDemoDb,
					// The server also owns the telemetry receiver listeners; they route
					// decoded signals into this shell's live view stores.
					...(httpPort ||
					zipkinPort ||
					datadogPort ||
					grpcPort ||
					promTargets.length ||
					statsdPort
						? {
								receivers: {
									httpPort: httpPort ?? undefined,
									zipkinPort: zipkinPort ?? undefined,
									datadogPort: datadogPort ?? undefined,
									grpcPort: grpcPort ?? undefined,
									promTargets,
									promIntervalMs: promInterval,
									statsdPort: statsdPort ?? undefined,
								},
								signalSink: signalRouter,
							}
						: {}),
				});
				const configured = configureBackendClient({
					baseUrl: workflowServer.url,
					token: workflowServer.token,
					ownerId: `tui-${process.pid}`,
				});
				if (db instanceof RemoteTelemetryDb) db.setClient(configured);
				// Hand the authenticated server to managed child processes (agents), so
				// the headless CLI reads/writes through the typed boundary.
				process.env.AGENTIC_WORKFLOW_URL = workflowServer.url;
				process.env.AGENTIC_WORKFLOW_TOKEN = workflowServer.token;
				// The environment client's capability for this process's own server. On
				// the owned route the server and the environment surface are the same
				// process, so both point at one address. An attached environment server
				// keeps the operator-supplied capability.
				if (ownsBackend)
					process.env.AGENTIC_DEVENV_TOKEN = workflowServer.token;
				acquireResource({
					kind: "workflow-server",
					label: `unified server :${workflowServer.port}`,
					step: "workflow-server",
					stop: async () => {
						delete process.env.AGENTIC_WORKFLOW_URL;
						delete process.env.AGENTIC_WORKFLOW_TOKEN;
						await workflowServer?.stop();
					},
				});
				delete process.env[BACKEND_STARTING_ENV];
				setStepDone("workflow-server");
				await tick();
				if (isShutdownRequested()) return;
			} else if (remoteAttach) {
				// Full-feature attach: the client is already configured against the
				// remote unified server; wire the remote telemetry proxy to it.
				const remote = backendClient();
				if (remote && db instanceof RemoteTelemetryDb) db.setClient(remote);
				setStepDone("workflow-server");
				await tick();
				if (isShutdownRequested()) return;
			}

			// 2. Workflow history / catalog. Catalog discovery runs after first
			// paint: an unreachable backend must not block the renderer.
			mark("workflow-application");
			if (!useDemoDb) {
				let catalogRoots: string[] = [];
				if (!isTest && !remoteAttach) {
					try {
						catalogRoots = await discoverProjectRepos(environmentSurfaceUrl);
					} catch (error) {
						notify(
							`Project catalog unavailable: ${
								error instanceof Error ? error.message : String(error)
							}`,
							"error",
						);
					}
				}
				const scanRoots = Array.from(
					new Set([...explicitRepos, ...catalogRoots]),
				);
				if (remoteAttach && db instanceof RemoteTelemetryDb) {
					// Remote history lives on the server; pull the snapshot instead of
					// scanning a local path.
					await db.refresh();
				} else {
					for (const r of scanRoots) await db.scanAllWorkspacesAsync(r);
					db.cleanupOlderThan();
				}
				loadedSpans = db.loadSpans();
				traceStore.loadFile(loadedSpans);
			}
			setStepDone("workflow-application");
			await tick();
			if (isShutdownRequested()) return;

			// 3. Telemetry receivers (loopback by default), optional gRPC helper,
			// then collectors — each acquired as an owned handle.
			mark("telemetry");
			// Receiver listeners are owned by the server composition root (started
			// with the workflow server above) and route into this shell's stores via
			// the injected sink; nothing is acquired here.
			await tick();
			if (isShutdownRequested()) return;
			setStepDone("telemetry");
			await tick();
			if (isShutdownRequested()) return;

			// Build topology from the history loaded after first paint.
			topologyStore.load(loadedSpans);
			if (homeMode) finishStartup();
			if (attachUrl) {
				notify(
					remoteAttach
						? `Attached to ${attachUrl}: workflow + observability (environment features unavailable remotely)`
						: `Attached to ${attachUrl}: environment features only, remote workflow features are unavailable in this milestone`,
					"info",
				);
			}
		} catch (error) {
			// Partial-startup rollback: release only what was acquired, then
			// report. The message names the failure so a port conflict or an
			// identity mismatch is actionable instead of a silent exit.
			delete process.env[BACKEND_STARTING_ENV];
			await releaseResources(1000);
			const text = error instanceof Error ? error.message : String(error);
			if (homeMode) {
				setStepError(activeStep, text);
				await sleep(1500);
			} else {
				console.error(`Cannot start server stack: ${text}`);
			}
			process.exit(1);
		}
	}
}

if (import.meta.main) {
	await main();
}
