import type { DevEnvClient } from "@devenv/core";
import { createEffect, onCleanup } from "solid-js";

type LogEffectStore = {
	logRefreshParams: () => {
		type: "container" | "kubernetes" | "job" | null;
		containerID?: string;
		appIdent?: string;
		jobId?: number;
		sourceType?: string;
	};
	showLogModal: () => boolean;
	logs: () => string;
	logLines: () => string[];
	setLogLines: (value: string[] | ((prev: string[]) => string[])) => void;
	setLogs: (value: string | ((prev: string) => string)) => void;
	appendLogLine: (line: string, maxLines?: number) => void;
	logHistoryCursor: () => number | null;
};

let logStreamAbortController: AbortController | null = null;

export function setupLogEffects(
	logStore: LogEffectStore,
	client: DevEnvClient,
) {
	createEffect(() => {
		const params = logStore.logRefreshParams();
		if (!params.type || !logStore.showLogModal()) return;

		if (params.type === "container" && params.containerID) {
			if (logStreamAbortController) logStreamAbortController.abort();
			const controller = new AbortController();
			logStreamAbortController = controller;
			client.streamContainerLogs(
				params.containerID,
				controller.signal,
				(line: string) => logStore.appendLogLine(line),
				(err: Error) => {
					if (err.name !== "AbortError")
						console.error("Log stream error:", err);
				},
				"0",
			);
			onCleanup(() => {
				controller.abort();
				if (logStreamAbortController === controller)
					logStreamAbortController = null;
			});
			return;
		}

		if (
			params.type === "job" &&
			params.jobId &&
			params.appIdent &&
			params.sourceType !== "github"
		) {
			if (logStreamAbortController) logStreamAbortController.abort();
			const controller = new AbortController();
			logStreamAbortController = controller;
			client.streamJobLogs(
				params.appIdent,
				params.jobId,
				controller.signal,
				(line: string) => logStore.appendLogLine(line),
				(err: Error) => {
					if (err.name !== "AbortError")
						console.error("Job log stream error:", err);
				},
			);
			onCleanup(() => {
				controller.abort();
				if (logStreamAbortController === controller)
					logStreamAbortController = null;
			});
			return;
		}

		let inFlight = false;
		let lastPolledText = logStore.logs();

		const updatePolledLogs = (text: string) => {
			if (text === lastPolledText) return;
			lastPolledText = text;
			if (logStore.logHistoryCursor() === null) {
				logStore.setLogs(text);
				return;
			}
			const incoming = text ? text.split("\n") : [];
			const current = logStore.logLines();
			let overlap = Math.min(incoming.length, current.length);
			while (overlap > 0) {
				const currentTail = current.slice(current.length - overlap).join("\n");
				const incomingHead = incoming.slice(0, overlap).join("\n");
				if (currentTail === incomingHead) break;
				overlap--;
			}
			const suffix = incoming.slice(overlap);
			if (suffix.length > 0)
				logStore.setLogLines((prev) => [...prev, ...suffix].slice(-20000));
		};

		const intervalId = setInterval(async () => {
			if (inFlight) return;
			inFlight = true;
			try {
				if (params.type === "kubernetes" && params.appIdent) {
					updatePolledLogs(await client.getKubernetesLogs(params.appIdent));
				} else if (params.type === "job" && params.jobId) {
					updatePolledLogs(
						await client.getJobLogs(
							params.appIdent || "",
							params.jobId,
							params.sourceType,
						),
					);
				}
			} catch {
			} finally {
				inFlight = false;
			}
		}, 1000);

		onCleanup(() => clearInterval(intervalId));
	});
}
