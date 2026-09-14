// Cross-runtime parity for the ported Git/provider foundation
// (`port-git-providers-and-ai-to-bun`, tasks 1.2, 2.1-2.4).
//
// Every case replays a Go-created recipe/fixture and asserts the Bun
// implementation reproduces the recorded request and result. Regenerate the
// fixtures with the Go generator documented in `docs/integration-port.md`.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type GitApp,
	GitRepository,
} from "../src/server/integrations/git-repository.ts";
import { GitHubClient } from "../src/server/integrations/github-client.ts";
import { GitLabClient } from "../src/server/integrations/gitlab-client.ts";
import { ProviderStore } from "../src/server/integrations/provider-store.ts";

const FIXTURES = path.join(import.meta.dir, "fixtures", "integrations");

// ---------------------------------------------------------------------------
// Git capability
// ---------------------------------------------------------------------------

interface GitFixtureSetup {
	cwd: string;
	args?: string[];
	write?: Record<string, string>;
}

interface GitFixtureOperation {
	op: string;
	branch?: string;
	repoURL?: string;
	error?: boolean;
	value?: string;
	message?: string;
	libraryMessage?: boolean;
}

interface GitFixture {
	case: string;
	app: {
		ident: string;
		repositoryPath: string;
		localDirectoryPath: string;
		branch: string;
		mainWorktreeBranch: string;
	};
	setup: GitFixtureSetup[];
	operations: GitFixtureOperation[];
}

/** Resolve a recipe key exactly like the Go generator does. */
function recipeKey(root: string, key: string): string {
	if (key.startsWith("linked:")) {
		const branch = key.slice("linked:".length);
		return path.join(root, "demo", `demo.${branch.replaceAll("/", "-")}`);
	}
	switch (key) {
		case "root":
			return root;
		case "remote":
			return path.join(root, "remote.git");
		case "other":
			return path.join(root, "other");
		default:
			return path.join(root, "demo", "demo");
	}
}

function expand(root: string, value: string): string {
	let out = value;
	for (const key of ["root", "remote", "primary", "other"])
		out = out.replaceAll(`{{${key}}}`, recipeKey(root, key));
	return out;
}

function runGit(cwd: string, args: readonly string[]): void {
	fs.mkdirSync(cwd, { recursive: true });
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.com",
			GIT_COMMITTER_NAME: "fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.com",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
	});
	if (result.exitCode !== 0)
		throw new Error(
			`git ${args.join(" ")} in ${cwd} failed: ${result.stderr.toString()}`,
		);
}

function materialize(root: string, setup: readonly GitFixtureSetup[]): void {
	for (const step of setup) {
		const cwd = recipeKey(root, step.cwd);
		fs.mkdirSync(cwd, { recursive: true });
		for (const [name, content] of Object.entries(step.write ?? {})) {
			const target = path.join(cwd, name);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content);
		}
		if (step.args && step.args.length > 0)
			runGit(
				cwd,
				step.args.map((arg) => expand(root, arg)),
			);
	}
}

function normalizePath(root: string, target: string): string {
	if (target === "") return "";
	let resolved = target;
	try {
		resolved = fs.realpathSync(target);
	} catch {
		resolved = target;
	}
	const rel = path.relative(root, resolved);
	return rel.startsWith("..") ? resolved : rel.split(path.sep).join("/");
}

