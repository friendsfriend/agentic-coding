import type { Models } from "@earendil-works/pi-ai";
import { type Config, text } from "../config.ts";
import { Refusal } from "../server/refusal.ts";

/** v1's bounds (`ai-streams.ts`): the newest 100 KB, 90 seconds. */
export const maxLogBytes = 100 * 1024;
export const analysisTimeoutMs = 90_000;
const defaultPrompt =
	"Analyze these logs. Summarize errors, warnings, and any notable events concisely.";
const keep = 8;

type Analysis = {
	text: string;
	done: boolean;
	error: string | null;
	controller: AbortController;
	touched: number;
};

/** The restored v1 log AI panel. v1 ran `pi --print --no-tools` per request;
 * v2 streams one tool-less completion from the configured orchestrator
 * profile. The developer's prompt submit is the approval. No transcript, no
 * tools and no durable state: the answer lives in memory until read. A gateway
 * call is bounded to 15 s, so the TUI starts an analysis and polls its text. */
export class LogAnalysis {
	private analyses = new Map<string, Analysis>();
	private sequence = 0;
	constructor(
		private config: Config,
		private models: Models,
	) {}
	start(input: Record<string, unknown>) {
		const logs = typeof input.logs === "string" ? input.logs : "";
		if (!logs.trim()) throw new Refusal("No logs to analyze");
		const prompt =
			typeof input.prompt === "string" && input.prompt.trim()
				? text(input.prompt, "prompt", 64000)
				: defaultPrompt;
		const profile = this.config.profiles.find(
			(item) => item.id === this.config.orchestratorProfile,
		);
		if (!profile)
			throw new Refusal("Configure an orchestratorProfile to analyze logs");
		const model = this.models.getModel(profile.provider, profile.modelId);
		if (!model)
			throw new Refusal(
				`Model ${profile.provider}/${profile.modelId} of the orchestrator profile is unavailable`,
			);
		if ([...this.analyses.values()].filter((item) => !item.done).length >= 2)
			throw new Refusal("Two log analyses are already running");
		for (const [id, item] of [...this.analyses].slice(
			0,
			Math.max(0, this.analyses.size - keep + 1),
		)) {
			item.controller.abort();
			this.analyses.delete(id);
		}
		const bytes = Buffer.from(logs, "utf8");
		const truncated = bytes.byteLength > maxLogBytes;
		const tail = truncated
			? bytes.subarray(bytes.byteLength - maxLogBytes).toString("utf8")
			: logs;
		const id = `logs-${++this.sequence}`;
		const analysis: Analysis = {
			text: "",
			done: false,
			error: null,
			controller: new AbortController(),
			touched: Date.now(),
		};
		this.analyses.set(id, analysis);
		const timer = setTimeout(
			() => analysis.controller.abort(),
			analysisTimeoutMs,
		);
		void (async () => {
			try {
				const stream = this.models.streamSimple(
					model,
					{
						messages: [
							{
								role: "user",
								content: `${prompt}${truncated ? "\n[Note: log was truncated to the most recent 100 KB]" : ""}\n\n${tail}`,
								timestamp: Date.now(),
							},
						],
					},
					{
						signal: analysis.controller.signal,
						...(profile.thinking !== "off"
							? { reasoning: profile.thinking }
							: {}),
					},
				);
				for await (const event of stream) {
					if (event.type === "text_delta") analysis.text += event.delta;
					else if (event.type === "error")
						analysis.error = analysis.controller.signal.aborted
							? "AI analysis timed out"
							: (event.error.errorMessage ?? "AI analysis failed").slice(
									0,
									600,
								);
				}
			} catch (error) {
				analysis.error = analysis.controller.signal.aborted
					? "AI analysis timed out"
					: (error instanceof Error
							? error.message
							: "AI analysis failed"
						).slice(0, 600);
			} finally {
				clearTimeout(timer);
				analysis.done = true;
			}
		})();
		return { id };
	}
	/** Text from `offset` on; `done` once the completion ended. */
	read(input: Record<string, unknown>) {
		const id = text(input.id, "analysis", 64);
		const analysis = this.analyses.get(id);
		if (!analysis) throw new Refusal("Log analysis not found");
		const offset =
			typeof input.offset === "number" && Number.isInteger(input.offset)
				? Math.max(0, input.offset)
				: 0;
		analysis.touched = Date.now();
		const delta = analysis.text.slice(offset, offset + 200_000);
		const done = analysis.done && offset + delta.length >= analysis.text.length;
		if (done) this.analyses.delete(id);
		return { delta, done, error: done ? analysis.error : null };
	}
	cancel(input: Record<string, unknown>) {
		const id = text(input.id, "analysis", 64);
		this.analyses.get(id)?.controller.abort();
		this.analyses.delete(id);
		return { cancelled: true };
	}
	close() {
		for (const analysis of this.analyses.values()) analysis.controller.abort();
		this.analyses.clear();
	}
}
