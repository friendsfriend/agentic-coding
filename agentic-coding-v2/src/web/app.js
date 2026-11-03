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
