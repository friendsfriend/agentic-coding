// Settings: the read-only **Stages** section and its one protected write
// (`add-stage-testing-foundation`, task 5.1).
//
// The section reads the connected server (`GET /api/v1/stages`) and asks it to
// set one referenced `.env` credential (`POST /api/v1/stages/credential`); a
// transport-less shell goes through the same in-process module. Both halves are
// exercised here against a temporary configuration root — never the real one —
// and the two rules that make the section safe are asserted at every step: a
// credential value never appears in a rendered item or a read, and the write
// touches only the one key the catalog references.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file asserts the literal `${VARIABLE}` reference syntax, so every occurrence is intentional fixture text, not a template placeholder.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFile } from "../src/env-file.ts";
import {
	clearBackendClient,
	configureBackendClient,
} from "../src/server/client.ts";
import { stagePaths } from "../src/server/stages/catalog.ts";
import { setStageCredentialValue } from "../src/server/stages/operations.ts";
import {
	type SettingsContext,
	settingsItems,
} from "../src/tui/settings/items.ts";
import {
	clearStageSnapshot,
	lastStageError,
	refreshStageStatus,
	setStageCredential,
} from "../src/tui/settings/stages.ts";

const USERNAME = "clerk-user-sentinel";
const PREVIOUS_PASSWORD = "previous-password-sentinel";
/** The variable the stage references and never sets: the row to fill in. */
const MISSING = "GRID_INT_CLERK_PASSWORD";

/** One allowed stage and one refused file, in a private configuration root. */
function withRoot<T>(run: (configDir: string) => Promise<T>): Promise<T> {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-stages-"));
	const defsDir = stagePaths(configDir).defsDir;
	fs.mkdirSync(defsDir, { recursive: true });
	fs.writeFileSync(
		path.join(defsDir, "grid-int.json"),
		`${JSON.stringify(
			{
				ident: "grid-int",
				displayName: "Grid integration",
				environment: "integration",
				system: "grid",
				access: "writable",
				planApproval: "always",
				apps: {
					web: {
						label: "Grid web",
						url: "https://grid-int.example.test/",
						kind: "ui",
						roles: {
							clerk: {
								login: "web-form",
								username: "${GRID_INT_CLERK_USERNAME}",
								password: `\${${MISSING}}`,
							},
						},
					},
				},
				logins: {
					"web-form": {
						kind: "form",
						success: { notOrigin: "https://grid-int.example.test" },
						steps: [
							{
								fields: [
									{ credential: "username", label: "User" },
									{ credential: "password", label: "Password" },
								],
							},
						],
					},
				},
				allowedOrigins: ["https://login.example.test"],
			},
			null,
			2,
		)}\n`,
	);
	// A file the catalog refuses: a credential inlined instead of referenced.
	fs.writeFileSync(
		path.join(defsDir, "grid-legacy.json"),
		`${JSON.stringify(
			{
				ident: "grid-legacy",
				displayName: "Grid legacy",
				environment: "integration",
				system: "grid",
				access: "read-only",
				apps: {
					web: {
						label: "Grid web",
						url: "https://grid.example.test/",
						kind: "ui",
						roles: {
							clerk: { username: "clerk", password: "hunter2hunter2" },
						},
					},
				},
			},
			null,
			2,
		)}\n`,
	);
	fs.writeFileSync(
		path.join(configDir, ".env"),
		`# an unrelated key the section must leave alone\nOTHER_KEY=untouched\nGRID_INT_CLERK_USERNAME=${USERNAME}\n`,
	);
	const previous = process.env.AGENTIC_CODING_CONFIG_DIR;
	process.env.AGENTIC_CODING_CONFIG_DIR = configDir;
	clearStageSnapshot();
	return run(configDir).finally(() => {
		clearStageSnapshot();
		if (previous === undefined) delete process.env.AGENTIC_CODING_CONFIG_DIR;
		else process.env.AGENTIC_CODING_CONFIG_DIR = previous;
	});
}

