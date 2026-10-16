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
import { extractTables } from "./lib/extract.ts";
import { buildInventory } from "./lib/inventory.ts";
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
	const write = writeDataset({ outDir, tables: extraction.tables, meta });
	meta.buildMs = String(Math.round(performance.now() - started));
	// Re-open only to record the final meta; the counts are already known.
	const readme = datasetReadme(
		meta,
		write.counts,
		extraction.tables.sourceFiles.length,
	);
	fs.writeFileSync(path.join(outDir, "README.md"), readme, { mode: 0o600 });

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
