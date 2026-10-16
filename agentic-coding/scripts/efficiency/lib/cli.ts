// Minimal argv parsing for the two CLIs. The repository has no CLI framework
// dependency and these tools take a handful of flags, so a tiny parser with an
// explicit error message beats pulling one in.

export interface ParsedArgs {
	/** Flags with a value (`--out x` or `--out=x`). */
	values: Map<string, string>;
	/** Flags without a value (`--json`). */
	flags: Set<string>;
	positionals: string[];
}

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): ParsedArgs {
	const values = new Map<string, string>();
	const flags = new Set<string>();
	const positionals: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		const [name, inline] = arg.slice(2).split("=", 2) as [
			string,
			string | undefined,
		];
		if (inline !== undefined) {
			values.set(name, inline);
			continue;
		}
		const next = argv[index + 1];
		if (next !== undefined && !next.startsWith("--")) {
			values.set(name, next);
			index += 1;
			continue;
		}
		flags.add(name);
	}
	return { values, flags, positionals };
}

export function requireValue(args: ParsedArgs, name: string): string {
	const value = args.values.get(name);
	if (value === undefined || value.length === 0)
		throw new UsageError(`missing required --${name}`);
	return value;
}

export function optionalValue(
	args: ParsedArgs,
	name: string,
): string | undefined {
	return args.values.get(name);
}

export function numberValue(
	args: ParsedArgs,
	name: string,
	fallback: number,
): number {
	const raw = args.values.get(name);
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0)
		throw new UsageError(`--${name} must be a non-negative number`);
	return Math.floor(parsed);
}

/** Format rows as a fixed-width table. Long values are truncated so a wide
 * `args_digest` cannot push the interesting columns off screen. */
export function formatTable(
	rows: ReadonlyArray<Record<string, unknown>>,
	columns: readonly string[],
	maxWidth = 48,
): string {
	const cells = rows.map((row) =>
		columns.map((column) => {
			const value = row[column];
			if (value === null || value === undefined) return "";
			const text = typeof value === "number" ? String(value) : String(value);
			return text.length > maxWidth ? `${text.slice(0, maxWidth - 1)}…` : text;
		}),
	);
	const widths = columns.map((column, index) =>
		Math.max(
			column.length,
			...cells.map((row) => (row[index] ?? "").length),
			0,
		),
	);
	const line = (row: readonly string[]) =>
		row
			.map((cell, index) => cell.padEnd(widths[index] ?? 0))
			.join("  ")
			.trimEnd();
	return [
		line(columns),
		line(widths.map((width) => "-".repeat(width))),
		...cells.map(line),
	].join("\n");
}
