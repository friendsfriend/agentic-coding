import fs from "node:fs";
import path from "node:path";
export type EngineState = {
	next: number;
	containers: Record<
		string,
		{
			Id: string;
			Name: string;
			Config: { Labels: Record<string, string>; Env: string[] };
			NetworkId?: string;
			Aliases?: string[];
			State: {
				Running: boolean;
				ExitCode: number;
				Health?: { Status: string };
			};
		}
	>;
	networks?: Record<
		string,
		{
			Id: string;
			Name: string;
			Labels: Record<string, string>;
			Containers: Record<string, { Name: string }>;
		}
	>;
	invalidNetworkReceipt?: boolean;
	workloadPrerequisite?: "healthy" | "running";
	history: string[][];
	followers?: number[];
	offline?: boolean;
	replaceAfterStop?: boolean;
	replaceWithCopiedLabels?: boolean;
	buildExit?: number;
	buildDelayMs?: number;
	inspectDelayMs?: number;
	startDelayMs?: number;
	initialHealth?: "missing" | "unhealthy";
	/** Exit code reported by the synthetic one-shot `wait` receipt. */
	completionExit?: number;
	/** Owned-container log lines with the engine's own timestamp per line. */
	logLines?: Array<{ at: string; text: string }>;
};
export const readEngineFile = (file: string) =>
	JSON.parse(fs.readFileSync(file, "utf8")) as EngineState;
