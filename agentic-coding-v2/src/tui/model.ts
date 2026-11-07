// Pure terminal-client model: snapshot rendering and key handling without IO.
// The event loop in loop.ts polls the Runtime, feeds snapshots here and
// executes the returned effects. Nothing here touches stdin, stdout or time.
export type Panel = "home" | "tasks" | "env";
export type SnapshotMessage = { id: string; role: string; content: string };
export type SnapshotTask = {
	id: number;
	topicId: string;
	skill: string;
	activity: string;
	detail: string;
};
export type SnapshotReview = {
	id: string;
	taskId: number;
	title: string;
	state: string;
	revision: number;
	snapshot: string;
};
export type SnapshotRun = { id: string; state: string; owner: number };
export type Snapshot = {
	messages: SnapshotMessage[];
	tasks: SnapshotTask[];
	reviews: SnapshotReview[];
	runs: SnapshotRun[];
};
export type Decision = "approved" | "changes-requested" | "rejected";
export type Effect =
	| { kind: "chat"; content: string; requestId: string }
	| { kind: "decide"; id: string; revision: number; decision: Decision }
	| { kind: "cancel"; id: number }
	| { kind: "quit" };
export type TuiState = {
	panel: Panel;
	snapshot: Snapshot;
	taskIndex: number;
	reviewIndex: number;
	detailTask: number | null;
	input: string;
	notice: string | null;
	seq: number;
};
export function initial(snapshot: Snapshot): TuiState {
	return {
		panel: "home",
		snapshot,
		taskIndex: 0,
		reviewIndex: 0,
		detailTask: null,
		input: "",
		notice: null,
		seq: 0,
	};
}
const pendingReviews = (state: TuiState, taskId: number) =>
	state.snapshot.reviews.filter(
		(review) => review.taskId === taskId && review.state === "pending",
	);
const clamp = (index: number, length: number) =>
	length === 0 ? 0 : Math.min(Math.max(index, 0), length - 1);
/** One parsed key: arrows, enter, escape, tab, backspace, printable char. */
export function reduce(
	state: TuiState,
	key: string,
): { state: TuiState; effect?: Effect } {
	const fail = (notice: string): { state: TuiState } => ({
		state: { ...state, notice },
	});
	if (key === "q" && state.panel !== "home")
		return {
			state: { ...state, panel: "home", detailTask: null, notice: null },
		};
	if (key === "1")
		return { state: { ...state, panel: "home", detailTask: null } };
	if (key === "2")
		return { state: { ...state, panel: "tasks", detailTask: null } };
	if (key === "3") return { state: { ...state, panel: "env" } };
	if (state.panel === "home") {
		if (key === "enter") {
			const content = state.input.trim();
			if (!content) return fail("Empty message; type before sending.");
			return {
				state: { ...state, input: "", notice: null, seq: state.seq + 1 },
				effect: {
					kind: "chat",
					content,
					requestId: `tui-${state.seq}-${content.length}`,
				},
			};
		}
		if (key === "backspace")
			return { state: { ...state, input: state.input.slice(0, -1) } };
		if (key.length === 1 && state.input.length < 4000)
			return { state: { ...state, input: state.input + key, notice: null } };
		return { state };
	}
	if (state.panel === "tasks") {
		const tasks = state.snapshot.tasks;
		if (key === "down")
			return {
				state: {
					...state,
					taskIndex: clamp(state.taskIndex + 1, tasks.length),
				},
			};
		if (key === "up")
			return {
				state: {
					...state,
					taskIndex: clamp(state.taskIndex - 1, tasks.length),
				},
			};
		const task = tasks[state.taskIndex];
		if (key === "enter" && task)
			return {
				state: { ...state, detailTask: task.id, reviewIndex: 0, notice: null },
			};
		if ((key === "escape" || key === "backspace") && state.detailTask !== null)
			return { state: { ...state, detailTask: null, reviewIndex: 0 } };
		if (key === "x" && task && state.detailTask === null)
			return {
				state: { ...state, notice: `Cancelling task ${task.id}…` },
				effect: { kind: "cancel", id: task.id },
			};
		if (state.detailTask !== null) {
			const reviews = pendingReviews(state, state.detailTask);
			if (key === "down")
				return {
					state: {
						...state,
						reviewIndex: clamp(state.reviewIndex + 1, reviews.length),
					},
				};
			if (key === "up")
				return {
					state: {
						...state,
						reviewIndex: clamp(state.reviewIndex - 1, reviews.length),
					},
				};
			const review = reviews[state.reviewIndex];
			const decide = (
				decision: Decision,
			): { state: TuiState; effect?: Effect } =>
				review
					? {
							state: { ...state, notice: `${decision} ${review.id}…` },
							effect: {
								kind: "decide",
								id: review.id,
								revision: review.revision,
								decision,
							},
						}
					: fail("No pending review is selected.");
			if (key === "a") return decide("approved");
			if (key === "r") return decide("rejected");
			if (key === "c") return decide("changes-requested");
			if (key === "x") {
				const id = state.detailTask;
				return {
					state: {
						...state,
						detailTask: null,
						notice: `Cancelling task ${id}…`,
					},
					effect: { kind: "cancel", id },
				};
			}
		}
		return { state };
	}
	return { state };
}
const clip = (value: string, width: number) =>
	value.length <= width ? value : `${value.slice(0, Math.max(width - 1, 0))}…`;
