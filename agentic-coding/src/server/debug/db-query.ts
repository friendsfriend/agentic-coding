// Read-only data access behind `db_query` (`add-agent-debug-tools`).
//
// An infrastructure definition may declare a `query` connection; this module
// turns it into one bounded, read-only transaction. Three properties hold for
// every call, whatever the caller sends:
//
//   * **read-only.** Postgres runs inside `BEGIN READ ONLY`, MySQL inside
//     `START TRANSACTION READ ONLY`, so a write the caller attempts is refused
//     by the database rather than by a keyword filter that a comment or a
//     quoted string could slip past;
//   * **bounded.** The statement timeout bounds the wait, the row limit bounds
//     the answer, and every value is truncated, so one query cannot flood the
//     model's context or hold the shared event loop; and
//   * **rolled back.** The transaction is rolled back and the connection closed
//     in `finally`, so nothing a caller sent can persist, commit or leak a
//     connection.
//
// The statements are built here rather than sent verbatim, and a schema
// identifier is validated before it is quoted: the schema name comes from the
// caller and identical quoting rules are what keeps it one identifier.
import type { InfraQueryConnection } from "../environment/config.ts";

/** The SQL dialects an infra definition may declare. */
export type DbQueryKind = InfraQueryConnection["kind"];

/** The resolved connection of one call. Credentials never leave this module:
 * they are read from the configuration `.env` and never appear in a result. */
export interface DbQueryConnection {
	readonly kind: DbQueryKind;
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly user: string;
	readonly password: string;
}

/** One open connection, as the runner uses it. */
export interface SqlSession {
	/** Execute one statement and return its rows. */
	query(statement: string): Promise<readonly unknown[]>;
	close(): Promise<void>;
}

/** The SQL port the runner talks to: `Bun.sql` in production, a fake in tests. */
export interface SqlPort {
	open(connection: DbQueryConnection): Promise<SqlSession>;
}

/** How long one statement may run, in milliseconds. */
export const STATEMENT_TIMEOUT_MS = 10_000;
/** Rows one answer carries by default, and at most. */
export const DEFAULT_ROW_LIMIT = 50;
export const MAX_ROW_LIMIT = 200;
/** One value's bound, so a blob or a long text column cannot flood the answer. */
export const MAX_VALUE_CHARS = 2_048;
/** The SQL text one call may carry. */
export const MAX_SQL_CHARS = 20_000;
/** The character budget of one answer. */
export const MAX_OUTPUT_CHARS = 40_000;

/** A refusal the route answers with its own status instead of a 500. */
export class DbQueryError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 400) {
		super(message);
		this.name = "DbQueryError";
		this.code = code;
		this.status = status;
	}
}

/** One identifier: letters, digits and `_`/`$`, never a quote, a space or a
 * statement separator. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/** Quote one identifier for its dialect, after validating it. */
export function quoteIdentifier(kind: DbQueryKind, value: string): string {
	if (!IDENTIFIER.test(value))
		throw new DbQueryError(
			"invalid-schema",
			`schema must be an identifier (letters, digits, _ and $), received ${JSON.stringify(value)}`,
		);
	return kind === "mysql" ? `\`${value}\`` : `"${value}"`;
}

/**
 * The statements that open one read-only transaction, in order.
 *
 * Postgres takes the timeout and the schema as transaction-local settings, so
 * both revert with the rollback; MySQL has no transaction-local setting, so the
 * timeout is a session variable and the schema a `USE` before the transaction
 * opens (both die with the connection this call closes).
 */
export function readOnlyStatements(
	kind: DbQueryKind,
	schema?: string,
): string[] {
	if (kind === "mysql")
		return [
			`SET SESSION max_execution_time = ${STATEMENT_TIMEOUT_MS}`,
			...(schema ? [`USE ${quoteIdentifier(kind, schema)}`] : []),
			"START TRANSACTION READ ONLY",
		];
	return [
		"BEGIN READ ONLY",
		`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS / 1000}s'`,
		...(schema
			? [`SET LOCAL search_path = ${quoteIdentifier(kind, schema)}`]
			: []),
	];
}

function boundRowLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0)
		return DEFAULT_ROW_LIMIT;
	return Math.min(MAX_ROW_LIMIT, Math.floor(limit));
}

/** One value, as a result may carry it: a string is truncated, a bigint becomes
 * a string, binary becomes a size marker, and anything else is JSON. */
export function boundValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === "string")
		return value.length > MAX_VALUE_CHARS
			? `${value.slice(0, MAX_VALUE_CHARS)}…`
			: value;
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
	try {
		const json = JSON.stringify(value);
		return json === undefined
			? String(value)
			: json.length > MAX_VALUE_CHARS
				? `${json.slice(0, MAX_VALUE_CHARS)}…`
				: json;
	} catch {
		return String(value);
	}
}

