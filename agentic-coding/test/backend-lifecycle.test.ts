// Backend lifecycle policy after the Go backend was retired (retire-go-
// backend-and-migration-bridges tasks 2.2/2.5): the shell owns exactly one
// server, only the managed home route owns it, the alias surface stays, and a
// taken port is a startup failure instead of a second runtime.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfigDir, resolveDevenvHome } from "../src/backend/home";
import { ownsEnvironmentBackend } from "../src/backend/ownership";
import { startWorkflowServer } from "../src/server/lifecycle";

test("only the managed home route owns a server; attach and dash never do", () => {
	const base = { home: true, isTest: false, json: false };
	// Managed unified/home owns the stack it spawns.
	expect(ownsEnvironmentBackend({ ...base })).toBe(true);
	// Attaching to an explicit server owns nothing, so its exit cannot stop it.
	expect(ownsEnvironmentBackend({ ...base, attachUrl: "http://x:1" })).toBe(
		false,
	);
	expect(ownsEnvironmentBackend({ ...base, explicitUrl: "http://x:1" })).toBe(
		false,
	);
	// Per-workflow dashboard, test profile and headless JSON reads own nothing.
	expect(ownsEnvironmentBackend({ ...base, home: false })).toBe(false);
	expect(ownsEnvironmentBackend({ ...base, isTest: true })).toBe(false);
	expect(ownsEnvironmentBackend({ ...base, json: true })).toBe(false);
});

test("the devenv alias maps onto unified modes, including its own name marker", async () => {
	const { devenvAliasArgv } = await import("../src/devenv-alias");
	expect(devenvAliasArgv(["devenv", "server", "--port", "4050"])).toEqual([
		"server",
		"--port",
		"4050",
	]);
	expect(devenvAliasArgv(["spawn", "--port", "4051"])).toEqual([
		"--devenv-port",
		"4051",
	]);
	expect(devenvAliasArgv(["-p", "4052"])).toEqual(["--devenv-port", "4052"]);
	expect(devenvAliasArgv([])).toEqual([]);
	expect(devenvAliasArgv(["attach", "http://127.0.0.1:4050"])).toEqual([
		"attach",
		"http://127.0.0.1:4050",
	]);
	// An unknown verb is reported by the unified dispatcher, not swallowed here.
	expect(devenvAliasArgv(["frobnicate"])).toEqual(["frobnicate"]);
});

test("the environment roots resolve from a config dir with no .env", () => {
	const configDir = process.env.DEVENV_CONFIG_DIR;
	const home = process.env.DEVENV_HOME;
	const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "home-resolution-"));
	try {
		delete process.env.DEVENV_HOME;
		process.env.DEVENV_CONFIG_DIR = isolated;
		// No .env in the isolated config dir, so the home falls back to ~/devenv
		// instead of whatever the developer's own config chooses.
		expect(resolveConfigDir()).toBe(isolated);
		expect(resolveDevenvHome()).toBe(path.join(os.homedir(), "devenv"));
		process.env.DEVENV_HOME = "/tmp/devenv-home-test";
		expect(resolveDevenvHome()).toBe("/tmp/devenv-home-test");
	} finally {
		if (configDir === undefined) delete process.env.DEVENV_CONFIG_DIR;
		else process.env.DEVENV_CONFIG_DIR = configDir;
		if (home === undefined) delete process.env.DEVENV_HOME;
		else process.env.DEVENV_HOME = home;
	}
});

test("a taken port fails startup instead of spawning a second runtime", async () => {
	const blocking = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("occupied"),
	});
	try {
		await expect(
			startWorkflowServer({ port: blocking.port ?? 0, ownTelemetry: false }),
		).rejects.toBeDefined();
	} finally {
		blocking.stop(true);
	}
});

test("the owned server serves the legacy environment surface and health", async () => {
	const server = await startWorkflowServer({ port: 0, ownTelemetry: false });
	try {
		const health = await fetch(`${server.url}/api/health`, {
			headers: { authorization: `Bearer ${server.token}` },
		});
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({
			status: "ok",
			instance: server.instance,
		});

		// Health is the one public route (liveness probe, no secret); every other
		// surface requires the instance capability.
		const unauthenticated = await fetch(`${server.url}/api/health`);
		expect(unauthenticated.status).toBe(200);
		const unauthenticatedApp = await fetch(`${server.url}/api/apps`);
		expect(unauthenticatedApp.status).toBe(401);
	} finally {
		await server.stop();
	}
});
