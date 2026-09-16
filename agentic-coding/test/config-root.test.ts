// One configuration-root resolver (unify-json-configuration-directory, task
// 2.1): precedence, the value-free deprecation diagnostic, subprocess
// propagation, and the rule that a root `.env` cannot select its own root.
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
	resetConfigRootDiagnostics,
	resolveConfigRoot,
} from "../src/config-root.ts";

const HOME = path.join(os.tmpdir(), "config-root-fixture-home");

describe("configuration root precedence", () => {
	test("explicit argument, then new env, then legacy alias, then default", () => {
		expect(
			configRootFrom(
				{
					AGENTIC_CODING_CONFIG_DIR: "/from/new",
					DEVENV_CONFIG_DIR: "/from/legacy",
				},
				"/from/explicit",
				HOME,
			),
		).toEqual({
			path: path.resolve("/from/explicit"),
			source: "explicit argument",
		});
		expect(
			configRootFrom(
				{
					AGENTIC_CODING_CONFIG_DIR: "/from/new",
					DEVENV_CONFIG_DIR: "/from/legacy",
				},
				undefined,
				HOME,
			),
		).toEqual({
			path: path.resolve("/from/new"),
			source: "AGENTIC_CODING_CONFIG_DIR",
		});
		expect(
			configRootFrom({ DEVENV_CONFIG_DIR: "/from/legacy" }, undefined, HOME),
		).toEqual({
			path: path.resolve("/from/legacy"),
			source: "DEVENV_CONFIG_DIR (deprecated)",
		});
		expect(configRootFrom({}, undefined, HOME)).toEqual({
			path: path.join(HOME, ".config", "agentic-coding"),
			source: "default (~/.config/agentic-coding)",
		});
	});

	test("an empty override falls through instead of becoming the root", () => {
		expect(
			configRootFrom({ AGENTIC_CODING_CONFIG_DIR: "" }, undefined, HOME).path,
		).toBe(defaultConfigRoot(HOME));
		expect(configRootFrom({}, "", HOME).path).toBe(defaultConfigRoot(HOME));
	});

	test("the legacy alias warns once, without printing the resolved path", () => {
		const previous = {
			canonical: process.env.AGENTIC_CODING_CONFIG_DIR,
			legacy: process.env.DEVENV_CONFIG_DIR,
		};
		const written: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			delete process.env.AGENTIC_CODING_CONFIG_DIR;
			process.env.DEVENV_CONFIG_DIR = "/tmp/legacy-root-must-not-be-printed";
			resetConfigRootDiagnostics();
			expect(resolveConfigRoot()).toBe("/tmp/legacy-root-must-not-be-printed");
			// Both set: the new name wins and the deprecation is still reported.
			process.env.AGENTIC_CODING_CONFIG_DIR = "/tmp/canonical-root";
			expect(resolveConfigRoot()).toBe("/tmp/canonical-root");
			resetConfigRootDiagnostics();
			resolveConfigRoot();
			resolveConfigRoot();
			expect(written.length).toBe(2);
			expect(written.join("")).toContain("DEVENV_CONFIG_DIR is deprecated");
			expect(written.join("")).not.toContain("legacy-root-must-not-be-printed");
			expect(written.join("")).not.toContain("canonical-root");
		} finally {
			process.stderr.write = original;
			resetConfigRootDiagnostics();
			if (previous.canonical === undefined)
				delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previous.canonical;
			if (previous.legacy === undefined) delete process.env.DEVENV_CONFIG_DIR;
			else process.env.DEVENV_CONFIG_DIR = previous.legacy;
		}
	});

	test("a child process is handed the resolved root, never the alias", () => {
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
			legacy: process.env.DEVENV_CONFIG_DIR,
			home: process.env.DEVENV_HOME,
		};
		try {
			delete process.env.DEVENV_HOME;
			delete process.env.AGENTIC_CODING_CONFIG_DIR;
			process.env.DEVENV_CONFIG_DIR = dir;
			fs.writeFileSync(
				path.join(dir, ".env"),
				[
					...ROOT_SELECTING_ENV_KEYS.map((key) => `${key}=/hijacked`),
					`DEVENV_HOME=${path.join(dir, "runtime-home")}`,
				].join("\n"),
			);
			expect(resolveDevenvHome()).toBe(path.join(dir, "runtime-home"));
		} finally {
			if (previous.canonical === undefined)
				delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previous.canonical;
			if (previous.legacy === undefined) delete process.env.DEVENV_CONFIG_DIR;
			else process.env.DEVENV_CONFIG_DIR = previous.legacy;
			if (previous.home === undefined) delete process.env.DEVENV_HOME;
			else process.env.DEVENV_HOME = previous.home;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