/** Render the whole screen as width-clipped lines over a body row budget. */
export function render(
	state: TuiState,
	width: number,
	bodyRows: number,
): string[] {
	const tabs: Panel[] = ["home", "tasks", "env"],
		header = tabs
			.map((tab) => `${tab === state.panel ? `[${tab}]` : ` ${tab} `}`)
			.join(" "),
		lines = [clip(`agentic-coding-v2  ${header}`, width), ""];
	if (state.panel === "home") {
		const tail = state.snapshot.messages.slice(-Math.max(bodyRows - 2, 1));
		for (const message of tail)
			lines.push(
				clip(
					`${message.role === "user" ? "you" : "host"}: ${oneLine(message.content)}`,
					width,
				),
			);
		if (tail.length === 0) lines.push("(no home messages yet)");
		lines.push("", clip(`> ${state.input}▌`, width));
	} else if (state.panel === "tasks") {
		if (state.detailTask === null) {
			if (state.snapshot.tasks.length === 0) lines.push("(no tasks yet)");
			const window = Math.max(bodyRows, 1),
				start = Math.max(
					0,
					Math.min(
						state.taskIndex - Math.floor(window / 2),
						state.snapshot.tasks.length - window,
					),
				);
			state.snapshot.tasks
				.slice(start, start + window)
				.forEach((task, offset) => {
					const index = start + offset,
						pending = pendingReviews(state, task.id).length,
						marker = index === state.taskIndex ? ">" : " ";
					lines.push(
						clip(
							`${marker} #${task.id} ${task.skill} ${task.activity} ${task.detail}${pending > 0 ? ` (${pending} review${pending === 1 ? "" : "s"})` : ""}`,
							width,
						),
					);
				});
		} else {
			const task = state.snapshot.tasks.find(
				(item) => item.id === state.detailTask,
			);
			if (!task) lines.push("(task is gone)");
			else {
				lines.push(clip(`#${task.id} ${task.topicId} [${task.skill}]`, width));
				lines.push(clip(`${task.activity}: ${task.detail}`, width));
				const reviews = pendingReviews(state, task.id);
				lines.push("", "pending reviews:");
				if (reviews.length === 0) lines.push("(none)");
				reviews.forEach((review, index) => {
					const marker = index === state.reviewIndex ? ">" : " ";
					lines.push(clip(`${marker} ${review.title} (${review.id})`, width));
					for (const row of review.snapshot.split("\n").slice(0, 6))
						lines.push(clip(`    ${row}`, width));
				});
			}
		}
	} else {
		if (state.snapshot.runs.length === 0) lines.push("(no environment runs)");
		for (const run of state.snapshot.runs.slice(0, 20))
			lines.push(clip(`${run.id} owner=${run.owner} ${run.state}`, width));
	}
	lines.push(
		"",
		clip(
			state.notice ??
				homeHint(state) +
					"1/2/3 panels · ctrl-c quits · home: type + enter · tasks: ↑↓ enter · detail: a/r/c decide, x cancel, esc back",
			width,
		),
	);
	return lines;
}
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
const homeHint = (state: TuiState) =>
	state.panel === "home"
		? ""
		: state.panel === "tasks" && state.detailTask !== null
			? "esc back · "
			: "";
