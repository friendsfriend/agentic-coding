import {
	generateKeyPairSync,
	randomBytes,
	sign,
	X509Certificate,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const der = (tag: number, ...parts: Uint8Array[]) => {
	const body = Buffer.concat(parts),
		bytes: number[] = [];
	for (let n = body.length; n; n >>>= 8) bytes.unshift(n & 255);
	return Buffer.concat([
		Buffer.from([
			tag,
			...(body.length < 128 ? [body.length] : [128 | bytes.length, ...bytes]),
		]),
		body,
	]);
};
const sequence = (...parts: Uint8Array[]) => der(48, ...parts);
function oid(value: string) {
	const nodes = value.split(".").map(Number),
		encoded: number[] = [];
	for (const node of [
		40 * (nodes[0] ?? 0) + (nodes[1] ?? 0),
		...nodes.slice(2),
	]) {
		const bytes = [node & 127];
		for (let n = Math.floor(node / 128); n; n = Math.floor(n / 128))
			bytes.unshift((n & 127) | 128);
		encoded.push(...bytes);
	}
	return der(6, Buffer.from(encoded));
}
function integer(value: Buffer) {
	while (value.length > 1 && value[0] === 0) value = value.subarray(1);
	return der(
		2,
		value[0] && value[0] & 128
			? Buffer.concat([Buffer.from([0]), value])
			: value,
	);
}
const time = (value: number) =>
	der(
		24,
		Buffer.from(
			`${new Date(value).toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`,
		),
	);
const stamp = (value: fs.Stats) => `${value.dev}:${value.ino}`;
/** Fresh in-memory signing key and one public certificate file. No key is saved,
 * no external CA/provider/tool is called and no path can restore this handle. */
export class TelemetryCertificate {
	readonly certificate: string;
	readonly key: string;
	private readonly directory: string;
	private readonly file: string;
	private readonly rootIdentity: string;
	private readonly fileIdentity: string;
	private closed = false;
	constructor(stateDir: string) {
		const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
			algorithm = sequence(oid("1.2.840.10045.4.3.2")),
			name = sequence(
				der(
					49,
					sequence(
						oid("2.5.4.3"),
						der(12, Buffer.from("host.docker.internal")),
					),
				),
			);
		const extension = (id: string, value: Uint8Array, critical = false) =>
			sequence(
				oid(id),
				...(critical ? [der(1, Buffer.from([255]))] : []),
				der(4, value),
			);
		const extensions = sequence(
			extension(
				"2.5.29.17",
				sequence(
					der(130, Buffer.from("host.docker.internal")),
					der(135, Buffer.from([127, 0, 0, 1])),
				),
			),
			extension("2.5.29.19", sequence(), true),
			extension("2.5.29.15", der(3, Buffer.from([7, 128])), true),
			extension("2.5.29.37", sequence(oid("1.3.6.1.5.5.7.3.1"))),
		);
		const tbs = sequence(
			der(160, integer(Buffer.from([2]))),
			integer(randomBytes(16)),
			algorithm,
			name,
			sequence(
				time(Date.now() - 60000),
				time(Date.UTC(9999, 11, 31, 23, 59, 59)),
			),
			name,
			keys.publicKey.export({ type: "spki", format: "der" }),
			der(163, extensions),
		);
		const encoded = sequence(
			tbs,
			algorithm,
			der(3, Buffer.from([0]), sign("sha256", tbs, keys.privateKey)),
		);
		this.certificate = `-----BEGIN CERTIFICATE-----\n${
			encoded
				.toString("base64")
				.match(/.{1,64}/g)
				?.join("\n") ?? ""
		}\n-----END CERTIFICATE-----\n`;
		this.key = keys.privateKey
			.export({ type: "pkcs8", format: "pem" })
			.toString();
		if (!new X509Certificate(this.certificate).verify(keys.publicKey))
			throw new Error("Native telemetry certificate verification failed");
		this.directory = fs.mkdtempSync(
			path.join(fs.realpathSync(stateDir), "environment-telemetry-"),
		);
		fs.chmodSync(this.directory, 0o700);
		this.rootIdentity = stamp(fs.lstatSync(this.directory));
		this.file = path.join(this.directory, "ca.pem");
		fs.writeFileSync(this.file, this.certificate, { mode: 0o444, flag: "wx" });
		this.fileIdentity = stamp(fs.lstatSync(this.file));
	}
	mount() {
		if (this.closed) throw new Error("Native telemetry certificate is closed");
		this.verify();
		if (/[\r\n\0,]/.test(this.file))
			throw new Error("Native telemetry certificate mount path is unsupported");
		return `type=bind,src=${this.file},dst=/acv2-otel-ca.pem,readonly`;
	}
	private verify() {
		const root = fs.lstatSync(this.directory),
			file = fs.lstatSync(this.file);
		if (
			!root.isDirectory() ||
			root.isSymbolicLink() ||
			stamp(root) !== this.rootIdentity ||
			!file.isFile() ||
			file.isSymbolicLink() ||
			file.nlink !== 1 ||
			stamp(file) !== this.fileIdentity ||
			fs.readFileSync(this.file, "utf8") !== this.certificate
		)
			throw new Error(
				"Original native telemetry certificate identity changed; files retained",
			);
	}
	close() {
		if (this.closed) return;
		this.verify();
		if (fs.readdirSync(this.directory).join() !== "ca.pem")
			throw new Error(
				"Native telemetry certificate cleanup is uncertain; files retained",
			);
		fs.unlinkSync(this.file);
		fs.rmdirSync(this.directory);
		this.closed = true;
	}
}
