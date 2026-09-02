// Local step-output contracts used by the builtin step catalog
// (definitions/steps.ts), plus the standalone research-handoff contract
// consumed directly by runtime.ts's `agent.research-handoff` reducer. Moved
// verbatim out of definitions.ts (split-workflow-god-modules).
import path from "node:path";
import type { Contract, JsonValue } from "../contracts.ts";
import { ContractFailure, validation } from "../contracts.ts";

export const passthrough: Contract<JsonValue> = {
	id: "core.json",
	version: 1,
	parse(value) {
		if (value === undefined) return null;
		try {
			return JSON.parse(JSON.stringify(value)) as JsonValue;
		} catch {
			throw new ContractFailure("core.json", [
				{ path: "$", message: "not JSON serializable" },
			]);
		}
	},
};
export const empty: Contract<null> = {
	id: "core.empty",
	version: 1,
	parse(value) {
		if (value !== undefined && value !== null)
			throw new ContractFailure("core.empty", [
				{ path: "$", message: "expected empty output" },
			]);
		return null;
	},
};
export const findings: Contract<{ critical: number }> = {
	id: "core.findings",
	version: 1,
	parse(value) {
		const item = validation.object(value, "$");
		if (!Array.isArray(item.findings))
			throw new ContractFailure("core.findings", [
				{ path: "$.findings", message: "expected findings array" },
			]);
		const ids = new Set<string>();
		let critical = 0;
		item.findings.forEach((value, index) => {
			const finding = validation.object(value, `$.findings[${index}]`);
			const id = validation.text(finding.id, `$.findings[${index}].id`);
			if (ids.has(id))
				throw new ContractFailure("core.findings", [
					{ path: `$.findings[${index}].id`, message: "duplicate stable ID" },
				]);
			ids.add(id);
			const severity = validation.enumValue(
				finding.severity,
				`$.findings[${index}].severity`,
				["critical", "warning", "info"],
			);
			validation.text(finding.detail, `$.findings[${index}].detail`);
			validation.text(finding.path, `$.findings[${index}].path`);
			validation.integer(finding.line, `$.findings[${index}].line`, 1);
			if (severity === "critical") critical++;
		});
		return { critical };
	},
};
export type ResearchHandoffDirectiveIntent = "create" | "update";
export interface ResearchHandoffDirective {
	/** Existing concept identifier to update, or a proposed project-scoped
	 * identifier for a new concept, depending on `intent`. */
	target: string;
	intent: ResearchHandoffDirectiveIntent;
	/** Specific source-backed facts the wiki agent must document. */
	claims: string[];
	/** Citations supporting this directive's claims. */
	citations: string[];
}
export interface ResearchHandoff {
	subject: string;
	canonicalTarget?: string;
	/** Freeform narrative/context the structured directives cannot capture. */
	findings: string;
	/** Per-concept documentation directives; the wiki agent's actionable
	 * starting point for which concepts to create or update. */
	directives: ResearchHandoffDirective[];
	citations: string[];
	noSourcesUsed: boolean;
}
const MAX_RESEARCH_HANDOFF_CITATIONS = 32;
const MAX_RESEARCH_HANDOFF_DIRECTIVES = 16;
const MAX_RESEARCH_HANDOFF_CLAIMS = 16;
const MAX_RESEARCH_HANDOFF_DIRECTIVE_CITATIONS = 16;
const MAX_RESEARCH_HANDOFF_BYTES = 48 * 1024;
export const researchHandoffContract: Contract<ResearchHandoff> = {
	id: "core.research-handoff",
	version: 1,
	parse(value) {
		const item = validation.object(value, "$");
		const subject = validation.text(item.subject, "$.subject", 512);
		const canonicalTarget =
			item.canonicalTarget === undefined || item.canonicalTarget === null
				? undefined
				: validation.text(item.canonicalTarget, "$.canonicalTarget", 512);
		const findings = validation.boundedText(item.findings, "$.findings", 16384);
		const noSourcesUsed = item.noSourcesUsed === true;
		if (
			item.citations !== undefined &&
			(!Array.isArray(item.citations) ||
				item.citations.length > MAX_RESEARCH_HANDOFF_CITATIONS)
		)
			throw new ContractFailure("core.research-handoff", [
				{
					path: "$.citations",
					message: `expected at most ${MAX_RESEARCH_HANDOFF_CITATIONS} source citations`,
				},
			]);
		const citations = Array.isArray(item.citations)
			? item.citations.map((entry, index) =>
					validation.text(entry, `$.citations[${index}]`, 1024),
				)
			: [];
		if (!noSourcesUsed && !citations.length)
			throw new ContractFailure("core.research-handoff", [
				{
					path: "$.citations",
					message:
						"expected at least one source citation, or noSourcesUsed set to true",
				},
			]);
		if (!Array.isArray(item.directives) || !item.directives.length)
			throw new ContractFailure("core.research-handoff", [
				{
					path: "$.directives",
					message: "expected at least one documentation directive",
				},
			]);
		if (item.directives.length > MAX_RESEARCH_HANDOFF_DIRECTIVES)
			throw new ContractFailure("core.research-handoff", [
				{
					path: "$.directives",
					message: `expected at most ${MAX_RESEARCH_HANDOFF_DIRECTIVES} documentation directives`,
				},
			]);
		const directives: ResearchHandoffDirective[] = item.directives.map(
			(raw, index) => {
				const entry = validation.object(raw, `$.directives[${index}]`);
				const target = validation.text(
					entry.target,
					`$.directives[${index}].target`,
					512,
				);
				const intent = validation.enumValue(
					entry.intent,
					`$.directives[${index}].intent`,
					["create", "update"],
				);
				if (!Array.isArray(entry.claims) || !entry.claims.length)
					throw new ContractFailure("core.research-handoff", [
						{
							path: `$.directives[${index}].claims`,
							message: "expected at least one source-backed claim",
						},
					]);
				if (entry.claims.length > MAX_RESEARCH_HANDOFF_CLAIMS)
					throw new ContractFailure("core.research-handoff", [
						{
							path: `$.directives[${index}].claims`,
							message: `expected at most ${MAX_RESEARCH_HANDOFF_CLAIMS} claims`,
						},
					]);
				const claims = entry.claims.map((claim, claimIndex) =>
					validation.text(
						claim,
						`$.directives[${index}].claims[${claimIndex}]`,
						2048,
					),
				);
				if (
					entry.citations !== undefined &&
					(!Array.isArray(entry.citations) ||
						entry.citations.length > MAX_RESEARCH_HANDOFF_DIRECTIVE_CITATIONS)
				)
					throw new ContractFailure("core.research-handoff", [
						{
							path: `$.directives[${index}].citations`,
							message: `expected at most ${MAX_RESEARCH_HANDOFF_DIRECTIVE_CITATIONS} citations`,
						},
					]);
				const directiveCitations = Array.isArray(entry.citations)
					? entry.citations.map((entryCitation, citationIndex) =>
							validation.text(
								entryCitation,
								`$.directives[${index}].citations[${citationIndex}]`,
								1024,
							),
						)
					: [];
				return { target, intent, claims, citations: directiveCitations };
			},
		);
		const parsed: ResearchHandoff = {
			subject,
			...(canonicalTarget === undefined ? {} : { canonicalTarget }),
			findings,
			directives,
			citations,
			noSourcesUsed,
		};
		if (
			Buffer.byteLength(JSON.stringify(parsed), "utf8") >
			MAX_RESEARCH_HANDOFF_BYTES
		)
			throw new ContractFailure("core.research-handoff", [
				{
					path: "$",
					message: `handoff exceeds ${MAX_RESEARCH_HANDOFF_BYTES} bytes serialized`,
				},
			]);
		return parsed;
	},
};
export const triage: Contract<{
	roles: string[];
	assignments: Array<{ role: string; reason: string; files: string[] }>;
}> = {
	id: "core.triage-plan",
	version: 1,
	parse(value) {
		const item = validation.object(value, "$");
		if (!Array.isArray(item.roles))
			throw new ContractFailure("core.triage-plan", [
				{ path: "$.roles", message: "expected role assignment array" },
			]);
		const roles = item.roles.map((value, index) => {
			const entry = validation.object(value, `$.roles[${index}]`);
			const role = validation.text(entry.role, `$.roles[${index}].role`);
			validation.text(entry.reason, `$.roles[${index}].reason`);
			const files = validation.strings(entry.files, `$.roles[${index}].files`);
			if (
				!files.length ||
				files.some(
					(file) =>
						path.isAbsolute(file) || file.split(path.sep).includes(".."),
				)
			)
				throw new ContractFailure("core.triage-plan", [
					{
						path: `$.roles[${index}].files`,
						message: "expected scoped repository-relative files",
					},
				]);
			if (entry.hunks !== undefined) {
				const hunks = validation.object(entry.hunks, `$.roles[${index}].hunks`);
				for (const [file, ids] of Object.entries(hunks))
					if (
						!files.includes(file) ||
						!Array.isArray(ids) ||
						ids.some(
							(id) => !Number.isInteger(id) || Number(id) < 1 || Number(id) > 8,
						)
					)
						throw new ContractFailure("core.triage-plan", [
							{
								path: `$.roles[${index}].hunks`,
								message: "invalid scoped hunk IDs",
							},
						]);
			}
			return { role, reason: String(entry.reason), files };
		});
		const roleNames = roles.map((item) => item.role);
		if (new Set(roleNames).size !== roleNames.length)
			throw new ContractFailure("core.triage-plan", [
				{ path: "$.roles", message: "duplicate role" },
			]);
		return { roles: roleNames, assignments: roles };
	},
};
export const planDraft: Contract<{
	approach: string;
	files: Array<{ path: string; change: string }>;
	risks: Array<{ detail: string }>;
	questions: Array<{ detail: string }>;
}> = {
	id: "core.plan-draft",
	version: 1,
	parse(value) {
		const item = validation.object(value, "$");
		const approach = validation.text(item.approach, "$.approach", 8192);
		if (!Array.isArray(item.files))
			throw new ContractFailure("core.plan-draft", [
				{ path: "$.files", message: "expected file plan array" },
			]);
		if (!item.files.length)
			throw new ContractFailure("core.plan-draft", [
				{ path: "$.files", message: "expected at least one planned file" },
			]);
		const files = item.files.map((entry, index) => {
			const file = validation.object(entry, `$.files[${index}]`);
			const filePath = validation.text(
				file.path,
				`$.files[${index}].path`,
				1024,
			);
			validation.text(file.change, `$.files[${index}].change`, 4096);
			if (path.isAbsolute(filePath) || filePath.split(path.sep).includes(".."))
				throw new ContractFailure("core.plan-draft", [
					{
						path: `$.files[${index}].path`,
						message: "expected repository-relative file path",
					},
				]);
			return { path: filePath, change: String(file.change) };
		});
		const section = (field: "risks" | "questions") => {
			if (!Array.isArray(item[field]))
				throw new ContractFailure("core.plan-draft", [
					{ path: `$.${field}`, message: `expected ${field} array` },
				]);
			return item[field].map((entry, index) => {
				const detail = validation.object(entry, `$.${field}[${index}]`);
				return {
					detail: validation.text(
						detail.detail,
						`$.${field}[${index}].detail`,
						4096,
					),
				};
			});
		};
		return {
			approach,
			files,
			risks: section("risks"),
			questions: section("questions"),
		};
	},
};

