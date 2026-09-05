import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	cleanupAskpassShim,
	credentialFailureMessage,
	installAskpassShim,
	maskingFor,
	runGitWithCredentials,
} from "../src/workflow/credentials.ts";

function fakeCredentialScript(dir: string): string {
	const file = path.join(dir, "fake-credential-git");
	fs.writeFileSync(
		file,
		[
			"#!/bin/sh",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional shell syntax
			"prompt=\"${AGENTIC_CODING_FAKE_PROMPT:-Enter passphrase for key '/home/test/.ssh/id_ed25519':}\"",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional shell syntax
			'accept="${AGENTIC_CODING_FAKE_ACCEPT:-correct-passphrase}"',
			'answer="$("$SSH_ASKPASS" "$prompt")"',
			'printf "answer=%s\\n" "$answer"',
			'if [ "$answer" = "$accept" ]; then exit 0; fi',
			'echo "Permission denied (publickey)." >&2',
			"exit 1",
			"",
		].join("\n"),
		{ mode: 0o700 },
	);
	return file;
}

function fakeNoCredentialScript(dir: string): string {
	const file = path.join(dir, "fake-no-credential-git");
	fs.writeFileSync(
		file,
		["#!/bin/sh", 'echo "no-credential-required"', "exit 0", ""].join("\n"),
		{ mode: 0o700 },
	);
	return file;
}

test("installAskpassShim creates a 0700 dir, 0700 shim and 0600 FIFOs, and cleans up", () => {
	const base = path.join(
		os.tmpdir(),
		`agentic-coding-askpass-test-${process.pid}`,
	);
	const shim = installAskpassShim(base);
	try {
		expect(fs.statSync(shim.dir).isDirectory()).toBe(true);
		expect(fs.statSync(shim.dir).mode & 0o777).toBe(0o700);
		expect(fs.statSync(shim.shimPath).mode & 0o777).toBe(0o700);
		expect(fs.statSync(shim.requestFifo).isFIFO()).toBe(true);
		expect(fs.statSync(shim.responseFifo).isFIFO()).toBe(true);
		expect(fs.statSync(shim.requestFifo).mode & 0o777).toBe(0o600);
	} finally {
		cleanupAskpassShim(shim);
	}
	expect(fs.existsSync(shim.dir)).toBe(false);
});

