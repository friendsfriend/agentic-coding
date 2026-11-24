export type BuildStepStatus =
	| "running"
	| "done"
	| "cached"
	| "error"
	| "canceled";

export type BuildStep = {
	readonly id: string;
	title: string;
	status: BuildStepStatus;
	duration?: string;
	readonly logs: string[];
};

export type BuildOutput = {
	readonly steps: readonly BuildStep[];
	readonly global: readonly string[];
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping is the purpose.
const ansi = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Parse Docker/BuildKit plain progress into stable steps and logs. Unknown
 * lines stay in `global`; no line is invented or reordered. */
export function parseBuildOutput(output: string): BuildOutput {
	const steps: BuildStep[] = [];
	const byId = new Map<string, BuildStep>();
	const global: string[] = [];
	let block: BuildStep | undefined;
	let inBlock = false;
	const step = (id: string) => {
		const existing = byId.get(id);
		if (existing) return existing;
		const created: BuildStep = {
			id,
			title: `Step ${id}`,
			status: "running",
			logs: [],
		};
		byId.set(id, created);
		steps.push(created);
		return created;
	};
	for (const raw of output.replace(ansi, "").replace(/\r/g, "").split("\n")) {
		const line = raw.trimEnd();
		if (!line.trim()) continue;
		if (line === "------") {
			inBlock = !inBlock;
			if (!inBlock) block = undefined;
			continue;
		}
		const match = /^#(\d+)\s*(.*)$/.exec(line);
		if (match?.[1]) {
			const id = match[1];
			const rest = match[2] ?? "";
			if (id === "0") {
				global.push(line);
				continue;
			}
			const current = step(id);
			if (inBlock) {
				current.logs.push(line);
				continue;
			}
			if (/^DONE\b/.test(rest)) {
				current.status = "done";
				const duration = /^DONE\s+(.+)$/.exec(rest)?.[1];
				if (duration) current.duration = duration;
				continue;
			}
			if (/^CACHED\b/.test(rest)) {
				current.status = "cached";
				continue;
			}
			if (/^ERROR:/.test(rest)) {
				current.status = "error";
				current.logs.push(rest);
				block = current;
				continue;
			}
			if (/^CANCELED\b/.test(rest)) {
				current.status = "canceled";
				continue;
			}
			const timed = /^([0-9]+(?:\.[0-9]+)?)\s+(.*)$/.exec(rest);
			if (timed?.[2] !== undefined) {
				current.logs.push(timed[2]);
				continue;
			}
			if (rest && current.title === `Step ${id}`) {
				current.title = rest;
				continue;
			}
			if (rest) current.logs.push(rest);
			continue;
		}
		if (inBlock && block) {
			block.logs.push(line);
			continue;
		}
		global.push(line);
	}
	return { steps, global };
}

export function buildStepTone(
	status: BuildStepStatus,
): "success" | "error" | "warning" | "muted" {
	if (status === "done") return "success";
	if (status === "error") return "error";
	if (status === "canceled") return "muted";
	if (status === "cached") return "muted";
	return "warning";
}

export function buildStepIcon(status: BuildStepStatus): string {
	if (status === "done") return "✓";
	if (status === "cached") return "↻";
	if (status === "error") return "✗";
	if (status === "canceled") return "⊘";
	return "◌";
}

/** Settled receipts are tail-truncated at the journal boundary, while the live
 * stream may retain earlier steps but miss the final status lines. Merge by
 * step id so the settled status/duration wins without dropping live steps. */
export function mergeBuildOutput(
	live: BuildOutput | undefined,
	settled: BuildOutput | undefined,
): BuildOutput | undefined {
	if (!live) return settled;
	if (!settled) return live;
	const steps = new Map<string, BuildStep>();
	for (const step of live.steps) steps.set(step.id, step);
	for (const step of settled.steps) {
		const existing = steps.get(step.id);
		if (!existing) {
			steps.set(step.id, step);
			continue;
		}
		steps.set(step.id, {
			...existing,
			status: step.status,
			duration: step.duration ?? existing.duration,
			title:
				existing.title.startsWith("Step ") && !step.title.startsWith("Step ")
					? step.title
					: existing.title,
			logs: step.logs.length > existing.logs.length ? step.logs : existing.logs,
		});
	}
	const ordered = [...steps.values()];
	if (ordered.every((step) => /^\d+$/.test(step.id)))
		ordered.sort((left, right) => Number(left.id) - Number(right.id));
	return {
		steps: ordered,
		global: settled.global.length ? settled.global : live.global,
	};
}
