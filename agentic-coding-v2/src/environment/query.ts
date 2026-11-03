import { checkServerIdentity } from "node:tls";
import { type ReservedSQL, SQL } from "bun";
import {
	type QueryConnection,
	type QueryInput,
	queryInput,
} from "./query-config.ts";

function redactValue(
	value: unknown,
	redact: (value: string) => string,
	depth = 0,
): unknown {
	if (typeof value === "string") return redact(value);
	if (depth >= 8) return "[nested value omitted]";
	if (Array.isArray(value))
		return value.map((item) => redactValue(item, redact, depth + 1));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				redact(key),
				redactValue(item, redact, depth + 1),
			]),
		);
	return value;
}
function rowsView(
	raw: unknown,
	input: QueryInput,
	redact: (value: string) => string,
) {
	if (!Array.isArray(raw))
		throw new Error("Database did not return a row list");
	const rows: unknown[] = [];
	let bytes = 2,
		truncatedRows = 0;
	for (const row of raw.slice(0, input.limit)) {
		if (!row || typeof row !== "object" || typeof row.row !== "string")
			throw new Error(
				"Database did not return the bounded JSON row projection",
			);
		// Never publish a clipped secret prefix or a placeholder mistaken for a data row.
		if (row.row.length > 1024) {
			truncatedRows++;
			continue;
		}
		const lossless = row.row.replace(
			/("(?:[^"\\]|\\.)*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
			(token: string, stringToken: string | undefined) =>
				stringToken ?? JSON.stringify(token),
		);
		let value: unknown;
		try {
			value = redactValue(JSON.parse(lossless), redact);
		} catch {
			throw new Error(
				"Database returned malformed row JSON; no result accepted",
			);
		}
		const size = Buffer.byteLength(JSON.stringify(value)) + 1;
		if (bytes + size > 8192) continue;
		rows.push(value);
		bytes += size;
	}
	return {
		rows,
		returnedRows: rows.length,
		observedRows: Math.min(raw.length, input.limit),
		more: raw.length > input.limit,
		omittedWithinLimit: Math.min(raw.length, input.limit) - rows.length,
		truncatedRows,
		limit: input.limit,
		rowCharacterLimit: 1024,
		resultByteBudget: 8192,
		numericFormat: "strings",
	};
}
/** One reserved connection, one read-only transaction, explicit acknowledged rollback.
 * Extended prepared execution makes a multi-statement escape fail before execution.
 * READ ONLY is a database write fence, not a sandbox for privileged SQL functions.
 */
export async function readOnlyQuery(
	connection: QueryConnection,
	credentials: { username: string; password: string },
	input: QueryInput,
	ca: Buffer | undefined,
	signal: AbortSignal,
	check: () => void,
	redact: (value: string) => string,
) {
	queryInput(input.infra, input.sql, input.limit, input.schema);
	const client = new SQL({
		adapter: "postgres",
		hostname: connection.host,
		port: connection.port,
		database: connection.database,
		username: credentials.username,
		password: credentials.password,
		max: 1,
		prepare: true,
		connectionTimeout: 5,
		tls: {
			rejectUnauthorized: true,
			...(ca ? { ca } : {}),
			checkServerIdentity: (_host, cert) =>
				checkServerIdentity(connection.host, cert),
		},
	});
	let reserved: ReservedSQL | undefined,
		rolledBack = false,
		raw: unknown,
		failure: Error | undefined;
	const abort = () => {
		// Close the reserved connection as well as its pool; no borrowed socket may outlive cancellation.
		void Promise.allSettled([
			...(reserved ? [reserved.close({ timeout: 0 })] : []),
			client.close({ timeout: 0 }),
		]);
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		check();
		signal.throwIfAborted();
		reserved = await client.reserve({ signal });
		check();
		signal.throwIfAborted();
		await reserved.unsafe("BEGIN READ ONLY");
		await reserved.unsafe("SET LOCAL statement_timeout = '10s'");
		if (input.schema)
			await reserved.unsafe(`SET LOCAL search_path TO "${input.schema}"`);
		const binding = await reserved.unsafe<unknown>(
			"SELECT pg_catalog.current_database()::pg_catalog.text = $1::pg_catalog.text AND session_user::pg_catalog.text = $2::pg_catalog.text AND pg_catalog.current_setting('transaction_read_only') = 'on' AND ($3::pg_catalog.text IS NULL OR pg_catalog.current_schema()::pg_catalog.text = $3::pg_catalog.text) AS bound",
			[connection.database, credentials.username, input.schema ?? null],
		);
		if (!Array.isArray(binding) || binding[0]?.bound !== true)
			throw new Error(
				"Database session binding or read-only mode did not match approval",
			);
		check();
		signal.throwIfAborted();
		const statement = input.sql.trim().replace(/;\s*$/, ""),
			wrapped = `SELECT pg_catalog.left(pg_catalog.row_to_json(_ac_rows)::pg_catalog.text, 1025) AS "row" FROM (\n${statement}\n) AS _ac_rows LIMIT $1`;
		// A nonempty binding is essential: Bun unsafe() without parameters can select
		// simple protocol despite prepare:true and allow a multi-statement escape.
		raw = await reserved.unsafe<unknown>(wrapped, [input.limit + 1]);
		await reserved.unsafe("ROLLBACK");
		rolledBack = true;
		check();
		signal.throwIfAborted();
	} catch (error) {
		const state =
			error instanceof SQL.PostgresError &&
			error.errno &&
			/^[A-Z0-9]{5}$/.test(error.errno)
				? ` (SQLSTATE ${error.errno})`
				: "";
		failure = new Error(
			signal.aborted
				? "Database query was cancelled or exceeded its total 10 second deadline; no result accepted"
				: `Database query failed${state}; no result accepted`,
		);
	} finally {
		if (reserved && !rolledBack && !signal.aborted)
			try {
				await reserved.unsafe("ROLLBACK");
			} catch {
				/* Closing the original connection is still required; no successful receipt is emitted. */
			}
		try {
			try {
				if (reserved) await reserved.close({ timeout: 0 });
			} finally {
				await client.close({ timeout: 0 });
			}
		} catch {
			failure = new Error(
				"Database connection cleanup failed; no result accepted",
			);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
	if (failure) throw failure;
	check();
	signal.throwIfAborted();
	return {
		...rowsView(raw, input, redact),
		database: connection.database,
		schema: input.schema ?? null,
		readOnly: true,
		rollback: "confirmed",
	};
}
