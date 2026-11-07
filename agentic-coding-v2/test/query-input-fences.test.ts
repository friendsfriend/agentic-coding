import { expect, test } from "bun:test";
import { queryInput } from "../src/environment/query-config.ts";

// The server never executes anything but one SELECT/WITH statement: the
// admission function refuses everything else before any connection exists.
// These are pure unit proofs of that boundary.
const refused: Array<[string, () => unknown, string]> = [
	[
		"INSERT",
		() => queryInput("db", "INSERT INTO t VALUES (1)"),
		"one SELECT/WITH",
	],
	["UPDATE", () => queryInput("db", "UPDATE t SET a = 1"), "one SELECT/WITH"],
	["DELETE", () => queryInput("db", "DELETE FROM t"), "one SELECT/WITH"],
	["DROP", () => queryInput("db", "DROP TABLE t"), "one SELECT/WITH"],
	[
		"EXPLAIN of a select",
		() => queryInput("db", "EXPLAIN SELECT 1"),
		"one SELECT/WITH",
	],
	[
		"leading line comment",
		() => queryInput("db", "-- audit\nSELECT 1"),
		"one SELECT/WITH",
	],
	[
		"leading block comment",
		() => queryInput("db", "/* audit */ SELECT 1"),
		"one SELECT/WITH",
	],
	["empty statement", () => queryInput("db", "   "), "one SELECT/WITH"],
	[
		"oversized statement",
		() => queryInput("db", `SELECT '${"x".repeat(20001)}'`),
		"at most 20 KiB",
	],
	["NUL byte", () => queryInput("db", "SELECT 1\0"), "control bytes"],
	[
		"newline-adjacent control byte",
		() => queryInput("db", "SELECT\x07 1"),
		"control bytes",
	],
	[
		"positional placeholder",
		() => queryInput("db", "SELECT $1", 50),
		"reserved for the row cap",
	],
	[
		"placeholder inside a literal",
		() => queryInput("db", "SELECT 'a$1b'"),
		"including inside literals",
	],
	["zero limit", () => queryInput("db", "SELECT 1", 0), "from 1 to 200"],
	["excess limit", () => queryInput("db", "SELECT 1", 201), "from 1 to 200"],
	["fractional limit", () => queryInput("db", "SELECT 1", 1.5), "integer"],
	[
		"schema with statement terminator",
		() => queryInput("db", "SELECT 1", 50, "public;--"),
		"PostgreSQL identifier",
	],
	[
		"oversized schema",
		() => queryInput("db", "SELECT 1", 50, `${"a".repeat(64)}`),
		"at most 63",
	],
	[
		"empty app",
		() => queryInput("db", "SELECT 1", 50, undefined, ""),
		"nonempty application ID",
	],
	[
		"oversized app",
		() => queryInput("db", "SELECT 1", 50, undefined, `${"a".repeat(65)}`),
		"at most 64",
	],
];
test.each(refused)("queryInput refuses %s", async (label, run, message) => {
	void label;
	expect(run).toThrow(message);
});
test("queryInput admits one bounded WITH statement with an identifier schema", () => {
	const input = queryInput(
		"db",
		"WITH one AS (SELECT 1 AS n) SELECT n FROM one",
		200,
		"public",
	);
	expect(input).toEqual({
		infra: "db",
		sql: "WITH one AS (SELECT 1 AS n) SELECT n FROM one",
		limit: 200,
		schema: "public",
	});
});