function runOperations(
	root: string,
	git: GitRepository,
	app: GitApp,
	operations: readonly GitFixtureOperation[],
): GitFixtureOperation[] {
	const recorded: GitFixtureOperation[] = [];
	for (const op of operations) {
		const result: GitFixtureOperation = { ...op };
		const capture = (fn: () => string) => {
			try {
				result.value = fn();
				result.error = false;
				result.message = "";
			} catch (error) {
				result.error = true;
				result.message = (
					error instanceof Error ? error.message : String(error)
				).split("\n")[0];
			}
		};
		switch (op.op) {
			case "currentBranch":
				capture(() => git.getCurrentBranch(app));
				break;
			case "status":
				capture(() => git.getStatus(app));
				break;
			case "localBranches":
				capture(() => git.getLocalBranches(app).join(","));
				break;
			case "remoteBranches":
				capture(() =>
					git.getBranches(expand(root, op.repoURL ?? "")).join(","),
				);
				break;
			case "listWorktrees":
				capture(() =>
					git
						.listWorktrees(app)
						.map(
							(wt) =>
								`${wt.branch}|${normalizePath(root, wt.path)}|${wt.isMain}|${wt.active}`,
						)
						.join(";"),
				);
				break;
			case "addWorktree":
				capture(() =>
					normalizePath(root, git.addWorktree(app, op.branch ?? "")),
				);
				break;
			case "removeWorktree":
				capture(() => {
					git.removeWorktree(app, op.branch ?? "");
					return "";
				});
				break;
			case "checkout":
				capture(() => {
					git.checkout(app, op.branch ?? "");
					return "";
				});
				break;
			case "fetch":
				capture(() => {
					git.fetch(app);
					return "";
				});
				break;
			case "pull":
				capture(() => {
					git.pull(app);
					return "";
				});
				break;
			case "headFile":
				capture(() =>
					fs
						.readFileSync(
							path.join(recipeKey(root, op.branch ?? ""), ".git", "HEAD"),
							"utf8",
						)
						.trim(),
				);
				break;
			default:
				throw new Error(`unknown fixture operation ${op.op}`);
		}
		recorded.push(result);
	}
	return recorded;
}

function gitFixtureCases(): string[] {
	return fs
		.readdirSync(path.join(FIXTURES, "git"))
		.filter((name) => name !== "expected.json")
		.sort();
}

describe("git capability parity (cross-runtime fixtures)", () => {
	for (const fixtureCase of gitFixtureCases()) {
		test(`reproduces the Go recipe: ${fixtureCase}`, () => {
			const dir = path.join(FIXTURES, "git", fixtureCase);
			const fixture = JSON.parse(
				fs.readFileSync(path.join(dir, "recipe.json"), "utf8"),
			) as GitFixture;
			const expected = JSON.parse(
				fs.readFileSync(path.join(dir, "expected.json"), "utf8"),
			) as GitFixture;
			const root = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), "git-fixture-")),
			);
			materialize(root, fixture.setup);
			const app: GitApp = {
				ident: fixture.app.ident,
				repositoryPath: expand(root, fixture.app.repositoryPath),
				localDirectoryPath: recipeKey(root, fixture.app.localDirectoryPath),
				branch: fixture.app.branch,
				mainWorktreeBranch: fixture.app.mainWorktreeBranch,
			};
			const recorded = runOperations(
				root,
				new GitRepository(),
				app,
				fixture.operations,
			);
			expect(recorded.length).toBe(expected.operations.length);
			for (let i = 0; i < recorded.length; i++) {
				const want = expected.operations[i];
				const got = recorded[i];
				expect(`${want.op}: error=${got.error}`).toBe(
					`${want.op}: error=${want.error ?? false}`,
				);
				if (!want.error) {
					expect(got.value ?? "").toBe(want.value ?? "");
					continue;
				}
				if (want.libraryMessage) {
					// go-git's wording is replaced with native git's; the contract is a
					// bounded single-line diagnostic, not the library's text.
					expect((got.message ?? "").length).toBeGreaterThan(0);
					expect((got.message ?? "").includes("\n")).toBe(false);
					continue;
				}
				expect(got.message).toBe(
					(want.message ?? "").replaceAll("{{root}}", root),
				);
			}
			fs.rmSync(root, { recursive: true, force: true });
		});
	}
});

// ---------------------------------------------------------------------------
// Provider store
// ---------------------------------------------------------------------------

interface ProviderOperation {
	op: string;
	name?: string;
	path?: string;
	provider?: { name: string; type: string; username: string; token?: string };
	error?: boolean;
	message?: string;
	list?: unknown;
	invalid?: unknown;
	value?: string;
}

interface ProviderFixture {
	case: string;
	input: Record<string, string>;
	operations: ProviderOperation[];
}

