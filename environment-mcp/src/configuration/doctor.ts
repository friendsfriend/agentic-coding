import type { ServerManifest } from "../configuration/server-manifest.ts";
import type { SecretSource } from "./secrets.ts";

const hints: Record<string, string> = {
	"container-name-prefix":
		"Rename explicit Compose container_name values to environment-mcp-<name>, after reviewing borrowed-service identity.",
	"compose-service-count":
		"Review the Compose services; only one to sixteen declared services are supported.",
	"compose-invalid":
		"Review the Compose source/file/socket and service declarations.",
	"endpoint-invalid":
		"Use explicit HTTP(S) IP-loopback endpoints without credentials or fragments.",
	"build-secret-invalid":
		"Use one v2 build-secret mode: template, absolute nonlinked file, or declared environment reference.",
	"kubernetes-unsupported":
		"Kubernetes execution is not implemented by this package yet.",
	"podman-unsupported":
		"Podman execution is not implemented by this package yet.",
	"docker-target-unsupported":
		"Use a supported Docker build target with dockerfileSource or dockerfile.",
	"missing-command": "Add the configured shell command.",
	"unsupported-provider": "Use the Docker Compose provider.",
	"unsupported-descriptor":
		"Review the target runtime/action fields against the supported execution matrix.",
};

const references = (
	executable: NonNullable<
		ServerManifest["apps"][number]["targets"][number]["executable"]
	>,
) => {
	const refs: string[] = [];
	const add = (values: Record<string, string>) => {
		refs.push(...Object.values(values));
	};
	if (
		executable.kind === "command" ||
		executable.kind === "process" ||
		executable.kind === "container-run"
	)
		add(executable.envRefs);
	else if (executable.kind === "compose") {
		add(executable.envRefs);
		for (const service of Object.values(executable.serviceEnvRefs))
			add(service);
	} else if (executable.kind === "docker-build") {
		for (const secret of executable.secrets)
			if (secret.kind === "template") add(secret.refs);
			else if (secret.kind === "env") refs.push(secret.env);
	}
	return [...new Set(refs)];
};

export function createDoctorReport(
	manifest: ServerManifest,
	options: { secrets?: SecretSource } = {},
) {
	let targets = 0,
		available = 0,
		unavailable = 0;
	const byKind: Record<string, number> = {};
	const issues: {
		app: string;
		target: string;
		action: string;
		runtime: string;
		issue: string;
		hint: string;
	}[] = [];
	for (const app of manifest.apps)
		for (const target of app.targets) {
			targets++;
			if (target.executable) {
				available++;
				byKind[target.executable.kind] =
					(byKind[target.executable.kind] ?? 0) + 1;
				continue;
			}
			unavailable++;
			const issue = target.executionIssue ?? "unsupported-descriptor";
			issues.push({
				app: app.id,
				target: target.id,
				action: target.action,
				runtime: target.runtime,
				issue,
				hint:
					hints[issue] ?? hints["unsupported-descriptor"] ?? "Review target.",
			});
		}
	return {
		version: 1,
		apps: manifest.apps.length,
		targets,
		available,
		unavailable,
		byKind,
		issues,
		secretGaps:
			options.secrets === undefined
				? undefined
				: manifest.apps
						.flatMap((app) =>
							app.targets.flatMap((target) => {
								if (!target.executable) return [];
								const missing = references(target.executable).filter(
									(reference) => !options.secrets?.get(reference),
								);
								return missing.length
									? [
											{
												app: app.id,
												target: target.id,
												references: missing.slice(0, 64),
											},
										]
									: [];
							}),
						)
						.slice(0, 100),
	};
}

export type DoctorReport = ReturnType<typeof createDoctorReport>;
