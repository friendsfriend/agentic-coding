import type { DevEnvClient } from "@devenv/core";
import type { Job } from "@devenv/types";
import type { AppStore } from "../stores/app-store";
import type { ChangeRequestStore } from "../stores/cr-store";

export function createPipelineActions(
	appStore: AppStore,
	changeRequestStore: ChangeRequestStore,
	client: DevEnvClient,
	showError: (title: string, message: string) => void,
) {
	const loadPipelineJobs = async () => {
		const app = appStore.tableFilteredApps()[appStore.selectedIndex()];
		const cr = changeRequestStore.selectedChangeRequest();
		if (!app || !cr?.head_pipeline) {
			const msg = !app
				? "No app selected"
				: !cr
					? "No change request selected"
					: "No pipeline available for this change request";
			changeRequestStore.setJobsError(msg);
			changeRequestStore.setJobsLoading(false);
			if (!cr?.head_pipeline) return;
		}
		changeRequestStore.setJobsLoading(true);
		changeRequestStore.setJobsError("");
		changeRequestStore.setCurrentPipelineId(cr?.head_pipeline?.id);
		appStore.pushView("jobs");
		try {
			changeRequestStore.setJobs(
				await client.getPipelineJobs(
					app?.ident,
					cr?.head_pipeline?.id,
					app?.sourceType,
				),
			);
		} catch (e) {
			changeRequestStore.setJobsError(
				`Failed to load pipeline #${cr?.head_pipeline?.id}: ${e instanceof Error ? e.message : "Unknown error"}`,
			);
			changeRequestStore.setJobs([]);
		} finally {
			changeRequestStore.setJobsLoading(false);
		}
	};

	const organizeJobsByStage = () => {
		const byStage: Map<string, Job[]> = new Map();
		const stageFirstJobId: Map<string, number> = new Map();
		for (const job of changeRequestStore.jobs()) {
			const stage = (job.stage ?? "").trim() || "Default";
			if (!byStage.has(stage)) {
				byStage.set(stage, []);
				stageFirstJobId.set(stage, job.id);
			} else if (
				job.id < (stageFirstJobId.get(stage) || Number.MAX_SAFE_INTEGER)
			) {
				stageFirstJobId.set(stage, job.id);
			}
			byStage.get(stage)?.push(job);
		}
		const stages = Array.from(byStage.keys()).sort(
			(a, b) => (stageFirstJobId.get(a) || 0) - (stageFirstJobId.get(b) || 0),
		);
		return stages.map((stage) => ({
			name: stage,
			jobs: byStage.get(stage) ?? [],
		}));
	};

	const backToCRDetail = () => {
		changeRequestStore.setJobs([]);
		changeRequestStore.setJobsError("");
		changeRequestStore.setCurrentPipelineId(null);
		changeRequestStore.setSelectedJobStageIndex(0);
		changeRequestStore.setSelectedJobIndex(0);
		changeRequestStore.setJobsSearchMode(false);
		changeRequestStore.setJobsSearchQuery("");
		appStore.pushView("changeRequestDetail");
	};

	const retryJob = async (jobId: number, jobName: string) => {
		const app = appStore.tableFilteredApps()[appStore.selectedIndex()];
		if (!app) return;
		try {
			await client.retryJob(app.ident, jobId);
			console.log(`Job ${jobName} (#${jobId}) retry initiated`);
		} catch (e) {
			showError(
				"Job Retry Failed",
				`Failed to retry job "${jobName}" (#${jobId}).\n\nError: ${e instanceof Error ? e.message : "Unknown error"}`,
			);
		}
	};

	const cancelJob = async (jobId: number, jobName: string) => {
		const app = appStore.tableFilteredApps()[appStore.selectedIndex()];
		if (!app) return;
		try {
			await client.cancelJob(app.ident, jobId);
			console.log(`Job ${jobName} (#${jobId}) cancel initiated`);
		} catch (e) {
			showError(
				"Job Cancel Failed",
				`Failed to cancel job "${jobName}" (#${jobId}).\n\nError: ${e instanceof Error ? e.message : "Unknown error"}`,
			);
		}
	};

	return {
		loadPipelineJobs,
		organizeJobsByStage,
		backToCRDetail,
		retryJob,
		cancelJob,
	};
}

export type PipelineActions = ReturnType<typeof createPipelineActions>;
