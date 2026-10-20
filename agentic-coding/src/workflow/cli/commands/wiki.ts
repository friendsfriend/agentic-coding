// The `wiki` command and its subcommands (list/search/show/write/verify/
// log), including the managed wiki/research-wiki write authorization gate
// and the wiki-comments concept-scope restriction. Moved verbatim out of
// cli.ts (split-workflow-god-modules); the managed write gate now runs at
// the CLI-invocation application root (complete-workflow-effect-cutover,
// task 2.1).
import fs from "node:fs";
import path from "node:path";
import { resolveConfigRoot } from "../../../config-root.ts";
import { loadEnvFile } from "../../../env-file.ts";
import type { WorkflowApplication } from "../../application.ts";
import { engine } from "../../operations.ts";
import {
	workflowDataRoot,
	workflowEvidenceScope,
} from "../../runtime/evidence-store.ts";
import {
	researchWorkflowTarget,
	stageTestWorkflowTarget,
	type WorkflowEngine,
	wikiWorkflowTarget,
} from "../../runtime.ts";
import {
	appendLog,
	containsConfiguredSecret,
	ensureBundle,
	listConcepts,
	readConcept,
	searchConcepts,
	verifyConcept,
	wikiRoot,
	writeConcept,
} from "../../wiki.ts";
import { flag, parseInput, positionals } from "../args.ts";
import { managedAgent } from "../caller-environment.ts";
import { WIKI_SUBCOMMANDS } from "../schema.ts";

function samePath(left: string, right: string): boolean {
	try {
		return fs.realpathSync(left) === fs.realpathSync(right);
	} catch {
		return path.resolve(left) === path.resolve(right);
	}
}
function wikiRole(): string | undefined {
	return process.env.HERDR_ROLE || undefined;
}
/** Both wiki-writing roles (openspec/implementation "wiki" and
 * research-handoff "research-wiki") may write centralized drafts; they
 * differ only in drafting approach (agent-definitions/instructions), never
 * in write authorization or promotion rights. */
const WIKI_WRITER_ROLES: readonly string[] = [
	"wiki",
	"research-wiki",
	"stage-wiki",
];
function authorizeWikiWriter(
	application?: WorkflowApplication,
): ReturnType<WorkflowEngine["getSnapshot"]> {
	const workflowId = process.env.HERDR_WORKFLOW_ID;
	const stepId = process.env.HERDR_STEP_ID;
	const role = process.env.HERDR_ROLE;
	const token = process.env.HERDR_RUN_TOKEN;
	if (
		!workflowId ||
		!token ||
		!(stepId === "core.wiki" && role && WIKI_WRITER_ROLES.includes(role))
	)
		throw new Error(
			"wiki write requires an authenticated managed wiki run (authenticated core.wiki run required)",
		);
	const workflowEngine = engine(application);
	const target =
		process.env.HERDR_WORKFLOW_TARGET === wikiWorkflowTarget() ||
		process.env.HERDR_WORKFLOW_TARGET === researchWorkflowTarget() ||
		process.env.HERDR_WORKFLOW_TARGET === stageTestWorkflowTarget()
			? process.env.HERDR_WORKFLOW_TARGET
			: process.cwd();
	if (application)
		application.runSync(
			workflowEngine.authorizeAgentCapabilityEffect(
				target,
				workflowId,
				stepId,
				role,
				token,
			),
		);
	else
		workflowEngine.authorizeAgentCapability(
			target,
			workflowId,
			stepId,
			role,
			token,
		);
	const snapshot = application
		? application.runSync(workflowEngine.getSnapshotEffect(target, workflowId))
		: workflowEngine.getSnapshot(target, workflowId);
	if (
		snapshot.currentStep !== "core.wiki" &&
		snapshot.definition.id !== "research" &&
		snapshot.definition.id !== "wiki" &&
		snapshot.definition.id !== "wiki-comments" &&
		snapshot.definition.id !== "stage-test"
	)
		throw new Error("wiki writes require a documentation workflow stage");
	const pinnedRoot = path.resolve(snapshot.metadata.wikiRoot ?? wikiRoot(true));
	if (!samePath(wikiRoot(), pinnedRoot))
		throw new Error(
			"wiki write destination does not match the pinned workflow wiki root",
		);
	return snapshot;
}
function stageWikiReadPrefix(
	application?: WorkflowApplication,
): string | undefined {
	const role = wikiRole();
	if (!role || !["stage-planner", "stage-tester", "stage-wiki"].includes(role))
		return undefined;
	const stepId = process.env.HERDR_STEP_ID;
	const expectedStep =
		role === "stage-planner"
			? "stage.plan"
			: role === "stage-tester"
				? "stage.execute"
				: "core.wiki";
	const workflowId = process.env.HERDR_WORKFLOW_ID;
	const token = process.env.HERDR_RUN_TOKEN;
	if (
		!workflowId ||
		!token ||
		stepId !== expectedStep ||
		process.env.HERDR_WORKFLOW_TARGET !== stageTestWorkflowTarget()
	)
		throw new Error(
			"stage wiki reads require an authenticated stage-test step",
		);
	const workflowEngine = engine(application);
	const target = stageTestWorkflowTarget();
	if (application)
		application.runSync(
			workflowEngine.authorizeAgentCapabilityEffect(
				target,
				workflowId,
				stepId,
				role,
				token,
			),
		);
	else
		workflowEngine.authorizeAgentCapability(
			target,
			workflowId,
			stepId,
			role,
			token,
		);
	const snapshot = application
		? application.runSync(workflowEngine.getSnapshotEffect(target, workflowId))
		: workflowEngine.getSnapshot(target, workflowId);
	if (
		snapshot.definition.id !== "stage-test" ||
		snapshot.currentStep !== expectedStep
	)
		throw new Error(
			"stage wiki reads are limited to the authenticated stage-test step",
		);
	const system = snapshot.metadata.stageSystem;
	if (typeof system !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(system))
		throw new Error("stage-test workflow has no valid system namespace");
	return `projects/${system}/`;
}

