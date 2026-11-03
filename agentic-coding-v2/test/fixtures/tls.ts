import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
/** Disposable local test certificate, never an operator credential. */
export function certificate(directory: string, name: string, ip = "127.0.0.1") {
	const settings = path.join(directory, `${name}.cnf`);
	fs.writeFileSync(
		settings,
		`[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=Disposable fixture\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${ip}\n`,
	);
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-config",
			settings,
			"-keyout",
			path.join(directory, `${name}.key`),
			"-out",
			path.join(directory, `${name}.pem`),
		],
		{ stdio: "ignore" },
	);
	fs.chmodSync(path.join(directory, `${name}.key`), 0o600);
}
