// GitLab CI capability (`port-git-providers-and-ai-to-bun`, tasks 3.8),
// ported from `server/pkg/gitlab/{ci,client}.go`.
//
// The test-report grouping the Go client computed (`FailedTests`,
// `FailedTestGroups`) is deliberately not ported: both fields carry
// `json:"-"`, so they never reached the client, and the route returns the
// provider summary as-is.
import {
	clampProviderLimit,
	type GitLabClient,
	type GitLabProjectInfo,
	projectPath,
} from "./gitlab-client.ts";
import { goRfc3339 } from "./provider-time.ts";

export interface GitLabPipeline {
	id: number;
	iid: number;
	project_id: number;
	status: string;
	ref: string;
	sha: string;
	web_url: string;
	created_at: string;
	updated_at: string;
	user: { name: string; username: string };
	source: string;
}

export interface GitLabJob {
	id: number;
	name: string;
	stage: string;
	status: string;
	web_url: string;
	created_at?: string;
	started_at?: string;
	finished_at?: string;
	duration?: number;
	queued_duration?: number;
	runner?: { id: number; description: string; name: string };
	pipeline: { id: number };
}

export interface GitLabTestCase {
	name: string;
	classname: string;
	status: string;
	execution_time: number;
	system_output?: string;
	stack_trace?: string;
}

export interface GitLabTestSuite {
	name: string;
	test_cases: GitLabTestCase[];
}

export interface GitLabTestSummary {
	total: number;
	success: number;
	failed: number;
	skipped: number;
	error: number;
	test_suites?: GitLabTestSuite[];
}

export class GitLabCi {
	private readonly client: GitLabClient;
	private readonly project: GitLabProjectInfo;

	constructor(client: GitLabClient, project: GitLabProjectInfo) {
		this.client = client;
		this.project = project;
	}

	private get base(): string {
		return `${this.client.baseUrl}/api/v4/projects/${projectPath(this.project)}`;
	}

	async getPipelines(limit: number): Promise<GitLabPipeline[]> {
		// Sorted like Go's `url.Values.Encode()`.
		const params = new URLSearchParams();
		params.set("order_by", "id");
		params.set("per_page", String(clampProviderLimit(limit)));
		params.set("sort", "desc");
		const response = await this.client.request(
			`${this.base}/pipelines?${params.toString()}`,
		);
		this.expectStatus(response, "pipelines");
		return parseArray<GitLabPipeline>(
			response.body,
			"failed to parse JSON response",
		).map((pipeline) => ({
			...pipeline,
			created_at: goRfc3339(pipeline.created_at),
			updated_at: goRfc3339(pipeline.updated_at),
		}));
	}

	async getPipelineJobs(pipelineId: number): Promise<GitLabJob[]> {
		const response = await this.client.request(
			`${this.base}/pipelines/${pipelineId}/jobs`,
		);
		this.expectStatus(response, `pipeline ${pipelineId}`);
		return parseArray<GitLabJob>(
			response.body,
			"failed to parse JSON response",
		).map((job) => ({
			...job,
			...(job.created_at ? { created_at: goRfc3339(job.created_at) } : {}),
			...(job.started_at ? { started_at: goRfc3339(job.started_at) } : {}),
			...(job.finished_at ? { finished_at: goRfc3339(job.finished_at) } : {}),
		}));
	}

	/** Job trace as plain text. */
	async getJobLogs(jobId: number): Promise<string> {
		const response = await this.client.request(
			`${this.base}/jobs/${jobId}/trace`,
			{
				accept: "text/plain",
			},
		);
		switch (response.status) {
			case 200:
				return response.body;
			case 404:
				throw new Error("job not found or logs not available");
			case 401:
				throw new Error("GitLab authentication failed - check your token");
			case 403:
				throw new Error(
					`access forbidden - token may lack permissions for project ${this.project.namespace}/${this.project.project}`,
				);
			default:
				throw new Error(
					`GitLab API request failed with status ${response.status}: ${response.body}`,
				);
		}
	}

