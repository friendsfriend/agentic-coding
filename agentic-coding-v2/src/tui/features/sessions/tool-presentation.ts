import type { Data } from "../../../protocol/index.ts";

/** How one tool family reads in the transcript header: the icon that marks it,
 * the line naming what it is doing, and the target it is doing it to. Pure and
 * total — the card decides what a family's *body* shows; this only decides what
 * the row says before it is opened.
 *
 * A family with a bespoke header of its own returns `null` and keeps it: the
 * file verbs spell "Read path/to/file", the shell family names its command, and
 * codemode offers its script's first line. Everything else — the orchestrator's
 * own tools, the environment tools, evidence and scheduling — is named here,
 * because those families previously read as a bare tool name twice over and no
 * icon at all. */
export type ToolPresentation = { label: string; hint?: string };

/** Families the card already presents itself. */
const owned = new Set([
	"read",
	"write",
	"edit",
	"apply_patch",
	"patch",
	"bash",
	"shell",
	"execute",
	"codemode",
	"developer_question",
	"agent_ask",
]);

const icons: Record<string, string> = {
	read: "→",
	write: "←",
	edit: "←",
	apply_patch: "←",
	patch: "←",
	glob: "✱",
	grep: "✱",
	find: "✱",
	bash: "$",
	shell: "$",
	execute: "▶",
	task: "✓",
	subagent: "✓",
	webfetch: "%",
	websearch: "◈",
	codemode: "λ",
	developer_question: "?",
	agent_ask: "?",
	db_query: "!",
	catalog: "☰",
	start_task: "▷",
	environment_action: "▷",
	task_result: "◇",
	cancel_task: "⊘",
	request_review: "✓",
	attach_image: "▣",
	attach_evidence: "▣",
};

/** The icon a family is recognised by. A family prefix answers for its whole
 * group — every environment tool shares one mark, as do the workflow, stage,
 * scheduling and browser tools — so a new member of a family needs no entry. */
export function toolIcon(name: string): string {
	const exact = icons[name];
	if (exact) return exact;
	if (name === "browser_run_script" || name === "browser_eval") return "λ";
	if (name === "browser_console" || name === "browser_network") return "≋";
	if (
		name.startsWith("browser_screenshot") ||
		name.startsWith("browser_record_")
	)
		return "▧";
	if (name.startsWith("browser_")) return "→";
	if (name.startsWith("env_cluster")) return "☸";
	if (name.startsWith("env_")) return "⚙";
	if (name.startsWith("otel_")) return "≋";
	if (name.startsWith("stage_")) return "▤";
	if (name.startsWith("workflow_")) return "◷";
	if (name.startsWith("evidence_")) return "▣";
	if (name.startsWith("scheduling")) return "◷";
	if (name.startsWith("list_") || name.startsWith("read_")) return "☰";
	if (name.startsWith("subscribe_") || name.startsWith("unsubscribe_"))
		return "◈";
	return "•";
}

/** The argument that identifies what a call acts on, in the order that makes the
 * most specific reading first. A value the call did not supply is skipped, and a
 * list of them is named as it is. */
const identities = [
	"workflowId",
	"scheduleId",
	"topicId",
	"title",
	"description",
	"taskId",
	"app",
	"apps",
	"infra",
	"repository",
	"path",
	"endpoint",
	"url",
	"caption",
	"skill",
	"pattern",
	"query",
	"label",
] as const;

/** Bounded like every other supplied label: one line, never a wall of text. */
const oneLine = (value: string, max = 120) => {
	const points = Array.from(value.replace(/\s+/g, " ").trim());
	return points.length > max
		? `${points.slice(0, max - 1).join("")}…`
		: points.join("");
};

const text = (value: unknown) =>
	typeof value === "string" ? value.trim() : "";

const target = (args: Data) => {
	for (const key of identities) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return oneLine(value);
		if (Array.isArray(value)) {
			const named = value.filter(
				(item): item is string => typeof item === "string" && item.length > 0,
			);
			if (named.length > 0) return oneLine(named.join(", "));
		}
		if (typeof value === "number" && Number.isFinite(value))
			return String(value);
	}
	return "";
};

