import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDiagnosticsLog } from "../src/persistence/diagnostics-log.ts";

test("durable diagnostics are private, sanitized and bounded", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-diagnostics-"));
	const log = openDiagnosticsLog(root, { maxBytes: 1024 });
	try {
		log.append({ event: "startup", count: 2 });
		log.append({
			event: "capability",
			action: "env_list",
			scope: "11111111-1111-4111-8111-111111111111",
		});
		log.append({
			event: "capability",
			action: "bad value",
			code: "Bad Code",
		});
		const events = log.tail(10);
		expect(events).toMatchObject([
			{ event: "startup", count: 2 },
			{
				event: "capability",
				action: "env_list",
				scope: "11111111-1111-4111-8111-111111111111",
			},
			{ event: "capability" },
		]);
		const file = path.join(root, "diagnostics.jsonl");
		expect(fs.statSync(file).mode & 0o077).toBe(0);
		expect(fs.readFileSync(file, "utf8")).not.toContain("bad value");
		for (let index = 0; index < 40; index++)
			log.append({ event: "capability", action: "env_status" });
		expect(fs.existsSync(`${file}.1`)).toBe(true);
		expect(log.tail(5).every((event) => event.event === "capability")).toBe(
			true,
		);
	} finally {
		log.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
