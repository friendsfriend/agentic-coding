#!/usr/bin/env bun

// Ready-made analysis queries over a built dataset.
//
// Every query is defined in `lib/queries.ts` and reads the preferred rows, so a
// workflow seen in three sources is counted once. All of them run in seconds on
// the full snapshot.
//
//   bun run scripts/efficiency/analyze.ts --help
//   bun run scripts/efficiency/analyze.ts repeated-calls --dataset <dir> --limit 20

import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
	formatTable,
	numberValue,
	optionalValue,
	parseArgs,
	UsageError,
} from "./lib/cli.ts";
import {
	assertDatasetSchemaVersion,
	DATASET_FILE,
	DatasetSchemaError,
	datasetMeta,
} from "./lib/dataset.ts";
import { QUERIES, queryByName } from "./lib/queries.ts";

const HELP = `Usage: bun run scripts/efficiency/analyze.ts <query> [options]

Runs one of the dataset's ready-made analysis queries. The dataset is the OUT
directory written by build-dataset.ts.

Options:
  --dataset <path>   Dataset directory (or dataset.sqlite itself). Required.
  --limit <n>        Row bound for queries that support it.
  --json             Emit JSON rows instead of a table.
  --help             Show this help, including the query list.

Queries:
${QUERIES.map((query) => `  ${query.name.padEnd(20)} ${query.summary}\n    ${query.example}`).join("\n")}
`;

function resolveDataset(input: string): string {
	const resolved = path.resolve(input);
	let stats: fs.Stats;
	try {
		stats = fs.statSync(resolved);
	} catch {
		throw new UsageError(`--dataset ${input} does not exist`);
	}
	const file = stats.isDirectory()
		? path.join(resolved, DATASET_FILE)
		: resolved;
	if (!fs.existsSync(file))
		throw new UsageError(`no ${DATASET_FILE} under ${resolved}`);
	return file;
}

function main(argv: readonly string[]): number {
	const args = parseArgs(argv);
	if (args.flags.has("help") || args.positionals.length === 0) {
		process.stdout.write(HELP);
		return args.positionals.length === 0 && !args.flags.has("help") ? 1 : 0;
	}
	if (args.positionals[0] === "list") {
		for (const query of QUERIES)
			process.stdout.write(`${query.name}\t${query.summary}\n`);
		return 0;
	}
	const name = args.positionals[0] ?? "";
	const query = queryByName(name);
	if (query === undefined)
		throw new UsageError(`unknown query "${name}" — see analyze.ts --help`);
	const datasetPath = resolveDataset(
		optionalValue(args, "dataset") ?? process.env.EFFICIENCY_DATASET ?? "",
	);
	const limit = numberValue(args, "limit", query.limit ?? 100);
	const sql = query.limitable ? `${query.sql}\nLIMIT ${limit}` : query.sql;
	const db = new Database(datasetPath, { readonly: true });
	try {
		assertDatasetSchemaVersion(db, datasetPath);
		const rows = db.query<Record<string, unknown>, []>(sql).all();
		// The build date is the only signal that an older file's zeros may be "not
		// recorded yet" rather than measurements: the schema version changes only
		// with the file's shape. Both output modes state it — the JSON on stderr, so
		// stdout stays byte-identical for the parsers that read it.
		const meta = datasetMeta(db);
		const provenance = `dataset ${path.basename(
			path.dirname(datasetPath),
		)} built ${meta.builtAt ?? "(unknown)"} (schema ${
			meta.schemaVersion ?? "unknown"
		})\n`;
		if (args.flags.has("json")) {
			process.stderr.write(provenance);
			process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
			return 0;
		}
		process.stdout.write(provenance);
		const columns = query.columns.filter(
			(column) => rows.length === 0 || column in (rows[0] ?? {}),
		);
		process.stdout.write(`${formatTable(rows, columns)}\n`);
		process.stdout.write(`${rows.length} row(s)\n`);
	} finally {
		db.close();
	}
	return 0;
}

try {
	process.exit(main(Bun.argv.slice(2)));
} catch (error) {
	// A dataset an earlier build wrote is a usage problem, not a crash: the
	// message names the rebuild, which is the only fix there is.
	if (error instanceof UsageError || error instanceof DatasetSchemaError) {
		process.stderr.write(`${error.message}\n\n${HELP}`);
		process.exit(2);
	}
	throw error;
}
