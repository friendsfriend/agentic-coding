/**
 * `ask_jev` — one general Jev tool the agent drives.
 *
 * Level 10 shape: the *agent* writes the questions, and code assembles the state
 * from up to three sources — its own inline state, files it names, and the output
 * of a command it names. One call judges one situation, and the agent receives the
 * answers, never the file contents and never the command output.
 *
 * The engine serializes its *resolved* classifier binding into `AGENTIC_JEV` at
 * launch, so the tool cannot disagree with the run's pinned classifier: provider,
 * model and endpoint arrive from the same resolution point the engine-side sweep
 * uses. One setting, one place it is read. The binding is only supplied for a
 * transport a pane can reach without a credential (the local sidecar); when it is
 * absent the tool reports that in-session judgment is unavailable and does nothing
 * else: no default endpoint, no guessed model, no credential.
 *
 * No conventions preamble is sent with a call, unlike the engine-side sweep: the
 * sweep's preamble states file-judgment conventions that would bias a question
 * about a test failure or a plan.
 *
 * The command runs through pi's own bash tool (`ctx.executeTool`), so it passes
 * the same argument validation, `tool_call`/`tool_result` handlers, and permission
 * checks as a model-issued call, instead of spawning a shell behind them.
 *
 * Two honesty rules are enforced here rather than left to the prompt:
 *
 * - A call that cannot fit the budget is **refused**, not truncated. A truncated
 *   state is silently a different question, and the agent cannot see which part
 *   went missing.
 * - An answer whose confidence is below the floor is reported as uninformative.
 *   Measured: the local classifier clusters its answers, so a coin flip read as a
 *   verdict is worse than no answer at all.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";

const MAX_RETAINED = 4;
const ENV_VAR = "AGENTIC_JEV";

/** Roughly four characters per token, the same estimate the sweep uses. */
const CHAR_PER_TOKEN = 4;
/** Jev's shared budget for state plus questions is 64k tokens; leave room for the
 * questions so a state that fits cannot be refused for the wrong reason. */
const STATE_TOKEN_BUDGET = 60_000;
/** The agent's own note is for context, not for pasting content code can fetch. */
const MAX_OWN_STATE_CHARS = 8_000;
/** One call judges one situation, not a corpus. Many files belong to many calls,
 * and the engine's own sweep covers the changed-file set at scale. */
const MAX_PATHS_PER_CALL = 20;
const MAX_FILE_BYTES = 96 * 1024;
const MAX_OUTPUT_CHARS = 96 * 1024;
const MAX_QUESTIONS = 12;
const MAX_CHOICE_OPTIONS = 255;
const MIN_SCORE_LEVELS = 2;
const MAX_SCORE_LEVELS = 10;
/** Below this, the classifier is telling us it does not know. */
const LOW_CONFIDENCE = 0.5;
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build"]);
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|onnx|bin|woff2?)$/i;
const QUESTION_TYPES = new Set(["noul", "choice", "score"]);

interface Binding {
	readonly provider: string;
	readonly model: string;
	readonly endpoint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readBinding(env: NodeJS.ProcessEnv = process.env): Binding | undefined {
	const raw = env[ENV_VAR];
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as Partial<Binding>;
		if (
			typeof parsed.provider !== "string" ||
			typeof parsed.model !== "string" ||
			typeof parsed.endpoint !== "string"
		)
			return undefined;
		return {
			provider: parsed.provider,
			model: parsed.model,
			endpoint: parsed.endpoint,
		};
	} catch {
		return undefined;
	}
}

// ── questions ────────────────────────────────────────────────────────────────
// The Jev wire contract, validated here before any transport so a malformed block
// costs an error message instead of a paid call that answers nothing.

export type QuestionsResult =
	| { readonly ok: true; readonly ids: string[]; readonly questions: Record<string, unknown> }
	| { readonly ok: false; readonly error: string };

function instructionsOf(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	return isRecord(value);
}

