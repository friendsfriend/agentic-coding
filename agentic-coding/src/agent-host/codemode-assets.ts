// Embedded QuickJS assets for the durable codemode tool
// (pi-durable-codemode-parity). A source run resolves both from `node_modules`;
// a compiled `agentic-coding` binary has no `node_modules`, so
// `scripts/build.ts` embeds the wasm file and the worker entrypoint and defines
// `PI_CODEMODE_WORKER_PATH` with the `$bunfs` specifier.
import wasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" };

declare const PI_CODEMODE_WORKER_PATH: string | undefined;

/** Path to the QuickJS wasm the sandbox compiles (an embedded path in a
 * compiled binary, the installed file in a source run). */
export function codemodeWasmPath(): string {
	return wasmPath;
}

/** The embedded worker specifier in a compiled binary; `undefined` in a source
 * run, where the sandbox resolves its own worker relative to the module. */
export function codemodeWorkerUrl(): string | undefined {
	return typeof PI_CODEMODE_WORKER_PATH === "string"
		? PI_CODEMODE_WORKER_PATH
		: undefined;
}
