import { text } from "../../../config.ts";
import {
	type Data,
	type ProviderInspection,
	record,
} from "../../../protocol/index.ts";
import type { Runtime } from "../../../runtime.ts";

/** Explicit read-only provider operations, never arbitrary routes or automatic outbound calls. */
export async function inspectProvider(
	app: Runtime,
	input: Data,
): Promise<ProviderInspection> {
	const provider = text(input.provider, "provider", 64);
	const operation = text(input.operation, "provider operation", 32);
	const extra =
		operation === "repos"
			? ["query"]
			: ["changes", "issues"].includes(operation)
				? ["repo", "state"]
				: operation === "jobs"
					? ["repo", "run"]
					: ["change", "issue", "files", "versions", "discussions"].includes(
								operation,
							)
						? ["repo", "number"]
						: ["repo"];
	if (
		Object.keys(input).some(
			(key) => !["provider", "operation", ...extra].includes(key),
		)
	)
		throw new Error("Unsupported provider field");
	if (
		extra.includes("number") &&
		(!Number.isSafeInteger(input.number) || Number(input.number) < 1)
	)
		throw new Error("Invalid provider number");
	if (
		input.run !== undefined &&
		(!Number.isSafeInteger(input.run) || Number(input.run) < 1)
	)
		throw new Error("Invalid provider run");
	const api = app.environments.providers;
	let value: unknown;
	switch (operation) {
		case "repos":
			value = await api.searchRepos(provider, input.query);
			break;
		case "branches":
			value = await api.repoBranches(
				provider,
				text(input.repo, "repository", 256),
			);
			break;
		case "labels":
			value = await api.repoLabels(
				provider,
				text(input.repo, "repository", 256),
			);
			break;
		case "collaborators":
			value = await api.repoCollaborators(
				provider,
				text(input.repo, "repository", 256),
			);
			break;
		case "changes":
			value = await api.changes(
				provider,
				text(input.repo, "repository", 256),
				input.state,
			);
			break;
		case "issues":
			value = await api.issues(
				provider,
				text(input.repo, "repository", 256),
				input.state,
			);
			break;
		case "change":
			value = await api.change(
				provider,
				text(input.repo, "repository", 256),
				input.number,
			);
			break;
		case "issue":
			value = await api.issue(
				provider,
				text(input.repo, "repository", 256),
				input.number,
			);
			break;
		case "files":
			value = await api.changeFiles(
				provider,
				text(input.repo, "repository", 256),
				input.number,
			);
			break;
		case "versions":
			value = await api.changeVersions(
				provider,
				text(input.repo, "repository", 256),
				input.number,
			);
			break;
		case "discussions":
			value = await api.discussions(
				provider,
				text(input.repo, "repository", 256),
				input.number,
			);
			break;
		case "jobs":
			value = await api.jobs(
				provider,
				text(input.repo, "repository", 256),
				input.run,
			);
			break;
		default:
			throw new Error("Unsupported provider operation");
	}
	return {
		provider,
		operation,
		value: Array.isArray(value) ? value.map(record) : record(value),
	};
}
