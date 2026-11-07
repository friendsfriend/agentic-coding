import { expect, test } from "bun:test";
import { httpOptions } from "../src/environment/http-options.ts";

// Request-time HTTP options admit safe reads by default; every write,
// credential-adjacent header and unbounded body needs explicit approval flags
// or is refused outright. Pure unit proofs of that boundary.
const refused: Array<[string, () => unknown, string]> = [
	[
		"unknown option",
		() => httpOptions({ method: "GET", trace: true }),
		"Unknown HTTP request option",
	],
	[
		"TRACE method",
		() => httpOptions({ method: "TRACE" }),
		"Unsupported endpoint HTTP method",
	],
	[
		"CONNECT method",
		() => httpOptions({ method: "CONNECT" }),
		"Unsupported endpoint HTTP method",
	],
	[
		"non-boolean flag",
		() => httpOptions({ method: "GET", allowWrite: "yes" }),
		"must be booleans",
	],
	[
		"POST without allowWrite",
		() => httpOptions({ method: "POST" }),
		"require explicit allowWrite",
	],
	[
		"PUT without allowWrite",
		() => httpOptions({ method: "PUT" }),
		"require explicit allowWrite",
	],
	[
		"PATCH without allowWrite",
		() => httpOptions({ method: "PATCH" }),
		"require explicit allowWrite",
	],
	[
		"DELETE without allowWrite",
		() => httpOptions({ method: "DELETE" }),
		"require explicit allowWrite",
	],
	[
		"body on GET",
		() => httpOptions({ method: "GET", body: "{}" }),
		"body-capable method",
	],
	[
		"body on HEAD",
		() => httpOptions({ method: "HEAD", body: "{}" }),
		"body-capable method",
	],
	[
		"oversized body",
		() =>
			httpOptions({
				method: "POST",
				allowWrite: true,
				body: "x".repeat(16385),
			}),
		"at most 16 KiB",
	],
	[
		"seventeenth header",
		() =>
			httpOptions({
				method: "GET",
				headers: Object.fromEntries(
					Array.from({ length: 17 }, (_, index) => [`x-h${index}`, "v"]),
				),
			}),
		"At most 16",
	],
	[
		"authorization header",
		() =>
			httpOptions({ method: "GET", headers: { authorization: "Bearer x" } }),
		"server-owned handling",
	],
	[
		"cookie header",
		() => httpOptions({ method: "GET", headers: { cookie: "a=b" } }),
		"server-owned handling",
	],
	[
		"proxy-authenticate header",
		() =>
			httpOptions({ method: "GET", headers: { "proxy-authenticate": "x" } }),
		"server-owned handling",
	],
	[
		"unlisted custom header",
		() => httpOptions({ method: "GET", headers: { "x-custom": "v" } }),
		"Only bounded printable",
	],
	[
		"non-printable header value",
		() => httpOptions({ method: "GET", headers: { accept: "a\tb" } }),
		"printable",
	],
	[
		"non-string header value",
		() => httpOptions({ method: "GET", headers: { accept: 1 } }),
		"Only bounded printable",
	],
	[
		"header block over 4 KiB",
		() =>
			httpOptions({
				method: "GET",
				headers: {
					accept: "v".repeat(1024),
					"content-type": "v".repeat(1024),
					"if-match": "v".repeat(1024),
					"if-none-match": "v".repeat(1024),
					"idempotency-key": "v".repeat(1024),
				},
			}),
		"exceed 4 KiB",
	],
];
test.each(refused)("httpOptions refuses %s", async (label, run, message) => {
	void label;
	expect(run).toThrow(message);
});
test("httpOptions admits a bounded approved write with an allow-listed header", () => {
	const options = httpOptions({
		method: "POST",
		allowWrite: true,
		headers: { "content-type": "application/json", "idempotency-key": "abc" },
		body: "{}",
	});
	expect(options).toEqual({
		method: "POST",
		headers: { "content-type": "application/json", "idempotency-key": "abc" },
		body: "{}",
		followRedirects: false,
		authenticate: false,
		allowWrite: true,
	});
});
test("httpOptions admits exactly 16 KiB bodies and defaults to safe reads", () => {
	const write = httpOptions({
		method: "PUT",
		allowWrite: true,
		body: "x".repeat(16384),
	});
	expect(write.body?.length).toBe(16384);
	expect(httpOptions({ method: "GET" })).toEqual({
		method: "GET",
		headers: {},
		followRedirects: false,
		authenticate: false,
		allowWrite: false,
	});
});
