// Pluggable classifier integrations (introduce-jev-for-model-range-decision).
//
// A classifier is pure domain knowledge: what it is called, which categories
// it may return, which workflow step/role its result routes, and how to turn
// the model's raw answer into one of those categories. The runtime owns the
// I/O half (collecting the OpenSpec artifacts, invoking the configured model,
// and rewriting routing) in `classifier-runner.ts`, so adding another JEV
// integration is one entry here plus (optionally) a new workflow step — no
// engine branches.
/** One category a classifier may return. Categories are integration-local
 * strings; the routing layer maps them to profiles through the preset. */
export type ClassifierCategory = string;

/** The bounded, already-collected material handed to a classifier. */
export interface ClassifierInput {
	readonly task: string;
	readonly changeId: string;
	readonly artifacts: readonly {
		readonly path: string;
		readonly content: string;
	}[];
}

/** Where a classifier's winning category is applied. */
export interface ClassifierTarget {
	readonly stepId: string;
	readonly role?: string;
}

export interface ClassifierQuestion {
	readonly id: string;
	readonly instructions: string;
	readonly criteria: Readonly<Record<ClassifierCategory, string>>;
}

export interface ClassifierIntegration {
	readonly id: string;
	readonly label: string;
	/** Every category this classifier may return, in display order. */
	readonly categories: readonly ClassifierCategory[];
	/** Step/role whose pinned profile this classification overrides. */
	readonly target: ClassifierTarget;
	/** Config profile used to select the classifier model. */
	readonly profile: string;
	/** OpenCode Zen System One endpoint used by this classifier. */
	readonly endpoint: string;
	/** Typed question sent to System One. */
	readonly question: ClassifierQuestion;
	readonly model: string;
	/** Prepended to the rendered artifacts to form the classifier state. */
	readonly instruction: string;
	/** Parse a raw model answer into exactly one category, or throw. */
	parse(raw: string): ClassifierCategory;
}

/** Render the prompt for one integration without leaking integration-specific
 * logic into the runtime. Artifact contents are bounded by the caller. */
export function renderClassifierPrompt(
	integration: ClassifierIntegration,
	input: ClassifierInput,
): string {
	const header = [
		integration.instruction.trim(),
		"",
		`Change: ${input.changeId || "(unknown)"}`,
		input.task.trim() ? `Task: ${input.task.trim()}` : "",
		`Allowed categories: ${integration.categories.join(", ")}`,
		"Answer with exactly one category and nothing else.",
	]
		.filter(Boolean)
		.join("\n");
	const body = input.artifacts
		.map(
			(artifact) =>
				`<artifact path="${artifact.path}">\n${artifact.content}\n</artifact>`,
		)
		.join("\n\n");
	return `${header}\n\n${body}\n`;
}

/** Case-insensitive first-category match used by keyword classifiers. */
export function parseCategoryAnswer(
	categories: readonly ClassifierCategory[],
	raw: string,
): ClassifierCategory {
	const text = raw.toLowerCase();
	for (const category of categories) {
		const escaped = category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) return category;
	}
	throw new Error(
		`classifier answer did not name one of: ${categories.join(", ")}`,
	);
}

const COMPLEXITY_INSTRUCTION = `You classify the implementation complexity of an OpenSpec change.
Judge how much engineering effort and care the tasks require, not how terse the
proposal is.`;

const COMPLEXITY_CRITERIA = Object.freeze({
	easy: "A tiny, low-risk change scoped to one or two files",
	medium: "A normal change touching a few modules with clear requirements",
	hard: "A broad or subtle change with many moving parts or integration risk",
	critical:
		"A high-risk change with architectural, migration, security, or cross-cutting consequences",
});

/** The first integration: worker-model range from plan complexity. This is
 * the only classifier the workflow family currently routes; more integrations
 * are added by appending entries to `CLASSIFIER_INTEGRATIONS`. */
export const complexityClassifier: ClassifierIntegration = Object.freeze({
	id: "complexity",
	label: "Plan complexity",
	categories: Object.freeze(["easy", "medium", "hard", "critical"]),
	target: Object.freeze({ stepId: "core.implementation", role: "worker" }),
	profile: "jev-classifier",
	endpoint: "https://opencode.ai/zen/v1/systemone",
	question: {
		id: "complexity",
		instructions: "Which complexity class fits this planned change?",
		criteria: COMPLEXITY_CRITERIA,
	},
	model: "opencode/jev-1.13-free",
	instruction: COMPLEXITY_INSTRUCTION,
	parse: (raw: string) =>
		parseCategoryAnswer(
			["easy", "medium", "hard", "critical"],
			raw,
		) as ClassifierCategory,
});

export const CLASSIFIER_INTEGRATIONS: readonly ClassifierIntegration[] =
	Object.freeze([complexityClassifier]);

export function classifierFor(id: string): ClassifierIntegration {
	const integration = CLASSIFIER_INTEGRATIONS.find((item) => item.id === id);
	if (!integration) throw new Error(`unknown classifier integration: ${id}`);
	return integration;
}