/** Synchronous state transition after body parsing: no fake lock survives a killed CLI. */
export function serveContainerFixture(file: string) {
	const directory = fs.mkdtempSync("/tmp/acv2-engine-");
	const socket = path.join(directory, "api %23.sock");
	const server = (() => {
		try {
			return Bun.serve({
				unix: socket,
				maxRequestBodySize: 16384,
				async fetch(request) {
					if (request.method === "HEAD")
						return new Response(null, { status: 204 });
					const incoming: unknown = await request.json();
					if (
						!Array.isArray(incoming) ||
						incoming.some((value) => typeof value !== "string")
					)
						return new Response(null, { status: 400 });
					const args = incoming as string[],
						state = readEngineFile(file);
					state.history.push([...args]);
					let stdout = "",
						stderr = "",
						follow = false,
						exit = 0;
					const print = (value: string) => {
						stdout += `${value}\n`;
					};
					const flag = args.shift(),
						socket = args.shift();
					if (
						!["--host", "--url"].includes(flag ?? "") ||
						!socket?.startsWith("unix:///")
					)
						throw new Error("Implicit/remote daemon is forbidden in fixture");
					const value = (key: string) => args[args.indexOf(key) + 1],
						// The CLI prefix names the provider under test: Podman
						// returns the claimed name from network create (not an ID)
						// and lowercases inspected network fields.
						podman = flag === "--url",
						cased = (record: {
							Id: string;
							Name: string;
							Labels: Record<string, string>;
							Containers: Record<string, unknown>;
						}) =>
							podman
								? {
										id: record.Id,
										name: record.Name,
										labels: record.Labels,
										containers: record.Containers,
									}
								: record,
						find = (id: string | undefined) =>
							Object.values(state.containers).find(
								(item) => item.Id === id || item.Name.replace(/^\//, "") === id,
							);
					if (state.offline) {
						stderr = "Engine unavailable";
						exit = 1;
					} else
						switch (args[0]) {
							case "network": {
								state.networks ??= {};
								const findNetwork = (id: string | undefined) =>
									Object.values(state.networks ?? {}).find(
										(item) => item.Id === id || item.Name === id,
									);
								if (args[1] === "ls") {
									const filter = value("--filter")?.replace(/^name=/, "") ?? "";
									for (const item of Object.values(state.networks))
										if (item.Name.includes(filter)) print(item.Id);
								} else if (args[1] === "inspect") {
									const found = findNetwork(args[2]);
									if (!found) {
										exit = 1;
										break;
									}
									print(JSON.stringify([cased(found)]));
									stderr = "must-not-leak-private-network-metadata";
								} else if (args[1] === "create") {
									const name = args.at(-1);
									if (!name || findNetwork(name)) {
										exit = 1;
										break;
									}
									const labels: Record<string, string> = {};
									for (let i = 0; i < args.length; i++)
										if (args[i] === "--label") {
											const label = args[i + 1] ?? "",
												position = label.indexOf("=");
											labels[label.slice(0, position)] = label.slice(
												position + 1,
											);
										}
									const id = (state.next++).toString(16).padStart(64, "0");
									state.networks[id] = {
										Id: id,
										Name: name,
										Labels: labels,
										Containers: {},
									};
									print(
										podman
											? state.invalidNetworkReceipt
												? "lost-receipt"
												: name
											: state.invalidNetworkReceipt
												? "lost-receipt"
												: id,
									);
								} else if (args[1] === "rm") {
									const found = findNetwork(args[2]);
									if (!found || Object.keys(found.Containers).length) {
										exit = 1;
										break;
									}
									delete state.networks[found.Id];
								} else throw new Error("Unexpected network command");
								break;
							}
							case "container": {
								const filter = value("--filter")?.replace(/^name=/, "") ?? "";
								for (const item of Object.values(state.containers))
									if (item.Name.includes(filter)) print(item.Id);
								break;
							}
							case "inspect": {
								const found = find(args.at(-1));
								if (!found) {
									exit = 1;
									break;
								}
								print(JSON.stringify([found]));
								stderr = "must-not-leak-machine-metadata";
								break;
							}
							case "create": {
								const name = value("--name");
								if (!name || find(name)) {
									exit = 1;
									break;
								}
								const networkId = args.includes("--network")
									? value("--network")
									: undefined;
								if (networkId && !state.networks?.[networkId]) {
									exit = 1;
									break;
								}
								const aliases = args.flatMap((arg, index) =>
									arg === "--network-alias" ? [args[index + 1] ?? ""] : [],
								);
								const labels: Record<string, string> = {};
								for (let i = 0; i < args.length; i++)
									if (args[i] === "--label") {
										const label = args[i + 1] ?? "",
											position = label.indexOf("=");
										labels[label.slice(0, position)] = label.slice(
											position + 1,
										);
									}
								const id = (state.next++).toString(16).padStart(64, "0");
								state.containers[id] = {
									Id: id,
									Name: `/${name}`,
									...(networkId
										? { NetworkId: networkId, Aliases: aliases }
										: {}),
									Config: {
										Labels: labels,
										Env: ["FOREIGN_PRIVATE=must-not-leak-machine-metadata"],
									},
									State: {
										Running: false,
										ExitCode: 0,
										...(state.initialHealth === "missing"
											? {}
											: {
													Health: { Status: state.initialHealth ?? "healthy" },
												}),
									},
								};
								if (networkId && state.networks?.[networkId])
									state.networks[networkId].Containers[id] = { Name: name };
								print(id);
								break;
							}
							case "start": {
								const found = find(args[1]);
								if (!found) {
									exit = 1;
									break;
								}
								found.State.Running = true;
								// A tiny app-level fixture: web cannot serve until it can discover its ready worker.
								if (
									state.workloadPrerequisite &&
									found.Name.includes("-web-")
								) {
									const worker = Object.values(state.containers).find((item) =>
										item.Name.includes("-worker-"),
									);
									const reachable =
										worker?.State.Running &&
										worker.NetworkId === found.NetworkId &&
										Boolean(found.NetworkId) &&
										worker.Aliases?.includes("worker");
									if (
										!reachable ||
										(state.workloadPrerequisite === "healthy" &&
											worker?.State.Health?.Status !== "healthy")
									) {
										found.State.Running = false;
										found.State.ExitCode = 12;
									}
								}
								break;
							}
							case "logs":
								for (const line of state.logLines ?? [])
									print(
										args.includes("--timestamps")
											? `${line.at} ${line.text}`
											: line.text,
									);
								follow = args.includes("--follow");
								if (follow) {
									const pid = Number(request.headers.get("X-Fixture-PID"));
									if (!Number.isSafeInteger(pid) || pid < 1)
										throw new Error("Missing fixture client PID");
									state.followers ??= [];
									state.followers.push(pid);
								}
								break;
							case "wait": {
								const found = find(args[1]);
								if (!found) {
									exit = 1;
									break;
								}
								found.State.Running = false;
								found.State.ExitCode = state.completionExit ?? 9;
								print(String(state.completionExit ?? 9));
								break;
							}
							case "stop": {
								const found = find(args.at(-1));
								if (!found) {
									exit = 1;
									break;
								}
								found.State.Running = false;
								if (state.replaceAfterStop)
									found.Config.Labels = { foreign: "replacement" };
								if (state.replaceWithCopiedLabels) {
									delete state.containers[found.Id];
									found.Id = (state.next++).toString(16).padStart(64, "0");
									state.containers[found.Id] = found;
								}
								break;
							}
							case "rm": {
								const found = find(args[1]);
								if (!found) {
									exit = 1;
									break;
								}
								if (found.NetworkId && state.networks?.[found.NetworkId])
									delete state.networks[found.NetworkId].Containers[found.Id];
								delete state.containers[found.Id];
								break;
							}
							case "build":
								print("build");
								exit = state.buildExit ?? 0;
								break;
							default:
								throw new Error("Unexpected engine command");
						}
					fs.writeFileSync(file, JSON.stringify(state));
					if (args[0] === "build" && state.buildDelayMs)
						await Bun.sleep(state.buildDelayMs);
					if (args[0] === "inspect" && state.inspectDelayMs)
						await Bun.sleep(state.inspectDelayMs);
					if (args[0] === "start" && state.startDelayMs)
						await Bun.sleep(state.startDelayMs);
					return Response.json({ stdout, stderr, follow, exit });
				},
			});
		} catch (error) {
			fs.rmSync(directory, { recursive: true, force: true });
			throw error;
		}
	})();
	return {
		socket,
		stop: async (force: boolean) => {
			try {
				await server.stop(force);
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		},
	};
}
