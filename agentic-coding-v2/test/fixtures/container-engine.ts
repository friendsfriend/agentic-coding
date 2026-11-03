// Executable fixture, never a real container engine. Requests go to one isolated
// in-test engine so killing a CLI cannot strand a synthetic filesystem lock.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const endpoint = process.env.FIXTURE_ENGINE_SOCKET;
const args = process.argv.slice(2);
const uri = args[1];

if (
	!endpoint ||
	!uri?.startsWith("unix:///") ||
	(args[0] === "--host"
		? uri.slice("unix://".length)
		: fileURLToPath(uri.replace(/^unix:/, "file:"))) !== endpoint
)
	throw new Error("Missing isolated fixture engine");
const response = await fetch("http://fixture/", {
	unix: endpoint,
	method: "POST",
	headers: { "X-Fixture-PID": String(process.pid) },
	body: JSON.stringify(args),
});
const result = (await response.json()) as {
	stdout: string;
	stderr: string;
	exit: number;
	follow: boolean;
};
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr)
	process.stderr.write(`${result.stderr} ${process.env.SERVICE_TOKEN ?? ""}\n`);
if (result.follow) {
	if (process.env.LOG_LINE) console.log(process.env.LOG_LINE);
	console.log(`service log ${process.env.SERVICE_TOKEN ?? ""}`);
	// Bound orphaned fixture clients to this disposable engine, even after a host SIGKILL.
	setInterval(async () => {
		try {
			await fetch("http://fixture/", {
				unix: endpoint,
				method: "HEAD",
				signal: AbortSignal.timeout(500),
			});
		} catch {
			try {
				fs.writeFileSync(
					path.join(
						process.env.CONFIG_DIR ?? "",
						`fixture-client-${process.pid}.exited`,
					),
					"fixture engine closed\n",
				);
			} catch {
				/* The parent may already have removed its disposable directory. */
			}
			process.exit(0);
		}
	}, 100);
} else {
	if (result.stdout.startsWith("build"))
		console.log(process.env.SERVICE_TOKEN ?? "");
	process.exit(result.exit);
}
