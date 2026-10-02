import { describe, expect, test } from "bun:test";
import { codingToolNames } from "../src/agent-host/tools.ts";

describe("durable coding tool policy", () => {
	test("read-only offers read and bash only", () => {
		expect(codingToolNames(true)).toEqual(["read", "bash"]);
	});
	test("writable offers the full coding tool set", () => {
		expect(codingToolNames(false)).toEqual(["read", "write", "edit", "bash"]);
	});
});