export function validateQuestions(raw: unknown): QuestionsResult {
	let parsed: unknown = raw;
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { ok: false, error: "questions is a string but not JSON. Pass an object keyed by question id." };
		}
	}
	if (!isRecord(parsed) || Object.keys(parsed).length === 0)
		return {
			ok: false,
			error: "questions must be a non-empty object keyed by the ids you choose, for example {leak: {type: \"noul\", instructions: \"...\"}}.",
		};
	const ids = Object.keys(parsed);
	if (ids.length > MAX_QUESTIONS)
		return { ok: false, error: `questions has ${ids.length} entries; the most one call takes is ${MAX_QUESTIONS}.` };
	const questions: Record<string, unknown> = {};
	for (const id of ids) {
		const question = parsed[id];
		if (!isRecord(question)) return { ok: false, error: `question "${id}" must be an object.` };
		const type = question.type;
		if (typeof type !== "string" || !QUESTION_TYPES.has(type))
			return { ok: false, error: `question "${id}" needs a type of noul, choice, or score.` };
		if (!instructionsOf(question.instructions))
			return {
				ok: false,
				error: `question "${id}" needs instructions: a non-blank string, or an object holding the question and the data it refers to.`,
			};
		if (type === "noul" && question.criteria !== undefined) {
			if (!isRecord(question.criteria))
				return { ok: false, error: `noul "${id}" criteria must be an object mapping true and false to descriptions.` };
			for (const [key, value] of Object.entries(question.criteria))
				if (key !== "true" && key !== "false")
					return { ok: false, error: `noul "${id}" criteria may only describe true and false, and it describes "${key}".` };
				else if (value !== undefined && typeof value !== "string")
					return { ok: false, error: `noul "${id}" criteria."${key}" must be a string.` };
		}
		if (type === "choice") {
			if (!isRecord(question.criteria))
				return {
					ok: false,
					error: `choice "${id}" needs criteria mapping each option to its rubric, using null when an option needs no detail.`,
				};
			const options = Object.keys(question.criteria);
			if (options.length === 0)
				return { ok: false, error: `choice "${id}" has no options; a choice cannot pick from an empty list.` };
			if (options.length > MAX_CHOICE_OPTIONS)
				return {
					ok: false,
					error: `choice "${id}" has ${options.length} options; the most the endpoint takes is ${MAX_CHOICE_OPTIONS}.`,
				};
			if (Object.values(question.criteria).some((value) => value !== null && typeof value !== "string"))
				return { ok: false, error: `choice "${id}" descriptions must be strings or null.` };
		}
		if (type === "score") {
			if (!Array.isArray(question.criteria))
				return {
					ok: false,
					error: `score "${id}" needs criteria as an ordered array of level descriptions, low to high.`,
				};
			if (question.criteria.length < MIN_SCORE_LEVELS || question.criteria.length > MAX_SCORE_LEVELS)
				return {
					ok: false,
					error: `score "${id}" needs between ${MIN_SCORE_LEVELS} and ${MAX_SCORE_LEVELS} levels; it has ${question.criteria.length}.`,
				};
			if (question.criteria.some((level) => typeof level !== "string" || level.trim().length === 0))
				return { ok: false, error: `score "${id}" levels must be non-blank strings.` };
		}
		questions[id] = question;
	}
	return { ok: true, ids, questions };
}

// ── state assembly ───────────────────────────────────────────────────────────

export interface CommandOutput {
	readonly command: string;
	readonly exit_code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly note?: string;
}

interface Part {
	readonly name: string;
	readonly tokens: number;
	readonly kind: "own" | "file" | "output";
}

export interface AssembledState {
	readonly state: Record<string, unknown>;
	readonly summary: string;
	readonly tokens: number;
	/** What the state was built from. Kept so a later call can rebuild the same
	 * state without reading the files again or re-running the command. */
	readonly sources: Sources;
}

export interface FileStat {
	readonly path: string;
	readonly mtimeMs: number;
	readonly size: number;
}

/** The inputs one state was assembled from, in the form a rebuild needs. */
export interface Sources {
	readonly own: Record<string, unknown>;
	readonly files: Record<string, string>;
	readonly stats: readonly FileStat[];
	readonly command?: CommandOutput;
}

/** One state the session can be asked about again. */
export interface RetainedState {
	readonly id: string;
	readonly at: number;
	readonly summary: string;
	readonly tokens: number;
	readonly sources: Sources;
}

export type AssembleResult =
	| { readonly ok: true; readonly assembled: AssembledState }
	| { readonly ok: false; readonly error: string };

/** Token counts are printed by code that branches on them, so a count below a
 * thousand must not read as thousands: the smoke run showed "65k tokens" for one
 * small file, which is exactly the kind of number an agent will act on. */
