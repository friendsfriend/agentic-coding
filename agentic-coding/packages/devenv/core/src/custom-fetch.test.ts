import { describe, expect, test } from "bun:test";
import { redactUrl } from "./custom-fetch";

describe("redactUrl", () => {
	test("drops query strings that may carry credentials", () => {
		expect(redactUrl("https://host.example/api/items?token=secret&x=1")).toBe(
			"https://host.example/api/items",
		);
	});

	test("drops userinfo", () => {
		expect(redactUrl("https://user:pass@host.example/api/items")).toBe(
			"https://host.example/api/items",
		);
	});

	test("keeps scheme, host and path", () => {
		expect(redactUrl("http://127.0.0.1:4050/api/health")).toBe(
			"http://127.0.0.1:4050/api/health",
		);
	});

	test("falls back to stripping the query for non-absolute input", () => {
		expect(redactUrl("/api/health?token=secret")).toBe("/api/health");
	});
});
