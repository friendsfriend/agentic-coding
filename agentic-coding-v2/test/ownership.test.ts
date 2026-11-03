import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../src/lock.ts";

test("only one host may write a state directory; lock cleanup cannot steal another owner's lock", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-owner-"));
	try {
		const release = acquireLock(root);
		expect(() => acquireLock(root)).toThrow("already locked");
		release();
		const again = acquireLock(root);
		fs.writeFileSync(path.join(root, "host.lock"), '{"token":"another"}');
		expect(again).toThrow("ownership changed");
		expect(fs.existsSync(path.join(root, "host.lock"))).toBe(true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