/** The planning handoff output (`core.plan` / `fusion.consolidate` complete):
 * declares the primary change the workflow implements. The planner picks the
 * change id(s) itself, so the engine cannot know the primary at start — it is
 * required here and recorded into `metadata.changeId` by the handoff reducer
 * (which also validates the id shape and the declared change directory). The
 * remaining fields the planner emits for developer review are bounded but
 * optional, so single-pass and addressed retries keep their shape. */
export const planResult: Contract<{
	primaryChangeId: string;
	summary?: string;
	artifacts?: string[];
	risks?: string[];
	openQuestions?: string[];
}> = {
	id: "core.plan-result",
	version: 1,
	parse(value) {
		const item = validation.object(value, "$");
		const primaryChangeId = validation.text(
			item.primaryChangeId,
			"$.primaryChangeId",
			80,
		);
		const itemList = (field: "artifacts" | "risks" | "openQuestions") => {
			if (item[field] === undefined) return undefined;
			if (!Array.isArray(item[field]))
				throw new ContractFailure("core.plan-result", [
					{ path: `$.${field}`, message: `expected ${field} array` },
				]);
			return (item[field] as unknown[]).map((entry, index) =>
				validation.text(entry, `$.${field}[${index}]`, 4096),
			);
		};
		const summary =
			item.summary === undefined
				? undefined
				: validation.text(item.summary, "$.summary", 16384);
		return {
			primaryChangeId,
			...(summary === undefined ? {} : { summary }),
			...(itemList("artifacts") === undefined
				? {}
				: { artifacts: itemList("artifacts") }),
			...(itemList("risks") === undefined ? {} : { risks: itemList("risks") }),
			...(itemList("openQuestions") === undefined
				? {}
				: { openQuestions: itemList("openQuestions") }),
		};
	},
};
