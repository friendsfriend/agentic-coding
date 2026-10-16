// One configuration-root resolver (unify-json-configuration-directory, task
// 2.1): precedence, subprocess propagation, and the rule that a root `.env`
// cannot select its own root. The deprecated alternate root is gone: only the
// canonical variable and the default decide where configuration lives.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDevenvHome } from "../src/backend/home.ts";
import {
	configRootEnv,
	configRootFrom,
	defaultConfigRoot,
	ROOT_SELECTING_ENV_KEYS,
	resolveConfigRoot,
} from "../src/config-root.ts";

const HOME = path.join(os.tmpdir(), "config-root-fixture-home");

describe("configuration root precedence", () => {
	test("explicit argument, then the canonical env, then the default", () => {
		expect(
			configRootFrom(
				{ AGENTIC_CODING_CONFIG_DIR: "/from/new" },
				"/from/explicit",
				HOME,
			),
		).toEqual({
			path: path.resolve("/from/explicit"),
			source: "explicit argument",
		});
		expect(
			configRootFrom(
				{ AGENTIC_CODING_CONFIG_DIR: "/from/new" },
				undefined,
				HOME,
			),
		).toEqual({
			path: path.resolve("/from/new"),
			source: "AGENTIC_CODING_CONFIG_DIR",
		});
		expect(configRootFrom({}, undefined, HOME)).toEqual({
			path: path.join(HOME, ".config", "agentic-coding"),
			source: "default (~/.config/agentic-coding)",
		});
	});

	test("the removed alternate-root variable selects nothing", () => {
		// A stale environment from an older installation must not move the
		// configuration root: the canonical default wins instead.
		expect(
			configRootFrom(
				{ DEVENV_CONFIG_DIR: "/from/removed-alias" } as Record<string, string>,
				undefined,
				HOME,
			).path,
		).toBe(defaultConfigRoot(HOME));
	});

	test("an empty override falls through instead of becoming the root", () => {
		expect(
			configRootFrom({ AGENTIC_CODING_CONFIG_DIR: "" }, undefined, HOME).path,
		).toBe(defaultConfigRoot(HOME));
		expect(configRootFrom({}, "", HOME).path).toBe(defaultConfigRoot(HOME));
	});

	test("a child process is handed the resolved root", () => {
		expect(configRootEnv("/resolved")).toEqual({
			AGENTIC_CODING_CONFIG_DIR: "/resolved",
		});
		expect(Object.keys(configRootEnv("/resolved"))).not.toContain(
			"DEVENV_CONFIG_DIR",
		);
	});
});

describe("the root's own .env cannot select the root", () => {
	test("root-selecting keys are ignored, other keys still apply", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-root-env-"));
		const previous = {
			canonical: process.env.AGENTIC_CODING_CONFIG_DIR,
			home: process.env.DEVENV_HOME,
		};
		try {
			delete process.env.DEVENV_HOME;
			process.env.AGENTIC_CODING_CONFIG_DIR = dir;
			fs.writeFileSync(
				path.join(dir, ".env"),
				[
					...ROOT_SELECTING_ENV_KEYS.map((key) => `${key}=/hijacked`),
					`DEVENV_HOME=${path.join(dir, "runtime-home")}`,
				].join("\n"),
			);
			expect(resolveDevenvHome()).toBe(path.join(dir, "runtime-home"));
			expect(resolveConfigRoot()).toBe(dir);
		} finally {
			if (previous.canonical === undefined)
				delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previous.canonical;
			if (previous.home === undefined) delete process.env.DEVENV_HOME;
			else process.env.DEVENV_HOME = previous.home;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
