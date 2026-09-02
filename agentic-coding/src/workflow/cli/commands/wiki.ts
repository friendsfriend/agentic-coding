// The `wiki` command and its subcommands (list/search/show/write/verify/
// log), including the managed wiki/research-wiki write authorization gate
// and the wiki-comments concept-scope restriction. Moved verbatim out of
// cli.ts (split-workflow-god-modules).
import fs from "node:fs";
import path from "node:path";
import {
	researchWorkflowTarget,
	type WorkflowEngine,
	wikiWorkflowTarget,
} from "../../runtime.ts";
import {
	appendLog,
	ensureBundle,
	listConcepts,
	readConcept,
	searchConcepts,
	verifyConcept,
	wikiRoot,
	writeConcept,
} from "../../wiki.ts";
import { flag, positionals } from "../args.ts";
import { managedAgent } from "../caller-environment.ts";
import { engine } from "../registry.ts";
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
const WIKI_WRITER_ROLES: readonly string[] = ["wiki", "research-wiki"];
function authorizeWikiWriter(): ReturnType<WorkflowEngine["getSnapshot"]> {
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
	const workflowEngine = engine();
	const target =
		process.env.HERDR_WORKFLOW_TARGET === wikiWorkflowTarget() ||
		process.env.HERDR_WORKFLOW_TARGET === researchWorkflowTarget()
			? process.env.HERDR_WORKFLOW_TARGET
			: process.cwd();
	workflowEngine.authorizeAgentCapability(
		target,
		workflowId,
		stepId,
		role,
		token,
	);
	const snapshot = workflowEngine.getSnapshot(target, workflowId);
	if (
		snapshot.currentStep !== "core.wiki" &&
		snapshot.definition.id !== "research" &&
		snapshot.definition.id !== "wiki" &&
		snapshot.definition.id !== "wiki-comments"
	)
		throw new Error("wiki writes require a documentation workflow stage");
	const pinnedRoot = path.resolve(snapshot.metadata.wikiRoot ?? wikiRoot(true));
	if (!samePath(wikiRoot(), pinnedRoot))
		throw new Error(
			"wiki write destination does not match the pinned workflow wiki root",
		);
	return snapshot;
}
function safeWikiBodyFile(
	snapshot: ReturnType<WorkflowEngine["getSnapshot"]> | undefined,
	value: string,
): string {
	if (!snapshot) return value;
	const file = fs.realpathSync(path.resolve(value));
	const roots = [
		path.join(
			snapshot.metadata.worktree,
			".herdr-workflow",
			snapshot.metadata.changeId,
			"runs",
		),
		wikiRoot(true),
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
export async function runWiki(rest: string[]): Promise<void> {
	const [operation, ...terms] = positionals(rest);
	if (
		!operation ||
		!(WIKI_SUBCOMMANDS as readonly string[]).includes(operation)
	)
		throw new Error(
			`unknown wiki command: ${operation ?? "(none)"}; usage: agentic-coding workflow wiki list|search|show|write|verify|log`,
		);
	const role = wikiRole();
	if (operation === "list") {
		wikiOutput(
			rest,
			listConcepts({ tag: flag(rest, "tag"), type: flag(rest, "type") }),
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
		wikiOutput(rest, searchConcepts(terms, limit));
		return;
	}
	if (operation === "show") {
		if (!terms[0])
			throw new Error("wiki show requires a concept id; usage: wiki show ID");
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
				? authorizeWikiWriter()
				: undefined;
		const concept = flag(rest, "path");
		const type = flag(rest, "type");
		const title = flag(rest, "title");
		const description = flag(rest, "description");
		if (!concept || !type || !title || !description)
			throw new Error(
				"wiki write requires --path, --type, --title, and --description; usage: wiki write --path ID --type T --title T --description D",
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
		const resources = [flag(rest, "resource"), flag(rest, "source")].filter(
			(value): value is string => Boolean(value),
		);
		const bodyFile = flag(rest, "body-file");
		const safeBodyFile = bodyFile
			? safeWikiBodyFile(authorizedSnapshot, bodyFile)
			: undefined;
		wikiOutput(
			rest,
			writeConcept(concept, {
				type,
				title,
				description,
				...(flag(rest, "tags")
					? {
							tags: flag(rest, "tags")
								?.split(",")
								.map((tag) => tag.trim())
								.filter(Boolean),
						}
					: {}),
				...(resources.length
					? { sources: resources.map((resource) => ({ resource })) }
					: {}),
				status: role ? "draft" : requestedStatus,
				...(flag(rest, "stale-after")
					? { stale_after: flag(rest, "stale-after") }
					: {}),
				...(safeBodyFile
					? { body: fs.readFileSync(safeBodyFile, "utf8") }
					: {}),
				generatedBy: requestedActor ?? wikiActor(role),
				...(requestedVerified
					? {
							verified: [
								{ by: requestedVerified, at: new Date().toISOString() },
							],
						}
					: {}),
				changeId: process.env.HERDR_CHANGE_ID,
			}),
		);
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
