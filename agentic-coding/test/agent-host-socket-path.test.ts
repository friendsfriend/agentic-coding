import { expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { canonicalWorkflowSocket } from "../src/agent-host/socket-path.ts";

test("canonical socket validation supports real Unix sockets without following links", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "socket-path-")),
	);
	const directory = path.join(root, "host");
	fs.mkdirSync(directory);
	const servers: net.Server[] = [];
	try {
		for (const name of ["host.sock", "host-tls.sock"]) {
			const socket = path.join(directory, name);
			const server = net.createServer();
			servers.push(server);
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socket, resolve);
			});
			expect(fs.lstatSync(socket).isSocket()).toBe(true);
			expect(canonicalWorkflowSocket(socket)).toBe(socket);
			const leaf = path.join(directory, `link-${name}`);
			fs.symlinkSync(socket, leaf);
			expect(() => canonicalWorkflowSocket(leaf)).toThrow(/symlink/);
		}
		const alias = path.join(root, "alias");
		fs.symlinkSync(directory, alias);
		expect(() =>
			canonicalWorkflowSocket(path.join(alias, "host.sock")),
		).toThrow(/symlink/);
		expect(() =>
			canonicalWorkflowSocket(path.join(directory, "missing.sock")),
		).toThrow();
	} finally {
		for (const server of servers)
			if (server.listening)
				await new Promise<void>((resolve) => server.close(() => resolve()));
		fs.rmSync(root, { recursive: true, force: true });
	}
});