export function fmtTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}`;
	return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function tokensOf(text: string): number {
	return Math.ceil(text.length / CHAR_PER_TOKEN);
}

/** The agent's own state: plain text stays text, a JSON object or array is kept
 * as written, so its field names survive into the question's instructions. */
export function parseOwnState(raw: unknown): Record<string, unknown> {
	if (raw === undefined || raw === "") return {};
	if (isRecord(raw)) return { ...raw };
	if (Array.isArray(raw)) return { items: raw };
	if (typeof raw !== "string") return { text: String(raw) };
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (isRecord(parsed)) return { ...parsed };
		if (Array.isArray(parsed)) return { items: parsed };
	} catch {
		/* not JSON: the agent's own prose */
	}
	return { text: raw };
}

/** Files under one path or glob, with the directories and binaries the sweep never
 * judges removed. The glob support is a directory prefix plus a suffix match, which
 * is all this needs and keeps the file dependency-free. */
export function expandTargets(patterns: readonly string[], cwd: string): string[] {
	const found: string[] = [];
	const walk = (target: string): void => {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(target);
		} catch {
			return;
		}
		if (stat.isFile()) {
			found.push(target);
			return;
		}
		if (!stat.isDirectory()) return;
		for (const entry of fs.readdirSync(target).sort()) {
			if (SKIP_DIRECTORIES.has(entry)) continue;
			const child = path.join(target, entry);
			let childStat: fs.Stats;
			try {
				childStat = fs.statSync(child);
			} catch {
				continue;
			}
			if (childStat.isDirectory()) walk(child);
			else found.push(child);
		}
	};
	for (const pattern of patterns) {
		if (!pattern.includes("*")) {
			walk(path.resolve(cwd, pattern));
			continue;
		}
		const star = pattern.indexOf("*");
		const prefix = pattern.slice(0, star);
		const suffix = pattern.slice(star).replace(/^\*+/, "").replace(/^\//, "");
		const base = path.resolve(cwd, prefix.endsWith("/") ? prefix : path.dirname(prefix));
		const before = found.length;
		walk(base);
		if (!suffix) continue;
		const matched = found.slice(before).filter((file) => file.endsWith(suffix));
		found.length = before;
		found.push(...matched);
	}
	return [...new Set(found.filter((file) => !BINARY_EXTENSIONS.test(file)))].sort();
}

/** Greedy first fit, largest first: the refusal can name a split that fits instead
 * of leaving the agent to discover the budget by bisection. */
function suggestSplit(parts: readonly Part[], budget: number): Part[][] {
	const bins: Array<{ total: number; items: Part[] }> = [];
	for (const part of [...parts].sort((a, b) => b.tokens - a.tokens)) {
		const bin = bins.find((candidate) => candidate.total + part.tokens <= budget);
		if (bin) {
			bin.items.push(part);
			bin.total += part.tokens;
		} else bins.push({ total: part.tokens, items: [part] });
	}
	return bins.map((bin) => bin.items);
}

function describeParts(parts: readonly Part[]): string {
	const files = parts.filter((part) => part.kind === "file").map((part) => part.name);
	const bits: string[] = [];
	if (parts.some((part) => part.kind === "own")) bits.push("your state");
	if (files.length) bits.push(`files [${files.join(", ")}]`);
	if (parts.some((part) => part.kind === "output")) bits.push("the command output");
	return `${bits.join(" + ")} (${fmtTokens(parts.reduce((total, part) => total + part.tokens, 0))} tokens)`;
}

export function overflowMessage(parts: readonly Part[], budget: number): string {
	const total = parts.reduce((sum, part) => sum + part.tokens, 0);
	const oversize = parts.filter((part) => part.tokens > budget);
	const groups = suggestSplit(parts, budget);
	const lines = [
		`ask_jev: the state is ${fmtTokens(total)} tokens and one call holds ${fmtTokens(budget)} tokens. Nothing was sent.`,
		`Parts, largest first: ${[...parts].sort((a, b) => b.tokens - a.tokens).map((part) => `${part.name} ${fmtTokens(part.tokens)} tokens`).join(", ")}.`,
	];
	if (oversize.length)
		lines.push(
			`Too large for any single call: ${oversize.map((part) => part.name).join(", ")}. Narrow it or leave it out.`,
		);
	if (groups.length > 1 && !oversize.length)
		lines.push(
			`Split into ${groups.length} calls with the same questions: ${groups
				.map((group, index) => `call ${index + 1}: ${describeParts(group)}`)
				.join("; ")}.`,
		);
	return lines.join(" ");
}

export function stateFromSources(sources: Sources): AssembleResult {
	const { own, files, command } = sources;
	const parts: Part[] = [];
	if (Object.keys(own).length)
		parts.push({ name: "your state", tokens: tokensOf(JSON.stringify(own)), kind: "own" });
	for (const [file, content] of Object.entries(files))
		parts.push({ name: file, tokens: tokensOf(content), kind: "file" });
	if (command)
		parts.push({
			name: `output of \`${command.command}\``,
			tokens: tokensOf([command.stdout, command.stderr].join("\n")) + (command.note ? tokensOf(command.note) : 0),
			kind: "output",
		});

	if (!parts.length)
		return { ok: false, error: "ask_jev: nothing to judge. Pass state, paths, or command." };
	const tokens = parts.reduce((sum, part) => sum + part.tokens, 0);
	if (tokens > STATE_TOKEN_BUDGET) return { ok: false, error: overflowMessage(parts, STATE_TOKEN_BUDGET) };

	const state: Record<string, unknown> = { ...own };
	if (Object.keys(files).length) state.files = files;
	if (command) state.output = outputOf(command);
	const summary = [
		Object.keys(own).length ? `your state (${Object.keys(own).join(", ")})` : "",
		Object.keys(files).length ? `files (${Object.keys(files).length})` : "",
		command ? `output of \`${command.command}\`` : "",
		`${fmtTokens(tokens)} tokens`,
	]
		.filter((part) => part.length > 0)
		.join(", ");
	return { ok: true, assembled: { state, summary, tokens, sources } };
}