/** The sections every context carries; only the Stages fields are under test. */
function context(
	stages: Awaited<ReturnType<typeof refreshStageStatus>>,
): SettingsContext {
	return {
		themes: ["catppuccin"],
		activeTheme: "catppuccin",
		clientSettingsPath: "/tmp/tui.json",
		section: "stages",
		agents: {
			scope: "project",
			projectIdent: "checkout",
			repository: "/repo/checkout",
			source: "project",
			files: [],
			conflicts: [],
			profiles: [],
			presets: [],
			routing: [],
		},
		providers: { state: "ready", providers: [] },
		stages,
	};
}

describe("settings: Stages", () => {
	test("the section shows allowed stages, credential presence and refusals, and no value", async () => {
		await withRoot(async () => {
			const snapshot = await refreshStageStatus();
			expect(snapshot?.stages.map((stage) => stage.ident)).toEqual([
				"grid-int",
			]);
			expect(snapshot?.excluded.map((file) => file.file)).toEqual([
				"grid-legacy.json",
			]);
			// The refusal names the rule and the field, never the value it found.
			expect(snapshot?.excluded[0]?.diagnostics.join(" ")).toContain(
				"${VARIABLE}",
			);
			expect(snapshot?.excluded[0]?.diagnostics.join(" ")).not.toContain(
				"hunter2hunter2",
			);

			const items = settingsItems(context(snapshot));
			const byId = (id: string) =>
				items.find((item) => item.id === id) as
					| { value: string; detail: string; editable: boolean }
					| undefined;
			// Validation state, access and structure of the allowed stage.
			expect(byId("stages.root")?.value).toBe("1 allowed · 1 refused");
			const stage = byId("stages.stage.grid-int");
			expect(stage?.value).toBe("writable · integration/grid · 1 app");
			expect(stage?.detail).toContain("plan approval always");
			expect(stage?.detail).toContain(
				"navigations stay on https://grid-int.example.test, https://login.example.test",
			);
			const app = byId("stages.app.grid-int.web");
			expect(app?.value).toBe("https://grid-int.example.test/");
			expect(app?.detail).toContain("roles: clerk");

			// Credential status: presence, never the value. The variable is named with
			// both statuses, because a value that is already set can still be replaced.
			const set = byId("stages.credentials.grid-int.web.clerk.username");
			expect(set?.value).toBe("set GRID_INT_CLERK_USERNAME (masked)");
			expect(set?.editable).toBe(true);
			expect(set?.detail).toContain("Enter replaces GRID_INT_CLERK_USERNAME");
			const missing = byId("stages.credentials.grid-int.web.clerk.password");
			expect(missing?.value).toBe(`missing ${MISSING}`);
			expect(missing?.editable).toBe(true);
			expect(missing?.detail).toContain(`Enter sets ${MISSING}`);
			expect(
				items.find(
					(item) =>
						item.id === "stages.credentials.grid-int.web.clerk.password",
				)?.action,
			).toEqual({
				kind: "stage-credential",
				variable: MISSING,
				// The field first, then the role, the app and the stage: a narrow row
				// clips the end, and the field is what the write touches.
				label: "password · clerk · Grid web · Grid integration",
			});
			// The refused file is listed with its diagnostics and cannot be edited
			// from here: a stage a file got wrong is fixed in the file.
			expect(byId("stages.excluded.grid-legacy.json")?.value).toContain(
				"${VARIABLE}",
			);
			expect(byId("stages.excluded.grid-legacy.json")?.editable).toBe(false);

			// Nothing on the page carries a value: not the sentinel the `.env`
			// holds, not the one the refused file inlined.
			const rendered = JSON.stringify(items);
			expect(rendered).not.toContain(USERNAME);
			expect(rendered).not.toContain(PREVIOUS_PASSWORD);
			expect(rendered).not.toContain("hunter2hunter2");
		});
	});

	test("setting a credential writes that one key and leaves the rest of `.env` byte-identical", async () => {
		await withRoot(async (configDir) => {
			await refreshStageStatus();
			const envFile = path.join(configDir, ".env");
			const before = fs.readFileSync(envFile, "utf8");
			expect(await setStageCredential(MISSING, PREVIOUS_PASSWORD)).toBe(true);
			expect(lastStageError()).toBeUndefined();

			const after = fs.readFileSync(envFile, "utf8");
			// The unrelated key and the comment are still there, in order, and the
			// new line is the only difference.
			expect(after.startsWith(before)).toBe(true);
			expect(after.slice(before.length)).toBe(
				`${MISSING}=${PREVIOUS_PASSWORD}\n`,
			);
			expect(loadEnvFile(envFile).get("OTHER_KEY")).toBe("untouched");
			expect(loadEnvFile(envFile).get("GRID_INT_CLERK_USERNAME")).toBe(
				USERNAME,
			);

			// The status the section re-reads says it is set, and still carries no
			// value.
			const snapshot = await refreshStageStatus();
			const items = settingsItems(context(snapshot));
			const row = items.find(
				(item) => item.id === "stages.credentials.grid-int.web.clerk.password",
			);
			expect(row?.value).toBe(`set ${MISSING} (masked)`);
			expect(row?.editable).toBe(true);
			expect(JSON.stringify(items)).not.toContain(PREVIOUS_PASSWORD);
		});
	});

	test("a variable no stage references is refused and nothing is written", async () => {
		await withRoot(async (configDir) => {
			await refreshStageStatus();
			const envFile = path.join(configDir, ".env");
			const before = fs.readFileSync(envFile, "utf8");
			expect(await setStageCredential("NOT_A_STAGE_VARIABLE", "value")).toBe(
				false,
			);
			// The section surfaces the server's own reason.
			expect(lastStageError()).toContain("NOT_A_STAGE_VARIABLE");
			expect(fs.readFileSync(envFile, "utf8")).toBe(before);
			// The in-process write refuses the same way, so a shell that renders this
			// section can never become a general `.env` writer.
			await expect(
				setStageCredentialValue("NOT_A_STAGE_VARIABLE", "value"),
			).rejects.toThrow(/no allow-listed stage references/);
			expect(fs.readFileSync(envFile, "utf8")).toBe(before);
		});
	});

	test("the section renders a retry before any read and after a failed one", async () => {
		// Nothing read yet, and no error: the section is *loading*, and it carries
		// its own retry row either way.
		const loading = settingsItems(context(undefined));
		expect(loading.map((item) => item.id)).toEqual([
			"stages.unavailable",
			"stages.retry",
		]);
		expect(loading[0]?.value).toBe("loading…");
		expect(loading[0]?.editable).toBe(false);
		expect(loading[1]?.editable).toBe(true);
		// Two states, two labels: a row over a *loading* section says what it does
		// (read again), and one over a failed read says what it repairs.
		expect(loading[1]?.label).toBe("Read the stage catalog again");
		expect(loading[1]?.action).toEqual({ kind: "retry" });

		// A failed read is a different fact, and the reason is the server's own.
		clearStageSnapshot();
		configureBackendClient({
			baseUrl: "http://127.0.0.1:9",
			token: "test-token",
			ownerId: "settings-stages-test",
		});
		try {
			expect(await refreshStageStatus()).toBeUndefined();
			const reason = lastStageError() ?? "";
			expect(reason).not.toBe("");
			const failed = settingsItems(context(undefined));
			expect(failed.map((item) => item.id)).toEqual([
				"stages.unavailable",
				"stages.retry",
			]);
			expect(failed[0]?.value).toBe("unavailable");
			expect(failed[0]?.detail).toContain(reason);
			expect(failed[0]?.detail).toContain("never falls back to a local");
			expect(failed[1]?.label).toBe("Retry the stage read");
			expect(failed[1]?.action).toEqual({ kind: "retry" });
		} finally {
			clearBackendClient();
			clearStageSnapshot();
		}
	});

	test("an empty definitions directory says where a stage definition goes", async () => {
		const configDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "settings-stages-empty-"),
		);
		const previous = process.env.AGENTIC_CODING_CONFIG_DIR;
		process.env.AGENTIC_CODING_CONFIG_DIR = configDir;
		clearStageSnapshot();
		try {
			const snapshot = await refreshStageStatus();
			expect(snapshot?.stages).toEqual([]);
			expect(snapshot?.excluded).toEqual([]);
			const items = settingsItems(context(snapshot));
			expect(items.map((item) => item.id)).toEqual([
				"stages.root",
				"stages.empty",
			]);
			const empty = items.find((item) => item.id === "stages.empty");
			expect(empty?.value).toBe(path.join(configDir, "stages", "definitions"));
		} finally {
			clearStageSnapshot();
			if (previous === undefined) delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previous;
		}
	});
});
