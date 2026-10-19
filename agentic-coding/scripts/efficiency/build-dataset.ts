#!/usr/bin/env bun
// Builds the efficiency dataset from the read-only evidence snapshot.
//
//   bun run scripts/efficiency/build-dataset.ts --evidence <dir> --out <dir>
//   bun run scripts/efficiency/build-dataset.ts --evidence <dir> --inventory docs/efficiency/00-data-inventory.md
//
// The OUT directory defaults to `<evidence>/dataset-<timestamp>` and is created
// with mode 0700. It holds `dataset.sqlite` (the normalized tables and views)
// and `README.md` (the schema). Neither belongs in the repository: the
// inventory markdown is the only artifact this tool writes into the repo, and it
// carries ids, counts and digests only.

import fs from "node:fs";
import path from "node:path";
import {
	numberValue,
	optionalValue,
	parseArgs,
	requireValue,
	UsageError,
} from "./lib/cli.ts";
import { writeDataset } from "./lib/dataset.ts";
import {
	describeEmptySources,
	EMPTY_SOURCE_ALLOWLIST,
	findEmptySources,
	parseEmptySourcePatterns,
} from "./lib/empty-sources.ts";
import { extractTables } from "./lib/extract.ts";
import { buildInventory } from "./lib/inventory.ts";
import {
	describeUnexplainedRunWindow,
	inspectRunWindow,
} from "./lib/run-window.ts";
import { datasetReadme } from "./lib/schema-readme.ts";
import { discoverEvidence } from "./lib/sources.ts";

const HELP = `Usage: bun run scripts/efficiency/build-dataset.ts --evidence <dir> [--out <dir>] [options]

Reads the read-only evidence snapshot and writes a normalized dataset outside
the repository.

Options:
  --evidence <dir>    Evidence snapshot root (the directory holding MANIFEST.md).
  --out <dir>         Output directory. Default: <evidence>/dataset-<timestamp>.
  --inventory <file>  Also write the data-inventory markdown to this path.
  --top <n>           Workflows listed per gap table in the inventory (default 40).
  --allow-empty <p>   Comma-separated path patterns of source files known to be
                      empty, added to the built-in allow-list. A source file
                      that parses into zero rows fails the build otherwise.
  --quiet             Do not log per-file progress.
  --help              Show this help.

The output directory is created with mode 0700 and contains:
  dataset.sqlite      workflows, runs, turns, tool_calls, events + views
  README.md           the schema and the de-duplication precedence
`;

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