/** Re-stat the snapshot's files and re-read only the ones that changed. The
 * command's output cannot be checked cheaply, so it is reused as it was and the
 * caller says so. */
export function refreshSources(
	sources: Sources,
	cwd: string,
): { sources: Sources; refreshed: string[]; removed: string[]; unreadable: string[] } {
	const files: Record<string, string> = {};
	const stats: FileStat[] = [];
	const refreshed: string[] = [];
	const removed: string[] = [];
	const unreadable: string[] = [];
	for (const stat of sources.stats) {
		const absolute = path.resolve(cwd, stat.path);
		let current: fs.Stats;
		try {
			current = fs.statSync(absolute);
		} catch {
			removed.push(stat.path);
			continue;
		}
		if (current.mtimeMs === stat.mtimeMs && current.size === stat.size) {
			files[stat.path] = sources.files[stat.path] ?? "";
			stats.push(stat);
			continue;
		}
		let content: string;
		try {
			content = fs.readFileSync(absolute, "utf8");
		} catch {
			// Keep the content that was judged rather than judging half a file.
			files[stat.path] = sources.files[stat.path] ?? "";
			stats.push(stat);
			unreadable.push(stat.path);
			continue;
		}
		files[stat.path] = content;
		stats.push({ path: stat.path, mtimeMs: current.mtimeMs, size: current.size });
		refreshed.push(stat.path);
	}
	return {
		sources: {
			own: sources.own,
			files,
			stats,
			...(sources.command ? { command: sources.command } : {}),
		},
		refreshed,
		removed,
		unreadable,
	};
}

/** How long ago, in the coarsest unit that still says something. */
export function ageOf(ms: number): string {
	if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
	if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} min ago`;
	return `${Math.round(ms / 3_600_000)}h ago`;
}

/** What a reuse found when it re-checked the files, in one clause. */
export function changeNote(outcome: {
	refreshed: string[];
	removed: string[];
	unreadable: string[];
}): string {
	const bits: string[] = [];
	if (outcome.refreshed.length)
		bits.push(
			`re-read ${outcome.refreshed.length} changed file(s) (${outcome.refreshed.join(", ")})`,
		);
	else bits.push("its files are unchanged");
	if (outcome.removed.length)
		bits.push(
			`dropped ${outcome.removed.length} removed file(s) (${outcome.removed.join(", ")})`,
		);
	if (outcome.unreadable.length)
		bits.push(
			`kept the judged content of ${outcome.unreadable.join(", ")} (now unreadable)`,
		);
	return bits.join("; ");
}

/** What a reuse did to the state it reused, in one line, so nothing about a
 * retained state is silent. */
export function describeReuse(
	snapshot: RetainedState,
	outcome: { refreshed: string[]; removed: string[]; unreadable: string[] },
	now: number,
): string {
	const age = ageOf(now - snapshot.at);
	const command = snapshot.sources.command
		? `; the output of \`${snapshot.sources.command.command}\` is the one from ${age} and was not re-run`
		: "";
	return `reused ${snapshot.id} (assembled ${age}: ${changeNote(outcome)}${command})`;
}

