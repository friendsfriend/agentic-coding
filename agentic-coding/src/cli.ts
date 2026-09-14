#!/usr/bin/env bun
// Top-level `agentic-coding` surface dispatch. One executable, one lifecycle
// owner; `devenv` is a thin alias that maps onto the same modes.
//   (default)  unified TUI with an owned environment backend
//   workflow   transactional workflow engine
//   dash       per-workflow dashboard pane (--repo --workflow-id | --profile test | --json)
//   home       workflow list + observability TUI (long-lived); manager is an alias
//   server     headless environment backend (no renderer)
//   attach     attach the shell to a running environment backend
// Internal modes (not user surfaces): __dashboard-observe, __grpc-sidecar.
import { DEVENV_ALIAS_NAMES, devenvAliasArgv } from "./devenv-alias.ts";
import { main as workflowMain } from "./workflow/cli.ts";

const argv = process.argv.slice(2);
const invokedAs = (process.argv[1] ?? "").split("/").pop() ?? "";
const viaDevenvAlias =
	!process.env.AGENTIC_CODING_INVOKED_AS &&
	(DEVENV_ALIAS_NAMES.has(invokedAs) || argv[0] === "devenv");

const [surface, ...rest] = viaDevenvAlias ? devenvAliasArgv(argv) : argv;

if (surface === "__grpc-sidecar") {
	// Internal mode of this executable: the optional OTLP gRPC helper. Bound to
	// loopback; the parent verifies a real TraceService export before readiness.
	await import("./tui/otel/receiver/otlp-grpc-sidecar.ts");
} else if (surface === "server") {
	// Headless environment backend: no renderer, and the same bounded lifecycle
	// (identity-verified child, one signal path) as the managed TUI route.
	const { runHeadlessServer } = await import("./server-command.ts");
	await runHeadlessServer(rest);
} else if (surface === "attach") {
	const url = rest[0];
	if (!url) {
		console.error("usage: agentic-coding attach <url>");
		process.exit(2);
	}
	const { main } = await import("./tui/index.tsx");
	process.argv.push("--attach-url", url, "--home");
	await main();
} else if (surface === "__dashboard-observe") {
	const {
		discoverProjects,
		listWorkflowsFromCatalog,
		loadDashboard,
		loadLocalChanges,
		loadLocalDiff,
	} = await import("./tui/dash/observations.ts");
	try {
		const observation = JSON.parse(
			Buffer.from(rest[0] ?? "", "base64").toString("utf8"),
		) as
			| { kind: "workflows" }
			| { kind: "projects" }
			| {
					kind: "artifacts";
					state: import("./tui/dash/types.ts").WorkflowState;
			  }
			| {
					kind: "artifact-content";
					state: import("./tui/dash/types.ts").WorkflowState;
					artifact: string;
			  }
			| { kind: "wiki-changes"; repo: string; workflowId: string }
			| {
					kind: "wiki-diff";
					repo: string;
					workflowId: string;
					file: import("./tui/dash/types.ts").LocalChange;
			  }
			| { kind: "dashboard"; repo: string; workflowId: string }
			| { kind: "local-changes"; repo: string; workflowId: string }
			| {
					kind: "local-diff";
					repo: string;
					workflowId: string;
					file: import("./tui/dash/types.ts").LocalChange;
			  };
		const value =
			observation.kind === "workflows"
				? await listWorkflowsFromCatalog()
				: observation.kind === "projects"
					? await discoverProjects()
					: observation.kind === "artifacts"
						? (await import("./tui/dash/observations.ts")).openSpecArtifacts(
								observation.state,
							)
						: observation.kind === "artifact-content"
							? (await import("./tui/dash/observations.ts")).openSpecArtifact(
									observation.state,
									observation.artifact,
								)
							: observation.kind === "wiki-changes"
								? (
										await import("./tui/dash/observations.ts")
									).loadWikiSnapshotChanges(
										observation.repo,
										observation.workflowId,
									)
								: observation.kind === "wiki-diff"
									? (
											await import("./tui/dash/observations.ts")
										).loadWikiSnapshotDiff(
											observation.repo,
											observation.workflowId,
											observation.file.newPath,
										)
									: observation.kind === "local-changes"
										? loadLocalChanges(observation.repo, observation.workflowId)
										: observation.kind === "local-diff"
											? loadLocalDiff(
													observation.repo,
													observation.workflowId,
													observation.file,
												)
											: loadDashboard(observation.repo, observation.workflowId);
		console.log(JSON.stringify({ ok: true, value }));
	} catch (error) {
		console.log(
			JSON.stringify({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		process.exitCode = 1;
	}
} else if (surface === "--help" || surface === "-h" || surface === "help") {
	console.log(
		"Usage: agentic-coding [command] [args]\n\nCommands:\n  (none)     Unified shell (owned environment backend + workflows + observability).\n  workflow   Transactional workflow engine. Run `agentic-coding workflow --help`.\n  home       Unified shell, home route. `manager` is an alias.\n  dash       Per-workflow dashboard pane. `agentic-coding dash --repo PATH --workflow-id ID`\n  server     Start only the environment backend (headless).\n  attach     Attach the shell to a running environment backend: `agentic-coding attach URL`\n  devenv     Thin alias of this executable (spawn/attach/server).",
	);
} else if (surface === "workflow") {
	await workflowMain(rest);
} else if (
	!surface ||
	surface === "dash" ||
	surface === "home" ||
	surface === "manager" ||
	surface.startsWith("-")
) {
	// Default unified route: no command (or only flags) means the shared shell
	// home route, which owns and reports the environment backend.
	if (!surface || surface === "home" || surface === "manager")
		process.argv.push("--home");
	const { main } = await import("./tui/index.tsx");
	await main();
} else {
	console.error(
		`unknown agentic-coding command: ${surface}. Known commands: workflow, dash, home, manager, server, attach`,
	);
	process.exit(1);
}
