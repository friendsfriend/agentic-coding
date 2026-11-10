import fs from "node:fs";
import path from "node:path";
import { contained } from "../git.ts";
import type { Plan } from "./model.ts";
import { type processEnvironment, ShellProcess } from "./shell.ts";

const layers = [
	"dependencies",
	"spring-boot-loader",
	"snapshot-dependencies",
	"application",
];
const limit = 512 * 1024 * 1024;
function identity(directory: string) {
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || fs.realpathSync(directory) !== directory)
		throw new Error("Host build directory identity is not canonical");
	return `${stat.dev}:${stat.ino}`;
}
function stamp(stat: fs.Stats) {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
/** One live host-preparation handle. No shell/engine dispatch, no reconstruction
 * from a path/receipt, and no removal of Maven outputs in the task workspace. */
export class HostBuild {
	private child: ShellProcess | null = null;
	private output = "";
	private directory: string | null = null;
	private directoryIdentity: string | null = null;
	private context: { directory: string; identity: string } | null = null;
	cleanupFailed = false;
	constructor(
		private plan: Plan,
		private configDir: string,
		private stateDir: string,
		private environment: ReturnType<typeof processEnvironment>,
	) {}
	get logs() {
		return `${this.output}${this.child?.logs ?? ""}`.slice(-64000);
	}
	private async command(
		executable: string,
		args: string[],
		signal: AbortSignal,
		deadline: number,
	) {
		signal.throwIfAborted();
		const timeoutMs = deadline - Date.now();
		if (timeoutMs <= 0) throw new Error("Host build preparation timed out");
		const child = new ShellProcess(
			{ ...this.plan, readyText: null, timeoutMs },
			this.configDir,
			{ executable, args, environment: this.environment },
		);
		this.child = child;
		try {
			const exit = await child.wait(signal);
			if (exit.code !== 0 || exit.signal)
				throw new Error(
					"Host build preparation command failed; inspect redacted logs",
				);
		} finally {
			try {
				await child.stop();
			} catch {
				this.cleanupFailed = true;
			} finally {
				this.cleanupFailed ||= child.cleanupFailed;
				this.output = `${this.output}${child.logs}`.slice(-64000);
				this.child = null;
			}
		}
		if (this.cleanupFailed)
			throw new Error("Host build process cleanup uncertain");
	}
	async prepare(signal: AbortSignal, deadline: number) {
		const pom = contained(
				this.plan.workspace,
				path.relative(this.plan.workspace, path.join(this.plan.cwd, "pom.xml")),
			),
			manifest = fs.lstatSync(pom);
		if (!manifest.isFile() || manifest.isSymbolicLink())
			throw new Error(
				"Host Maven preparation requires a regular workspace pom.xml",
			);
		await this.command(
			"mvn",
			["-B", "-DskipTests", "package"],
			signal,
			deadline,
		);
		signal.throwIfAborted();
		const target = contained(
			this.plan.workspace,
			path.relative(this.plan.workspace, path.join(this.plan.cwd, "target")),
		);
		identity(target);
		const candidates = fs
			.readdirSync(target)
			.filter(
				(name) =>
					name.endsWith(".jar") &&
					!name.endsWith("-sources.jar") &&
					!name.endsWith("-javadoc.jar"),
			);
		if (candidates.length !== 1 || !candidates[0])
			throw new Error(
				"Host build requires exactly one packaged application jar",
			);
		const jar = path.join(target, candidates[0]),
			before = fs.lstatSync(jar);
		if (
			!before.isFile() ||
			before.isSymbolicLink() ||
			before.nlink !== 1 ||
			before.size > limit
		)
			throw new Error(
				"Host build jar is not a bounded regular private artifact",
			);
		const root = fs.realpathSync(this.stateDir);
		this.directory = fs.mkdtempSync(path.join(root, "environment-host-build-"));
		fs.chmodSync(this.directory, 0o700);
		this.directoryIdentity = identity(this.directory);
		const frozen = path.join(this.directory, "input.jar"),
			destination = path.join(this.directory, "context");
		const input = fs.openSync(
			jar,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		try {
			const opened = fs.fstatSync(input);
			if (
				stamp(before) !== stamp(opened) ||
				!opened.isFile() ||
				opened.nlink !== 1
			)
				throw new Error("Host build jar changed");
			const output = fs.openSync(
				frozen,
				fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
				0o600,
			);
			try {
				const buffer = Buffer.alloc(65536);
				let total = 0;
				for (;;) {
					signal.throwIfAborted();
					if (Date.now() >= deadline)
						throw new Error("Host build preparation timed out");
					const n = fs.readSync(input, buffer, 0, buffer.length, null);
					if (!n) break;
					total += n;
					if (total > limit)
						throw new Error("Host build jar grew beyond its bound");
					let written = 0;
					while (written < n)
						written += fs.writeSync(output, buffer, written, n - written);
				}
				if (
					total !== opened.size ||
					stamp(opened) !== stamp(fs.fstatSync(input)) ||
					stamp(opened) !== stamp(fs.lstatSync(jar))
				)
					throw new Error("Host build jar changed while being captured");
			} finally {
				fs.closeSync(output);
			}
		} finally {
			fs.closeSync(input);
		}
		fs.mkdirSync(destination, { mode: 0o700 });
		this.context = { directory: destination, identity: identity(destination) };
		const capturedJarStamp = stamp(fs.lstatSync(frozen));
		await this.command(
			"java",
			[
				"-Djarmode=layertools",
				"-jar",
				frozen,
				"extract",
				"--destination",
				destination,
			],
			signal,
			deadline,
		);
		if (identity(this.directory) !== this.directoryIdentity)
			throw new Error("Host build preparation directory changed");
		this.verify();
		if (capturedJarStamp !== stamp(fs.lstatSync(frozen)))
			throw new Error("Captured host build jar changed during extraction");
		if (fs.readdirSync(destination).some((name) => !layers.includes(name)))
			throw new Error("Unexpected extracted host build entries");
		for (const layer of layers) identity(path.join(destination, layer));
		let files = 0,
			bytes = 0;
		const inspect = (directory: string, depth = 0) => {
			if (depth > 64)
				throw new Error(
					"Extracted host build exceeds its directory depth limit",
				);
			for (const name of fs.readdirSync(directory)) {
				signal.throwIfAborted();
				if (Date.now() >= deadline)
					throw new Error("Host build validation timed out");
				if (++files > 100000)
					throw new Error("Extracted host build exceeds its entry limit");
				const file = path.join(directory, name),
					stat = fs.lstatSync(file);
				if (
					stat.isSymbolicLink() ||
					!(stat.isFile() || stat.isDirectory()) ||
					(stat.isFile() && stat.nlink !== 1)
				)
					throw new Error(
						"Extracted host build contains unsupported links or entries",
					);
				if (stat.isDirectory()) inspect(file, depth + 1);
				else {
					bytes += stat.size;
					if (bytes > 2 * limit)
						throw new Error("Extracted host build exceeds its byte limit");
				}
			}
		};
		inspect(destination);
		return destination;
	}
	verify() {
		if (
			!this.directory ||
			identity(this.directory) !== this.directoryIdentity ||
			!this.context ||
			identity(this.context.directory) !== this.context.identity
		)
			throw new Error("Original private host build context identity changed");
	}
	cleanup() {
		if (!this.directory) return;
		if (this.child || this.cleanupFailed) {
			this.cleanupFailed = true;
			throw new Error(
				"Host build process did not settle; private artifacts retained",
			);
		}
		try {
			if (identity(this.directory) !== this.directoryIdentity)
				throw new Error("Host build directory changed");
			fs.rmSync(this.directory, { recursive: true });
			this.directory = null;
		} catch {
			this.cleanupFailed = true;
			throw new Error(
				"Private host build cleanup uncertain; retained artifacts require inspection",
			);
		}
	}
}
