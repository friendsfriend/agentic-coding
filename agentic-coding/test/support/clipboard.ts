import { spyOn } from "bun:test";
import * as childProcess from "node:child_process";

/** Exercise the real clipboard helper without touching the desktop clipboard,
 * depending on installed programs, or emitting OSC 52 into the renderer. */
export function stubClipboardCommand(success: boolean): () => void {
	const platform = process.platform;
	const which = Bun.which;
	const spawn = childProcess.spawnSync;
	const executable = "/synthetic/pbcopy";
	Object.defineProperty(process, "platform", { value: "darwin" });
	const whichSpy = spyOn(Bun, "which").mockImplementation((command, options) =>
		command === "pbcopy" ? executable : which(command, options),
	);
	const spawnSpy = spyOn(childProcess, "spawnSync").mockImplementation(((
		...args: Parameters<typeof childProcess.spawnSync>
	) => {
		if (args[0] !== executable) return spawn(...args);
		return {
			pid: 0,
			output: [null, Buffer.alloc(0), Buffer.alloc(0)],
			stdout: Buffer.alloc(0),
			stderr: Buffer.alloc(0),
			status: success ? 0 : 1,
			signal: null,
		};
	}) as typeof childProcess.spawnSync);
	return () => {
		spawnSpy.mockRestore();
		whichSpy.mockRestore();
		Object.defineProperty(process, "platform", { value: platform });
	};
}
