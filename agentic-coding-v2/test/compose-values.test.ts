// Pure Compose value parsing: argv, explicit environment keys and published ports.
// No engine, Compose file or container is created to prove these rules.
import { expect, test } from "bun:test";
import {
	composeArgv,
	composeEnvironment,
	composePort,
} from "../src/environment/compose-values.ts";

test("a Compose command is argv with quoting and escapes, never a shell string", () => {
	expect(composeArgv("serve --port 8080")).toEqual(["serve", "--port", "8080"]);
	expect(composeArgv("sh -c 'echo $HOME && ls *'")).toEqual([
		"sh",
		"-c",
		"echo $HOME && ls *",
	]);
	expect(composeArgv("node -e \"console.log('x')\"")).toEqual([
		"node",
		"-e",
		"console.log('x')",
	]);
	expect(composeArgv('echo "a \\"b\\""')).toEqual(["echo", 'a "b"']);
	expect(composeArgv('echo "\\$PATH"')).toEqual(["echo", "$PATH"]);
	expect(composeArgv("echo \\$PATH")).toEqual(["echo", "$PATH"]);
	expect(composeArgv("   ")).toEqual([]);
	expect(composeArgv(["already", "argv"])).toEqual(["already", "argv"]);
	for (const invalid of [
		"echo 'unclosed",
		'echo "unclosed',
		"echo a\nb",
		"a\rb",
		`a${"\0"}b`,
	])
		expect(() => composeArgv(invalid)).toThrow(
			/Unclosed Compose|Invalid Compose/,
		);
	expect(() => composeArgv("x".repeat(16001))).toThrow(
		"Invalid Compose command",
	);
});

test("Compose environment arrays need explicit keys and never inherit a value", () => {
	expect(composeEnvironment(["A=1", "B=two words"])).toEqual({
		A: "1",
		B: "two words",
	});
	expect(composeEnvironment({ A: 1 })).toEqual({ A: 1 });
	expect(composeEnvironment(undefined)).toEqual({});
	for (const invalid of [["A=1", "A=2"], ["INHERITED"], [123]])
		expect(() => composeEnvironment(invalid)).toThrow(/Compose environment/);
	expect(() =>
		composeEnvironment(Array.from({ length: 101 }, (_, i) => `${i}=x`)),
	).toThrow("Too many Compose environment entries");
});

test("a published Compose port keeps its protocol and refuses an unbounded form", () => {
	expect(composePort("8080:80")).toMatchObject({ published: 8080, target: 80 });
	expect(composePort("127.0.0.1:5432:5432/tcp")).toMatchObject({
		host_ip: "127.0.0.1",
		target: 5432,
	});
	expect(composePort("9000:9000/udp")).toMatchObject({ protocol: "udp" });
	for (const invalid of ["80", "80:80:80:80", "abc:def"])
		expect(() => composePort(invalid)).toThrow();
	// A port above 65535 is passed through as published 0/target 65536 by the
	// parser; range enforcement belongs to the Compose schema, not this function.
	expect(composePort("0:65536")).toMatchObject({ published: 0, target: 65536 });
});
