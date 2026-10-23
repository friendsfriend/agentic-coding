/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: Literal template fixtures. */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	BUILD_CONTEXT_COMMAND,
	buildContext,
} from "../src/server/actions/build-context.ts";
import { OSCommandRunner } from "../src/server/actions/command.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "build context "));
	roots.push(root);
	const config = path.join(root, "config");
	const checkout = path.join(root, "checkout");
	const templates = path.join(config, "templates");
	fs.mkdirSync(templates, { recursive: true });
	fs.mkdirSync(checkout);
	const marker = path.join(root, "state", "manifest");
	const args = (operation: string) => [operation, config, checkout, marker];
	const put = (relative: string, text: string) => {
		const file = path.join(root, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
		return file;
	};
	return { root, config, checkout, templates, args, put };
}

test("native runner dereferences installed templates and renders the selected config .env without output", async () => {
	const f = fixture();
	const source = f.put(
		"external/settings.xml",
		"<user>${TEST_BUILD_USER}</user><pass>${TEST_BUILD_PASS}</pass>",
	);
	fs.symlinkSync(source, path.join(f.templates, "settings.xml"));
	f.put(
		"config/.env",
		"TEST_BUILD_USER=dummy-user\nTEST_BUILD_PASS='dummy-$value'\n",
	);
	const runner = new OSCommandRunner();
	const output: string[] = [];
	const result = await runner.run(
		{ name: BUILD_CONTEXT_COMMAND, args: f.args("prepare"), runId: "one" },
		(_stream, text) => output.push(text),
	);
	expect(result.error).toBeUndefined();
	const file = path.join(f.checkout, "settings.xml");
	expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
	expect(fs.readFileSync(file, "utf8")).toBe(
		"<user>dummy-user</user><pass>dummy-$value</pass>",
	);
	expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	expect(output).toEqual([]);
	const manifests = fs.readdirSync(path.join(f.root, "state"));
	const state = fs.readFileSync(
		path.join(f.root, "state", manifests[0] as string),
		"utf8",
	);
	expect(state).not.toContain("dummy-user");
	expect(state).not.toContain("dummy-$value");
	const cleanup = await runner.run({
		name: BUILD_CONTEXT_COMMAND,
		args: f.args("cleanup"),
		runId: "one",
	});
	expect(cleanup.error).toBeUndefined();
	expect(fs.existsSync(file)).toBe(false);
	expect(fs.readFileSync(source, "utf8")).toContain("${TEST_BUILD_PASS}");
});

test("existing files and nested directories survive prepare and cleanup", () => {
	const f = fixture();
	f.put("config/templates/settings.xml", "replacement");
	f.put("config/templates/sub/new.txt", "generated");
	f.put("checkout/settings.xml", "developer settings");
	f.put("checkout/sub/user.txt", "developer file");
	buildContext(f.args("prepare"), "one", {});
	expect(fs.readFileSync(path.join(f.checkout, "settings.xml"), "utf8")).toBe(
		"developer settings",
	);
	buildContext(f.args("cleanup"), "one", {});
	expect(fs.readFileSync(path.join(f.checkout, "settings.xml"), "utf8")).toBe(
		"developer settings",
	);
	expect(fs.readFileSync(path.join(f.checkout, "sub/user.txt"), "utf8")).toBe(
		"developer file",
	);
	expect(fs.existsSync(path.join(f.checkout, "sub/new.txt"))).toBe(false);
	buildContext(f.args("cleanup"), "one", {}); // idempotent
});

test("a failed preparation rolls back only generated files and reports variable names, not values", () => {
	const f = fixture();
	f.put("config/templates/a.txt", "${DUMMY_SECRET}");
	f.put("config/templates/z.txt", "${UNSET_BUILD_VARIABLE}");
	expect(() =>
		buildContext(f.args("prepare"), "one", { DUMMY_SECRET: "dummy-sensitive" }),
	).toThrow("Missing build-template variable: UNSET_BUILD_VARIABLE");
	expect(fs.readdirSync(f.checkout)).toEqual([]);
	expect(fs.readdirSync(path.join(f.root, "state"))).toEqual([]);
});

test("checkout symlinks cannot redirect generated files or cleanup outside the checkout", () => {
	const f = fixture();
	f.put("config/templates/sub/a.txt", "generated");
	f.put("external/user.txt", "keep");
	fs.symlinkSync(path.join(f.root, "external"), path.join(f.checkout, "sub"));
	expect(() => buildContext(f.args("prepare"), "one", {})).toThrow(
		"checkout symlink",
	);
	expect(fs.readdirSync(path.join(f.root, "external"))).toEqual(["user.txt"]);
});

test("cleanup preserves files changed by the developer during a build", () => {
	const f = fixture();
	f.put("config/templates/new/file.txt", "generated");
	buildContext(f.args("prepare"), "one", {});
	f.put("checkout/new/file.txt", "developer change");
	buildContext(f.args("cleanup"), "one", {});
	expect(fs.readFileSync(path.join(f.checkout, "new/file.txt"), "utf8")).toBe(
		"developer change",
	);
});

test("cleanup is scoped to the run and cannot remove another run's context", () => {
	const f = fixture();
	f.put("config/templates/settings.xml", "generated");
	buildContext(f.args("prepare"), "one", {});
	buildContext(f.args("cleanup"), "two", {});
	expect(fs.existsSync(path.join(f.checkout, "settings.xml"))).toBe(true);
	buildContext(f.args("cleanup"), "one", {});
	expect(fs.existsSync(path.join(f.checkout, "settings.xml"))).toBe(false);
});

test("environment overrides selected .env values without recursive shell evaluation", () => {
	const f = fixture();
	f.put("config/.env", "DUMMY=from-file\n");
	f.put("config/templates/a.txt", "${DUMMY}");
	buildContext(f.args("prepare"), "one", {
		DUMMY: "$(not-a-command)${NOT_EXPANDED}",
	});
	expect(fs.readFileSync(path.join(f.checkout, "a.txt"), "utf8")).toBe(
		"$(not-a-command)${NOT_EXPANDED}",
	);
	buildContext(f.args("cleanup"), "one", {});
});

test("always-run cleanup works even when the build signal has been cancelled", async () => {
	const f = fixture();
	f.put("config/templates/settings.xml", "generated");
	buildContext(f.args("prepare"), "one", {});
	const cancelled = AbortSignal.abort();
	const result = await new OSCommandRunner().run(
		{ name: BUILD_CONTEXT_COMMAND, args: f.args("cleanup"), runId: "one" },
		undefined,
		cancelled,
	);
	expect(result.exitCode).toBe(0);
	expect(fs.existsSync(path.join(f.checkout, "settings.xml"))).toBe(false);
});
