import fs from "node:fs";
import { request } from "node:http";
import path from "node:path";
import type { DockerServiceBinding } from "../../configuration/service-binding.ts";
import {
	type ContainerInspection,
	type ContainerInspectionPort,
	DependencyBindingRefusal,
} from "../../domain/dependency-binding.ts";

const responseByteLimit = 256 * 1024;
const unavailable = () =>
	new DependencyBindingRefusal("dependency-observation-unavailable");

// Bun on macOS cannot realpath a socket itself. Resolve directory identities
// and explicit symlink hops without opening the socket as a regular file.
function resolveSocketPath(file: string) {
	let current = file;
	for (let hop = 0; hop < 16; hop++) {
		const resolved = path.join(
			fs.realpathSync(path.dirname(current)),
			path.basename(current),
		);
		const entry = fs.lstatSync(resolved);
		if (entry.isSocket()) return resolved;
		if (!entry.isSymbolicLink()) throw unavailable();
		current = path.resolve(path.dirname(resolved), fs.readlinkSync(resolved));
	}
	throw unavailable();
}

/** Read-only Docker Engine adapter. No default context, subprocess, TCP host,
 * mutation method or full inspector payload is exposed to MCP callers. */
export function createDockerInspectionAdapter(): ContainerInspectionPort {
	return {
		async inspect(
			binding: DockerServiceBinding,
			signal: AbortSignal,
		): Promise<ContainerInspection> {
			try {
				const socket = resolveSocketPath(binding.socket);
				const identity = fs.statSync(socket);
				if (!identity.isSocket()) throw unavailable();
				const result = await new Promise<ContainerInspection>(
					(resolve, reject) => {
						const client = request(
							{
								method: "GET",
								socketPath: socket,
								path: `/containers/${encodeURIComponent(binding.containerName)}/json`,
								agent: false,
								maxHeaderSize: 8192,
								headers: { Accept: "application/json", Host: "docker" },
								signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
							},
							(response) => {
								if (
									response.statusCode !== 200 ||
									response.headers["content-type"]?.split(";")[0]?.trim() !==
										"application/json"
								) {
									if (response.statusCode === 404)
										resolve({ status: "absent" });
									else reject(unavailable());
									response.destroy();
									return;
								}
								const chunks: Buffer[] = [];
								let length = 0;
								response.on("data", (value: Buffer) => {
									length += value.length;
									if (length > responseByteLimit) {
										client.destroy(unavailable());
										return;
									}
									chunks.push(value);
								});
								response.once("error", () => reject(unavailable()));
								response.once("aborted", () => reject(unavailable()));
								response.once("end", () => {
									try {
										resolve({
											status: "present",
											document: JSON.parse(
												Buffer.concat(chunks).toString("utf8"),
											),
										});
									} catch {
										reject(unavailable());
									}
								});
							},
						);
						client.once("error", () => reject(unavailable()));
						client.end();
					},
				);
				const after = fs.statSync(socket);
				if (
					resolveSocketPath(binding.socket) !== socket ||
					after.dev !== identity.dev ||
					after.ino !== identity.ino
				)
					throw unavailable();
				signal.throwIfAborted();
				return result;
			} catch {
				throw unavailable();
			}
		},
	};
}
