import { button, element } from "/dom.js";

export function idleDescription(run) {
	if (run.idleReap)
		return `Idle expiry requested at ${new Date(run.idleReap.at).toISOString()}; cleanup state: ${run.state}${run.inspection ? " (operator-confirmed inspection)" : ""}. Idle expiry itself neither cancels coding nor permanently revokes its authority.`;
	if (!run.idle) return "";
	const scope =
			Number.isInteger(run.idle.ownerHeldRuns) &&
			Number.isInteger(run.idle.ownerBatches)
				? `Owner-wide activity: ${run.idle.ownerHeldRuns} held run${run.idle.ownerHeldRuns === 1 ? "" : "s"} across ${run.idle.ownerBatches} acquisition batch${run.idle.ownerBatches === 1 ? "" : "es"}.`
				: "Owner-wide activity across all held runs.",
		dependency =
			run.idle.dependencyScope === "exclusive-coupled-batch"
				? " Declared dependencies have an exclusive coupled lifetime, not shared-reference expiry."
				: " This is not independent per-app expiry.";
	if (run.idle.protection)
		return `Idle expiry protected: ${run.idle.protection}. ${scope}${dependency}`;
	const seconds = Math.ceil(run.idle.remainingMs / 1000);
	return (
		(seconds > 0
			? `Agent owner idle TTL: ${seconds}s remaining; any owner-scoped member activity renews all held runs.`
			: "Agent owner idle TTL elapsed; awaiting the next protected sweep (at most once per 60 seconds).") +
		` ${scope}${dependency}`
	);
}

// Clock-only polls must not recreate topics, task controls or focused diagnostics.
export function lifecycleRevision(state, topic, focusedTask) {
	return JSON.stringify([
		{
			...state,
			environments: {
				...state.environments,
				runs: state.environments.runs.map((run) =>
					run.idle ? { ...run, idle: { ...run.idle, remainingMs: null } } : run,
				),
			},
		},
		topic,
		focusedTask,
	]);
}
export function updateLifecycleClocks(root, runs) {
	const byId = new Map(runs.map((run) => [run.id, run]));
	for (const card of root.querySelectorAll("[data-environment-run]")) {
		const run = byId.get(card.dataset.environmentRun);
		const clock = card.querySelector(".environment-idle");
		if (run && clock) clock.textContent = idleDescription(run);
	}
	for (const clock of root.querySelectorAll("[data-wait-since]"))
		clock.textContent = `waiting ${Math.max(0, Math.floor((Date.now() - Number(clock.dataset.waitSince)) / 1000))}s`;
}
function matchingHolds(environments, waiter) {
	return environments.runs.filter(
		(run) => run.state !== "exited" && waiter.apps.includes(run.plan.app),
	);
}
export function waiterCard(waiter, environments, index, openOwner) {
	const card = element("div", null, "task environment-wait");
	const age = element("span");
	age.dataset.waitSince = String(waiter.since);
	card.append(
		element(
			"strong",
			`Task ${waiter.owner} waiting for ${waiter.apps.join(", ")} · global queue order ${index + 1}/${environments.waiters.length}`,
		),
		age,
		button(`Open waiting task ${waiter.owner}`, () => openOwner(waiter.owner)),
	);
	const holds = matchingHolds(environments, waiter);
	if (!holds.length)
		card.append(
			element(
				"p",
				"No matching app hold in this snapshot; other resource conflicts may apply.",
				"meta",
			),
		);
	for (const run of holds)
		card.append(
			element(
				"p",
				`Matching hold: ${run.plan.app} · task ${run.owner} · ${run.state}`,
				"meta",
			),
		);
	for (const owner of new Set(holds.map((run) => run.owner)))
		card.append(button(`Open holding task ${owner}`, () => openOwner(owner)));
	return card;
}

// Bounded, best-effort snapshot notices; never a durable event log or a cleanup claim
// from an issued intent alone. Initial hydration does not replay historical notices.
export function lifecycleNotices(root, openOwner) {
	let previous = null;
	const notices = [];
	const add = (message, owner) => {
		const node = element("div", null, "environment-notice");
		node.append(
			element("span", message),
			button(`Open task ${owner}`, () => openOwner(owner)),
		);
		notices.push({ node, expiresAt: Date.now() + 30000 });
		root.append(node);
		while (notices.length > 5) {
			const index = notices.findIndex(
				(notice) => !notice.node.contains(document.activeElement),
			);
			notices.splice(index, 1)[0].node.remove();
		}
	};
	return (environments) => {
		for (let index = notices.length - 1; index >= 0; index--) {
			const notice = notices[index];
			if (
				notice.expiresAt <= Date.now() &&
				!notice.node.contains(document.activeElement)
			) {
				notice.node.remove();
				notices.splice(index, 1);
			}
		}
		const runs = new Map(environments.runs.map((run) => [run.id, run]));
		const waits = new Set(environments.waiters.map((wait) => wait.batch));
		if (previous) {
			for (const waiter of environments.waiters)
				if (!previous.waits.has(waiter.batch)) {
					const holders = [
						...new Set(
							matchingHolds(environments, waiter).map((run) => run.owner),
						),
					];
					add(
						`Task ${waiter.owner} waits for ${waiter.apps.join(", ")}${holders.length ? ` · matching holds: ${holders.map((owner) => `task ${owner}`).join(", ")}` : " · resource conflict"}`,
						waiter.owner,
					);
				}
			for (const run of environments.runs) {
				const before = previous.runs.get(run.id);
				if (
					run.plan.action === "run" &&
					run.state === "running" &&
					before?.state !== "running"
				)
					add(`${run.plan.app} running for task ${run.owner}`, run.owner);
				if (
					run.idleReap &&
					run.state === "exited" &&
					(!before?.idleReap || before.state !== "exited")
				)
					add(
						`${run.plan.app} idle cleanup ${run.inspection ? "confirmed by operator inspection" : "completed"} · task ${run.owner}`,
						run.owner,
					);
			}
		}
		previous = { runs, waits };
	};
}