test("shim contract: relays the verbatim prompt and echoes the entered answer", async () => {
	const shim = installAskpassShim();
	const proc = Bun.spawn(
		[shim.shimPath, "Enter passphrase for key '/home/test/.ssh/id_ed25519':"],
		{
			env: { ...process.env, AGENTIC_CODING_ASKPASS_DIR: shim.dir },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		const reader = await fs.promises.open(shim.requestFifo, "r");
		const promptText = (await reader.readFile({ encoding: "utf8" })).toString();
		await reader.close();
		expect(promptText.trim()).toBe(
			"Enter passphrase for key '/home/test/.ssh/id_ed25519':",
		);
		const writer = await fs.promises.open(shim.responseFifo, "w");
		await writer.writeFile("s3cret", "utf8");
		await writer.close();
		const stdout = await new Response(proc.stdout).text();
		expect(stdout).toBe("s3cret");
	} finally {
		cleanupAskpassShim(shim);
	}
});

test("shim times out instead of hanging when no answer is ever provided", async () => {
	const shim = installAskpassShim();
	const started = Date.now();
	const proc = Bun.spawn(
		[shim.shimPath, "Enter passphrase for key '/home/test/.ssh/id_ed25519':"],
		{
			env: {
				...process.env,
				AGENTIC_CODING_ASKPASS_DIR: shim.dir,
				AGENTIC_CODING_ASKPASS_TIMEOUT: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		const reader = await fs.promises.open(shim.requestFifo, "r");
		await reader.readFile({ encoding: "utf8" });
		await reader.close();
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		expect(stdout).toBe("");
		expect(exitCode).toBe(0);
		expect(Date.now() - started).toBeLessThan(5000);
	} finally {
		cleanupAskpassShim(shim);
	}
});

test("shim still times out instead of hanging when neither timeout(1) nor gtimeout(1) is on PATH", async () => {
	// Regression test for a hang the test-verifier found: without `timeout`/
	// `gtimeout` on PATH, the shim's fallback used to run a plain, unbounded
	// `cat response.fifo`, blocking forever. Force that fallback deterministically
	// (independent of whatever happens to be installed on the host running this
	// suite) with a minimal PATH containing only the plain utilities the shim
	// needs, and none named `timeout`/`gtimeout`.
	const binDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "credentials-minimal-bin-"),
	);
	const shim = installAskpassShim();
	try {
		for (const utility of ["cat", "sleep", "rm"]) {
			const resolved = Bun.which(utility);
			if (!resolved)
				throw new Error(
					`test environment is missing required utility: ${utility}`,
				);
			fs.symlinkSync(resolved, path.join(binDir, utility));
		}
		const started = Date.now();
		const proc = Bun.spawn(
			[shim.shimPath, "Enter passphrase for key '/home/test/.ssh/id_ed25519':"],
			{
				env: {
					AGENTIC_CODING_ASKPASS_DIR: shim.dir,
					AGENTIC_CODING_ASKPASS_TIMEOUT: "1",
					PATH: binDir,
					HOME: os.homedir(),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const reader = await fs.promises.open(shim.requestFifo, "r");
		await reader.readFile({ encoding: "utf8" });
		await reader.close();
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		expect(stdout).toBe("");
		expect(exitCode).toBe(0);
		expect(Date.now() - started).toBeLessThan(5000);
	} finally {
		cleanupAskpassShim(shim);
		fs.rmSync(binDir, { recursive: true, force: true });
	}
});

test("runner detects the prompt, feeds the answer, and the command completes", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credentials-runner-"));
	try {
		const prompts: string[] = [];
		const stdout = await runGitWithCredentials(
			dir,
			["push", "--set-upstream", "origin", "feature/x"],
			{
				executable: fakeCredentialScript(dir),
				env: {
					AGENTIC_CODING_FAKE_PROMPT:
						"Enter passphrase for key '/home/test/.ssh/id_ed25519':",
				},
				prompt: async (prompt) => {
					prompts.push(prompt);
					return "correct-passphrase";
				},
			},
		);
		expect(prompts).toEqual([
			"Enter passphrase for key '/home/test/.ssh/id_ed25519':",
		]);
		expect(stdout).toContain("answer=correct-passphrase");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runner never invokes the prompt when no credential is requested", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credentials-runner-"));
	try {
		let calls = 0;
		const stdout = await runGitWithCredentials(dir, [], {
			executable: fakeNoCredentialScript(dir),
			prompt: async () => {
				calls++;
				return "x";
			},
		});
		expect(calls).toBe(0);
		expect(stdout).toBe("no-credential-required");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runner cancels with an empty answer: command fails with its original error", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credentials-runner-"));
	try {
		await expect(
			runGitWithCredentials(dir, [], {
				executable: fakeCredentialScript(dir),
				prompt: async () => "",
			}),
		).rejects.toThrow(/Permission denied \(publickey\)/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runner aborts a credential wait when ownership is already lost", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credentials-runner-"));
	try {
		const controller = new AbortController();
		controller.abort();
		await expect(
			runGitWithCredentials(dir, [], {
				executable: fakeCredentialScript(dir),
				signal: controller.signal,
			}),
		).rejects.toThrow();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runner aborts a credential wait that is already in progress", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credentials-runner-"));
	try {
		const controller = new AbortController();
		let prompted = false;
		const operation = runGitWithCredentials(dir, [], {
			executable: fakeCredentialScript(dir),
			prompt: async () => {
				prompted = true;
				await Bun.sleep(25);
				controller.abort();
				return "";
			},
			signal: controller.signal,
		});
		await expect(operation).rejects.toThrow();
		expect(prompted).toBe(true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runner fails fast with an actionable diagnostic when no prompt provider is attached", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credentials-runner-"));
	try {
		const promise = runGitWithCredentials(dir, [], {
			executable: fakeCredentialScript(dir),
			env: {
				AGENTIC_CODING_FAKE_PROMPT:
					"Enter passphrase for key '/home/test/.ssh/id_ed25519':",
			},
		});
		await expect(promise).rejects.toThrow(/no interactive prompt is available/);
		await expect(promise).rejects.toThrow(
			"Enter passphrase for key '/home/test/.ssh/id_ed25519'",
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runner does not hang when the shim times out waiting for an answer", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credentials-runner-"));
	try {
		const started = Date.now();
		await expect(
			runGitWithCredentials(dir, [], {
				executable: fakeCredentialScript(dir),
				env: { AGENTIC_CODING_ASKPASS_TIMEOUT: "1" },
				prompt: async () => new Promise<string>(() => {}),
			}),
		).rejects.toThrow(/Permission denied \(publickey\)/);
		expect(Date.now() - started).toBeLessThan(5000);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("masking heuristic masks passphrases and passwords but not usernames", () => {
	expect(
		maskingFor("Enter passphrase for key '/home/me/.ssh/id_ed25519':"),
	).toBe(true);
	expect(maskingFor("Password:")).toBe(true);
	expect(maskingFor("Username for 'https://github.com':")).toBe(false);
	expect(maskingFor("Enter PIN for 'yubikey':")).toBe(true);
});

test("credentialFailureMessage names the requested credential", () => {
	const message = credentialFailureMessage(
		"Enter passphrase for key '/home/me/.ssh/id_ed25519':",
	);
	expect(message).toContain(
		"Enter passphrase for key '/home/me/.ssh/id_ed25519':",
	);
	expect(message).toContain("ssh-add");
	expect(message).toContain("dashboard");
});