export interface DbQueryResult {
	readonly kind: DbQueryKind;
	readonly database: string;
	readonly schema?: string;
	readonly rows: Array<Record<string, unknown>>;
	readonly rowCount: number;
	readonly limit: number;
	/** Rows the database returned beyond `limit`, or beyond the output budget. */
	readonly truncated: boolean;
}

/**
 * Run one read-only query and always roll it back. A failure inside the
 * transaction still rolls back and still closes the connection: a query that
 * timed out is exactly when a connection must not be left holding one.
 */
export async function runReadOnlyQuery(
	port: SqlPort,
	connection: DbQueryConnection,
	options: {
		readonly sql: string;
		readonly schema?: string;
		readonly limit?: number;
	},
): Promise<DbQueryResult> {
	const limit = boundRowLimit(options.limit);
	const statements = readOnlyStatements(connection.kind, options.schema);
	const session = await port.open(connection);
	try {
		for (const statement of statements) await session.query(statement);
		let raw: readonly unknown[];
		try {
			raw = await session.query(options.sql);
		} catch (error) {
			// The database's own refusal (a write inside a read-only transaction, a
			// timeout, a syntax error) is the caller's answer, not a transport
			// failure: it is reported with the statement's message and still rolled
			// back below.
			throw new DbQueryError(
				"query-failed",
				message(error).slice(0, 2_000),
				400,
			);
		}
		const bounded = boundRows(raw, limit);
		return {
			kind: connection.kind,
			database: connection.database,
			...(options.schema ? { schema: options.schema } : {}),
			limit,
			...bounded,
		};
	} finally {
		// Always: a read-only transaction is closed explicitly, and a connection
		// is never handed back to a pool holding one.
		try {
			await session.query("ROLLBACK");
		} catch {
			/* closing below; a failed rollback is not the caller's problem */
		}
		await session.close();
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Bound the rows and the characters one answer may carry. */
export function boundRows(
	rows: readonly unknown[],
	limit: number,
): {
	rows: Array<Record<string, unknown>>;
	rowCount: number;
	truncated: boolean;
} {
	const kept: Array<Record<string, unknown>> = [];
	let budget = MAX_OUTPUT_CHARS;
	let truncated = rows.length > limit;
	for (const row of rows.slice(0, limit)) {
		const record: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(
			(row ?? {}) as Record<string, unknown>,
		))
			record[key] = boundValue(value);
		const size = JSON.stringify(record).length + 1;
		if (size > budget) {
			truncated = true;
			break;
		}
		budget -= size;
		kept.push(record);
	}
	return { rows: kept, rowCount: kept.length, truncated };
}

// ---------------------------------------------------------------------------
// The production port
// ---------------------------------------------------------------------------

type BunSqlClient = {
	unsafe(query: string): Promise<unknown>;
	close(options?: { timeout?: number }): Promise<void>;
};

/** `Bun.sql`, reached through the runtime global. The bundled type definitions
 * do not declare the SQL client, so the shape this module uses is stated here
 * once instead of at every call. */
function createSqlClient(url: string): BunSqlClient {
	const runtime = globalThis as { Bun?: { SQL?: unknown } };
	const Sql = runtime.Bun?.SQL;
	if (typeof Sql !== "function")
		throw new DbQueryError(
			"sql-unavailable",
			"this runtime provides no SQL client",
			503,
		);
	return new (
		Sql as new (
			url: string,
			options?: Record<string, unknown>,
		) => BunSqlClient
	)(url, { max: 1 });
}

/** The connection string of one call. Credentials are percent-encoded, so a
 * password carrying `@` or `:` cannot rewrite the URL's structure. */
export function connectionUrl(connection: DbQueryConnection): string {
	const scheme = connection.kind === "mysql" ? "mysql" : "postgres";
	const user = encodeURIComponent(connection.user);
	const password = encodeURIComponent(connection.password);
	return `${scheme}://${user}:${password}@${connection.host}:${connection.port}/${encodeURIComponent(connection.database)}`;
}

/** The production SQL port: one connection per call, closed by the runner. */
export const bunSqlPort: SqlPort = {
	async open(connection: DbQueryConnection): Promise<SqlSession> {
		const client = createSqlClient(connectionUrl(connection));
		return {
			async query(statement: string) {
				const result = await client.unsafe(statement);
				return Array.isArray(result) ? result : [];
			},
			close: () => client.close({ timeout: 1 }),
		};
	},
};
