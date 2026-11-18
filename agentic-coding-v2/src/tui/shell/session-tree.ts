import type { Data, Session } from "../../protocol/index.ts";
import type { WorkspaceEntry } from "../presentation/components/WorkspaceNavigation.tsx";

const labels: Record<string, string> = {
	"openspec-workflow": "OpenSpec workflow",
	"verify-workflow": "Verify",
	"openspec-apply-change": "Apply",
	"openspec-archive-change": "Archive",
	"openspec-sync-specs": "Sync specs",
	"openspec-verify-change": "OpenSpec verification",
	"code-quality-verifier": "Code quality",
	"security-verifier": "Security",
	"performance-verifier": "Performance",
	"migration-verifier": "Migration",
	"concurrency-verifier": "Concurrency",
	"openspec-verifier": "OpenSpec",
	review: "Review",
	code: "Code",
};

/** A visual projection, never ownership or cancellation authority. Missing/closed
 * parents become roots; old sessions remain visible without guessed lineage. */
export function sessionTree(
	sessions: Session[],
	tasks: Data[],
	reviews: Data[],
	collapsed: ReadonlySet<number>,
): WorkspaceEntry[] {
	const known = new Set(sessions.map((session) => session.id));
	const taskById = new Map(tasks.map((task) => [task.id, task]));
	const attention = new Set(
		reviews
			.filter((review) => review.state === "pending")
			.map((review) => review.taskId),
	);
	const children = new Map<number | null, Session[]>();
	for (const session of sessions) {
		const candidate = session.spawnedBy ?? session.parent;
		const parent =
			candidate !== null && candidate !== session.id && known.has(candidate)
				? candidate
				: null;
		const siblings = children.get(parent) ?? [];
		siblings.push(session);
		children.set(parent, siblings);
	}
	const status = (session: Session) => {
		const task = taskById.get(session.task);
		const outcome = task?.result as Data | undefined;
		if (attention.has(session.task)) return "attention";
		if (task?.status === "terminal") {
			if (outcome?.status === "completed") return "completed";
			return outcome?.status === "aborted" || outcome?.status === "cancelled"
				? "cancelled"
				: "failed";
		}
		if (task?.status === "waiting") return "waiting";
		return task ? "running" : session.status === "running" ? "running" : "idle";
	};
	const marks = {
		cancelled: { glyph: "■", tone: "muted" },
		idle: { glyph: "○", tone: "muted" },
		running: { glyph: "●", tone: "accent" },
		waiting: { glyph: "◷", tone: "primary" },
		attention: { glyph: "!", tone: "warning" },
		failed: { glyph: "!", tone: "error" },
		completed: { glyph: "✓", tone: "success" },
	} as const;
	// Compute each subtree once, not once per ancestor on every snapshot.
	const totals = new Map<number, { running: number; attention: number }>();
	const counting = new Set<number>();
	const aggregate = (
		session: Session,
	): { running: number; attention: number } => {
		const cached = totals.get(session.id);
		if (cached) return cached;
		if (counting.has(session.id)) return { running: 0, attention: 0 };
		counting.add(session.id);
		const own = status(session);
		const total = {
			running: own === "running" ? 1 : 0,
			attention: own === "attention" || own === "failed" ? 1 : 0,
		};
		for (const child of children.get(session.id) ?? []) {
			const next = aggregate(child);
			total.running += next.running;
			total.attention += next.attention;
		}
		counting.delete(session.id);
		totals.set(session.id, total);
		return total;
	};
	const rows: WorkspaceEntry[] = [];
	const visited = new Set<number>();
	const walk = (
		session: Session,
		ancestors: boolean[],
		last: boolean,
		parent?: number,
	) => {
		if (visited.has(session.id)) return;
		visited.add(session.id);
		const nested = children.get(session.id) ?? [];
		const task = taskById.get(session.task);
		const skill = typeof task?.skill === "string" ? task.skill : session.title;
		const name =
			session.branch && session.title === "openspec-workflow"
				? session.branch.replace(/^feature\//, "").replaceAll("-", " ")
				: (labels[skill] ?? session.title);
		const counts = { running: 0, attention: 0 };
		for (const child of nested) {
			const next = aggregate(child);
			counts.running += next.running;
			counts.attention += next.attention;
		}
		const own = status(session);
		const mark =
			marks[
				counts.attention && own !== "failed" && own !== "attention"
					? "attention"
					: counts.running && own === "idle"
						? "running"
						: own
			];
		const hidden = collapsed.has(session.id);
		const summary = hidden
			? [
					counts.running ? `${counts.running} running` : "",
					counts.attention ? `${counts.attention} attention` : "",
				]
					.filter(Boolean)
					.join(" · ")
			: "";
		rows.push({
			name,
			value: `session:${session.id}`,
			description: session.branch ?? session.path ?? `${skill} · ${own}`,
			...mark,
			tree: {
				prefix:
					parent === undefined
						? ""
						: `${ancestors.map((isLast) => (isLast ? "  " : "│ ")).join("")}${last ? "└─" : "├─"}`,
				// Same two-column cells as the title. Detail rows retain sibling
				// trunks and, for an expanded parent, the line into its children.
				continuation: `${parent === undefined ? "" : `${ancestors.map((isLast) => (isLast ? "  " : "│ ")).join("")}${last ? "  " : "│ "}`}${nested.length && !hidden ? "│ " : "  "}`,
				parent: parent === undefined ? undefined : `session:${parent}`,
				branch: nested.length > 0,
				collapsed: hidden,
				summary,
				kind:
					session.task === null
						? parent === undefined
							? "project"
							: "workflow"
						: "task",
			},
		});
		if (!hidden)
			nested.forEach((child, index) => {
				walk(
					child,
					parent === undefined ? [] : [...ancestors, last],
					index === nested.length - 1,
					session.id,
				);
			});
	};
	for (const session of children.get(null) ?? []) walk(session, [], true);
	// Malformed cycles must not hide sessions. A collapsed subtree, however, is
	// intentionally hidden and must not reappear as an orphan root.
	const reachable = new Set<number>();
	const reach = (id: number) => {
		if (reachable.has(id)) return;
		reachable.add(id);
		for (const child of children.get(id) ?? []) reach(child.id);
	};
	for (const root of children.get(null) ?? []) reach(root.id);
	for (const session of sessions)
		if (!reachable.has(session.id)) {
			walk(session, [], true);
			reach(session.id);
		}
	return rows;
}