function main(argv: readonly string[]): number {
	const args = parseArgs(argv);
	if (args.flags.has("help")) {
		process.stdout.write(HELP);
		return 0;
	}
	const evidenceDir = path.resolve(requireValue(args, "evidence"));
	if (!fs.existsSync(path.join(evidenceDir, "MANIFEST.md")))
		process.stderr.write(
			`warning: ${evidenceDir} has no MANIFEST.md — is this the snapshot root?\n`,
		);
	const outDir = path.resolve(
		optionalValue(args, "out") ??
			path.join(evidenceDir, `dataset-${timestamp()}`),
	);
	const inventoryPath = optionalValue(args, "inventory");
	const top = numberValue(args, "top", 40);
	const allowlist = [
		...EMPTY_SOURCE_ALLOWLIST,
		...parseEmptySourcePatterns(optionalValue(args, "allow-empty")),
	];
	const quiet = args.flags.has("quiet");
	const log = (message: string) => {
		if (!quiet) process.stderr.write(`${message}\n`);
	};

	const started = performance.now();
	log(`reading evidence from ${evidenceDir}`);
	const discovery = discoverEvidence(evidenceDir);
	const extraction = extractTables({
		evidenceDir,
		onProgress: quiet ? undefined : log,
	});
	log(
		`extracted ${extraction.tables.workflows.length} workflows, ${extraction.tables.runs.length} runs, ` +
			`${extraction.tables.turns.length} turns, ${extraction.tables.toolCalls.length} tool calls, ` +
			`${extraction.tables.events.length} events`,
	);

	const sourcesAvailable = [
		...new Set(extraction.tables.sourceFiles.map((file) => file.source)),
	].sort();
	const meta: Record<string, string> = {
		builtAt: new Date().toISOString(),
		evidenceDir,
		evidenceFiles: String(extraction.discoveryFiles),
		evidenceMissing: extraction.discoveryMissing.join(", "),
		sourcesAvailable: sourcesAvailable.join(", "),
		buildMs: "",
	};
	meta.buildMs = String(Math.round(performance.now() - started));

	// A source file that parsed nothing is an error, not a note: the harness
	// stores reported zero rows for weeks while holding a sixth of the
	// snapshot's turns, and a build that records that in a note loses the source
	// without failing anything. `source-gaps` reports the same rows on a dataset
	// that was built before this check existed.
	const emptySources = findEmptySources(
		extraction.tables.sourceFiles,
		allowlist,
	);
	if (emptySources.length > 0) {
		process.stderr.write(describeEmptySources(emptySources));
		return 1;
	}

	const write = writeDataset({ outDir, tables: extraction.tables, meta });
	// Re-open only to record the final meta; the counts are already known.
	const readme = datasetReadme(
		meta,
		write.counts,
		extraction.tables.sourceFiles.length,
	);
	fs.writeFileSync(path.join(outDir, "README.md"), readme, { mode: 0o600 });

	// A run whose session kept working after the run closed is either stated by
	// the recording or a defect (efficiency backlog item 20): a tail no record
	// states a continuation for fails the build, the way a source that parses
	// nothing does. The gate is per *run*, not per workflow: a run's record is the
	// one that names its own run id, so one run's move cannot hide another's lost
	// record. A run that began before its workflow's first session-window event
	// (or whose own window cannot be read) is reported as unrecorded and still
	// builds; a run that began after that event with no such record fails.
	const runWindow = inspectRunWindow(write.path);
	if (runWindow.failures.length > 0) {
		fs.rmSync(write.path, { force: true });
		fs.rmSync(path.join(outDir, "README.md"), { force: true });
		process.stderr.write(
			describeUnexplainedRunWindow(runWindow.failures, write.path),
		);
		return 1;
	}

	if (inventoryPath !== undefined) {
		const inventory = buildInventory({
			datasetPath: write.path,
			evidenceDir,
			discovery,
			notes: extraction.tables.notes,
			top,
		});
		fs.mkdirSync(path.dirname(path.resolve(inventoryPath)), {
			recursive: true,
		});
		fs.writeFileSync(path.resolve(inventoryPath), inventory);
		log(`wrote inventory to ${inventoryPath}`);
	}

	const summary = {
		outDir,
		dataset: write.path,
		counts: write.counts,
		bytes: write.bytes,
		sources: sourcesAvailable,
		missingSources: extraction.discoveryMissing,
		skippedRecords: extraction.tables.sourceFiles.reduce(
			(total, file) => total + file.skipped,
			0,
		),
		notes: extraction.tables.notes.length,
		// The run/session window split: three populations, never mixed — the runs the
		// session record explains, the runs whose window cannot be read, and the runs
		// no record states a continuation for (with whether one was due).
		runWindow: {
			drifting: runWindow.rows.length,
			judged: {
				runs: runWindow.judged.rows.length,
				attributed: runWindow.judged.attributed,
				resumed: runWindow.judged.resumed,
			},
			unrecorded: {
				runs: runWindow.unrecorded.rows.length,
				beforeRecord: runWindow.unrecorded.beforeRecord,
				afterRecord: runWindow.unrecorded.afterRecord,
			},
			// Over every row, recorded or not: the query's `clock-artifact` class.
			clockArtifact: runWindow.clockArtifact,
			unexplained: runWindow.unexplained,
			recordedWorkflows: runWindow.recordedWorkflows.length,
		},
		buildMs: Math.round(performance.now() - started),
	};
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	return 0;
}

try {
	process.exit(main(Bun.argv.slice(2)));
} catch (error) {
	if (error instanceof UsageError) {
		process.stderr.write(`${error.message}\n\n${HELP}`);
		process.exit(2);
	}
	throw error;
}
