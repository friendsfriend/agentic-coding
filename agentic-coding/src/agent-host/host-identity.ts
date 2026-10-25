// Local host-instance authentication. TLS owns the handshake, key exchange and
// encrypted records; the dashboard pins the freshly read instance certificate,
// rather than trusting a pathname, a self-reported host id or a public CA.
import { dlopen, ptr } from "bun:ffi";
import {
	createHash,
	generateKeyPairSync,
	randomBytes,
	sign,
	X509Certificate,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface AuthenticatedHostEndpoint {
	readonly socket: string;
	readonly fingerprint: string;
}

export function hostIdentityPaths(socketPath: string) {
	return {
		socket: path.join(path.dirname(socketPath), "host-tls.sock"),
		certificate: path.join(path.dirname(socketPath), "host.cert"),
	};
}

// Minimal DER encoding of a self-signed P-256 X.509 certificate. No external
// executable/dependency or persisted private key. Signing and all TLS crypto
// are provided by node:crypto / node:tls, not a custom wire protocol.
function der(tag: number, ...parts: Buffer[]): Buffer {
	const value = Buffer.concat(parts);
	const length = value.length;
	const size =
		length < 128
			? Buffer.from([length])
			: length < 256
				? Buffer.from([0x81, length])
				: Buffer.from([0x82, length >> 8, length & 255]);
	return Buffer.concat([Buffer.from([tag]), size, value]);
}
const seq = (...parts: Buffer[]) => der(0x30, ...parts);
const algorithm = () => seq(Buffer.from("06082a8648ce3d040302", "hex")); // ecdsa-with-SHA256
const name = () =>
	seq(
		der(
			0x31,
			seq(
				Buffer.from("0603550403", "hex"),
				der(0x0c, Buffer.from("agent-host")),
			),
		),
	);
function time(value: Date): Buffer {
	return der(
		0x18,
		Buffer.from(
			value
				.toISOString()
				.replace(/[-:T]/g, "")
				.replace(/\.\d{3}Z$/, "Z"),
		),
	);
}

export function createHostIdentity() {
	const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const now = Date.now();
	const tbs = seq(
		der(0xa0, der(0x02, Buffer.from([2]))),
		der(0x02, Buffer.concat([Buffer.from([1]), randomBytes(16)])),
		algorithm(),
		name(),
		seq(
			time(new Date(now - 86_400_000)),
			time(new Date(now + 366 * 86_400_000)),
		),
		name(),
		pair.publicKey.export({ format: "der", type: "spki" }),
	);
	const raw = seq(
		tbs,
		algorithm(),
		der(0x03, Buffer.from([0]), sign("sha256", tbs, pair.privateKey)),
	);
	const cert = `-----BEGIN CERTIFICATE-----\n${raw
		.toString("base64")
		.match(/.{1,64}/g)
		?.join("\n")}\n-----END CERTIFICATE-----\n`;
	return {
		cert,
		key: pair.privateKey.export({ format: "pem", type: "pkcs8" }),
		fingerprint: certificateFingerprint(raw),
	};
}

export function certificateFingerprint(raw: Buffer): string {
	return createHash("sha256").update(raw).digest("hex");
}

// Darwin's /dev/fd does not support descriptor-relative child traversal.
// Bind only openat(2), lazily, instead of falling back to racy pathname reads.
function darwinOpenAt() {
	const libc = dlopen("/usr/lib/libSystem.B.dylib", {
		openat: { args: ["i32", "ptr", "i32"], returns: "i32" },
	});
	return (directory: number, component: string, flags: number) => {
		const name = Buffer.from(`${component}\0`);
		const fd = libc.symbols.openat(directory, ptr(name), flags);
		if (fd < 0)
			throw new Error(
				"host certificate descriptor traversal failed (missing or symlink component)",
			);
		return fd;
	};
}
let openAt: ReturnType<typeof darwinOpenAt> | undefined;
function openComponent(
	directory: number,
	component: string,
	flags: number,
): number {
	if (process.platform === "linux")
		return fs.openSync(`/proc/self/fd/${directory}/${component}`, flags);
	if (process.platform === "darwin") {
		openAt ??= darwinOpenAt();
		return openAt(directory, component, flags);
	}
	throw new Error(
		"authenticated local hosts require descriptor-relative filesystem access",
	);
}

/** Open every component relative to an already-open directory descriptor,
 * with O_NOFOLLOW. A rename/symlink swap cannot redirect the remaining walk.
 * No check-then-read race and no private key travels through this boundary.
 * Linux uses its descriptor filesystem; Darwin uses openat(2). Unavailable
 * native support fails closed, never falls back to an ordinary pathname. */
export function readHostCertificate(socketPath: string): string {
	const file = hostIdentityPaths(socketPath).certificate;
	if (!path.isAbsolute(file))
		throw new Error("host certificate path must be absolute");
	const parts = file.split(path.sep).filter(Boolean);
	let fd = fs.openSync(
		path.parse(file).root,
		fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
	);
	try {
		for (const [index, part] of parts.entries()) {
			const last = index === parts.length - 1;
			const next = openComponent(
				fd,
				part,
				fs.constants.O_RDONLY |
					fs.constants.O_NOFOLLOW |
					(last ? fs.constants.O_NONBLOCK : fs.constants.O_DIRECTORY),
			);
			fs.closeSync(fd);
			fd = next;
		}
		const stat = fs.fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.size > 8192 ||
			(stat.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid())
		)
			throw new Error(
				"host certificate is not a private owner-controlled file",
			);
		const cert = new X509Certificate(fs.readFileSync(fd));
		return certificateFingerprint(cert.raw);
	} finally {
		fs.closeSync(fd);
	}
}