/** The verb a family reports, spelled for a call that has and has not returned:
 * an unreturned call is never named as a completed one. */
const verbs: Record<string, { pending: string; done: string }> = {
	start_task: { pending: "Starting", done: "Started" },
	environment_action: { pending: "Preparing", done: "Prepared" },
	cancel_task: { pending: "Cancelling", done: "Cancelled" },
	request_review: { pending: "Review", done: "Reviewed" },
	env_start: { pending: "Starting", done: "Started" },
	env_stop: { pending: "Stopping", done: "Stopped" },
	env_wait: { pending: "Waiting for", done: "Waited for" },
	env_cluster_status: { pending: "Cluster", done: "Cluster" },
};

const capitalise = (value: string) =>
	value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;

/** `POST /v1/requests` rather than a bare tool name: the verb and the path are
 * what a reader scanning diagnostics needs. */
const httpLabel = (args: Data) => {
	const method = text(args.method) || "GET";
	const path = text(args.path) || text(args.endpoint);
	const app = text(args.app);
	return {
		label: oneLine(`${method.toUpperCase()}${path ? ` ${path}` : ""}`, 80),
		hint: app ? oneLine(app, 60) : undefined,
	};
};

/** SQL keeps its own line: the statement identifies the call, the database it
 * runs against is the target. */
const sqlLabel = (args: Data) => {
	const sql = text(args.sql);
	const infra = text(args.infra);
	const first = sql.split("\n").find((line) => line.trim().length > 0) ?? "";
	return {
		label: infra ? `SQL · ${oneLine(infra, 40)}` : "SQL",
		hint: first ? oneLine(first, 80) : undefined,
	};
};

export function toolPresentation(
	name: string,
	args: Data,
	phase: "pending" | "done",
): ToolPresentation | null {
	if (owned.has(name) || name.startsWith("browser_")) return null;
	if (name === "http_request") return httpLabel(args);
	if (name === "db_query") return sqlLabel(args);
	if (name === "attach_image" || name === "attach_evidence") {
		// The file is the target and the caption describes it; the kind of evidence
		// is the call's own name, which the icon and the row already carry.
		const verb = phase === "done" ? "Attached" : "Attach";
		const path = text(args.path);
		const caption = text(args.caption);
		return {
			label: oneLine(`${verb}${path ? ` ${path}` : ""}`, 100),
			...(caption ? { hint: oneLine(caption, 90) } : {}),
		};
	}
	if (name === "start_task") {
		const verb = verbs.start_task?.[phase] ?? "Start";
		const skill = text(args.skill) || text(args.repository);
		const repository = text(args.repository);
		const policy = text(args.policy);
		return {
			label: oneLine(
				`${verb}${skill ? ` ${skill}` : " task"}`,
				skill ? 80 : 40,
			),
			hint:
				[repository, policy].filter((part) => part).join(" · ") || undefined,
		};
	}
	if (name === "environment_action") {
		const verb = verbs.environment_action?.[phase] ?? "Prepare";
		const action = capitalise(text(args.action));
		const apps = target({ apps: args.apps });
		const shape = [text(args.runtime), text(args.target), text(args.profile)]
			.filter((part) => part)
			.join(" · ");
		return {
			label: oneLine(
				action
					? `${action}${apps ? ` ${apps}` : ""}`
					: `${verb} environment action`,
				100,
			),
			hint: shape || undefined,
		};
	}
	const verb = verbs[name];
	const acted = target(args);
	if (verb) {
		return {
			label: oneLine(`${verb[phase]}${acted ? ` ${acted}` : ""}`, 100),
		};
	}
	// Every remaining family states its own name and what it acts on; nothing is
	// repeated, and an argument the call never supplied is not invented.
	return { label: oneLine(name, 60), ...(acted ? { hint: acted } : {}) };
}
