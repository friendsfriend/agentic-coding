import { digest, type Skill } from "../../../config.ts";
import type { SkillDocument, SkillSummary } from "../../../protocol/index.ts";
import type { Runtime } from "../../../runtime.ts";

function summary(skill: Skill): SkillSummary {
	if (
		!skill.id ||
		skill.id.length > 128 ||
		!["system", "user"].includes(skill.origin) ||
		skill.digest.length !== 64 ||
		!/^[a-f0-9]{64}$/.test(skill.digest)
	)
		throw new Error("Invalid loaded skill metadata");
	return {
		id: skill.id,
		origin: skill.origin,
		description: skill.description.slice(0, 2048),
		revision: skill.digest,
		readOnly: skill.readOnly,
	};
}
export function listSkills(app: Runtime): SkillSummary[] {
	if (
		app.config.skills.length > 128 ||
		new Set(app.config.skills.map((skill) => skill.id)).size !==
			app.config.skills.length
	)
		throw new Error("Loaded skill catalog is oversized or ambiguous");
	return app.config.skills.map(summary);
}
export function readSkill(
	app: Runtime,
	id: unknown,
	revision: unknown,
): SkillDocument {
	listSkills(app);
	const skill = app.config.skills.find((skill) => skill.id === id);
	if (
		!skill ||
		typeof revision !== "string" ||
		revision !== skill.digest ||
		skill.content.length > 64000 ||
		digest(skill.content) !== skill.digest
	)
		throw new Error("Loaded skill is unavailable, changed or oversized");
	return { ...summary(skill), content: skill.content };
}