function outputOf(command: CommandOutput): Record<string, unknown> {
	return {
		command: command.command,
		exit_code: command.exit_code,
		stdout: command.stdout,
		stderr: command.stderr,
		...(command.note ? { note: command.note } : {}),
	};
}

export interface AssembleInput {
	readonly own?: unknown;
	readonly paths?: readonly string[];
	readonly command?: CommandOutput;
}

export function assembleState(
	input: AssembleInput,
	cwd: string,
): AssembleResult {
	const own = parseOwnState(input.own);
	const ownText = JSON.stringify(own);
	if (ownText.length > MAX_OWN_STATE_CHARS)
		return {
			ok: false,
			error: `ask_jev: your own state is ${fmtTokens(tokensOf(ownText))} tokens and the limit is ${fmtTokens(tokensOf("x".repeat(MAX_OWN_STATE_CHARS)))} tokens. Do not paste file contents or command output into it; pass paths or command and code fetches them. Nothing was sent.`,
		};
	const files: Record<string, string> = {};
	const stats: FileStat[] = [];
	const skipped: Array<{ path: string; reason: string }> = [];
	if (input.paths?.length) {
		const expanded = expandTargets(input.paths, cwd);
		if (expanded.length > MAX_PATHS_PER_CALL)
			return {
				ok: false,
				error: `ask_jev: paths expanded to ${expanded.length} files and one call holds ${MAX_PATHS_PER_CALL}. Nothing was sent. Narrow the paths, or make one call per file when you want a verdict for each.`,
			};
		for (const file of expanded) {
			const relative = path.relative(cwd, file);
			let content: string;
			let stat: fs.Stats;
			try {
				stat = fs.statSync(file);
				content = fs.readFileSync(file, "utf8");
			} catch {
				skipped.push({ path: relative, reason: "unreadable" });
				continue;
			}
			if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
				skipped.push({ path: relative, reason: `over the ${MAX_FILE_BYTES / 1024} KiB per-file limit` });
				continue;
			}
			files[relative] = content;
			stats.push({ path: relative, mtimeMs: stat.mtimeMs, size: stat.size });
		}
	}

	const result = stateFromSources({
		own,
		files,
		stats,
		...(input.command ? { command: input.command } : {}),
	});
	if (!result.ok) return result;
	if (!skipped.length) return result;
	const coverage = `skipped ${skipped.length} (${[...new Set(skipped.map((entry) => entry.reason))].join(", ")})`;
	return {
		ok: true,
		assembled: {
			...result.assembled,
			summary: `${result.assembled.summary}, ${coverage}`,
		},
	};
}

// ── answers ──────────────────────────────────────────────────────────────────

function confidenceOf(answer: Record<string, unknown>): number | undefined {
	const value = answer.confidence;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function probabilityLine(probabilities: Record<string, unknown>, chosen: string): string {
	const ranked = Object.entries(probabilities)
		.filter((entry): entry is [string, number] => typeof entry[1] === "number")
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5);
	if (ranked.length < 2) return "";
	return ` [${ranked.map(([label, value]) => `${label === chosen ? "*" : ""}${label} ${value.toFixed(2)}`).join(", ")}]`;
}

/** One line per answer, plus the warning a low-confidence answer earns. A verdict
 * the classifier is guessing at is reported as a guess, not as a verdict. */
