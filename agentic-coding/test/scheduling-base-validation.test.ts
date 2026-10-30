import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SchedulingInfrastructureError } from "../src/server/scheduling/adapters.ts";
import { validateSessionBase } from "../src/server/scheduling/base-validation.ts";

for (const cancel of [false, true])
	test(`base validation ${cancel ? "cancellation" : "timeout"} releases the caller only after killing/reaping its child`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "base-deadline-")),
			pidFile = path.join(root, "pid");
		const controller = new AbortController();
		try {
			fs.writeFileSync(
				path.join(root, "git"),
				`#!/bin/sh\nprintf '%s' $$ > '${pidFile}'\nexec /bin/sleep 600\n`,
				{ mode: 0o700 },
			);
			const started = Date.now(),
				pending = validateSessionBase(root, "main", {
					timeoutMs: cancel ? 5000 : 300,
					signal: controller.signal,
					gitExecutable: path.join(root, "git"),
				}).catch((error) => error);
			for (let index = 0; index < 100 && !fs.existsSync(pidFile); index++)
				await Bun.sleep(5);
			expect(fs.existsSync(pidFile)).toBe(true);
			if (cancel) controller.abort();
			expect(await pending).toBeInstanceOf(SchedulingInfrastructureError);
			expect(Date.now() - started).toBeLessThan(2000);
			const pid = Number(fs.readFileSync(pidFile, "utf8"));
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			controller.abort();
			fs.rmSync(root, { force: true, recursive: true });
		}
	});
