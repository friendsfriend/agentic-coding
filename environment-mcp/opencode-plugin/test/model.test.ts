import { describe, expect, test } from "bun:test";
import {
	appsForTab,
	defaultTarget,
	filterApps,
	parseApp,
	parseConfigurationMutation,
	parseConfigurationRevision,
	parseContainerStats,
	parseGitChanges,
	parseGitDiff,
	parseGitRemotes,
	parseHistory,
	parseKubernetesClusters,
	parseKubernetesResources,
	parseOperationDetail,
	parseProviderChangeDetail,
	parseProviderChanges,
	parseProviderDiscussions,
	parseProviderFiles,
	parseProviderIssueComments,
	parseProviderIssueDetail,
	parseProviderIssues,
	parseProviderJobLogs,
	parseProviderJobs,
	parseProviderPipelines,
	parseProviderRepositories,
	parseProviderRepositoryMatches,
	parseProviders,
	parseProviderVersions,
	parseProviderWriteOutcome,
	parseProviderWrites,
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
	test("parses configuration revisions and preview/apply outcomes", () => {
		expect(
			parseConfigurationRevision({
				digest: "a".repeat(64),
				apps: 3,
				targets: 7,
				repositories: ["/repo"],
			}),
		).toEqual({
			digest: "a".repeat(64),
			apps: 3,
			targets: 7,
			repositories: ["/repo"],
		});
		expect(
			parseConfigurationMutation({
				status: "confirmation-required",
				expectedDigest: "a".repeat(64),
				nextDigest: "b".repeat(64),
				confirm: "c".repeat(64),
				summary: "create app",
			}),
		).toMatchObject({ status: "confirmation-required", summary: "create app" });
		expect(
			parseConfigurationMutation({
				status: "completed",
				digest: "b".repeat(64),
				summary: "created",
			}),
		).toEqual({
			status: "completed",
			digest: "b".repeat(64),
			summary: "created",
		});
	});

	test("parses local provider repository matches", () => {
		expect(
			parseProviderRepositoryMatches({
				matches: [
					{
						provider: "github-fixture",
						type: "github",
						reference: "org/repo",
						host: "github.com",
						url: "https://github.com/org/repo",
					},
				],
			}),
		).toEqual([
			{
				provider: "github-fixture",
				type: "github",
				reference: "org/repo",
				host: "github.com",
				url: "https://github.com/org/repo",
			},
		]);
	});

	test("parses provider write previews, receipts and replayed outcomes", () => {
		const preview = parseProviderWriteOutcome({
			status: "confirmation-required",
			digest: "a".repeat(64),
			intent: {
				provider: "github-fixture",
				action: "comment-change",
				target: "org/repo:1",
			},
		});
		expect(preview).toMatchObject({
			status: "confirmation-required",
			intent: { target: "org/repo:1" },
		});
		const writes = parseProviderWrites({
			writes: [
				{
					requestId: "comment-1",
					provider: "github-fixture",
					action: "comment-change",
					target: "org/repo:1",
					digest: "a".repeat(64),
					state: "completed",
					createdAt: 1,
					updatedAt: 2,
					result: { id: 10 },
				},
			],
		});
		expect(writes[0]).toMatchObject({
			state: "completed",
			result: { id: 10 },
		});
		expect(
			parseProviderWriteOutcome({
				status: "replayed",
				digest: "a".repeat(64),
				receipt: writes[0],
			}),
		).toMatchObject({ status: "replayed" });
	});

	test("parses authorized clusters and bounded resource output", () => {
		expect(
			parseKubernetesClusters({
				clusters: [
					{
						id: "devenv",
						context: "kind-devenv",
						repositories: ["/repo"],
					},
				],
			}),
		).toEqual([
			{ id: "devenv", context: "kind-devenv", repositories: ["/repo"] },
		]);
		expect(
			parseKubernetesResources({
				cluster: "devenv",
				namespace: "default",
				output: "NAME READY",
				truncated: true,
				items: [
					{
						kind: "Pod",
						name: "pod-a",
						status: "Running",
						ready: "1/1",
						restarts: 2,
						age: "3m",
					},
				],
			}),
		).toEqual({
			cluster: "devenv",
			namespace: "default",
			output: "NAME READY",
			truncated: true,
			items: [
				{
					kind: "Pod",
					name: "pod-a",
					status: "Running",
					ready: "1/1",
					restarts: 2,
					age: "3m",
				},
			],
		});
	});

	test("parses container stats entries and unavailable counts", () => {
		expect(
			parseContainerStats({
				containers: [
					{
						container: "a".repeat(64),
						app: "web",
						provider: "docker",
						cpuPercent: 1.5,
						memoryUsageBytes: 1024,
						memoryLimitBytes: 4096,
						pids: 2,
					},
				],
				unavailable: 1,
				note: "owned only",
			}),
		).toMatchObject({
			containers: [
				{
					container: "a".repeat(64),
					app: "web",
					cpuPercent: 1.5,
					memoryUsageBytes: 1024,
					pids: 2,
				},
			],
			unavailable: 1,
			note: "owned only",
		});
	});

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

	test("parses remotes with sanitized fetch and push URLs", () => {
		const remotes = parseGitRemotes({
			repository: "/repo",
			remotes: [
				{ name: "origin", fetchUrl: "git@github.com:org/repo.git" },
				{
					name: "mirror",
					fetchUrl: "https://mirror.example/repo.git",
					pushUrl: "ssh://mirror/repo.git",
				},
			],
		});
		expect(remotes.remotes).toHaveLength(2);
		expect(remotes.remotes[1]?.pushUrl).toBe("ssh://mirror/repo.git");
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
						worktree: "/worktrees/feature",
					},
				},
			],
		});
		expect(history.operations[0]?.subject?.target).toBe("run-mocked");
		expect(history.operations[0]?.subject?.worktree).toBe("/worktrees/feature");
	});

	test("parses provider summaries and list envelopes", () => {
		expect(
			parseProviders({
				providers: [
					{
						name: "github-fixture",
						type: "github",
						baseUrl: "https://api.github.example",
						username: "fixture",
						hasToken: true,
					},
				],
			}),
		).toEqual([
			{
				name: "github-fixture",
				type: "github",
				baseUrl: "https://api.github.example",
				username: "fixture",
				hasToken: true,
			},
		]);
		expect(
			parseProviderRepositories({
				repositories: [
					{
						reference: "org/repo",
						name: "repo",
						description: "fixture",
						url: "https://example/repo",
						defaultBranch: "main",
					},
				],
			})[0]?.reference,
		).toBe("org/repo");
		expect(
			parseProviderChanges({
				changes: [
					{
						id: "github-change-1",
						number: 1,
						title: "change",
						state: "open",
						sourceBranch: "feature",
						targetBranch: "main",
						author: "author",
						url: "https://example/1",
					},
				],
			})[0]?.sourceBranch,
		).toBe("feature");
		expect(
			parseProviderIssues({
				issues: [
					{
						id: "github-issue-2",
						number: 2,
						title: "issue",
						state: "open",
						author: "author",
						labels: ["bug"],
						url: "https://example/2",
					},
				],
			})[0]?.labels,
		).toEqual(["bug"]);
		expect(
			parseProviderPipelines({
				pipelines: [
					{
						id: 3,
						name: "CI",
						status: "completed",
						conclusion: "success",
						url: "https://example/3",
					},
				],
			})[0]?.conclusion,
		).toBe("success");
		expect(
			parseProviderJobs({
				jobs: [
					{
						id: 4,
						name: "test",
						status: "completed",
						stage: "test",
						url: "https://example/4",
					},
				],
			})[0]?.stage,
		).toBe("test");
		expect(
			parseProviderChangeDetail({
				change: {
					id: "github-change-1",
					number: 1,
					title: "change",
					state: "open",
					sourceBranch: "feature",
					targetBranch: "main",
					author: "author",
					url: "https://example/1",
					body: "body",
					changedFiles: 2,
				},
			}),
		).toMatchObject({ body: "body", changedFiles: 2 });
		expect(
			parseProviderFiles({
				files: [
					{
						path: "src/a.ts",
						status: "modified",
						patch: "@@",
					},
				],
				truncated: true,
			}),
		).toMatchObject({
			truncated: true,
			files: [{ path: "src/a.ts", patch: "@@" }],
		});
		expect(
			parseProviderVersions({
				versions: [{ sha: "a".repeat(40), message: "commit" }],
			})[0]?.sha,
		).toBe("a".repeat(40));
		expect(
			parseProviderIssueDetail({
				issue: {
					id: "github-issue-2",
					number: 2,
					title: "issue",
					state: "open",
					author: "author",
					labels: ["bug"],
					url: "https://example/2",
					body: "body",
				},
			}),
		).toMatchObject({ body: "body" });
		expect(
			parseProviderIssueComments({
				comments: [
					{
						id: "61",
						author: "reviewer",
						body: "issue note",
					},
				],
			})[0]?.body,
		).toBe("issue note");
		expect(
			parseProviderDiscussions({
				discussions: [
					{
						id: "1",
						author: "reviewer",
						body: "note",
						resolved: true,
					},
				],
			})[0]?.resolved,
		).toBe(true);
		expect(
			parseProviderJobLogs({
				output: "line",
				truncated: true,
			}),
		).toEqual({ output: "line", truncated: true });
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
