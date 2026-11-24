import type { UiCapabilityApi } from "../../../src/ui/capability-api.ts";
import {
	type EnvironmentService,
	type EnvironmentStatus,
	type ExecutionReceipt,
	type GitChanges,
	type GitDiff,
	type GitStatus,
	type LogsSnapshot,
	type OperationDetail,
	type OperationSummary,
	parseExecution,
	parseGitChanges,
	parseGitDiff,
	parseGitStatuses,
	parseHistory,
	parseList,
	parseLogs,
	parseOperationDetail,
	parseService,
	parseStatus,
	parseStop,
	parseTelemetry,
	type TelemetrySnapshot,
} from "./model.ts";

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export class EnvironmentMcpClient {
	constructor(private readonly api: UiCapabilityApi) {}

	private async invoke(
		name: string,
		input: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		return record(await this.api.invoke(name, input));
	}

	async list(): Promise<{
		apps: ReturnType<typeof parseList>["apps"];
		services: readonly EnvironmentService[];
		repositories: readonly string[];
		total: number;
	}> {
		const apps: ReturnType<typeof parseList>["apps"] = [];
		let services: readonly EnvironmentService[] = [];
		let repositories: readonly string[] = [];
		let total = 0;
		let offset = 0;
		for (let page = 0; page < 8; page += 1) {
			const result = parseList(
				await this.invoke("env_list", { offset, limit: 10 }),
			);
			if (page === 0) {
				services = result.services;
				repositories = result.repositories;
				total = result.total;
			}
			apps.push(...result.apps);
			if (result.nextOffset === null || result.nextOffset <= offset) break;
			offset = result.nextOffset;
		}
		return { apps, services, repositories, total };
	}

	async status(): Promise<EnvironmentStatus> {
		return parseStatus(await this.invoke("env_status"));
	}

	async services(): Promise<readonly EnvironmentService[]> {
		const result = await this.invoke("env_services");
		const list = result.services;
		if (!Array.isArray(list)) return [];
		return list.flatMap((item) => {
			const parsed = parseService(item);
			return parsed ? [parsed] : [];
		});
	}

	async history(
		offset = 0,
		limit = 20,
	): Promise<ReturnType<typeof parseHistory>> {
		return parseHistory(await this.invoke("env_history", { offset, limit }));
	}

	async operation(id: string, progressOffset = 0): Promise<OperationDetail> {
		return parseOperationDetail(
			await this.invoke("env_operation", {
				operationId: id,
				...(progressOffset > 0 ? { progressOffset } : {}),
			}),
		);
	}

	async execute(
		app: string,
		target: string,
	): Promise<{
		operation?: OperationSummary;
		receipt: ExecutionReceipt | null;
	}> {
		return parseExecution(
			await this.invoke("env_execute", {
				app,
				target,
				requestId: crypto.randomUUID(),
			}),
		);
	}

	async wait(
		id: string,
		waitSec = 30,
	): Promise<{
		operation?: OperationSummary;
		receipt: ExecutionReceipt | null;
	}> {
		const result = parseExecution(
			await this.invoke("env_wait", { operationId: id, waitSec }),
		);
		return result;
	}

	async gitChanges(repository: string): Promise<GitChanges> {
		return parseGitChanges(
			await this.invoke("env_git_changes", { repository }),
		);
	}

	async gitDiff(repository: string, path: string): Promise<GitDiff> {
		return parseGitDiff(
			await this.invoke("env_git_diff", { repository, path }),
		);
	}

	async git(repositories?: readonly string[]): Promise<readonly GitStatus[]> {
		return parseGitStatuses(
			await this.invoke(
				"env_git",
				repositories?.length ? { repositories } : {},
			),
		);
	}

	async stop(app: string): Promise<ReturnType<typeof parseStop>> {
		return parseStop(await this.invoke("env_stop", { app }));
	}

	async logs(app: string, tail = 200, grep?: string): Promise<LogsSnapshot> {
		return parseLogs(
			await this.invoke("env_logs", {
				app,
				tail,
				...(grep ? { grep } : {}),
			}),
		);
	}

	async telemetry(app: string, traceId?: string): Promise<TelemetrySnapshot> {
		return parseTelemetry(
			await this.invoke("env_telemetry", {
				app,
				...(traceId ? { traceId } : {}),
			}),
		);
	}
}
