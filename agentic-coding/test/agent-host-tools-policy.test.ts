import { describe, expect, test } from "bun:test";
import { codingToolNames } from "../src/agent-host/tools.ts";

describe("durable coding tool policy", () => {
	// This narrows pi-durable's own coding tools. A read-only run's full
	// selection adds the host's `grep` and `ask_jev` on top (asserted against a
	// live host in `agent-host-watch.test.ts`), because the verifier briefs name
	// both and a read-only run offers an explicit list.
	test("read-only narrows the coding tools to read and bash", () => {
		expect(codingToolNames(true)).toEqual(["read", "bash"]);
	});
	test("writable offers the full coding tool set", () => {
		expect(codingToolNames(false)).toEqual(["read", "write", "edit", "bash"]);
	});
});
