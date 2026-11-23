import { describe, expect, test } from "bun:test";
import { errorCopy } from "../src/errors.ts";

describe("environment error copy", () => {
	test("separates service connectivity from capability refusal", () => {
		expect(errorCopy("operation-unavailable").title).toBe("Request failed");
		expect(errorCopy("client token unavailable: /tmp/token").title).toBe(
			"Environment unavailable",
		);
		expect(errorCopy("fetch failed").hint).toContain("service is running");
		expect(errorCopy("network not found").title).toBe("Request failed");
	});
});
