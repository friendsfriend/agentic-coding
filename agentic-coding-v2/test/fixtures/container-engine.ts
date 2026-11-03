// Executable fixture, never a real container engine. Requests go to one isolated
// in-test engine so killing a CLI cannot strand a synthetic filesystem lock.
const endpoint = process.env.FIXTURE_ENGINE_URL;

export {};

if (!endpoint?.startsWith("http://127.0.0.1:"))
	throw new Error("Missing isolated fixture engine");
const response = await fetch(endpoint, {
	method: "POST",
	body: JSON.stringify(process.argv.slice(2)),
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
	console.log(`service log ${process.env.SERVICE_TOKEN ?? ""}`);
	setInterval(() => {}, 1000);
} else {
	if (result.stdout.startsWith("build"))
		console.log(process.env.SERVICE_TOKEN ?? "");
	process.exit(result.exit);
}
