import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import { serveEnvironmentOperator } from "../environment/controller/operator-http.ts";
import { EnvironmentController } from "../environment/controller/service.ts";
import { daemonOptions } from "./daemon-options.ts";
import { serveEnvironmentMcp } from "./http.ts";
import { createNativeCatalog } from "./native-catalog.ts";

const absolute = z.string().max(4096).refine(path.isAbsolute);
const clientSchema = z.strictObject({
	version: z.literal(1),
	clients: z
		.array(
			z.strictObject({
				id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
				repository: absolute,
				workspace: absolute,
				mode: z.enum(["job", "interactive"]),
				idleMinutes: z.number().int().min(1).max(43200),
				tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/),
			}),
		)
		.min(1)
		.max(32),
});

function clientDefinitions(file: string) {
	const fd = fs.openSync(
		file,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
			throw new Error("Invalid client definitions");
		const buffer = Buffer.alloc(65537);
		let bytes = 0;
		while (bytes < buffer.length) {
			const size = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
			if (!size) break;
			bytes += size;
		}
		const after = fs.fstatSync(fd);
		if (
			bytes > 65536 ||
			stat.size !== after.size ||
			stat.mtimeMs !== after.mtimeMs ||
			stat.ctimeMs !== after.ctimeMs
		)
			throw new Error("Client definitions changed");
		const data = clientSchema.parse(
			JSON.parse(buffer.subarray(0, bytes).toString("utf8")),
		);
		if (
			new Set(data.clients.map((client) => client.id)).size !==
			data.clients.length
		)
			throw new Error("Duplicate MCP client ID");
		return data.clients;
	} finally {
		fs.closeSync(fd);
	}
}

function operatorAccess(file: string, value: unknown) {
	const content = JSON.stringify(value);
	const fd = fs.openSync(file, "wx", 0o600);
	let identity: fs.Stats;
	try {
		fs.writeFileSync(fd, content);
		fs.fsyncSync(fd);
		identity = fs.fstatSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	return () => {
		const current = fs.lstatSync(file);
		if (
			!current.isFile() ||
			current.dev !== identity.dev ||
			current.ino !== identity.ino ||
			current.size !== Buffer.byteLength(content) ||
			fs.readFileSync(file, "utf8") !== content
		)
			throw new Error("Operator access file changed; retained for inspection");
		fs.unlinkSync(file);
	};
}

/** Foreground shared daemon. It never authenticates an agent with the operator credential. */
export async function runEnvironmentDaemon(args: string[]) {
	const options = daemonOptions(args);
	const definitions = clientDefinitions(options.clients);
	const controller = await EnvironmentController.open(options);
	let mcp: Awaited<ReturnType<typeof serveEnvironmentMcp>> | undefined;
	let operator: ReturnType<typeof serveEnvironmentOperator> | undefined;
	let removeAccess: (() => void) | undefined;
	let closing: Promise<void> | null = null;
	const closed = Promise.withResolvers<void>();
	void closed.promise.catch(() => undefined);
	const close = () => {
		closing ??= (async () => {
			const listeners = await Promise.allSettled([
				mcp?.stop(),
				operator?.stop(),
			]);
			try {
				removeAccess?.();
			} finally {
				await controller.close();
			}
			if (listeners.some((result) => result.status === "rejected"))
				throw new Error("Environment listener cleanup failed");
		})();
		void closing.then(closed.resolve, closed.reject);
		return closing;
	};
	const signal = () => {
		void close().catch(() => undefined);
	};
	try {
		const bindings = [];
		for (const definition of definitions) {
			const principal = { id: definition.id, role: "agent" as const };
			const token = process.env[definition.tokenEnv];
			if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token))
				throw new Error("Missing MCP credential reference");
			const scope = await controller.scopes.bind(principal).create({
				requestId: `daemon-${randomUUID()}`,
				repository: definition.repository,
				workspace: definition.workspace,
				mode: definition.mode,
				idleMs: definition.idleMinutes * 60_000,
			});
			bindings.push({ token, principal, scopeId: scope.id });
		}
		operator = serveEnvironmentOperator(controller.operations, {
			port: options.operatorPort,
			controls: controller.operatorControls(),
		});
		const access = path.join(options.stateDir, "operator-access.json");
		removeAccess = operatorAccess(access, {
			url: operator.url,
			token: operator.token,
		});
		mcp = await serveEnvironmentMcp({
			controller,
			catalog: createNativeCatalog(options),
			bindings,
			port: options.port,
		});
		process.stderr.write(
			`Environment MCP: ${mcp.url}\nOperator access: ${access} (private; do not share with agents)\n`,
		);
		process.once("SIGINT", signal);
		process.once("SIGTERM", signal);
		await closed.promise;
	} finally {
		process.off("SIGINT", signal);
		process.off("SIGTERM", signal);
		await close();
	}
}