function runProviderOperations(
	store: ProviderStore,
	configDir: string,
	operations: readonly ProviderOperation[],
): ProviderOperation[] {
	const recorded: ProviderOperation[] = [];
	for (const op of operations) {
		const result: ProviderOperation = { ...op, error: false };
		const capture = (fn: () => void) => {
			try {
				fn();
				result.error = false;
				result.message = "";
			} catch (error) {
				result.error = true;
				result.message = (
					error instanceof Error ? error.message : String(error)
				).split("\n")[0];
			}
		};
		switch (op.op) {
			case "load":
				capture(() => store.load());
				break;
			case "list":
				result.list = store.list().map((provider) => ({
					name: provider.name,
					type: provider.type,
					username: provider.username,
					...(provider.token !== "" ? { token: provider.token } : {}),
					...(provider.missingVars.length > 0
						? { missingVars: provider.missingVars }
						: {}),
				}));
				break;
			case "invalid":
				result.invalid = store.invalidProviders();
				break;
			case "get":
				capture(() => {
					const provider = store.get(op.name ?? "");
					if (!provider) throw new Error("not found");
					result.list = [
						{
							name: provider.name,
							type: provider.type,
							username: provider.username,
							...(provider.token !== "" ? { token: provider.token } : {}),
						},
					];
				});
				break;
			case "credentialsFor":
				capture(() => {
					const credentials = store.credentialsFor(op.name ?? "");
					result.value = `${credentials.username}\x1f${credentials.token}`;
				});
				break;
			case "save":
				capture(() =>
					store.save({
						name: op.provider?.name ?? "",
						type: op.provider?.type ?? "",
						username: op.provider?.username ?? "",
						token: op.provider?.token ?? "",
						missingVars: [],
					}),
				);
				break;
			case "delete":
				capture(() => store.delete(op.name ?? ""));
				break;
			case "readFile":
				capture(() => {
					result.value = fs.readFileSync(
						path.join(configDir, op.path ?? ""),
						"utf8",
					);
				});
				break;
			default:
				throw new Error(`unknown fixture operation ${op.op}`);
		}
		recorded.push(result);
	}
	return recorded;
}

/** Compare only the fields a provider fixture records, so an absent optional
 * field in the Go encoding is not read as a difference. */
function projectOperation(
	operation: ProviderOperation,
): Record<string, unknown> {
	const projected: Record<string, unknown> = { op: operation.op };
	if (operation.name !== undefined) projected.name = operation.name;
	if (operation.path !== undefined) projected.path = operation.path;
	if (operation.provider !== undefined)
		projected.provider = {
			...operation.provider,
			token: operation.provider.token ?? "",
		};
	if (operation.list !== undefined) projected.list = operation.list;
	if (operation.invalid !== undefined) projected.invalid = operation.invalid;
	if (operation.value !== undefined) projected.value = operation.value;
	return projected;
}

describe("provider store parity (cross-runtime fixtures)", () => {
	for (const fixtureCase of fs
		.readdirSync(path.join(FIXTURES, "provider"))
		.sort()) {
		test(`reproduces the Go recipe: ${fixtureCase}`, () => {
			const dir = path.join(FIXTURES, "provider", fixtureCase);
			const fixture = JSON.parse(
				fs.readFileSync(path.join(dir, "recipe.json"), "utf8"),
			) as ProviderFixture;
			const expected = JSON.parse(
				fs.readFileSync(path.join(dir, "expected.json"), "utf8"),
			) as ProviderFixture;
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-fixture-"));
			const configDir = path.join(root, "config");
			for (const [name, content] of Object.entries(fixture.input)) {
				const target = path.join(configDir, name);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, content, { mode: 0o600 });
			}
			const store = new ProviderStore(
				path.join(configDir, "providers"),
				path.join(configDir, ".env"),
			);
			const recorded = runProviderOperations(
				store,
				configDir,
				fixture.operations,
			);
			for (let i = 0; i < recorded.length; i++) {
				const want = expected.operations[i];
				const got = recorded[i];
				expect(`${want.op}: error=${got.error}`).toBe(
					`${want.op}: error=${want.error ?? false}`,
				);
				if (want.error) expect(got.message).toBe(want.message);
				else expect(projectOperation(got)).toEqual(projectOperation(want));
			}
			fs.rmSync(root, { recursive: true, force: true });
		});
	}
});

