// Cross-runtime private-operation contract
// (port-project-catalog-and-state-to-bun, tasks 3.2, 3.4, 4.1).
//
// `test/fixtures/environment/operations/*.json` are captured from the Go client
// (`server/pkg/environment/contract_test.go` asserts them byte-for-byte). This
// suite feeds the same files into the Bun authority, so a drift on either side —
// operation name, field name, timestamp format, required field — fails here or
// in the Go suite rather than in a live mixed-runtime stack.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnvironmentAuthority } from "../src/server/environment/authority.ts";
import {
	decodeEnvironmentOperation,
	EnvironmentOperationError,
	runEnvironmentOperation,
} from "../src/server/environment/private-api.ts";

const OPERATIONS = path.join(
	import.meta.dir,
	"fixtures",
	"environment",
	"operations",
);
const CONFIG_FIXTURES = path.join(import.meta.dir, "fixtures", "environment");

function operationFiles(): Array<{ name: string; body: unknown }> {
	return fs
		.readdirSync(OPERATIONS)
		.filter((entry) => entry.endsWith(".json"))
		.sort()
		.map((entry) => ({
			name: entry.replace(/\.json$/, ""),
			body: JSON.parse(fs.readFileSync(path.join(OPERATIONS, entry), "utf8")),
		}));
}

/** An authority over a temporary home plus a worktree-apps configuration. */
async function withAuthority(
	work: (
		authority: ReturnType<typeof createEnvironmentAuthority>,
		fixture: { configDir: string; home: string },
	) => void | Promise<void>,
): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-contract-"));
	const home = path.join(dir, "home");
	const configDir = path.join(dir, "config");
	fs.mkdirSync(home, { recursive: true });
	// A configuration that only has `alpha`: the captured contract includes an
	// `addApp` for `beta`, so the fixture must not already define it.
	fs.cpSync(path.join(CONFIG_FIXTURES, "config", "contract-apps"), configDir, {
		recursive: true,
	});
	try {
		const authority = createEnvironmentAuthority({ homeDir: home, configDir });
		try {
			await work(authority, { configDir, home });
		} finally {
			authority.state.close();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("Go client operation contract", () => {
	test("every captured envelope decodes", () => {
		const files = operationFiles();
		expect(files.length).toBeGreaterThanOrEqual(20);
		for (const file of files)
			expect(() => decodeEnvironmentOperation(file.body)).not.toThrow();
	});

	test("every captured envelope executes against the authority exactly once", async () => {
		await withAuthority(async (authority) => {
			// Seed the rows the read operations of the contract expect, so a
			// captured read is exercised against real content rather than an
			// always-empty result.
			runEnvironmentOperation(authority, {
				operation: "state.setAppState",
				params: {
					ident: "leased-app",
					branch: "feature/x",
					activeWorktree: "feature/x",
					mainWorktreeBranch: "main",
				},
			});
			runEnvironmentOperation(authority, {
				operation: "state.setDependencyLease",
				params: {
					targetId: "lease:db",
					ownerRunId: "run-A",
					ownerApp: "leased-app",
					lifecycle: "owned",
					updatedAt: "2024-04-05T06:07:08Z",
				},
			});
			runEnvironmentOperation(authority, {
				operation: "state.addActionLogEvent",
				params: {
					runId: "run-A",
					stepId: "step-a",
					eventJson: '{"type":"action.step.output","properties":{}}',
					maxEntries: 50000,
				},
			});
			runEnvironmentOperation(authority, {
				operation: "state.addScriptArgsHistory",
				params: {
					relativePath: "scripts/build.sh",
					values: { target: "release" },
					maxEntries: 50,
				},
			});
			runEnvironmentOperation(authority, {
				operation: "state.addActionEvent",
				params: {
					eventJson: '{"type":"action.run.started","properties":{}}',
					maxEntries: 50000,
				},
			});

			for (const file of operationFiles()) {
				const operation = decodeEnvironmentOperation(file.body);
				expect(() =>
					runEnvironmentOperation(authority, operation),
				).not.toThrow();
			}

			// The captured mutations landed where the Go caller expects them.
			expect(authority.state.getAppState("leased-app").branch).toBe(
				"feature/x",
			);
			expect(authority.state.getAppState("alpha").branch).toBe("main");
			expect(authority.state.getAppRunTargetInfo("leased-app")?.display).toBe(
				"docker:local",
			);
			// The captured envelope set is applied in file-name order, so the
			// delete runs before the set: the lease the set re-creates is present.
			expect(
				authority.state.getDependencyLeases().map((lease) => lease.targetId),
			).toEqual(["lease:db"]);
			// The captured set adds `beta` and then removes it again, so the
			// published snapshot reflects the last captured operation.
			expect(authority.manager.getAppByIdent("beta")).toBeUndefined();
			expect(authority.manager.getAppByIdent("alpha")?.activeWorktree).toBe(
				"feature/x",
			);
			// The captured history insert ran twice (seed plus envelope), newest
			// first, and no unrelated entry appeared.
			expect(
				authority.state.getScriptArgsHistory("scripts/build.sh", 50),
			).toEqual([{ target: "release" }, { target: "release" }]);
			expect(authority.state.getActionLogEvents("run-A", "step-a", 50)).toEqual(
				[
					'{"type":"action.step.output","properties":{}}',
					'{"type":"action.step.output","properties":{"output":"line"}}',
				],
			);
		});
	});

	test("the captured time cursor keeps the stored textual format", () => {
		const file = operationFiles().find(
			(entry) => entry.name === "state.getActionEventsBetween",
		);
		expect(file).toBeDefined();
		const operation = decodeEnvironmentOperation(file?.body);
		expect(operation).toMatchObject({
			operation: "state.getActionEventsBetween",
			params: {
				limit: 50000,
				since: "2024-04-05T06:07:11.000Z",
				before: "2024-04-05T07:07:11.000Z",
			},
		});
	});

	test("an envelope with an unknown field is rejected, not silently accepted", async () => {
		await withAuthority(() => {
			const file = operationFiles().find(
				(entry) => entry.name === "state.setBranch",
			);
			const drifted = {
				...(file?.body as Record<string, unknown>),
				params: { ident: "alpha", branch: "main", sql: "SELECT 1" },
			};
			expect(() => decodeEnvironmentOperation(drifted)).toThrow(
				EnvironmentOperationError,
			);
			// Decoding is the boundary; an undecoded object must never reach a
			// dispatch that would read the extra field.
			expect(() => decodeEnvironmentOperation(drifted)).toThrow(/sql/);
		});
	});
});
