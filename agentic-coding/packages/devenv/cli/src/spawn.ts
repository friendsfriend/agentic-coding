#!/usr/bin/env bun
// Thin `devenv` alias of the one executable. It maps devenv's verbs/flags onto
// the unified CLI (src/devenv-alias.ts) and re-execs this same checkout's
// entry, so there is exactly one command surface, one lifecycle owner and one
// version. No TUI, backend or lifecycle code lives here.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devenvAliasArgv } from "../../../../src/devenv-alias.ts";

const entry = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../src/cli.ts",
);

const argv = devenvAliasArgv(process.argv.slice(2));
const child = Bun.spawn([process.execPath, entry, ...argv], {
	stdio: ["inherit", "inherit", "inherit"],
	env: { ...process.env, AGENTIC_CODING_INVOKED_AS: "devenv" },
});
await child.exited;
process.exit(child.exitCode ?? 0);