// ---------------------------------------------------------------------------
// Provider HTTP clients (repository search)
// ---------------------------------------------------------------------------

interface HttpFixture {
	case: string;
	response: { status: number; body: string };
	call: {
		op: string;
		baseUrl?: string;
		query: string;
		limit: number;
		error?: boolean;
		message?: string;
		value?: string;
	};
	request: {
		method: string;
		url: string;
		headers: Record<string, string>;
	};
}

/** A fetch that serves one canned response and records the request. */
function fixtureFetch(response: { status: number; body: string }): {
	fetchFn: typeof fetch;
	recorded: () => {
		method: string;
		url: string;
		headers: Record<string, string>;
	};
} {
	let recorded = { method: "", url: "", headers: {} as Record<string, string> };
	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const headers = new Headers(init?.headers);
		recorded = {
			method: init?.method ?? "GET",
			url,
			headers: {
				accept: headers.get("accept") ?? "",
				authorization: headers.get("authorization") ?? "",
				"x-github-api-version": headers.get("x-github-api-version") ?? "",
				"user-agent": headers.get("user-agent") ?? "",
				"private-token": headers.get("private-token") ?? "",
				"content-type": headers.get("content-type") ?? "",
			},
		};
		return new Response(response.body, {
			status: response.status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return { fetchFn, recorded: () => recorded };
}

/** Go and Bun report JSON syntax failures with their own wording, so a parse
 * error is compared on the bounded prefix; a provider-status diagnostic is
 * runtime-independent and compared exactly. */
function expectSameDiagnostic(want: string, got: string): void {
	if (want.includes("API error") || want.includes("API request failed"))
		expect(got).toBe(want);
	else expect(got.startsWith(want.split(": ")[0] ?? want)).toBe(true);
}

describe("provider search parity (cross-runtime fixtures)", () => {
	for (const provider of ["github", "gitlab"]) {
		// Only the search cases at the top level: the issues/changerequest
		// subdirectories have their own replay harness.
		for (const fixtureCase of fs
			.readdirSync(path.join(FIXTURES, provider))
			.filter((name) =>
				fs.existsSync(path.join(FIXTURES, provider, name, "fixture.json")),
			)
			.sort()) {
			test(`${provider}: ${fixtureCase}`, async () => {
				const fixture = JSON.parse(
					fs.readFileSync(
						path.join(FIXTURES, provider, fixtureCase, "fixture.json"),
						"utf8",
					),
				) as HttpFixture;
				const { fetchFn, recorded } = fixtureFetch(fixture.response);
				const client =
					provider === "github"
						? new GitHubClient({
								token: "fixture-token",
								username: "octo",
								fetch: fetchFn,
							})
						: new GitLabClient({
								baseUrl: fixture.call.baseUrl ?? "",
								token: "fixture-token",
								username: "octo",
								fetch: fetchFn,
							});
				let value: string | undefined;
				let failure: string | undefined;
				try {
					const results =
						provider === "github"
							? await new GitHubClient({
									token: "fixture-token",
									username: "octo",
									fetch: fetchFn,
								}).search(fixture.call.query, fixture.call.limit ?? 0)
							: await new GitLabClient({
									baseUrl: fixture.call.baseUrl ?? "",
									token: "fixture-token",
									username: "octo",
									fetch: fetchFn,
								}).searchProjects(fixture.call.query, fixture.call.limit ?? 0);
					value = JSON.stringify(results);
				} catch (error) {
					failure = error instanceof Error ? error.message : String(error);
				}
				expect(client).toBeDefined();
				const request = recorded();
				expect(request.method).toBe(fixture.request.method);
				expect(request.url).toBe(fixture.request.url);
				for (const [name, headerValue] of Object.entries(
					fixture.request.headers,
				))
					expect(`${name}: ${request.headers[name]}`).toBe(
						`${name}: ${headerValue}`,
					);
				if (fixture.call.error) {
					expect(failure).toBeDefined();
					expectSameDiagnostic(fixture.call.message ?? "", failure ?? "");
				} else {
					expect(failure).toBeUndefined();
					expect(value).toBe(fixture.call.value);
				}
			});
		}
	}
});