	/** Test report for a pipeline. A pipeline without tests, an unsupported
	 * endpoint or any other unexpected status answers `null`, because the test
	 * report is a nice-to-have. */
	async getTestSummary(pipelineId: number): Promise<GitLabTestSummary | null> {
		const response = await this.client.request(
			`${this.base}/pipelines/${pipelineId}/test_report`,
		);
		switch (response.status) {
			case 200: {
				let parsed: {
					total_count?: number;
					success_count?: number;
					failed_count?: number;
					skipped_count?: number;
					error_count?: number;
					test_suites?: GitLabTestSuite[];
				};
				try {
					parsed = JSON.parse(response.body);
				} catch (error) {
					throw new Error(
						`failed to parse test report JSON: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				const summary: GitLabTestSummary = {
					total: parsed.total_count ?? 0,
					success: parsed.success_count ?? 0,
					failed: parsed.failed_count ?? 0,
					skipped: parsed.skipped_count ?? 0,
					error: parsed.error_count ?? 0,
				};
				const suites = (parsed.test_suites ?? []).map((suite) => ({
					name: suite.name,
					test_cases: (suite.test_cases ?? []).map(normalizeTestCase),
				}));
				if (suites.length > 0) summary.test_suites = suites;
				return summary;
			}
			case 404:
			case 501:
				return null;
			case 401:
				throw new Error("GitLab authentication failed - check your token");
			case 403:
				throw new Error(
					`access forbidden - token may lack permissions for project ${this.project.namespace}/${this.project.project}`,
				);
			default:
				return null;
		}
	}

	async restartJob(jobId: number): Promise<void> {
		const response = await this.client.request(
			`${this.base}/jobs/${jobId}/retry`,
			{
				method: "POST",
			},
		);
		switch (response.status) {
			case 201:
				return;
			case 404:
				throw new Error("job not found or cannot be restarted");
			case 401:
				throw new Error("GitLab authentication failed - check your token");
			case 403:
				throw new Error(
					`access forbidden - you may not have permission to restart jobs in project ${this.project.namespace}/${this.project.project}`,
				);
			case 400:
				throw new Error(
					"job cannot be restarted (may already be running or in a non-restartable state)",
				);
			default:
				throw new Error(
					`GitLab API request failed with status ${response.status}: ${response.body}`,
				);
		}
	}

	async cancelJob(jobId: number): Promise<void> {
		const response = await this.client.request(
			`${this.base}/jobs/${jobId}/cancel`,
			{
				method: "POST",
			},
		);
		switch (response.status) {
			case 201:
				return;
			case 404:
				throw new Error("job not found or cannot be cancelled");
			case 401:
				throw new Error("GitLab authentication failed - check your token");
			case 403:
				throw new Error(
					`access forbidden - you may not have permission to cancel jobs in project ${this.project.namespace}/${this.project.project}`,
				);
			case 400:
				throw new Error(
					"job cannot be cancelled (may already be finished or in a non-cancellable state)",
				);
			default:
				throw new Error(
					`GitLab API request failed with status ${response.status}: ${response.body}`,
				);
		}
	}

	/** The shared provider-status diagnostics the Go CI reads used. */
	private expectStatus(
		response: { status: number; body: string },
		what: string,
	): void {
		switch (response.status) {
			case 200:
				return;
			case 401:
				throw new Error("GitLab authentication failed - check your token");
			case 403:
				throw new Error(
					`access forbidden - token may lack permissions for project ${this.project.namespace}/${this.project.project}`,
				);
			case 404:
				throw new Error(
					`${what} or project not found: ${what} in ${this.project.namespace}/${this.project.project}`,
				);
			case 429:
				throw new Error(
					"GitLab API rate limit exceeded - please try again later",
				);
			case 500:
				throw new Error("GitLab server error - please try again later");
			default:
				throw new Error(
					`GitLab API request failed with status ${response.status}: ${response.body}`,
				);
		}
	}
}

/** GitLab returns `system_output` either as a string or as `{"value": …}`; the
 * port always emits a plain string. */
function normalizeTestCase(testCase: GitLabTestCase): GitLabTestCase {
	const normalized: GitLabTestCase = {
		name: testCase.name,
		classname: testCase.classname,
		status: testCase.status,
		execution_time: testCase.execution_time,
	};
	const systemOutput = flexibleString(
		(testCase as { system_output?: unknown }).system_output,
	);
	if (systemOutput !== "") normalized.system_output = systemOutput;
	if (testCase.stack_trace) normalized.stack_trace = testCase.stack_trace;
	return normalized;
}

function flexibleString(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "object" && value !== null) {
		const inner = (value as { value?: unknown }).value;
		return typeof inner === "string" ? inner : "";
	}
	return "";
}

function parseArray<T>(body: string, message: string): T[] {
	try {
		const parsed = JSON.parse(body);
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch (error) {
		throw new Error(
			`${message}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