function safeWikiBodyFile(
	snapshot: ReturnType<WorkflowEngine["getSnapshot"]> | undefined,
	value: string,
): string {
	if (!snapshot) return value;
	const file = fs.realpathSync(path.resolve(value));
	const roots = [
		path.join(
			workflowDataRoot({
				workflowId: snapshot.workflowId,
				worktree: snapshot.metadata.worktree,
				definitionId: snapshot.definition.id,
			}),
			snapshot.workflowId,
			"runs",
		),
		workflowEvidenceScope({
			workflowId: snapshot.workflowId,
			worktree: snapshot.metadata.worktree,
			definitionId: snapshot.definition.id,
		}).root,
		...(snapshot.definition.id === "stage-test" ? [] : [wikiRoot(true)]),
	];
	const operational = [
		path.join(snapshot.metadata.worktree, "runtime-bin"),
		path.join(snapshot.metadata.worktree, "runtime-config"),
		path.join(snapshot.metadata.worktree, ".herdr-workflow", "herdr.db"),
	];
	const evidenceFiles = snapshot.evidence.flatMap((item) => {
		try {
			return [fs.realpathSync(item.path)];
		} catch {
			return [];
		}
	});
	if (
		operational.some(
			(root) => file === root || file.startsWith(`${root}${path.sep}`),
		)
	)
		throw new Error("wiki body file cannot read workflow operational data");
	const allowed =
		evidenceFiles.includes(file) ||
		roots.some((root) => {
			try {
				const resolvedRoot = fs.realpathSync(root);
				return (
					file === resolvedRoot || file.startsWith(`${resolvedRoot}${path.sep}`)
				);
			} catch {
				return false;
			}
		});
	if (!allowed)
		throw new Error(
			"wiki body file must stay inside approved workflow or evidence roots",
		);
	const stat = fs.statSync(file);
	if (!stat.isFile() || stat.size > 512 * 1024)
		throw new Error(
			"wiki body file must be a regular file no larger than 512 KiB",
		);
	return file;
}
function wikiActor(role: string | undefined): string {
	return role
		? `herdr-${role}/${process.env.HERDR_PROFILE || "default"}`
		: "human:developer";
}
function wikiOutput(rest: string[], value: unknown): void {
	console.log(
		JSON.stringify(value, null, rest.includes("--json") ? 2 : undefined),
	);
}
export async function runWiki(
	rest: string[],
	application?: WorkflowApplication,
): Promise<void> {
	const [operation, ...terms] = positionals(rest);
	if (
		!operation ||
		!(WIKI_SUBCOMMANDS as readonly string[]).includes(operation)
	)
		throw new Error(
			`unknown wiki command: ${operation ?? "(none)"}; usage: agentic-coding workflow wiki list|search|show|write|verify|log`,
		);
	const role = wikiRole();
	const stageReadPrefix = stageWikiReadPrefix(application);
	if (operation === "list") {
		const concepts = listConcepts({
			tag: flag(rest, "tag"),
			type: flag(rest, "type"),
		});
		wikiOutput(
			rest,
			stageReadPrefix
				? concepts.filter((concept) => concept.id.startsWith(stageReadPrefix))
				: concepts,
		);
		return;
	}
	if (operation === "search") {
		if (!terms.length)
			throw new Error(
				"wiki search requires TERMS; usage: wiki search TERMS [--limit N]",
			);
		const rawLimit = flag(rest, "limit");
		const limit = rawLimit === undefined ? 20 : Number(rawLimit);
		if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
			throw new Error("wiki search --limit must be an integer from 1 to 1000");
		wikiOutput(rest, searchConcepts(terms, limit, stageReadPrefix));
		return;
	}
	if (operation === "show") {
		if (!terms[0])
			throw new Error("wiki show requires a concept id; usage: wiki show ID");
		if (stageReadPrefix && !terms[0].startsWith(stageReadPrefix))
			throw new Error(
				"stage-test wiki reads are limited to the pinned system namespace",
			);
		wikiOutput(rest, readConcept(terms[0]));
		return;
	}
	if (operation === "write") {
		// Preserve the explicitly supported unmanaged administrative path when
		// no managed identity is present. This is the selected compatibility
		// trade-off for hosts where managed ancestry may be detectable without
		// workflow variables.
		if (
			!role &&
			managedAgent() &&
			(process.env.HERDR_RUN_TOKEN ||
				process.env.HERDR_WORKFLOW_ID ||
				process.env.HERDR_STEP_ID)
		)
			throw new Error("wiki write requires an authenticated workflow role");
		if (role && !WIKI_WRITER_ROLES.includes(role))
			throw new Error(`wiki write is not permitted for role ${role}`);
		const authorizedSnapshot =
			role && WIKI_WRITER_ROLES.includes(role)
				? authorizeWikiWriter(application)
				: undefined;
		const concept = flag(rest, "path");
		const type = flag(rest, "type");
		const title = flag(rest, "title");
		const description = flag(rest, "description");
		if (!concept || !type || !title || !description)
			throw new Error(
				"wiki write requires --path, --type, --title, and --description; usage: wiki write --path ID --type T --title T --description D [--sources JSON]",
			);
		if (authorizedSnapshot?.definition.id === "wiki-comments") {
			const context = authorizedSnapshot.step.context;
			const comments =
				context && typeof context === "object" && !Array.isArray(context)
					? (context as { comments?: unknown }).comments
					: undefined;
			const permitted = new Set(
				Array.isArray(comments)
					? comments.flatMap((item) =>
							item && typeof item === "object" && "conceptId" in item
								? [String((item as { conceptId: unknown }).conceptId)]
								: [],
						)
					: [],
			);
			if (!permitted.has(concept.replaceAll("\\", "/").replace(/\.md$/, "")))
				throw new Error("wiki write is outside the submitted comment scope");
		}
		const requestedStatus = flag(rest, "status");
		const requestedVerified = flag(rest, "verified");
		const requestedActor = flag(rest, "generated-by");
		if (
			role &&
			(requestedActor?.startsWith("human:") ||
				requestedVerified?.startsWith("human:"))
		)
			throw new Error(
				"human-reviewed tier is granted only by the approval gate",
			);
		if (requestedStatus === "stable" || requestedVerified)
			throw new Error(
				"stable or verified wiki metadata is granted only by the approval gate",
			);
		const legacySource = flag(rest, "resource") ?? flag(rest, "source");
		const sourcesFlag = flag(rest, "sources");
		let sources: unknown[] | undefined;
		if (sourcesFlag !== undefined) {
			const parsed = parseInput(sourcesFlag);
			if (!Array.isArray(parsed) || !parsed.length)
				throw new Error(
					"wiki write --sources must be a non-empty JSON list of { id, resource } entries",
				);
			sources = parsed;
		}
		if (legacySource !== undefined)
			throw new Error(
				"wiki write no longer accepts --source/--resource; pass keyed sources with --sources JSON so every inline citation resolves",
			);
		const bodyFile = flag(rest, "body-file");
		const safeBodyFile = bodyFile
			? safeWikiBodyFile(authorizedSnapshot, bodyFile)
			: undefined;
		const bodyText = safeBodyFile ? fs.readFileSync(safeBodyFile, "utf8") : "";
		const tags = flag(rest, "tags")
			?.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean);
		const staleAfter = flag(rest, "stale-after");
		// One object is both scanned and written, so a field added here can never
		// be written without also passing the secret scan (SEC-003).
		const writeInput = {
			type,
			title,
			description,
			...(tags ? { tags } : {}),
			...(sources ? { sources } : {}),
			status: role ? "draft" : requestedStatus,
			...(staleAfter ? { stale_after: staleAfter } : {}),
			...(safeBodyFile ? { body: bodyText } : {}),
			generatedBy: requestedActor ?? wikiActor(role),
			...(requestedVerified
				? {
						verified: [{ by: requestedVerified, at: new Date().toISOString() }],
					}
				: {}),
			changeId: process.env.HERDR_CHANGE_ID,
		};
		// Every managed draft write refuses a declared configuration secret, not
		// only the stage-test role: the capability contract has no family carve-out,
		// and the message never names the value.
		const secretValues = [
			...loadEnvFile(path.join(resolveConfigRoot(), ".env")).values(),
		].filter(Boolean);
		if (
			containsConfiguredSecret(
				JSON.stringify({ concept, ...writeInput }),
				secretValues,
			)
		)
			throw new Error(
				"wiki draft contains a configured secret; remove it before writing",
			);
		if (authorizedSnapshot?.definition.id === "stage-test") {
			const system = authorizedSnapshot.metadata.stageSystem;
			const stage = authorizedSnapshot.metadata.stage;
			if (
				!system ||
				!stage ||
				!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(system) ||
				!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(stage)
			)
				throw new Error("stage wiki write requires a safe pinned stage system");
			const normalized = concept.replaceAll("\\", "/").replace(/\.md$/, "");
			const segments = normalized.split("/");
			if (segments.some((part) => !part || part === "." || part === ".."))
				throw new Error("stage wiki write has an invalid concept path");
			const base = `projects/${system}`;
			const allowedProcess =
				segments.length === 4 &&
				segments[0] === "projects" &&
				segments[1] === system &&
				segments[2] === "processes" &&
				segments[3] !== "index" &&
				type === "process";
			const allowedHub =
				normalized === `${base}/processes/index` && type === "process-index";
			const allowedStage =
				normalized === `${base}/stages/${stage}` && type === "stage-notes";
			if (!allowedProcess && !allowedHub && !allowedStage)
				throw new Error(
					"stage wiki write is outside the pinned system's process/stage knowledge scope",
				);
			const stageCitation = `stage://${stage}/${authorizedSnapshot.workflowId}`;
			if (
				!sources?.some(
					(source) =>
						source &&
						typeof source === "object" &&
						"resource" in source &&
						(source as { resource?: unknown }).resource === stageCitation,
				)
			)
				throw new Error(`stage wiki write must cite ${stageCitation}`);
			if (type === "process" && !safeBodyFile)
				throw new Error(
					"stage process concepts require a body file with the standard process sections",
				);
			if (type === "process-index" && !safeBodyFile)
				throw new Error(
					"stage process indexes require a body file linking every process concept",
				);
			const body = bodyText;
			if (type === "process") {
				const headings = [
					"Covers",
					"Actors & apps",
					"Steps",
					"Hand-overs",
					"Asynchronous steps",
					"Test data",
					"Assertions that matter",
					"Gotchas",
				];
				const escapeRegex = (value: string) =>
					value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
				if (
					headings.some(
						(heading) =>
							!new RegExp(`^#{1,6}\\s+${escapeRegex(heading)}\\s*$`, "im").test(
								body,
							),
					)
				)
					throw new Error(
						"stage process concepts must include every required process section",
					);
			}
			if (type === "process-index") {
				const processIds = listConcepts({ type: "process" })
					.map(({ id }) => id)
					.filter(
						(id) =>
							id.startsWith(`${base}/processes/`) &&
							id !== `${base}/processes/index`,
					);
				const unlinked = processIds.filter((id) => {
					const slug = id.slice(`${base}/processes/`.length);
					return !body.includes(`](${slug}.md`) && !body.includes(`](${id}.md`);
				});
				if (unlinked.length)
					throw new Error(
						"stage process index must link every process concept in the pinned system",
					);
			}
		}
		wikiOutput(rest, writeConcept(concept, writeInput));
		return;
	}
	if (operation === "verify") {
		if (
			!role &&
			managedAgent() &&
			(process.env.HERDR_RUN_TOKEN ||
				process.env.HERDR_WORKFLOW_ID ||
				process.env.HERDR_STEP_ID)
		)
			throw new Error(
				"wiki verify requires the archive role or an interactive caller",
			);
		if (role && role !== "archive")
			throw new Error("wiki verify is archive-only");
		const concept = flag(rest, "path");
		if (!concept)
			throw new Error(
				"wiki verify requires --path ID; usage: wiki verify --path ID",
			);
		const verifyingActor = flag(rest, "actor") ?? "process:herdr-archive";
		if (verifyingActor !== "process:herdr-archive")
			throw new Error(
				"wiki verify requires process:herdr-archive; human promotion requires the approval gate",
			);
		wikiOutput(rest, verifyConcept(concept, verifyingActor));
		return;
	}
	if (
		!role &&
		managedAgent() &&
		(process.env.HERDR_RUN_TOKEN ||
			process.env.HERDR_WORKFLOW_ID ||
			process.env.HERDR_STEP_ID)
	)
		throw new Error(
			"wiki log requires the archive role or an interactive caller",
		);
	if (role && role !== "archive") throw new Error("wiki log is archive-only");
	const entry = flag(rest, "entry");
	if (!entry)
		throw new Error(
			"wiki log requires --entry TEXT; usage: wiki log --entry TEXT [--path DIR]",
		);
	wikiOutput(rest, {
		path: appendLog(flag(rest, "path") ?? ensureBundle(), entry),
	});
}
