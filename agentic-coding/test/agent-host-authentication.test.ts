import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { HostClient, watchStream } from "../src/agent-host/client.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import {
	createHostIdentity,
	hostIdentityPaths,
	readHostCertificate,
} from "../src/agent-host/host-identity.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import {
	encodeFrame,
	FrameReader,
	type HostRequest,
} from "../src/agent-host/protocol.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture() {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "host-auth-")),
	);
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const layout = hostLayout(root);
	fs.mkdirSync(layout.root, { recursive: true, mode: 0o700 });
	return { root, layout, paths: hostIdentityPaths(layout.socketPath) };
}
async function until(check: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition timed out");
		await Bun.sleep(5);
	}
}
async function listener(
	socketPath: string,
	handle: (request: HostRequest, socket: net.Socket) => void,
	identity = createHostIdentity(),
) {
	const sockets = new Set<net.Socket>();
	const server = tls.createServer(
		{ cert: identity.cert, key: identity.key, minVersion: "TLSv1.3" },
		(socket) => {
			const reader = new FrameReader();
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				for (const line of reader.push(chunk))
					handle(JSON.parse(line) as HostRequest, socket);
			});
		},
	);
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	cleanups.push(() => {
		for (const socket of sockets) socket.destroy();
		server.close();
	});
	return { server, identity, sockets };
}

test("TLS pins the connected host before controls/catalog/watch and revalidates every new connection", async () => {
	const f = fixture();
	const seen: HostRequest[] = [];
	const host = await listener(f.paths.socket, (request, socket) => {
		seen.push(request);
		if (request.type === "submit")
			socket.write(
				encodeFrame({
					type: "submit",
					runId: request.runId,
					submissionId: "s",
				}),
			);
		else if (request.type === "watch")
			socket.write(
				encodeFrame({
					type: "watchFrame",
					runId: request.runId,
					value: { entries: [] },
				}),
			);
		else if (request.type === "catalog")
			socket.write(
				encodeFrame({ type: "catalog", models: [], thinkingLevels: [] }),
			);
		else if (request.type === "compactRun")
			socket.write(
				encodeFrame({
					type: "compactRun",
					runId: request.runId,
					status: "nothing-to-compact",
				}),
			);
		else socket.write(encodeFrame({ type: "ok" }));
	});
	let checks = 0;
	let valid = true;
	const client = new HostClient(async () => {
		checks++;
		if (!valid) throw new Error("exact run is no longer authoritative");
		return { socket: f.paths.socket, fingerprint: host.identity.fingerprint };
	}, 1000);
	await client.submit("run", "private prompt", "request");
	await client.configureRun("run", { thinking: "high" });
	await client.abort("run");
	await client.compactRun("run", "private instructions");
	await client.catalog();
	let frames = 0;
	const stop = await client.watch("run", () => frames++);
	stop();
	expect(checks).toBe(6);
	expect(frames).toBe(1);
	expect(seen.map((r) => r.type)).toEqual([
		"submit",
		"configureRun",
		"abort",
		"compactRun",
		"catalog",
		"watch",
	]);
	valid = false;
	for (const operation of [
		() => client.submit("run", "do not send", "later"),
		() => client.configureRun("run", { model: "other" }),
		() => client.abort("run"),
		() => client.compactRun("run"),
		() => client.watch("run", () => frames++),
	])
		await expect(operation()).rejects.toThrow(/authoritative/);
	expect(seen).toHaveLength(6);
});

test("a path swapped after verification cannot obtain command text or impersonate a watch", async () => {
	for (const operation of ["submit", "watch"]) {
		const f = fixture();
		const foreign = fixture();
		const legitimate = await listener(f.paths.socket, () => {
			throw new Error("swapped connection reached original host");
		});
		fs.writeFileSync(f.paths.certificate, legitimate.identity.cert, {
			mode: 0o600,
		});
		let received = 0;
		let frames = 0;
		await listener(foreign.paths.socket, (_request, socket) => {
			received++;
			socket.write(
				encodeFrame({
					type: "watchFrame",
					runId: "run",
					value: { forged: true },
				}),
			);
		});
		const client = new HostClient(async () => {
			const fingerprint = readHostCertificate(f.layout.socketPath);
			// Deterministic verification-to-connect race: authority/identity were
			// read from the real directory, then the very same path is redirected.
			fs.renameSync(f.layout.root, `${f.layout.root}-original`);
			fs.symlinkSync(foreign.layout.root, f.layout.root);
			return { socket: f.paths.socket, fingerprint };
		}, 1000);
		await expect(
			operation === "submit"
				? client.submit("run", "secret text", "request")
				: client.watch("run", () => frames++),
		).rejects.toThrow(/authentication/);
		expect(received).toBe(0);
		expect(frames).toBe(0);
	}
});

