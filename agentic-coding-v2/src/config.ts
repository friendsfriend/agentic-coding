import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	loadSkillsFromDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import codeSkill from "../skills/code/SKILL.md" with { type: "text" };
import researchSkill from "../skills/research/SKILL.md" with { type: "text" };
import wikiCommentSkill from "../skills/wiki-comment/SKILL.md" with {
	type: "text",
};
import { readProviders } from "./providers/config.ts";

export type Profile = {
	id: string;
	provider: string;
	modelId: string;
	thinking: ModelThinkingLevel;
	description: string;
};
export type Skill = {
	origin: "system" | "user";
	id: string;
	description: string;
	content: string;
	digest: string;
	readOnly: boolean;
	/** Native-only source identity; never a client path selector. */
	sourceFile?: string;
};
export type Config = {
	profiles: Profile[];
	orchestratorProfile: string;
	repositories: string[];
	providers: import("./providers/config.ts").ProviderConfig[];
	skills: Skill[];
	stateDir: string;
	configDir: string;
};
export const digest = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");
export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected an object");
	return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = 16000): string {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw new Error(`Invalid ${name}`);
	return value;
}
export function readProfiles(value: unknown): Profile[] {
	return Object.entries(object(value)).map(([id, raw]) => {
		const entry = object(raw);
		const model = text(entry.model, `model in profile ${id}`, 512);
		const slash = model.indexOf("/");
		if (slash < 1 || slash === model.length - 1)
			throw new Error(`Profile ${id} needs provider/model`);
		const thinking = entry.thinking ?? "low";
		if (
			!["off", "minimal", "low", "medium", "high", "xhigh"].includes(
				String(thinking),
			)
		)
			throw new Error(`Invalid thinking in ${id}`);
		return {
			id,
			provider: model.slice(0, slash),
			modelId: model.slice(slash + 1),
			thinking: thinking as ModelThinkingLevel,
			description:
				typeof entry.description === "string" ? entry.description : "",
		};
	});
}
function readConfigFile(file: string): Record<string, unknown> {
	if (!fs.existsSync(file)) return {};
	try {
		return object(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		throw new Error(
			`Invalid configuration file: ${file}. Expected a JSON object; values are not logged.`,
		);
	}
}
export function defaultConfigDir(): string {
	return path.resolve(
		process.env.AGENTIC_CODING_V2_CONFIG_DIR ??
			path.join(
				process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
				"agentic-coding-v2",
			),
	);
}
export function loadConfig(
	stateDir: string,
	cwd: string,
	configDir = defaultConfigDir(),
): Config {
	configDir = path.resolve(configDir);
	const file = path.join(configDir, "config.json");
	const data = readConfigFile(file);
	// Read profiles only. Never load legacy presets, routes, runtime data, or credentials into our state.
	const source =
		typeof data.profileSource === "string"
			? data.profileSource
			: (process.env.HERDR_WORKFLOW_CONFIG ??
				path.join(
					process.env.AGENTIC_CODING_CONFIG_DIR ??
						path.join(os.homedir(), ".config/agentic-coding"),
					"config.json",
				));
	const legacy = data.profiles === undefined ? readConfigFile(source) : {};
	const agents = legacy.agents ? object(legacy.agents) : {};
	if (data.repositories !== undefined && !Array.isArray(data.repositories))
		throw new Error("repositories must be an array");
	if (data.skillDirectories !== undefined)
		throw new Error(
			"skillDirectories is not supported; put user skills in CONFIG_DIR/skills",
		);
	const profiles = readProfiles(data.profiles ?? agents.profiles ?? {});
	const orchestratorProfile = String(
		data.orchestratorProfile ?? agents.default_profile ?? profiles[0]?.id ?? "",
	);
	if (
		orchestratorProfile &&
		!profiles.some((profile) => profile.id === orchestratorProfile)
	)
		throw new Error(
			"orchestratorProfile names no configured profile; names and values are withheld",
		);
	const repositories = (
		Array.isArray(data.repositories) ? data.repositories : [cwd]
	).map((item) => fs.realpathSync(text(item, "repository", 4096)));
	const skills: Skill[] = [
		{ content: codeSkill, readOnly: false },
		{ content: researchSkill, readOnly: true },
		{ content: wikiCommentSkill, readOnly: true },
	].map(({ content, readOnly }) => {
		const { frontmatter } = parseFrontmatter(content);
		return {
			id: text(frontmatter.name, "system skill name"),
			description: text(frontmatter.description, "system skill description"),
			content,
			readOnly,
			origin: "system",
			digest: digest(content),
		};
	});
	const dir = path.join(configDir, "skills");
	if (fs.existsSync(dir)) {
		const loaded = loadSkillsFromDir({ dir, source: "user" });
		if (loaded.diagnostics.some((d) => d.type === "error"))
			throw new Error(`Invalid skills in ${dir}`);
		for (const skill of loaded.skills) {
			if (skills.some((s) => s.id === skill.name))
				throw new Error(`Duplicate skill: ${skill.name}`);
			const content = fs.readFileSync(skill.filePath, "utf8");
			skills.push({
				id: skill.name,
				description: skill.description,
				origin: "user",
				sourceFile: fs.realpathSync(skill.filePath),
				content,
				digest: digest(content),
				readOnly: false,
			});
		}
	}
	return {
		profiles,
		orchestratorProfile,
		repositories,
		providers: readProviders(data.providers),
		skills,
		stateDir,
		configDir,
	};
}
