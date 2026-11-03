import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

export type Profile = {
	id: string;
	provider: string;
	modelId: string;
	thinking: ModelThinkingLevel;
	description: string;
};
export type Skill = {
	id: string;
	description: string;
	content: string;
	digest: string;
	readOnly: boolean;
};
export type Config = {
	profiles: Profile[];
	orchestratorProfile: string;
	repositories: string[];
	skills: Skill[];
	stateDir: string;
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
export function loadConfig(stateDir: string, cwd: string): Config {
	const file = path.join(stateDir, "config.json");
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
	if (
		data.skillDirectories !== undefined &&
		!Array.isArray(data.skillDirectories)
	)
		throw new Error("skillDirectories must be an array");
	const profiles = readProfiles(data.profiles ?? agents.profiles ?? {});
	const orchestratorProfile = String(
		data.orchestratorProfile ?? agents.default_profile ?? profiles[0]?.id ?? "",
	);
	const repositories = (
		Array.isArray(data.repositories) ? data.repositories : [cwd]
	).map((item) => fs.realpathSync(text(item, "repository", 4096)));
	const directories = [
		path.resolve(import.meta.dir, "../skills"),
		...(Array.isArray(data.skillDirectories)
			? data.skillDirectories.map((v) => text(v, "skill directory", 4096))
			: []),
	];
	const skills: Skill[] = [];
	for (const dir of directories) {
		const loaded = loadSkillsFromDir({ dir, source: "v2" });
		if (loaded.diagnostics.some((d) => d.type === "error"))
			throw new Error(`Invalid skills in ${dir}`);
		for (const skill of loaded.skills) {
			if (skills.some((s) => s.id === skill.name))
				throw new Error(`Duplicate skill: ${skill.name}`);
			const content = fs.readFileSync(skill.filePath, "utf8");
			skills.push({
				id: skill.name,
				description: skill.description,
				content,
				digest: digest(content),
				readOnly: skill.name === "research",
			});
		}
	}
	return { profiles, orchestratorProfile, repositories, skills, stateDir };
}