test("resilient watch reconnects acquire a fresh pin and reject a substituted listener", async () => {
	const f = fixture();
	const expected = createHostIdentity();
	let checks = 0;
	let frames = 0;
	let impostorRequests = 0;
	const first = await listener(
		f.paths.socket,
		(request, socket) => {
			if (request.type === "watch")
				socket.write(
					encodeFrame({ type: "watchFrame", runId: request.runId, value: {} }),
				);
		},
		expected,
	);
	const client = new HostClient(async () => {
		checks++;
		return { socket: f.paths.socket, fingerprint: expected.fingerprint };
	}, 1000);
	let resume: (() => void) | undefined;
	const stop = watchStream(client, "run", {
		onFrame: () => frames++,
		sleep: () =>
			new Promise((resolve) => {
				resume = resolve;
			}),
	});
	try {
		await until(() => frames === 1);
		for (const socket of first.sockets) socket.destroy();
		await until(() => resume !== undefined);
		await new Promise<void>((resolve) => first.server.close(() => resolve()));
		fs.rmSync(f.paths.socket, { force: true });
		await listener(f.paths.socket, () => impostorRequests++);
		const again = resume;
		resume = undefined;
		again?.();
		await until(() => checks >= 2 && resume !== undefined);
		expect(frames).toBe(1);
		expect(impostorRequests).toBe(0);
	} finally {
		stop();
		resume?.();
	}
});

test("certificate reads reject symlink components, non-private files, and symlink swaps during traversal", () => {
	const f = fixture();
	const identity = createHostIdentity();
	fs.writeFileSync(f.paths.certificate, identity.cert, { mode: 0o600 });
	expect(readHostCertificate(f.layout.socketPath)).toBe(identity.fingerprint);
	fs.chmodSync(f.paths.certificate, 0o644);
	expect(() => readHostCertificate(f.layout.socketPath)).toThrow(/private/);
	fs.chmodSync(f.paths.certificate, 0o600);
	const foreign = fixture();
	fs.writeFileSync(foreign.paths.certificate, createHostIdentity().cert, {
		mode: 0o600,
	});
	if (process.platform !== "linux") {
		// Darwin exercises native openat rather than the Linux descriptor alias;
		// the injected fs.openSync traversal race below is Linux-specific.
		fs.renameSync(f.layout.root, `${f.layout.root}-original`);
		fs.symlinkSync(foreign.layout.root, f.layout.root);
		expect(() => readHostCertificate(f.layout.socketPath)).toThrow();
		return;
	}
	const open = fs.openSync;
	let swapped = false;
	const opening = spyOn(fs, "openSync").mockImplementation(
		(...args: Parameters<typeof fs.openSync>) => {
			const fd = open(...args);
			if (
				!swapped &&
				typeof args[0] === "string" &&
				args[0].endsWith("/agent-host")
			) {
				swapped = true;
				fs.renameSync(f.layout.root, `${f.layout.root}-original`);
				fs.symlinkSync(foreign.layout.root, f.layout.root);
			}
			return fd;
		},
	);
	try {
		// The held directory descriptor still anchors the original certificate,
		// even though a normal path read now follows the foreign directory.
		expect(readHostCertificate(f.layout.socketPath)).toBe(identity.fingerprint);
		expect(swapped).toBe(true);
	} finally {
		opening.mockRestore();
	}
	expect(() => readHostCertificate(f.layout.socketPath)).toThrow();
});

test("a real durable host publishes a private instance certificate and serves authenticated recovery watches", async () => {
	const f = fixture();
	const host = await DurableHost.open({
		layout: f.layout,
		settings: {},
		globalAgentDir: f.root,
		storage: new MemoryStorage(),
	});
	cleanups.push(() => host.shutdown());
	await host.listen();
	expect(fs.statSync(f.paths.certificate).mode & 0o777).toBe(0o600);
	const client = new HostClient(
		async () => ({
			socket: f.paths.socket,
			fingerprint: readHostCertificate(f.layout.socketPath),
		}),
		2000,
	);
	const catalog = await client.catalog();
	expect(Array.isArray(catalog.models)).toBe(true);
	await expect(
		client.watch("unknown", () => {}, { conversationId: "other" }),
	).rejects.toThrow(/unknown-run/);
	await host.shutdown();
	expect(fs.existsSync(f.paths.certificate)).toBe(false);
	expect(fs.existsSync(f.paths.socket)).toBe(false);
});
