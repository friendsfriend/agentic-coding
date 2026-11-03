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
function environmentProject(project, existing) {
	const card = existing ?? element("div", null, "task environment-project");
	const version = JSON.stringify(project);
	if (card.dataset.environmentProjectRevision === version) return card;
	card.dataset.environmentProject = project.id;
	card.dataset.environmentProjectRevision = version;
	card.replaceChildren();
	const field = (label, control) => {
		const wrapper = element("label", `${label} `);
		control.setAttribute("aria-label", `${project.id} ${label}`);
		wrapper.append(control);
		card.append(wrapper);
		return wrapper;
	};
	const choices = (control, entries, selected) => {
		control.replaceChildren(
			...entries.map(([value, label, disabled]) => {
				const option = element("option", label);
				option.value = value;
				option.disabled = Boolean(disabled);
				return option;
			}),
		);
		if (entries.some(([value]) => value === selected)) control.value = selected;
	};
	const action = element("select"),
		runtime = element("select"),
		profile = element("select"),
		target = element("select"),
		workspace = element("select"),
		replicas = element("input"),
		base = element("input");
	base.value = "HEAD";
	base.disabled = true;
	replicas.type = "number";
	replicas.min = "1";
	replicas.max = "16";
	replicas.value = "1";
	choices(
		workspace,
		[
			["checkout", "Developer checkout (includes local edits)"],
			["worktree", "Isolated worktree (captured commit)"],
		],
		"checkout",
	);
	workspace.onchange = () => {
		base.disabled = workspace.value !== "worktree";
	};
	card.append(
		element("strong", `${project.id} · ${project.kind}`),
		element("p", project.repository, "meta"),
	);
	field("Action", action);
	field("Runtime", runtime);
	field("Profile", profile);
	field("Target", target);
	field("Workspace", workspace);
	field("Git base (worktree only)", base);
	const replicaField = field("Replicas (Kubernetes)", replicas);
	let replicaTarget = "";
	const detail = element("p", null, "meta");
	let request = null;
	const submit = button("Prepare action for review", async () => {
		submit.disabled = true;
		try {
			const selected = project.targets.find((item) => item.id === target.value);
			if (!selected) throw new Error("Choose a target");
			const body = {
				apps: [project.id],
				action: action.value,
				target: selected.id,
				runtime: selected.runtime,
				profile: selected.profile ?? "default",
				workspaceMode: workspace.value,
				...(workspace.value === "worktree"
					? { baseRef: base.value || "HEAD" }
					: {}),
				...(selected.runtime === "kubernetes"
					? { replicas: Number(replicas.value) }
					: {}),
			};
			const fingerprint = JSON.stringify(body);
			if (!request || request.fingerprint !== fingerprint)
				request = { fingerprint, requestId: crypto.randomUUID() };
			const result = await api("/api/environments/actions", {
				...body,
				requestId: request.requestId,
			});
			request = null;
			detail.textContent =
				"Native environment task " +
				result.taskId +
				" admitted. Review the exact plan before execution.";
			selectTopic("environments");
		} finally {
			submit.disabled = !target.value;
		}
	});
	const updateTargets = () => {
		const candidates = project.targets.filter(
			(item) =>
				item.action === action.value &&
				(!runtime.value || item.runtime === runtime.value) &&
				(!profile.value || (item.profile ?? "default") === profile.value),
		);
		const preferred = project.defaultTargets?.[action.value];
		choices(
			target,
			candidates.map((item) => [
				item.id,
				(item.label ?? item.id) +
					" · " +
					item.runtime +
					"/" +
					(item.profile ?? "default") +
					(item.availability?.eligible === false
						? ` · unavailable: ${item.availability.reason}`
						: ""),
				item.availability?.eligible === false,
			]),
			candidates.some((item) => item.id === target.value)
				? target.value
				: preferred?.id,
		);
		if (target.selectedOptions[0]?.disabled) {
			target.value =
				candidates.find((item) => item.availability?.eligible !== false)?.id ??
				"";
		}
		submit.disabled = !target.value;
		const selected = candidates.find((item) => item.id === target.value);
		replicaField.hidden = selected?.runtime !== "kubernetes";
		if (replicaTarget !== target.value) {
			replicas.value = String(selected?.kubernetes?.replicas ?? 1);
			replicaTarget = target.value;
		}
		detail.textContent =
			"Default: " +
			(preferred?.id ?? "none") +
			" (" +
			(preferred?.reason ?? "not configured") +
			"). " +
			(selected?.availability?.reason ?? "Choose an eligible target.") +
			" Startup compatibility is not verified by metadata.";
	};
	const updateFilters = () => {
		const candidates = project.targets.filter(
			(item) => item.action === action.value,
		);
		choices(
			runtime,
			[
				["", "All configured runtimes"],
				...[...new Set(candidates.map((item) => item.runtime))].map((value) => [
					value,
					value,
				]),
			],
			"",
		);
		choices(
			profile,
			[
				["", "All configured profiles"],
				...[
					...new Set(candidates.map((item) => item.profile ?? "default")),
				].map((value) => [value, value]),
			],
			"",
		);
		updateTargets();
	};
	choices(
		action,
		[...new Set(project.targets.map((item) => item.action))].map((value) => [
			value,
			value,
		]),
	);
	action.onchange = updateFilters;
	runtime.onchange = updateTargets;
	profile.onchange = updateTargets;
	target.onchange = updateTargets;
	card.append(
		detail,
		element(
			"p",
			"No agent or model runs. Developer-checkout actions include mutable local edits and may modify the checkout. Isolated-worktree actions use a captured commit without uncommitted edits. Review the exact commands, workspace and resource scope before execution.",
			"meta",
		),
		submit,
	);
	updateFilters();
	return card;
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
			...(environments.projects.length
				? environments.projects.map((project) =>
						environmentProject(
							project,
							Array.from($("environments").children).find(
								(card) => card.dataset.environmentProject === project.id,
							),
						),
					)
				: [
						element(
							"p",
							"No configured environments. Add CONFIG_DIR/environments.json.",
							"meta",
						),
					]),
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
					const resource = run.runtimeStatus;
					const renderRevision = JSON.stringify([
						run.revision,
						resource?.id,
						resource?.state,
						resource?.health,
						resource?.owned,
						(run.runtimeStatuses ?? []).map((status) => [
							status.id,
							status.state,
							status.health,
							status.owned,
						]),
					]);
					if (card.dataset.environmentRevision === renderRevision) return card;
					const previousLogs = card.querySelector("pre.environment-logs");
					const previousTelemetry = card.querySelector(
						"pre.environment-telemetry",
					);
					card.replaceChildren();
					card.dataset.environmentRun = run.id;
					card.dataset.environmentRevision = renderRevision;
					card.append(
						element(
							"strong",
							`${run.plan.app} · ${run.plan.action}/${run.plan.id} · ${run.state}`,
						),
						element(
							"p",
							`Task ${run.owner} · ${resource ? `${resource.runtime} ${resource.name} · last observed ${resource.state} · health ${resource.health ?? "not checked"} · ownership ${resource.owned === null ? "unknown" : resource.owned ? "confirmed" : "foreign"} · ID ${resource.id ?? "unknown"} (diagnostic only)` : `PID ${run.pid ?? "unknown"} (diagnostic only)`} · startup readiness ${run.ready === null ? "not checked" : run.ready ? "observed" : "not observed"} · exit ${run.exitCode ?? run.signal ?? "unknown"}`,
							"meta",
						),
					);
					for (const service of run.runtimeStatuses ?? [])
						card.append(
							element(
								"p",
								`${service.name} · ${service.runtime}/${service.kind ?? "container"} · ${service.state} · health ${service.health ?? "not checked"} · ownership ${service.owned === null ? "unknown" : service.owned ? "confirmed" : "foreign"} · ID ${service.id ?? "unknown"} (diagnostic only)`,
								"meta",
							),
						);
					if (run.error) card.append(element("p", run.error));
					if (
						run.state !== "exited" &&
						run.state !== "interrupted" &&
						state.tasks.some(
							(task) =>
								task.id === run.owner && task.kind === "operator-environment",
						)
					)
						card.append(
							button("Stop operator batch", async () => {
								if (
									!confirm(
										"Stop this operator action and all coupled dependencies?",
									)
								)
									return;
								await api(`/api/tasks/${run.owner}/cancel`, {});
								await refresh();
							}),
						);
					card.append(
						button("View redacted logs", async () => {
							const logs = await api(
								`/api/environments/logs?app=${encodeURIComponent(run.plan.app)}`,
							);
							const log = logs.find((item) => item.id === run.id);
							const pre =
								card.querySelector("pre.environment-logs") ??
								element("pre", null, "environment-logs");
							pre.textContent = !log
								? "This run is outside the retained log response window."
								: log.output ||
									(log.selection.omittedForBudget
										? "Matching lines exceed the retained-log response budget; no complete line was returned."
										: "No matching complete lines in the retained log window.");
							card.append(pre);
						}),
					);
					if (
						run.state === "running" &&
						run.ready === true &&
						run.plan.telemetry
					)
						for (const mode of ["traces", "logs"])
							card.append(
								button(
									mode === "traces"
										? "View native trace summaries"
										: "View native telemetry logs",
									async () => {
										const query = new URLSearchParams({
											app: run.plan.app,
											run: run.id,
											mode,
										});
										const observation = await api(
											`/api/environments/telemetry?${query}`,
										);
										const pre =
											card.querySelector("pre.environment-telemetry") ??
											element("pre", null, "environment-telemetry");
										pre.textContent = JSON.stringify(observation, null, 2);
										card.append(pre);
									},
								),
							);
					if (run.state === "interrupted")
						card.append(
							button("Release after inspection", async () => {
								if (
									!confirm(
										"Confirm: I inspected this interrupted execution and stopped/removed its leftover processes, containers and stack networks. Release its resource lock without executing or killing anything? A saved PID alone does not establish process identity.",
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
					if (previousTelemetry) card.append(previousTelemetry);
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
