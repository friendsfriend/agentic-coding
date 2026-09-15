#!/usr/bin/env bun
// Top-level `agentic-coding` surface dispatch. One executable, one lifecycle
// owner; `devenv` is a thin alias that maps onto the same modes.
//   (default)  unified TUI with an owned environment backend
//   workflow   transactional workflow engine
//   dash       per-workflow dashboard pane (--repo --workflow-id | --profile test | --json)
//   home       workflow list + observability TUI (long-lived); manager is an alias
//   server     headless environment backend (no renderer)
//   attach     attach the shell to a running environment backend
// Internal modes (not user surfaces): __catalog, __dashboard-observe (removed).
import { DEVENV_ALIAS_NAMES, devenvAliasArgv } from "./devenv-alias.ts";
import { main as workflowMain } from "./workflow/cli.ts";

const argv = process.argv.slice(2);
const invokedAs = (process.argv[1] ?? "").split("/").pop() ?? "";
const viaDevenvAlias =
	!process.env.AGENTIC_CODING_INVOKED_AS &&
	(DEVENV_ALIAS_NAMES.has(invokedAs) || argv[0] === "devenv");

const [surface, ...rest] = viaDevenvAlias ? devenvAliasArgv(argv) : argv;

if (surface === "__catalog") {
	// Internal mode of this executable: the bounded read-only catalog read
	// `loadProjectCatalog` falls back to when no server is running. It builds the
	// same environment authority the server owns and prints the projection, so
	// there is exactly one catalog implementation.
	const { printProjectCatalog } = await import("./server/catalog-command.ts");
	await printProjectCatalog();
} else if (surface === "server") {
	// Headless environment backend: no renderer, and the same bounded lifecycle
	// (identity-verified child, one signal path) as the managed TUI route.
	const { runHeadlessServer } = await import("./server-command.ts");
	await runHeadlessServer(rest);
} else if (surface === "attach") {
	const url = rest[0];
	if (!url || url.startsWith("--")) {
		console.error("usage: agentic-coding attach <url> --token TOKEN");
		process.exit(2);
	}
	const tokenIndex = rest.indexOf("--token");
	const token =
		tokenIndex >= 0 ? rest[tokenIndex + 1] : process.env.AGENTIC_WORKFLOW_TOKEN;
	// The unified server authenticates every surface, so an attach without a
	// capability could only render empty views. Fail with the fix instead.
	if (!token) {
		console.error(
			"attach requires the server capability: pass --token TOKEN (or set AGENTIC_WORKFLOW_TOKEN). Start the server with the same value to allow attach.",
		);
		process.exit(2);
	}
	const { main } = await import("./tui/index.tsx");
	process.argv.push("--attach-url", url, "--home", "--attach-token", token);
	await main();
} else if (surface === "__dashboard-observe") {
	// Removed: the TUI reaches observations through the typed backend client
	// (expose-unified-bun-backend, task 3.5). Fail loudly rather than silently
	// keeping a second transport alive.
	console.error("__dashboard-observe was removed; use the typed backend API");
	process.exit(2);
} else if (surface === "--help" || surface === "-h" || surface === "help") {
	console.log(
		"Usage: agentic-coding [command] [args]\n\nCommands:\n  (none)     Unified shell (owned environment backend + workflows + observability).\n  workflow   Transactional workflow engine. Run `agentic-coding workflow --help`.\n  home       Unified shell, home route. `manager` is an alias.\n  dash       Per-workflow dashboard pane. `agentic-coding dash --repo PATH --workflow-id ID`\n  server     Start only the unified backend (headless).\n  attach     Attach the shell to a running environment backend: `agentic-coding attach URL`\n  devenv     Thin alias of this executable (spawn/attach/server).",
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
