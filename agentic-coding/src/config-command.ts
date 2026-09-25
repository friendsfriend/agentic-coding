// `agentic-coding config` — explicit, preview-first configuration migration
// (unify-json-configuration-directory, tasks 4.1-4.3). Ordinary startup and
// installation never move user data; only `config migrate --apply` does, and it
// previews unless told otherwise.
import {
	applyMigration,
	formatMigrationPlan,
	planMigration,
	resumeMigration,
	rollbackMigration,
} from "./config-migration.ts";
import { resolveConfigRoot } from "./config-root.ts";

const USAGE = `usage: agentic-coding config migrate [options]

  (no options)      Preview the migration plan and write nothing.
  --apply           Publish the previewed plan. Stop servers and workflow
                    writers first; every source is backed up.
  --resume          Finish a migration that stopped during publication.
  --rollback        Restore the configuration a stopped migration replaced.
  --source DIR      Legacy environment configuration root
                    (default: DEVENV_CONFIG_DIR or ~/.config/devenv).
  --target DIR      Canonical configuration root
                    (default: the shared resolver's root).
`;

function flagValue(args: readonly string[], flag: string): string | undefined {
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === flag) return args[index + 1];
		if (args[index]?.startsWith(`${flag}=`))
			return args[index].slice(flag.length + 1);
	}
	return undefined;
}

export async function runConfigCommand(
	args: readonly string[],
): Promise<number> {
	const [subcommand, ...rest] = args;
	if (
		subcommand === undefined ||
		subcommand === "--help" ||
		subcommand === "-h"
	) {
		process.stdout.write(USAGE);
		return subcommand === undefined ? 2 : 0;
	}
	if (subcommand !== "migrate") {
		process.stderr.write(`unknown config command: ${subcommand}\n\n${USAGE}`);
		return 2;
	}
	if (rest.includes("--help") || rest.includes("-h")) {
		process.stdout.write(USAGE);
		return 0;
	}

	const target = flagValue(rest, "--target") ?? resolveConfigRoot();
	const source = flagValue(rest, "--source");
	const options = { ...(source ? { source } : {}), target };

	if (rest.includes("--rollback")) {
		const restored = rollbackMigration(target);
		process.stdout.write(
			restored
				? `Restored ${restored} file(s) from the protected backup.\n`
				: "No interrupted migration to roll back.\n",
		);
		return 0;
	}
	if (rest.includes("--resume")) {
		const resumed = resumeMigration(target);
		process.stdout.write(
			resumed.published
				? `Finished publishing ${resumed.published} file(s).\n`
				: "No interrupted migration to resume.\n",
		);
		if (resumed.presetsRemoved > 0)
			process.stdout.write(
				`Removed ${resumed.presetsRemoved} presets; recreate them as model pools in Settings \u2192 Presets.\n`,
			);
		return 0;
	}

	const plan = planMigration(options);
	if (!rest.includes("--apply")) {
		process.stdout.write(formatMigrationPlan(plan));
		return plan.conflicts.length ? 1 : 0;
	}

	if (plan.pendingJournal) {
		process.stderr.write(
			`An incomplete migration journal exists at ${target}; run --resume or --rollback first.\n`,
		);
		return 1;
	}
	if (plan.conflicts.length) {
		process.stderr.write(formatMigrationPlan(plan));
		return 1;
	}
	const result = applyMigration(plan);
	process.stdout.write(
		result.applied === 0
			? "Configuration is already migrated.\n"
			: `Migrated ${result.applied} file(s)${result.backupDir ? `; protected backup at ${result.backupDir}` : ""}.\n`,
	);
	if (result.presetsRemoved > 0)
		process.stdout.write(
			`Removed ${result.presetsRemoved} presets; recreate them as model pools in Settings \u2192 Presets.\n`,
		);
	return 0;
}
