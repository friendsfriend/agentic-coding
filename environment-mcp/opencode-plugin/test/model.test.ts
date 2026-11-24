import { describe, expect, test } from "bun:test";
import {
	appsForTab,
	defaultTarget,
	filterApps,
	parseApp,
	parseGitChanges,
	parseGitDiff,
	parseHistory,
	parseOperationDetail,
	parseStatus,
	parseTelemetry,
	targetSummary,
	targetsFor,
} from "../src/environments/model.ts";

const app = parseApp({
	id: "customer-external-mw",
	repository: "/repo/customer-external-mw",
	kind: "app",
	defaults: { build: "build-docker", run: "run-mocked" },
	targets: [
		{ id: "build-docker", action: "build", runtime: "docker" },
		{
			id: "run-mocked",
			action: "run",
			runtime: "compose",
			profile: "Mocked",
		},
		{ id: "run-qa", action: "run", runtime: "compose", profile: "QA" },
		{ id: "test-maven", action: "test", runtime: "shell" },
	],
});
if (!app) throw new Error("expected app");

describe("environment model", () => {
	test("parses git changes and diff envelopes", () => {
		const changes = parseGitChanges({
			repository: "/repo",
			truncated: false,
			changes: [
				{
					path: "src/a.ts",
					kind: "modified",
					staged: false,
					worktree: true,
				},
				{
					path: "src/b.ts",
					originalPath: "src/old.ts",
					kind: "renamed",
					staged: true,
					worktree: false,
				},
			],
		});
		expect(changes.changes).toHaveLength(2);
		expect(changes.changes[1]?.originalPath).toBe("src/old.ts");
		const diff = parseGitDiff({
			repository: "/repo",
			path: "src/a.ts",
			diff: "+added\n-removed",
			binary: false,
			truncated: true,
		});
		expect(diff).toMatchObject({
			path: "src/a.ts",
			binary: false,
			truncated: true,
		});
		expect(diff.diff).toContain("+added");
	});

	test("parses live operation progress", () => {
		const detail = parseOperationDetail({
			id: "00000000-0000-4000-8000-000000000001",
			scope: "00000000-0000-4000-8000-000000000002",
			kind: "executable",
			digest: "a".repeat(64),
			state: "issued",
			revision: 2,
			createdAt: 1,
			inspectionRequired: false,
			historical: false,
			progress: { offset: 12, text: "#1 RUN x\n", reset: true },
		});
		expect(detail.progress).toEqual({
			offset: 12,
			text: "#1 RUN x\n",
			reset: true,
		});
	});

	test("parses apps and selects default and matching targets", () => {
		expect(app.kind).toBe("app");
		expect(app.targets).toHaveLength(4);
		expect(targetsFor(app, "run").map((target) => target.id)).toEqual([
			"run-mocked",
			"run-qa",
		]);
		expect(defaultTarget(app, "run")?.id).toBe("run-mocked");
		expect(targetSummary(app)).toBe("⚒ ✓ ▶2");
	});

	test("filters and groups apps without inventing kinds", () => {
		const library = parseApp({
			id: "commons-mw",
			repository: "/repo/commons",
			kind: "library",
			targets: [],
		});
		if (!library) throw new Error("expected library");
		const infra = parseApp({
			id: "redis",
			repository: "/repo/devenv",
			kind: "infrastructure",
			targets: [],
		});
		if (!infra) throw new Error("expected infra");
		expect(appsForTab([app, library, infra], "applications")).toEqual([app]);
		expect(appsForTab([app, library, infra], "libraries")).toEqual([library]);
		expect(appsForTab([app, library, infra], "infrastructure")).toEqual([
			infra,
		]);
		expect(filterApps([app, library], "mocked")).toEqual([app]);
		expect(filterApps([app, library], "commons")).toEqual([library]);
		expect(filterApps([app, library], "missing")).toEqual([]);
	});

	test("parses owned resources and safe operation attribution", () => {
		const status = parseStatus({
			scope: { id: "scope", state: "active", revision: 2 },
			owned: [
				{
					id: "owned",
					app: "customer-external-mw",
					kind: "container",
					runtimeId: "abcdef0123456789",
					createdAt: 10,
				},
			],
		});
		expect(status.owned?.[0]?.app).toBe("customer-external-mw");
		const history = parseHistory({
			operations: [
				{
					id: "operation",
					state: "awaiting-approval",
					revision: 1,
					createdAt: 1,
					subject: {
						app: "customer-external-mw",
						target: "run-mocked",
						action: "run",
					},
				},
			],
		});
		expect(history.operations[0]?.subject?.target).toBe("run-mocked");
	});

	test("parses bounded telemetry summaries", () => {
		const telemetry = parseTelemetry({
			app: "customer-external-mw",
			transport: "tls-host-gateway-v1",
			bytes: 12,
			traces: [
				{ traceId: "a".repeat(32), root: "GET /", spanCount: 2, errors: 0 },
			],
		});
		expect(telemetry.app).toBe("customer-external-mw");
		expect(telemetry.traces[0]?.root).toBe("GET /");
	});
});
