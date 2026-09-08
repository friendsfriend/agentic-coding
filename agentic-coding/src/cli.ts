#!/usr/bin/env bun
// Top-level `agentic-coding` surface dispatch.
//   workflow   transactional workflow engine
//   dash       per-workflow dashboard TUI (--repo --workflow-id | --profile test | --json)
//   home       workflow list + observability TUI (long-lived)
//   manager    alias for home (herdr-manager launches this)
import { main as workflowMain } from "./workflow/cli.ts";

const [surface, ...rest] = process.argv.slice(2);

if (surface === "__dashboard-observe") {
	const {
		discoverProjects,
		listWorkflows,
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
				? listWorkflows()
				: observation.kind === "projects"
					? discoverProjects()
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
} else if (
	!surface ||
	surface === "--help" ||
	surface === "-h" ||
	surface === "help"
) {
	console.log(
		"Usage: agentic-coding <surface> [args]\n\nSurfaces:\n  workflow   Transactional workflow engine. Run `agentic-coding workflow --help`.\n  dash       Per-workflow dashboard + observability TUI. `agentic-coding dash --repo PATH --workflow-id ID`\n  home       Workflow list + observability TUI (long-lived launcher).\n  manager    Alias for home (used by herdr-manager).",
	);
} else if (surface === "workflow") {
	await workflowMain(rest);
} else if (surface === "dash" || surface === "home" || surface === "manager") {
	if (surface === "home" || surface === "manager") process.argv.push("--home");
	const { main } = await import("./tui/index.tsx");
	await main();
} else {
	console.error(
		`unknown agentic-coding surface: ${surface}. Known surfaces: workflow, dash, home, manager`,
	);
	process.exit(1);
}
