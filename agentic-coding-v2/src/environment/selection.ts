export type Action = "run" | "build" | "test";
export type Runtime =
	| "shell"
	| "systemshell"
	| "powershell"
	| "docker"
	| "podman"
	| "compose"
	| "kubernetes";
export type Selection = {
	target?: string;
	profile?: string;
	runtime?: Runtime;
	replicas?: number;
};
export type Candidate = {
	id: string;
	action: Action;
	runtime: Runtime;
	profile?: string;
	label?: string;
	availability?: { eligible: boolean | null; reason: string };
};
const preference: Runtime[] = [
	"docker",
	"podman",
	"compose",
	"shell",
	"systemshell",
	"powershell",
	"kubernetes",
];
/** One resolver for tools and dashboard defaults. Cluster execution is never an implicit fallback. */
export function selectTarget<T extends Candidate>(
	targets: T[],
	action: Action,
	selection: Selection = {},
	declared?: string,
): T {
	const { target, profile, runtime, replicas } = selection;
	let declaredChosen = false;
	const exactId =
		target !== undefined &&
		targets.some((item) => item.action === action && item.id === target);
	let candidates = targets.filter(
		(item) =>
			item.action === action &&
			item.availability?.eligible !== false &&
			(target === undefined ||
				(exactId ? item.id === target : item.label === target)) &&
			(profile === undefined || (item.profile ?? "default") === profile) &&
			(runtime === undefined || item.runtime === runtime),
	);
	// A declaration can select a non-default profile; an explicit profile/runtime
	// may deliberately override it, but a broken declaration must never be guessed around.
	if (target === undefined && declared) {
		const configured = targets.find(
			(item) => item.id === declared && item.action === action,
		);
		if (!configured) throw new Error(`Unknown declared ${action} default`);
		const chosen = candidates.find((item) => item.id === declared);
		if (chosen?.runtime === "kubernetes" && runtime !== "kubernetes")
			throw new Error("Kubernetes defaults require explicit runtime selection");
		if (chosen) {
			candidates = [chosen];
			declaredChosen = true;
		} else if (profile === undefined && runtime === undefined)
			throw new Error(`Declared ${action} default is unavailable`);
	}
	if (target === undefined && runtime !== "kubernetes")
		candidates = candidates.filter((item) => item.runtime !== "kubernetes");
	if (target === undefined && profile === undefined && !declaredChosen)
		candidates = candidates.filter(
			(item) => (item.profile ?? "default") === "default",
		);
	if (candidates.length > 1 && action === "run" && !target) {
		const preferred = preference.find((value) =>
			candidates.some((item) => item.runtime === value),
		);
		candidates = candidates.filter((item) => item.runtime === preferred);
	}
	if (candidates.length !== 1)
		throw new Error(
			`Choose an unambiguous ${action} target; candidates: ${candidates.map((item) => item.id).join(", ") || "none"}`,
		);
	const chosen = candidates[0];
	if (!chosen) throw new Error("Environment target missing");
	if (
		replicas !== undefined &&
		(chosen.runtime !== "kubernetes" ||
			!Number.isSafeInteger(replicas) ||
			replicas < 1 ||
			replicas > 100)
	)
		throw new Error(
			"replicas-unsupported: replicas require an explicit Kubernetes target and a count from 1 to 100",
		);
	return chosen;
}
type DefaultChoice = { id: string | null; reason: string };
export function defaultTargets<T extends Candidate>(
	targets: T[],
	defaults: Partial<Record<Action, string>> = {},
): Record<Action, DefaultChoice> {
	const choice = (action: Action): DefaultChoice => {
		try {
			const selected = selectTarget(targets, action, {}, defaults[action]);
			const count = targets.filter(
				(item) =>
					item.action === action &&
					(item.profile ?? "default") === "default" &&
					item.runtime !== "kubernetes" &&
					item.availability?.eligible !== false,
			).length;
			const reason =
				defaults[action] === selected.id
					? "declared"
					: count === 1
						? "only-candidate"
						: "runtime-preference";
			return { id: selected.id, reason };
		} catch (error) {
			return {
				id: null,
				reason: error instanceof Error ? error.message : "Unavailable",
			};
		}
	};
	return { run: choice("run"), build: choice("build"), test: choice("test") };
}
