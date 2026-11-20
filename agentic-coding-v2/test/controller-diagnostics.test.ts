import { expect, test } from "bun:test";
import {
	diagnosticHttpInput,
	diagnosticQueryInput,
	diagnosticResult,
} from "../src/environment/controller/diagnostic-input.ts";
import { httpDiagnosticAuthority } from "../src/environment/diagnostic-approval.ts";

test("diagnostic inputs normalize exact HTTP intent and retain native SQL refusals", () => {
	const first = diagnosticHttpInput({
		app: "api",
		endpoint: "web",
		headers: { Accept: "text/plain", "Content-Type": "text/plain" },
	});
	const reordered = diagnosticHttpInput({
		endpoint: "web",
		app: "api",
		headers: { "content-type": "text/plain", accept: "text/plain" },
	});
	expect(JSON.stringify(first)).toBe(JSON.stringify(reordered));
	expect(
		diagnosticQueryInput({ infra: "store", sql: "SELECT 1" }),
	).toMatchObject({ limit: 50, sql: "SELECT 1" });
	expect(() =>
		diagnosticHttpInput({ app: "api", endpoint: "web", method: "POST" }),
	).toThrow("allowWrite");
	expect(() =>
		diagnosticHttpInput({
			app: "api",
			endpoint: "web",
			headers: { Authorization: "not-allowed" },
		}),
	).toThrow("credentials");
	expect(() =>
		diagnosticQueryInput({ infra: "store", sql: "DELETE FROM data" }),
	).toThrow("SELECT/WITH");
	expect(() =>
		diagnosticQueryInput({
			infra: "store",
			sql: "SELECT 1",
			connection: "postgres://caller",
		}),
	).toThrow();
});

test("a large diagnostic view omits presentation bytes rather than inventing uncertain execution", () => {
	const input = diagnosticHttpInput({ app: "api", endpoint: "web" });
	const snapshot = {
		kind: "http" as const,
		input,
		request: {
			app: "api",
			endpoint: "web",
			run: "run",
			url: "http://127.0.0.1:8080/",
		},
		authority: httpDiagnosticAuthority,
	};
	const view = diagnosticResult(
		{ status: 200, body: "é".repeat(30000), bodyFormat: "text", run: "run" },
		snapshot,
		"operation",
	);
	expect(view.status).toBe("completed");
	expect(view.diagnostic).toMatchObject({
		status: 200,
		bodyFormat: "omitted",
		controllerBodyOmitted: true,
	});
	expect(view.history).toEqual({
		kind: "http",
		run: "run",
		operation: "http-controller-operation",
	});
	expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(64000);
});
