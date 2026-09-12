import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Embedded server binary (base64 encoded) - defined at compile time.
declare const EMBEDDED_SERVER_BINARY_BASE64: string | undefined;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ManagedServer {
	port: string;
	url: string;
	process: ReturnType<typeof Bun.spawn>;
	stop: (timeoutMs?: number) => Promise<void>;
}

function parseEnvFile(filePath: string): Record<string, string> {
	try {
		const content = fs.readFileSync(filePath, "utf8");
		const vars: Record<string, string> = {};
		for (const raw of content.split("\n")) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const stripped = line.replace(/^export\s+/, "");
			const eq = stripped.indexOf("=");
			if (eq === -1) continue;
			const key = stripped.slice(0, eq).trim();
			let value = stripped
				.slice(eq + 1)
				.trim()
				.replace(/^["']|["']$/g, "");
			value = value.replace(/\$\{HOME\}|\$HOME/g, os.homedir());
			if (key) vars[key] = value;
		}
		return vars;
	} catch {
		return {};
	}
}

export function resolveDevenvHome(): string {
	if (process.env.DEVENV_HOME) return process.env.DEVENV_HOME;
	const configDir =
		process.env.DEVENV_CONFIG_DIR ||
		path.join(os.homedir(), ".config", "devenv");
	const envVars = parseEnvFile(path.join(configDir, ".env"));
	if (envVars.DEVENV_HOME) return envVars.DEVENV_HOME;
	return path.join(os.homedir(), "devenv");
}

export async function getEmbeddedServerPath(): Promise<string | null> {
	if (
		typeof EMBEDDED_SERVER_BINARY_BASE64 === "undefined" ||
		!EMBEDDED_SERVER_BINARY_BASE64
	)
		return null;
	try {
		const tmpDir = path.join(os.tmpdir(), "devenv", `${process.pid}`);
		await fs.promises.mkdir(tmpDir, { recursive: true });
		const extension = process.platform === "win32" ? ".exe" : "";
		const tmpBinaryPath = path.join(tmpDir, `devenv-server${extension}`);
		const binaryData = Buffer.from(EMBEDDED_SERVER_BINARY_BASE64, "base64");
		await Bun.write(tmpBinaryPath, binaryData);
		if (process.platform !== "win32")
			await fs.promises.chmod(tmpBinaryPath, 0o755);
		if (process.platform === "darwin") {
			try {
				Bun.spawnSync(["codesign", "--remove-signature", tmpBinaryPath]);
				Bun.spawnSync(["codesign", "-s", "-", tmpBinaryPath]);
			} catch {}
		}
		return tmpBinaryPath;
	} catch (error) {
		console.error("Failed to extract embedded server:", error);
		return null;
	}
}

export function getListeningPid(port: string): number | null {
	try {
		const result = Bun.spawnSync([
			"lsof",
			"-n",
			"-P",
			`-iTCP:${port}`,
			"-sTCP:LISTEN",
		]);
		const lines = new TextDecoder()
			.decode(result.stdout)
			.trim()
			.split("\n")
			.filter(Boolean);
		for (const line of lines.slice(1)) {
			const parts = line.trim().split(/\s+/);
			const pid = parseInt(parts[1], 10);
			if (!Number.isNaN(pid)) return pid;
		}
	} catch {}
	return null;
}

async function waitForServer(
	serverUrl: string,
	expectedHomeDir: string,
	maxRetries: number,
): Promise<boolean> {
	let retries = maxRetries;
	while (retries > 0) {
		try {
			const response = await fetch(`${serverUrl}/api/health`, {
				signal: AbortSignal.timeout(1000),
			});
			if (response.ok) {
				const data = await response.json();
				if (data.status === "ok" && data.homeDir === expectedHomeDir)
					return true;
			}
		} catch {}
		retries--;
		if (retries > 0) await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return false;
}

export async function resolveServerBinary(): Promise<{
	serverBinaryPath: string | null;
	isEmbedded: boolean;
	isDevMode: boolean;
	cleanupTemp: boolean;
}> {
	const embeddedPath = await getEmbeddedServerPath();
	if (embeddedPath)
		return {
			serverBinaryPath: embeddedPath,
			isEmbedded: true,
			isDevMode: false,
			cleanupTemp: true,
		};
	const projectRoot = path.resolve(__dirname, "../../../../..");
	const distBinaryPath = path.join(projectRoot, "dist/server/devenv");
	const distBinaryExists = await Bun.file(distBinaryPath).exists();
	if (distBinaryExists)
		return {
			serverBinaryPath: distBinaryPath,
			isEmbedded: false,
			isDevMode: false,
			cleanupTemp: false,
		};
	return {
		serverBinaryPath: null,
		isEmbedded: false,
		isDevMode: true,
		cleanupTemp: false,
	};
}

export async function startManagedServer(port: string): Promise<ManagedServer> {
	const serverUrl = `http://127.0.0.1:${port}`;
	const devenvHome = resolveDevenvHome();
	const { serverBinaryPath, isDevMode, cleanupTemp } =
		await resolveServerBinary();

	await fs.promises.mkdir(devenvHome, { recursive: true });
	const logDir = path.join(devenvHome, "logs");
	await fs.promises.mkdir(logDir, { recursive: true });
	const serverLogFile = await fs.promises.open(
		path.join(logDir, "server.log"),
		"a",
	);

	const projectRoot = path.resolve(__dirname, "../../../../..");
	const serverDir = path.join(projectRoot, "server");
	let serverProcess: ReturnType<typeof Bun.spawn>;
	if (isDevMode) {
		serverProcess = Bun.spawn(
			["go", "run", "main.go", "server", "--port", port],
			{
				cwd: serverDir,
				stdout: serverLogFile.fd,
				stderr: serverLogFile.fd,
				env: process.env,
			},
		);
	} else {
		if (!serverBinaryPath) throw new Error("Server binary not found");
		serverProcess = Bun.spawn([serverBinaryPath, "server", "--port", port], {
			stdout: serverLogFile.fd,
			stderr: serverLogFile.fd,
			env: process.env,
		});
	}

	try {
		let staleServerPid: number | null = null;
		try {
			const response = await fetch(`${serverUrl}/api/health`, {
				signal: AbortSignal.timeout(1000),
			});
			if (response.ok) {
				const data = await response.json();
				if (data.status === "ok" && data.homeDir !== devenvHome)
					staleServerPid = getListeningPid(port);
			}
		} catch {}
		if (staleServerPid !== null) {
			try {
				process.kill(staleServerPid);
			} catch {}
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}

		const serverReady = await waitForServer(serverUrl, devenvHome, 10);
		if (!serverReady) {
			serverProcess.kill();
			throw new Error(
				"Server failed to start: Health check timed out after retries",
			);
		}
	} finally {
		await serverLogFile.close();
	}

	const cleanupTempBinary = async () => {
		if (!cleanupTemp || !serverBinaryPath) return;
		try {
			await fs.promises.rm(path.dirname(serverBinaryPath), {
				recursive: true,
				force: true,
			});
		} catch {}
	};

	let stopPromise: Promise<void> | null = null;
	const waitForExit = (timeoutMs: number) =>
		Promise.race([
			serverProcess.exited.then(() => true),
			new Promise<boolean>((resolve) =>
				setTimeout(() => resolve(false), timeoutMs),
			),
		]);
	const killPid = (pid: number, signal?: NodeJS.Signals) => {
		try {
			process.kill(pid, signal);
		} catch {}
	};
	const stop = async (timeoutMs = 2000) => {
		if (stopPromise) return stopPromise;
		stopPromise = (async () => {
			const listenerPid = getListeningPid(port);
			if (listenerPid !== null) killPid(listenerPid, "SIGTERM");
			try {
				serverProcess.kill("SIGTERM");
			} catch {}

			if (!(await waitForExit(timeoutMs))) {
				const pid = getListeningPid(port);
				if (pid !== null) killPid(pid, "SIGKILL");
				try {
					serverProcess.kill("SIGKILL");
				} catch {}
				await serverProcess.exited;
			}

			await cleanupTempBinary();
		})();
		return stopPromise;
	};

	return { port, url: serverUrl, process: serverProcess, stop };
}
