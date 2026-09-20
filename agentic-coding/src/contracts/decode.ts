import { Schema } from "effect";
import { ArrayFormatter, ParseError } from "effect/ParseResult";

// Synchronous contract decode helpers: `Contract`/`ContractFailure` and the
// Effect-Schema -> `ContractFailure` boundary. Pure: no I/O, no domain imports.
export interface ContractError {
	path: string;
	message: string;
}
export class ContractFailure extends Error {
	constructor(
		readonly contractId: string,
		readonly issues: ContractError[],
	) {
		super(
			`${contractId}: ${issues
				.slice(0, 8)
				.map((issue) => `${issue.path}: ${issue.message}`)
				.join("; ")}`,
		);
	}
}
export interface Contract<T> {
	readonly id: string;
	readonly version: number;
	parse(value: unknown): T;
}

/** Cap for a single parsed issue message so diagnostics stay bounded. */
const MAX_ISSUE_MESSAGE_CHARS = 256;

/** Render an Effect issue path (property + index parts) as a `$.a.b[0]` path. */
function formatIssuePath(path: readonly PropertyKey[]): string {
	let formatted = "$";
	for (const part of path) {
		formatted +=
			typeof part === "number" || /^\d+$/.test(String(part))
				? `[${String(part)}]`
				: `.${String(part)}`;
	}
	return formatted;
}

/** Bound an Effect issue message and strip raw received values. Leaf type
 * errors are formatted `Expected <type>, actual <value>`; `<value>` is the raw
 * input and can be a capability token or secret carried on a wrong-typed
 * field, so it must never reach messages or diagnostics (SEC-001). Refinement
 * messages (custom filter text) have no raw value and pass through unchanged. */
function sanitizeIssueMessage(message: string): string {
	const bounded =
		message.length > MAX_ISSUE_MESSAGE_CHARS
			? `${message.slice(0, MAX_ISSUE_MESSAGE_CHARS)}\u2026`
			: message;
	return bounded
		.replace(/,\s*actual\s.+$/s, "")
		.replace(/Expected /g, "expected ");
}

/** Run a Schema decode and surface expected validation failures as the
 * established `ContractFailure` rather than an Effect `ParseError`, with one
 * localized issue per parsed field instead of a full union/schema dump. The
 * schema parameter is typed loosely because Effect Schema generic inference
 * does not always line up with the domain contract types (readonly arrays,
 * optional vs `| undefined`); the facade casts the decoded value to the
 * contract type. */
export function decodeContract<T>(
	contractId: string,
	// biome-ignore lint/suspicious/noExplicitAny: Effect Schema generics don't line up with domain types (readonly arrays, optional vs undefined); the facade casts the decoded value.
	schema: Schema.Schema<any, any, never>,
	value: unknown,
	decodeOptions?: {
		readonly onExcessProperty?: "preserve" | "ignore" | "error";
	},
): T {
	try {
		return Schema.decodeUnknownSync(
			schema,
			decodeOptions as Parameters<typeof Schema.decodeUnknownSync>[1],
		)(value) as T;
	} catch (error) {
		if (error instanceof ParseError) {
			const issues = ArrayFormatter.formatErrorSync(error)
				.slice(0, 8)
				.map((issue) => ({
					path: formatIssuePath(issue.path),
					message: sanitizeIssueMessage(issue.message),
				}));
			throw new ContractFailure(
				contractId,
				issues.length > 0
					? issues
					: [{ path: "$", message: "expected valid value" }],
			);
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------

// Reusable field builders mirroring the legacy `validation` helpers.
// ---------------------------------------------------------------------------

/** Non-empty UTF-8 string, trimmed and bounded in bytes (legacy semantics:
 * the old hand-written parsers enforced `Buffer.byteLength`, so multibyte
 * content counts as its UTF-8 size, not its UTF-16 code-unit length). */
export function text(max: number): Schema.Schema<string> {
	return Schema.String.pipe(
		Schema.filter(
			(value) =>
				value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= max,
			{
				message: () => `expected non-empty string <= ${max} bytes`,
			},
		),
	);
}
/** String bounded in bytes (UTF-8); absent/null become the empty string. */
export function boundedText(max: number): Schema.Schema<string> {
	return Schema.String.pipe(
		Schema.filter((value) => Buffer.byteLength(value, "utf8") <= max, {
			message: () => `expected string <= ${max} bytes`,
		}),
	);
}
/** Non-negative integer at or above a floor. */
export function integer(min = 0): Schema.Schema<number> {
	return Schema.Number.pipe(
		Schema.filter((value) => Number.isInteger(value) && value >= min, {
			message: () => `expected integer >= ${min}`,
		}),
	);
}
export function stringArray(): Schema.Schema<readonly string[]> {
	return Schema.Array(Schema.String);
}

// ---------------------------------------------------------------------------