export function renderAnswers(
	answers: Record<string, unknown>,
	ids: readonly string[],
): { readonly text: string; readonly warnings: readonly string[] } {
	const lines: string[] = [];
	const warnings: string[] = [];
	for (const id of ids) {
		const answer = answers[id];
		if (!isRecord(answer)) {
			lines.push(`${id}: no answer came back.`);
			warnings.push(`the classifier returned no answer for "${id}"; nothing was decided for it.`);
			continue;
		}
		const confidence = confidenceOf(answer);
		const confidenceText = confidence !== undefined ? ` confidence ${confidence.toFixed(2)}` : "";
		const probabilities = isRecord(answer.probabilities) ? answer.probabilities : {};
		if (typeof answer.noul === "number" && Number.isFinite(answer.noul)) {
			lines.push(`${id} (noul): ${answer.noul.toFixed(2)}${confidenceText}`);
			if (confidence !== undefined && confidence < LOW_CONFIDENCE)
				warnings.push(
					`"${id}" came back ${answer.noul.toFixed(2)} at confidence ${confidence.toFixed(2)}, which is a coin flip. Do not branch on it; narrow the state or judge it yourself.`,
				);
			continue;
		}
		if (typeof answer.choice === "string") {
			lines.push(`${id} (choice): ${answer.choice}${confidenceText}${probabilityLine(probabilities, answer.choice)}`);
			if (confidence !== undefined && confidence < LOW_CONFIDENCE)
				warnings.push(
					`"${id}" picked ${answer.choice} at confidence ${confidence.toFixed(2)}: the pick is plausible, the confidence is not. The options may not cover the state; resolve it before you act on it.`,
				);
			continue;
		}
		if (typeof answer.score === "number" && Number.isFinite(answer.score)) {
			// A score is a position on the question's own scale, not a 0..1 fraction:
			// with three levels it runs 0..2. Reading it as a fraction picked the wrong
			// level in the smoke run.
			const legend = isRecord(answer.legend) ? answer.legend : {};
			const levels = Object.keys(legend).length;
			const index = Math.min(Math.max(Math.round(answer.score), 0), Math.max(levels - 1, 0));
			const nearest = levels > 0 ? ` (nearest "${String(legend[String(index)] ?? "")}")` : "";
			lines.push(
				`${id} (score): ${answer.score.toFixed(2)} of ${Math.max(levels - 1, 0)}${nearest}${confidenceText}${probabilityLine(probabilities, "")}`,
			);
			if (confidence !== undefined && confidence < LOW_CONFIDENCE)
				warnings.push(
					`"${id}" scored ${answer.score.toFixed(2)} at confidence ${confidence.toFixed(2)}; the position is not settled. Treat it as a range, not a level.`,
				);
			continue;
		}
		lines.push(`${id}: unrecognised answer shape ${JSON.stringify(answer).slice(0, 200)}`);
	}
	return { text: lines.join("\n"), warnings };
}

function usageLine(usage: unknown): string {
	if (!isRecord(usage)) return "";
	const input = usage.input_tokens;
	const output = usage.output_tokens;
	const cost = usage.cost;
	const bits = [
		typeof input === "number" ? `${input} in` : "",
		typeof output === "number" ? `${output} out` : "",
		typeof cost === "number" ? `$${cost.toFixed(6)}` : "",
	].filter((bit) => bit.length > 0);
	return bits.length ? `jev ${bits.join(" / ")}` : "";
}

// ── the tool ─────────────────────────────────────────────────────────────────

const DESCRIPTION = [
	"Ask the run's configured classifier (Jev, a fast decision model) typed questions about one situation: files, a command's output, your own state, or any mix. It answers in about 300 ms for a fraction of a cent, and each answer is a number you can branch on, not prose. Use it whenever a judgment call would otherwise cost you a long think.",
	"",
	"Do not paste content you already have; that costs output tokens. Pass paths and code reads the files into files[path]. Pass command and code runs it in the repo through the bash tool and puts the result into output{command, exit_code, stdout, stderr}. Use state for what only you can say: a ticket, your plan, a line of context. You can combine all three, and you never receive the files or the output, only the answers.",
	"",
	"One call judges one situation: up to 20 files and about 60k tokens in total. Over that the call is refused and nothing is sent, with a message naming the parts and a split that fits; make two calls with the same questions. For a verdict on each of many files, make one call per file.",
	"",
	'The result names the state it judged (`state s7f3a2`). To ask more questions about that same situation, call again with reuse: "s7f3a2" and new questions: the files are re-checked rather than read again, and the command is not re-run, so a second round costs one classifier call and nothing else. A reuse says which files changed since, and a command\'s output is reused as it was.',
	"",
	"questions: an object keyed by question id. Three types:",
	'	 noul   {"type":"noul","instructions":"Does `output` show a real failure rather than a flaky one?","criteria":{"true":"...","false":"..."}}  -> { noul: 0..1, confidence }',
	'	 choice {"type":"choice","instructions":"What kind of failure is `output`?","criteria":{"bug_in_code":"...","wrong_test":"...","environment":"...","other":"..."}}  -> { choice, confidence, probabilities }',
	'	 score  {"type":"score","instructions":"How risky is the diff in `files`?","criteria":["Isolated, tested","Some callers","Security sensitive, no tests"]}  -> { score, confidence, legend }',
	"",
	"Write the questions against files[path], output, or your own field names. Good uses: run the tests through command and classify the failure before choosing a fix; put git diff through command and score its risk before committing; pass a request's words as state with the relevant paths and decide which step of the workflow it belongs to.",
	"Ask every question you might need in one call; they share the state. Always give a choice an `other` option. Describe situations, not degrees.",
	"An answer is a judgment, not evidence, and one whose confidence comes back below 0.5 is reported as a guess: narrow the state and ask again, or judge it yourself. Not for exact lookups, counting, math, or anything a grep answers, and not a substitute for reading code you are about to edit.",
].join("\n");

