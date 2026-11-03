const $ = (id) => document.getElementById(id);
let topic = null;
let revision = "";
const token = new URLSearchParams(location.hash.slice(1)).get("token");
if (token) history.replaceState(null, "", location.pathname);
async function api(url, data) {
	const response = await fetch(url, {
		method: data === undefined ? "GET" : "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		...(data === undefined ? {} : { body: JSON.stringify(data) }),
	});
	const value = await response.json();
	if (!response.ok) throw new Error(value.error ?? response.statusText);
	return value;
}
function element(tag, text, className) {
	const el = document.createElement(tag);
	if (text) el.textContent = text;
	if (className) el.className = className;
	return el;
}
function button(label, action) {
	const el = element("button", label);
	el.type = "button";
	el.onclick = async () => {
		try {
			await action();
		} catch (error) {
			$("connection").textContent = String(error);
		}
	};
	return el;
}
function reuseChildren(parent, ...cards) {
	const keep = new Set(cards);
	for (const child of [...parent.children])
		if (!keep.has(child)) child.remove();
	cards.forEach((card, index) => {
		if (parent.children[index] !== card)
			parent.insertBefore(card, parent.children[index] ?? null);
	});
}
function selectTopic(value) {
	topic = value;
	revision = "";
	void refresh();
}
$("home").onclick = () => selectTopic(null);
async function refresh() {
	try {
		const state = await api("/api/state");
		$("connection").textContent = "Connected";
		const next = JSON.stringify([state, topic]);
		if (revision === next) return;
		revision = next;
		$("topics").replaceChildren(
			...state.topics.map((item) => {
				const tasks = state.tasks.filter((task) => task.topicId === item.id);
				const count = tasks.filter(
					(task) => task.activity === "running",
				).length;
				const reviews = state.reviews.some(
					(review) => review.topicId === item.id && review.state === "pending",
				);
				const el = button(
					`${item.title} · ${count ? `${count} running` : "idle"}${reviews ? " · review" : ""}`,
					() => selectTopic(item.id),
				);
				el.setAttribute("aria-current", String(topic === item.id));
				return el;
			}),
		);
		$("profiles").replaceChildren(
			...state.profiles.map((profile) =>
				element(
					"p",
					`${profile.id} · ${profile.provider}/${profile.modelId} · ${profile.available ? profile.thinking : "unavailable"}`,
					"meta",
				),
			),
		);
		for (const origin of ["system", "user"]) {
			$(`${origin}-skills`).replaceChildren(
				...state.skills
					.filter((skill) => skill.origin === origin)
					.map((skill) =>
						element("p", `${skill.id} · ${skill.description}`, "meta"),
					),
			);
		}
		$("title").textContent = topic ?? "Orchestrator";
		$("dashboard").hidden = !topic;
		const tasks = state.tasks.filter((task) => task.topicId === topic);
		$("tasks").replaceChildren(
			...tasks.map((task) => {
				const el = element("div", null, "task");
				el.append(
					element(
						"strong",
						`${task.skill} · ${task.activity} · ${task.detail}`,
					),
					element(
						"div",
						`Task ${task.id} · ${task.profile}${task.baseCommit ? ` · base ${task.baseCommit.slice(0, 12)}` : ""}${task.relatedTo ? ` · follows ${task.relatedTo}` : ""}`,
						"meta",
					),
				);
				if (
					!["completed", "failed", "aborted", "faulted", "orphaned"].includes(
						task.detail,
					)
				)
					el.append(
						button("Cancel task", () =>
							api(`/api/tasks/${task.id}/cancel`, {}),
						),
					);
				return el;
			}),
		);
		const workspaces = new Set(tasks.map((task) => task.workspace));
		$("git").replaceChildren(
			...state.git
				.filter((item) => workspaces.has(item.workspace))
				.map((item) => {
					const el = element("div", null, "git");
					el.append(
						element("div", item.workspace, "meta"),
						element("pre", item.error ?? item.status),
					);
					return el;
				}),
		);
		const ownerIds = new Set(tasks.map((task) => task.id));
		const environments = state.environments;
		const existingEnvironments = new Map(
			Array.from($("environments").children, (card) => [
				card.dataset.environmentRun,
				card,
			]),
		);
		reuseChildren(
			$("environments"),
			element(
				"p",
				environments.projects.length
					? environments.projects
							.map(
								(project) =>
									`${project.id} (${project.kind}): ${project.targets.map((target) => `${target.id} · ${target.action}/${target.runtime}`).join(", ")}`,
							)
							.join("\n")
					: "No configured environments. Add CONFIG_DIR/environments.json.",
				"meta",
			),
			...environments.waiters
				.filter((waiter) => !topic || ownerIds.has(waiter.owner))
				.map((waiter) =>
					element(
						"p",
						`Task ${waiter.owner} waiting for ${waiter.apps.join(", ")} · FIFO acquisition`,
					),
				),
			...environments.runs
				.filter((run) => !topic || ownerIds.has(run.owner))
				.sort(
					(a, b) =>
						Number(b.state !== "exited") - Number(a.state !== "exited") ||
						b.createdAt - a.createdAt,
				)
				.map((run) => {
					const card =
						existingEnvironments.get(run.id) ?? element("div", null, "task");
					if (card.dataset.environmentRevision === String(run.revision))
						return card;
					const previousLogs = card.querySelector("pre");
					card.replaceChildren();
					card.dataset.environmentRun = run.id;
					card.dataset.environmentRevision = String(run.revision);
					card.append(
						element(
							"strong",
							`${run.plan.app} · ${run.plan.action}/${run.plan.id} · ${run.state}`,
						),
						element(
							"p",
							`Task ${run.owner} · PID ${run.pid ?? "unknown"} (diagnostic only) · readiness ${run.ready === null ? "not checked" : run.ready ? "observed" : "not observed"} · exit ${run.exitCode ?? run.signal ?? "unknown"}`,
							"meta",
						),
					);
					if (run.error) card.append(element("p", run.error));
					card.append(
						button("View redacted logs", async () => {
							const logs = await api(
								`/api/environments/logs?app=${encodeURIComponent(run.plan.app)}`,
							);
							const log = logs.find((item) => item.id === run.id);
							const pre = card.querySelector("pre") ?? element("pre");
							pre.textContent =
								log?.output || "No complete log lines captured.";
							card.append(pre);
						}),
					);
					if (run.state === "interrupted")
						card.append(
							button("Release after inspection", async () => {
								if (
									!confirm(
										"Confirm: I inspected this interrupted execution and stopped any leftover processes. Release its resource lock without executing or killing anything? A saved PID alone does not establish process identity.",
									)
								)
									return;
								await api("/api/environments/release", {
									id: run.id,
									revision: run.revision,
									inspectionConfirmed: true,
								});
								await refresh();
							}),
						);
					if (previousLogs) card.append(previousLogs);
					return card;
				}),
		);
		const existingReviews = new Map(
			Array.from($("reviews").children, (card) => [
				card.dataset.reviewId,
				card,
			]),
		);
		reuseChildren(
			$("reviews"),
			...state.reviews
				.filter(
					(review) =>
						review.state === "pending" && (!topic || review.topicId === topic),
				)
				.map((review) => {
					const existing = existingReviews.get(review.id);
					if (existing) return existing;
					const el = element("div", null, "review");
					el.dataset.reviewId = review.id;
					const comments = element("textarea");
					comments.placeholder = "Review comments";
					el.append(
						element("h3", review.title),
						element(
							"div",
							`${review.topicId} · task ${review.taskId} · snapshot ${review.digest.slice(0, 12)}`,
							"meta",
						),
						element("pre", review.snapshot),
						comments,
					);
					for (const [label, decision] of [
						["Approve snapshot", "approved"],
						["Request changes", "changes-requested"],
						["Reject", "rejected"],
					])
						el.append(
							button(label, () =>
								api(`/api/reviews/${review.id}`, {
									revision: review.revision,
									decision,
									comments: comments.value,
								}),
							),
						);
					return el;
				}),
		);
		const nearBottom =
			document.querySelector("main").scrollHeight -
				document.querySelector("main").scrollTop -
				document.querySelector("main").clientHeight <
			250;
		$("chat").replaceChildren(
			...state.messages.map((message) => {
				const article = element("article", null, message.role);
				article.append(
					element(
						"div",
						message.role === "assistant"
							? "Orchestrator"
							: "Developer / task notification",
						"meta",
					),
				);
				const content = element("div");
				content.innerHTML = message.html;
				article.append(content);
				return article;
			}),
		);
		if (nearBottom) $("compose").scrollIntoView({ block: "end" });
	} catch (error) {
		$("connection").textContent = String(error);
	}
}
$("compose").onsubmit = async (event) => {
	event.preventDefault();
	const input = $("message");
	const content = input.value;
	if (!content.trim()) return;
	try {
		await api("/api/chat", { content, requestId: crypto.randomUUID() });
		input.value = "";
		await refresh();
	} catch (error) {
		$("connection").textContent = String(error);
	}
};
try {
	if (token) await api("/api/session", {});
	await refresh();
} catch (error) {
	$("connection").textContent = String(error);
}
setInterval(() => {
	void refresh();
}, 1500);
