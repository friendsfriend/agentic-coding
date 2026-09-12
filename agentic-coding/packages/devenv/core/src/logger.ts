import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";

type FatalCleanupCallback = () => void;

const fatalCleanupCallbacks = new Set<FatalCleanupCallback>();

export function registerFatalCleanup(
	callback: FatalCleanupCallback,
): () => void {
	fatalCleanupCallbacks.add(callback);
	return () => fatalCleanupCallbacks.delete(callback);
}

function runFatalCleanup(): void {
	for (const callback of fatalCleanupCallbacks) {
		try {
			callback();
		} catch {
			// Best-effort fatal cleanup only.
		}
	}
}

// Parse a .env file and return key-value pairs (no shell export required).
function parseEnvFile(filePath: string): Record<string, string> {
	try {
		const content = readFileSync(filePath, "utf8");
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

// Resolve the devenv home directory.
// Priority: DEVENV_HOME env var → DEVENV_HOME in ~/.config/devenv/.env → ~/devenv fallback.
function resolveDevenvHome(): string {
	if (process.env.DEVENV_HOME) return process.env.DEVENV_HOME;
	const configDir =
		process.env.DEVENV_CONFIG_DIR || join(os.homedir(), ".config", "devenv");
	const vars = parseEnvFile(join(configDir, ".env"));
	if (vars.DEVENV_HOME) return vars.DEVENV_HOME;
	return join(os.homedir(), "devenv");
}

/**
 * Logger utility that captures console errors and writes to file.
 */
export class Logger {
	private logFilePath: string;
	private logDir: string;
	private originalConsole: {
		log: typeof console.log;
		error: typeof console.error;
		warn: typeof console.warn;
		debug: typeof console.debug;
	};
	private originalStderr: typeof process.stderr.write | null = null;

	constructor(logFileName: string = "devenv.log") {
		const devenvHome = resolveDevenvHome();
		this.logDir = join(devenvHome, "logs");
		this.logFilePath = join(this.logDir, logFileName);

		// Store original console methods
		this.originalConsole = {
			log: console.log,
			error: console.error,
			warn: console.warn,
			debug: console.debug,
		};

		this.ensureLogDirectory();
		this.initializeLogFile();
	}

	private ensureLogDirectory(): void {
		mkdirSync(this.logDir, { recursive: true });
	}

	private initializeLogFile(): void {
		const timestamp = new Date().toISOString();
		const header = `
========================================
DevEnv TUI Log File
Started: ${timestamp}
========================================

`;
		writeFileSync(this.logFilePath, header);
	}

	private formatLogEntry(level: string, args: unknown[]): string {
		const timestamp = new Date().toISOString();
		const message = args
			.map((arg) => {
				if (arg instanceof Error) {
					return `${arg.message}\nStack: ${arg.stack}`;
				}
				if (typeof arg === "object") {
					try {
						return JSON.stringify(arg, null, 2);
					} catch {
						return String(arg);
					}
				}
				return String(arg);
			})
			.join(" ");

		return `[${timestamp}] [${level}] ${message}\n`;
	}

	private writeToLog(level: string, args: unknown[]): void {
		try {
			const entry = this.formatLogEntry(level, args);
			appendFileSync(this.logFilePath, entry);
		} catch (error) {
			// Fallback to original console if logging fails
			this.originalConsole.error("Failed to write to log file:", error);
		}
	}

	/**
	 * Install logger to intercept console methods
	 * Writes ONLY to log file (silent mode - no console output)
	 * OpenTUI handles console display automatically
	 */
	install(): void {
		// Override console.error - write to file only (silent)
		console.error = (...args: unknown[]) => {
			this.writeToLog("ERROR", args);
			// Don't call originalConsole - OpenTUI handles display
		};

		// Override console.warn - write to file only (silent)
		console.warn = (...args: unknown[]) => {
			this.writeToLog("WARN", args);
			// Don't call originalConsole - OpenTUI handles display
		};

		// Override console.log - write to file only (silent)
		console.log = (...args: unknown[]) => {
			this.writeToLog("INFO", args);
			// Don't call originalConsole - OpenTUI handles display
		};

		// Override console.debug - write to file only (silent)
		console.debug = (...args: unknown[]) => {
			this.writeToLog("DEBUG", args);
			// Don't call originalConsole - OpenTUI handles display
		};

		// Redirect stderr to log file (completely silent)
		// TEMPORARILY DISABLED: This may interfere with Bun's fetch implementation
		// this.originalStderr = process.stderr.write;
		// process.stderr.write = ((chunk: any, encoding?: any, callback?: any): boolean => {
		//   // Convert chunk to string
		//   const message = typeof chunk === 'string' ? chunk : chunk.toString();
		//
		//   // Write to log file
		//   this.writeToLog('STDERR', [message.trim()]);
		//
		//   // Call callback if provided
		//   if (typeof encoding === 'function') {
		//     encoding();
		//   } else if (typeof callback === 'function') {
		//     callback();
		//   }
		//
		//   return true;
		// }) as any;

		// Capture uncaught exceptions - cleanup OpenTUI before allowing runtime to terminate.
		process.on("uncaughtException", (error: Error) => {
			this.writeToLog("UNCAUGHT_EXCEPTION", [error]);
			runFatalCleanup();
			process.exitCode = 1;
			process.removeAllListeners("uncaughtException");
			queueMicrotask(() => {
				throw error;
			});
		});

		// Capture unhandled promise rejections - completely silent
		process.on(
			"unhandledRejection",
			(reason: unknown, promise: Promise<unknown>) => {
				this.writeToLog("UNHANDLED_REJECTION", [
					"Unhandled Promise Rejection:",
					reason,
					"Promise:",
					promise,
				]);
				// Silent - no console output
			},
		);
	}

	/**
	 * Restore original console methods and stderr
	 */
	uninstall(): void {
		console.log = this.originalConsole.log;
		console.error = this.originalConsole.error;
		console.warn = this.originalConsole.warn;
		console.debug = this.originalConsole.debug;

		if (this.originalStderr) {
			process.stderr.write = this.originalStderr;
		}
	}

	/**
	 * Get the log file path
	 */
	getLogPath(): string {
		return this.logFilePath;
	}

	/**
	 * Write a custom log entry
	 */
	write(level: string, ...args: unknown[]): void {
		this.writeToLog(level, args);
	}

	/**
	 * Clear the log file
	 */
	clear(): void {
		this.initializeLogFile();
	}
}

// Singleton instance
let loggerInstance: Logger | null = null;

/**
 * Get or create the global logger instance
 */
export function getLogger(): Logger {
	if (!loggerInstance) {
		loggerInstance = new Logger();
	}
	return loggerInstance;
}

/**
 * Initialize logging system
 * Call this at application startup
 */
export function initializeLogging(): Logger {
	const logger = getLogger();
	logger.install();
	return logger;
}
