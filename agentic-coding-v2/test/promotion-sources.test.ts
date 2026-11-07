import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { digest } from "../src/config.ts";
import { serve } from "../src/server.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
// Staged auxiliary sources publish into the live configuration directory under
// the same lock, digest approval and readback verification as the document.
// Repository-bound sources are never published. Proofs run against HTTP.
const setup = async () => {
	const { app, config } = await fixture(true, (config) => {
		fs.chmodSync(config.stateDir, 0o700);
		fs.mkdirSync(config.configDir, { mode: 0o700 });
	});
	const host = serve(app);
	const headers = {
		Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
		"Content-Type": "application/json",
	};
	const post = (route: string, body: unknown) =>
		fetch(new URL(route, host.url), {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
	const composeText = "services:\n  web:\n    image: fixture:latest\n",
		auxText = "KEY=value\n",
		auxFile = "extra/env.conf",
		document = JSON.stringify({
			version: 1,
			projects: [
				{
					id: "promoted",
					kind: "app",
					repository: config.repositories[0] ?? "",
					targets: [
						{
							id: "v1",
							action: "run",
							runtime: "compose",
							compose: {
								file: "compose.yaml",
								provider: "docker",
								socket: path.join(config.stateDir, "absent.sock"),
							},
						},
					],
				},
			],
		});
	const create = (requestId: string) =>
		post("/api/environments/drafts", { requestId, content: document }).then(
			(response) => response.json(),
		);
	const stage = (
		requestId: string,
		id: string,
		revision: number,
		extra: Record<string, unknown>,
	) =>
		post("/api/environments/drafts/source", {
			requestId,
			id,
			revision,
			app: "promoted",
			target: "v1",
			...extra,
		}).then((response) => response.json());
	const assemble = (
		requestId: string,
		id: string,
		revision: number,
		hash: string,
	) =>
		post("/api/environments/drafts/preflight", {
			requestId,
			id,
			revision,
			digest: hash,
			materializeStagedTree: true,
		});
	const promote = (body: Record<string, unknown>) =>
		post("/api/environments/drafts/promote", body);
	const sourcesApprove = digest(
		JSON.stringify([{ file: auxFile, digest: digest(auxText) }]),
	);
	const prepare = async (tag: string) => {
		const created = await create(`${tag}-create`);
		await stage(`${tag}-compose`, created.id, 1, { content: composeText });
		await stage(`${tag}-aux`, created.id, 2, {
			content: auxText,
			auxiliary: true,
			file: auxFile,
		});
		const tree = await (
			await assemble(`${tag}-tree`, created.id, 3, created.digest)
		).json();
		expect(tree.accepted).toBe(true);
		return created;
	};
	return {
		app,
		config,
		host,
		promote,
		prepare,
		sourcesApprove,
		auxText,
		auxFile,
		document,
	};
};
test("auxiliary sources require their own explicit approval", async () => {
	const { app, host, promote, prepare } = await setup();
	try {
		const created = await prepare("approval");
		const refused = await promote({
			requestId: "approval-missing",
			id: created.id,
			revision: 3,
			digest: created.digest,
			approve: created.digest,
		});
		expect(refused.status).toBe(400);
		expect(await refused.text()).toContain("auxiliary");
		const wrong = await promote({
			requestId: "approval-wrong",
			id: created.id,
			revision: 3,
			digest: created.digest,
			approve: created.digest,
			sourcesApprove: "0".repeat(64),
		});
		expect(wrong.status).toBe(400);
	} finally {
		host.stop();
		await app.close();
	}
});
test("exact auxiliary approval publishes beside the live document", async () => {
	const {
		app,
		config,
		host,
		promote,
		prepare,
		sourcesApprove,
		auxText,
		auxFile,
		document,
	} = await setup();
	try {
		const created = await prepare("publish");
		const promoted = await (
			await promote({
				requestId: "publish-first",
				id: created.id,
				revision: 3,
				digest: created.digest,
				approve: created.digest,
				sourcesApprove,
			})
		).json();
		expect(promoted).toMatchObject({
			outcome: "written",
			sourceFilesWritten: true,
			repositoriesChanged: false,
			reloaded: false,
			runtimeChecked: false,
			auxiliaryFiles: [
				{
					file: auxFile,
					digest: digest(auxText),
					bytes: Buffer.byteLength(auxText),
					previous: null,
				},
			],
		});
		const destination = path.join(config.configDir, auxFile);
		expect(fs.readFileSync(destination, "utf8")).toBe(auxText);
		expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
		expect(
			fs.readFileSync(path.join(config.configDir, "environments.json"), "utf8"),
		).toBe(document);
		// Nothing is published into the repository checkout.
		expect(
			fs.existsSync(path.join(config.repositories[0] ?? "", auxFile)),
		).toBe(false);
	} finally {
		host.stop();
		await app.close();
	}
});
test("replay is exact and a converged promotion is unchanged", async () => {
	const { app, host, promote, prepare, sourcesApprove } = await setup();
	try {
		const created = await prepare("replay");
		const body = {
			requestId: "replay-first",
			id: created.id,
			revision: 3,
			digest: created.digest,
			approve: created.digest,
			sourcesApprove,
		};
		const first = await (await promote(body)).json();
		expect(first.outcome).toBe("written");
		expect(await (await promote(body)).json()).toEqual(first);
		const second = await (
			await promote({ ...body, requestId: "replay-second" })
		).json();
		expect(second.outcome).toBe("unchanged");
		expect(second.auxiliaryFiles).toHaveLength(1);
	} finally {
		host.stop();
		await app.close();
	}
});
test("an auxiliary approval without auxiliary sources is refused", async () => {
	const { app, host, promote } = await setup();
	try {
		const created = await (
			await fetch(new URL("/api/environments/drafts", host.url), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${new URLSearchParams(new URL(host.url).hash.slice(1)).get("token")}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					requestId: "bare-create",
					content: JSON.stringify({ version: 1, projects: [] }),
				}),
			})
		).json();
		const refused = await promote({
			requestId: "bare-promote",
			id: created.id,
			revision: 1,
			digest: created.digest,
			approve: created.digest,
			sourcesApprove: "0".repeat(64),
		});
		expect(refused.status).toBe(400);
		expect(await refused.text()).toContain("no auxiliary sources");
	} finally {
		host.stop();
		await app.close();
	}
});
test("a planted symlink at the auxiliary destination blocks before any write", async () => {
	const { app, config, host, promote, prepare, sourcesApprove, auxFile } =
		await setup();
	try {
		const created = await prepare("planted");
		const destination = path.join(config.configDir, auxFile);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		const target = path.join(config.configDir, "planted-target.txt");
		fs.writeFileSync(target, "planted");
		fs.symlinkSync(target, destination);
		const refused = await promote({
			requestId: "planted-promote",
			id: created.id,
			revision: 3,
			digest: created.digest,
			approve: created.digest,
			sourcesApprove,
		});
		expect(refused.status).toBe(400);
		expect(await refused.text()).toContain("never adopted or converted");
		expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
		expect(
			fs.existsSync(path.join(config.configDir, "environments.json")),
		).toBe(false);
	} finally {
		host.stop();
		await app.close();
	}
});
test("a changed auxiliary file is replaced and verified", async () => {
	const {
		app,
		config,
		host,
		promote,
		prepare,
		sourcesApprove,
		auxText,
		auxFile,
	} = await setup();
	try {
		const created = await prepare("replace");
		const first = await (
			await promote({
				requestId: "replace-first",
				id: created.id,
				revision: 3,
				digest: created.digest,
				approve: created.digest,
				sourcesApprove,
			})
		).json();
		expect(first.outcome).toBe("written");
		// A changed live file needs a fresh draft: the recorded base predates
		// the first publication, exactly like the promoted document itself.
		const fresh = await prepare("replace-fresh");
		const destination = path.join(config.configDir, auxFile);
		fs.writeFileSync(destination, "stale\n");
		const second = await (
			await promote({
				requestId: "replace-second",
				id: fresh.id,
				revision: 3,
				digest: fresh.digest,
				approve: fresh.digest,
				sourcesApprove,
			})
		).json();
		expect(second.outcome).toBe("written");
		expect(second.auxiliaryFiles[0].previous).toBe(digest("stale\n"));
		expect(fs.readFileSync(destination, "utf8")).toBe(auxText);
	} finally {
		host.stop();
		await app.close();
	}
});