export default function askJev(pi: {
	registerTool: (tool: Record<string, unknown>) => void;
}) {
	// One session's retained states, newest last. A follow-up round about the same
	// situation costs a classifier call but no re-read and no re-run; the handle is
	// the only way in, so a call never silently judges a state it did not name.
	//
	// Handles are random, never a counter. A counter is predictable, and a stale
	// handle outlives its session: rounds run in fresh panes and compaction keeps
	// old handles in context, so an agent recalling "state s1" would land on
	// whatever the new pane called s1 — a different situation, answered
	// confidently. A random handle from another session simply does not resolve.
	const retained = new Map<string, RetainedState>();

	const newHandleId = (): string => {
		let id = `s${randomUUID().replace(/-/g, "").slice(0, 6)}`;
		while (retained.has(id)) id = `s${randomUUID().replace(/-/g, "").slice(0, 6)}`;
		return id;
	};

	const describeRetained = (now: number): string =>
		[...retained.values()]
			.map(
				(snapshot) =>
					`${snapshot.id} (${snapshot.summary}, assembled ${ageOf(now - snapshot.at)})`,
			)
			.join("; ") || "none";

	const retain = (state: Omit<RetainedState, "id" | "at">): string => {
		const id = newHandleId();
		retained.set(id, { ...state, id, at: Date.now() });
		for (const key of [...retained.keys()].slice(0, -MAX_RETAINED)) retained.delete(key);
		return id;
	};

	pi.registerTool({
		name: "ask_jev",
		label: "Ask Jev",
		description: DESCRIPTION,
		// Honest hints: the tool can run a command, and it reaches a service that is
		// not this repository. A permission extension uses these to decide whether to
		// confirm the call.
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		parameters: Type.Object({
			questions: Type.Unknown({
				description: "The question block, keyed by question id; see the description for the three types.",
			}),
			reuse: Type.Optional(
				Type.String({
					description:
						'A state handle from an earlier result in this session, for example "s7f3a2". Asks new questions about the same files and command output without reading or running anything again. Only the files are re-checked; the command is not re-run.',
				}),
			),
			state: Type.Optional(
				Type.Unknown({
					description: "Your own state: plain text, or a JSON object with your own field names.",
				}),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description: "Files or globs for code to read into files[path]. Up to 20 files.",
				}),
			),
			command: Type.Optional(
				Type.String({
					description: "A command for code to run in the repository through the bash tool; its output goes into output.",
				}),
			),
		}),
		async execute(
			_id: string,
			params: {
				questions?: unknown;
				reuse?: string;
				state?: unknown;
				paths?: string[];
				command?: string;
			},
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: {
				cwd?: string;
				tools?: readonly { name?: string }[];
				executeTool?: (
					name: string,
					args: unknown,
					options?: { signal?: AbortSignal },
				) => Promise<{ isError?: boolean; content?: readonly { type?: string; text?: string }[] }>;
			},
		) {
			const fail = (text: string) => ({
				content: [{ type: "text", text }],
				isError: true,
			});
			const binding = readBinding();
			if (!binding)
				return fail(
					"In-session judgment is unavailable for this run: the engine supplied no classifier binding, which happens when the configured provider is not the local one. Judge this yourself, or report the limitation.",
				);
			const questions = validateQuestions(params.questions);
			if (!questions.ok) return fail(`ask_jev: ${questions.error}`);
			const cwd = ctx?.cwd ?? process.cwd();

			const namesSomethingElse =
				params.state !== undefined ||
				(params.paths?.length ?? 0) > 0 ||
				(params.command?.trim().length ?? 0) > 0;
			let assembled: AssembledState;
			let handleId: string;
			let handle: string;
			if (params.reuse?.trim()) {
				if (namesSomethingElse)
					return fail(
						"ask_jev: pass reuse on its own. A reuse answers new questions about the state that was already judged; if the situation changed, name state, paths, or command again instead.",
					);
				const snapshot = retained.get(params.reuse.trim());
				if (!snapshot)
					return fail(
						`ask_jev: unknown state "${params.reuse.trim()}". Retained here: ${describeRetained(Date.now())}. Nothing was sent.`,
					);
				const refreshed = refreshSources(snapshot.sources, cwd);
				const rebuilt = stateFromSources(refreshed.sources);
				if (!rebuilt.ok)
					return fail(`${rebuilt.error} Reuse of ${snapshot.id} found: ${changeNote(refreshed)}.`);
				assembled = rebuilt.assembled;
				handleId = snapshot.id;
				handle = describeReuse(snapshot, refreshed, Date.now());
			} else {
				let command: CommandOutput | undefined;
				if (params.command?.trim()) {
					const executeTool = ctx?.executeTool;
					const hasBash = ctx?.tools?.some((tool) => tool.name === "bash") ?? false;
					if (!executeTool || !hasBash)
						return fail(
							"ask_jev: the bash tool is not available in this session, so `command` cannot run. Pass the output as state instead, or ask again without command.",
						);
					const outcome = await executeTool("bash", { command: params.command.trim() }, { signal });
					const text = (outcome?.content ?? [])
						.filter((part) => part.type === "text" && typeof part.text === "string")
						.map((part) => part.text ?? "")
						.join("\n");
					const clipped = text.slice(0, MAX_OUTPUT_CHARS);
					const notes = [
						outcome?.isError ? "the command reported a failure" : "",
						clipped.length < text.length
							? `the output was ${text.length} characters and only the first ${MAX_OUTPUT_CHARS} were judged`
							: "",
					]
						.filter((note) => note.length > 0)
						.join("; ");
					command = {
						command: params.command.trim(),
						exit_code: null,
						stdout: clipped,
						stderr: "",
						...(notes.length > 0 ? { note: notes } : {}),
					};
				}

				const fresh = assembleState(
					{ own: params.state, paths: params.paths, command },
					cwd,
				);
				if (!fresh.ok) return fail(fresh.error);
				assembled = fresh.assembled;
				// Retained before the call goes out: a state that was assembled is worth
				// reusing even when the classifier then fails to answer.
				handleId = retain({
					summary: assembled.summary,
					tokens: assembled.tokens,
					sources: assembled.sources,
				});
				handle = `state ${handleId}`;
			}

			const body: Record<string, unknown> = {
				model: binding.model,
				state: assembled.state,
				questions: questions.questions,
			};

			let response: Response;
			try {
				response = await fetch(binding.endpoint, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
					...(signal ? { signal } : {}),
				});
			} catch (error) {
				return fail(
					`ask_jev: the classifier at ${binding.provider} could not be reached (${(error as Error).message}). Nothing was decided. State ${handleId} is still retained: call again with reuse "${handleId}" to retry without re-reading.`,
				);
			}
			if (!response.ok)
				return fail(`ask_jev: the classifier answered ${response.status} ${response.statusText}. Nothing was decided.`);
			const payload = (await response.json()) as { answers?: unknown; usage?: unknown };
			const answers = isRecord(payload.answers) ? payload.answers : {};
			const rendered = renderAnswers(answers, questions.ids);
			const usage = usageLine(payload.usage);
			const header = [
				handle,
				`judged ${assembled.summary}`,
				usage,
				`provider=${binding.provider} model=${binding.model}`,
			]
				.filter((part) => part.length > 0)
				.join(" · ");
			const text = [
				"## Jev",
				header,
				"",
				rendered.text,
				...(rendered.warnings.length ? ["", ...rendered.warnings.map((warning) => `- ${warning}`)] : []),
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					provider: binding.provider,
					model: binding.model,
					stateTokens: assembled.tokens,
					answers,
				},
			};
		},
	});
}
