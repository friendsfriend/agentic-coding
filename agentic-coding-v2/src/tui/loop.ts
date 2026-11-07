// Raw-mode terminal event loop binding the pure model to a live Runtime.
// No external TUI dependencies: stdin raw mode, ANSI redraw, 1s polling.
import { projectState } from "../projection.ts";
import type { Runtime } from "../runtime.ts";
import {
	type Effect,
	initial,
	reduce,
	render,
	type Snapshot,
	type TuiState,
} from "./model.ts";

async function snapshot(app: Runtime): Promise<Snapshot> {
	const state = await projectState(
		app.harness,
		app.home,
		app.config,
		app.models,
	);
	const runs = await app.environments.snapshot();
	return {
		messages: state.messages.map(({ id, role, content }) => ({
			id,
			role,
			content,
		})),
		tasks: state.tasks.map((task) => ({
			id: task.id,
			topicId: task.topicId,
			skill: task.skill,
			activity: task.activity,
			detail: task.detail,
		})),
		reviews: state.reviews.map((review) => ({
			id: review.id,
			taskId: review.taskId,
			title: review.title,
			state: review.state,
			revision: review.revision,
			snapshot: review.snapshot,
		})),
		runs: runs.runs.map((run) => ({
			id: run.id,
			state: run.state,
			owner: run.owner,
		})),
	};
}
async function apply(app: Runtime, effect: Effect): Promise<string | null> {
	if (effect.kind === "chat") {
		await app.chat(effect.content, effect.requestId);
		return "Sent to the orchestrator.";
	}
	if (effect.kind === "decide") {
		await app.decide(effect.id, effect.revision, effect.decision, "");
		return `${effect.decision} ${effect.id}.`;
	}
	await app.cancel(effect.id);
	return `Cancelled task ${effect.id}.`;
}
const parseKey = (data: string): string | null => {
	if (data === "\x03") return "quit-signal";
	if (data === "\r" || data === "\n") return "enter";
	if (data === "\x1b") return "escape";
	if (data === "\x7f") return "backspace";
	if (data === "\t") return "tab";
	if (data === "\x1b[A") return "up";
	if (data === "\x1b[B") return "down";
	if (data === "\x1b[C") return "right";
	if (data === "\x1b[D") return "left";
	if (data.length === 1 && data >= " " && data !== "\x7f") return data;
	return null;
};
export async function runTui(app: Runtime): Promise<void> {
	const stdin = process.stdin,
		stdout = process.stdout;
	if (!stdin.isTTY || !stdout.isTTY)
		throw new Error("The terminal client needs an interactive terminal");
	stdin.setRawMode(true);
	stdin.resume();
	stdout.write("\x1b[?25l");
	let state: TuiState = initial({
		messages: [],
		tasks: [],
		reviews: [],
		runs: [],
	});
	let stopped = false;
	const draw = () => {
		const width = stdout.columns || 80,
			height = stdout.rows || 24;
		stdout.write("\x1b[H\x1b[2J");
		for (const line of render(state, width, Math.max(height - 5, 3)))
			stdout.write(`${line}\n`);
	};
	const refresh = async () => {
		try {
			const fresh = await snapshot(app);
			state = {
				...state,
				snapshot: fresh,
				taskIndex: Math.min(
					state.taskIndex,
					Math.max(fresh.tasks.length - 1, 0),
				),
				notice: null,
			};
		} catch (error) {
			state = {
				...state,
				notice: error instanceof Error ? error.message : String(error),
			};
		}
		draw();
	};
	const onData = (data: Buffer) => {
		const key = parseKey(data.toString("utf8"));
		if (key === null || key === "tab") {
			draw();
			return;
		}
		if (key === "quit-signal") {
			stopped = true;
			return;
		}
		const next = reduce(state, key);
		state = next.state;
		draw();
		if (next.effect)
			apply(app, next.effect).then(
				(notice) => {
					state = { ...state, notice };
					draw();
				},
				(error) => {
					state = {
						...state,
						notice: error instanceof Error ? error.message : String(error),
					};
					draw();
				},
			);
	};
	try {
		await refresh();
		stdin.on("data", onData);
		while (!stopped) {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			if (!stopped) await refresh();
		}
	} finally {
		stdin.off("data", onData);
		stdin.setRawMode(false);
		stdin.pause();
		stdout.write("\x1b[?25h\n");
	}
}
