/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import type { StageAppStatus, StageStatus } from "@devenv/core";
import { testRender } from "@opentui/solid";
import {
	StagePickerModal,
	type StagePickerModalProps,
} from "./stage-picker-view.tsx";

// The stage picker's rendered dialog (`open-stage-from-environments`): the list,
// the filter, the empty catalog and a failed read. The dialog is presentational,
// so these cases pass props and never read the store or the server.

function stage(
	ident: string,
	displayName: string,
	access: StageStatus["access"] = "read-only",
	apps: StageAppStatus[] = [],
): StageStatus {
	return {
		ident,
		displayName,
		environment: "acceptance",
		system: "portal",
		access,
		exclusive: false,
		apps,
		origins: [],
		readOnlyExceptions: [],
		limits: {
			maxSessions: 1,
			maxActionsPerMinute: 10,
			maxWaitSeconds: 30,
			maxScreenshots: 5,
			maxRecordingMinutes: 1,
			maxLoginHandoffSeconds: 60,
		},
		identityCache: {
			enabled: true,
			ttlMinutes: 30,
			maxEntries: 1,
			refreshSeconds: 60,
		},
		data: {},
		wiki: { processes: [] },
		diagnostics: [],
	};
}

function props(
	overrides: Partial<StagePickerModalProps> = {},
): StagePickerModalProps {
	return {
		step: "stages",
		stages: [],
		apps: [],
		selectedIndex: 0,
		appIndex: 0,
		filterQuery: "",
		filterActive: false,
		loading: false,
		error: null,
		...overrides,
	};
}

async function render(overrides: Partial<StagePickerModalProps>) {
	const t = await testRender(() => <StagePickerModal {...props(overrides)} />, {
		width: 90,
		height: 24,
	});
	await t.flush();
	const frame = t.captureCharFrame();
	t.renderer.destroy();
	return frame;
}

test("lists each stage with its ident, environment and access marker", async () => {
	const frame = await render({
		stages: [
			stage("acceptance", "Acceptance"),
			stage("production", "Production", "writable"),
		],
	});

	expect(frame).toContain("Open Stage");
	expect(frame).toContain("Acceptance · acceptance · acceptance · read-only");
	expect(frame).toContain("Production · production · acceptance · writable");
});

test("the filter bar shows its query over the filtered list", async () => {
	// Filtering itself is the stage actions' single implementation
	// (`filterStages`); the dialog renders the rows it is given.
	const frame = await render({
		stages: [stage("production", "Production")],
		filterActive: true,
		filterQuery: "prod",
	});

	expect(frame).toContain("/prod");
	expect(frame).toContain("Production");
	expect(frame).not.toContain("Acceptance");
});

test("an unconfigured catalog says so", async () => {
	const frame = await render({});

	expect(frame).toContain(
		"No stages configured — see Settings → Stages / docs",
	);
});

test("a failed read shows the server's message instead of the list", async () => {
	const frame = await render({
		stages: [],
		error: "HTTP 401 Error: invalid token",
	});

	expect(frame).toContain("HTTP 401 Error: invalid token");
	expect(frame).not.toContain("No stages configured");
});

test("the second step lists the chosen stage's applications", async () => {
	const frame = await render({
		step: "apps",
		stageName: "Acceptance",
		apps: [
			{
				key: "portal",
				label: "Portal",
				url: "https://acceptance.example.test/portal",
				kind: "ui",
				roles: [],
			},
		],
	});

	expect(frame).toContain("Open Stage · Acceptance");
	expect(frame).toContain("Portal · https://acceptance.example.test/portal");
});
