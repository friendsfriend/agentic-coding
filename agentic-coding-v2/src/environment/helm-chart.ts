import fs from "node:fs";
import path from "node:path";
import { digest, object, text } from "../config.ts";
import { contained } from "../git.ts";

/** Explicit chart declaration: the chart directory and values files stay in the
 * task workspace and are frozen at approval time; nothing is fetched. */
export type HelmSpec = {
	chart: string;
	release: string;
	values: string[];
	setString: Record<string, string>;
	replicasValuePath?: string;
	/** Selected only by an explicit request; never a chart default. */
	replicas?: number;
};
export type HelmChartCapture = {
	protocol: "frozen-helm-chart-v1";
	root: string;
	digest: string;
	files: { path: string; size: number; digest: string }[];
	values: string[];
};
const MAX_FILES = 512,
	MAX_BYTES = 2 * 1024 * 1024,
	valuePath = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*){0,15}$/;

export function readHelm(raw: unknown): HelmSpec {
	const data = object(raw);
	if (
		Object.keys(data).some(
			(key) =>
				![
					"chart",
					"release",
					"values",
					"setString",
					"replicasValuePath",
				].includes(key),
		)
	)
		throw new Error(
			"Unsupported Helm field; only chart/release/values/setString/replicasValuePath are supported",
		);
	const chart = text(data.chart, "Helm chart directory", 4096),
		release = text(data.release, "Helm release", 53);
	if (path.isAbsolute(chart) || chart.split(/[\\/]/).includes(".."))
		throw new Error("Helm charts must be workspace-relative directories");
	if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(release))
		throw new Error(
			"Helm release names must be DNS labels of at most 53 characters",
		);
	const values = (data.values ?? []) as unknown;
	if (!Array.isArray(values) || values.length > 8)
		throw new Error("Helm values require at most 8 chart-relative files");
	const files = values.map((value) => {
		const file = text(value, "Helm values file", 4096);
		if (
			path.isAbsolute(file) ||
			file.split(/[\\/]/).includes("..") ||
			!/\.ya?ml$/.test(file)
		)
			throw new Error(
				"Helm values files must be chart-relative YAML files frozen with the chart",
			);
		return path.normalize(file);
	});
	if (new Set(files).size !== files.length)
		throw new Error("Helm values files must be distinct");
	const literal = object(data.setString ?? {});
	if (Object.keys(literal).length > 32)
		throw new Error("Helm setString accepts at most 32 non-secret literals");
	const setString = Object.fromEntries(
		Object.entries(literal).map(([key, value]) => {
			if (!valuePath.test(key))
				throw new Error(
					"Helm setString keys must be plain dotted value paths without indexes or escapes",
				);
			const selected = text(value, "Helm setString value", 1024);
			if (/[,\\\n\r\0]/.test(selected) || selected.includes("{"))
				throw new Error(
					"Helm setString values cannot contain separators, escapes or structure",
				);
			return [key, selected];
		}),
	);
	const replicasValuePath =
		data.replicasValuePath === undefined
			? undefined
			: text(data.replicasValuePath, "Helm replicas value path", 256);
	if (replicasValuePath !== undefined && !valuePath.test(replicasValuePath))
		throw new Error("Helm replicasValuePath must be a plain dotted value path");
	if (replicasValuePath !== undefined && replicasValuePath in setString)
		throw new Error(
			"Helm replicasValuePath cannot also be a setString literal",
		);
	return {
		chart: path.normalize(chart),
		release,
		values: files,
		setString,
		...(replicasValuePath ? { replicasValuePath } : {}),
	};
}

type Entry = { path: string; bytes: Buffer };
/** Bounded no-follow walk: every regular file of the chart is part of its
 * identity. Links, devices, CRD directories and oversized trees refuse. */
function walk(root: string): Entry[] {
	const entries: Entry[] = [];
	let total = 0;
	const visit = (relative: string) => {
		const absolute = path.join(root, relative);
		for (const item of fs
			.readdirSync(absolute, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name))) {
			const child = relative ? path.join(relative, item.name) : item.name;
			if (item.isSymbolicLink())
				throw new Error("Helm charts cannot contain links");
			if (item.isDirectory()) {
				if (child === "crds")
					throw new Error(
						"Helm chart CRDs are cluster-scoped effects and are not authorized",
					);
				visit(child);
				continue;
			}
			if (!item.isFile())
				throw new Error("Helm charts may contain only regular files");
			const fd = fs.openSync(
				path.join(root, child),
				fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
			);
			try {
				const stat = fs.fstatSync(fd);
				if (!stat.isFile() || stat.size > MAX_BYTES)
					throw new Error("Helm chart file exceeds its bound");
				const bytes = fs.readFileSync(fd);
				total += bytes.length;
				entries.push({ path: child, bytes });
			} finally {
				fs.closeSync(fd);
			}
			if (entries.length > MAX_FILES || total > MAX_BYTES)
				throw new Error("Helm chart exceeds 512 files or 2 MiB");
		}
	};
	visit("");
	return entries;
}
function identity(entries: Entry[]) {
	const files = entries.map((entry) => ({
		path: entry.path,
		size: entry.bytes.length,
		digest: digest(entry.bytes.toString("base64")),
	}));
	return { files, digest: digest(JSON.stringify(files)) };
}
/** Approval-time chart identity. Values files must be inside the frozen tree. */
export function captureHelmChart(
	workspace: string,
	spec: HelmSpec,
): HelmChartCapture {
	const root = contained(fs.realpathSync(workspace), spec.chart);
	if (!fs.lstatSync(root).isDirectory())
		throw new Error("Helm chart must be an existing workspace directory");
	const entries = walk(root);
	const chart = entries.find((entry) => entry.path === "Chart.yaml");
	if (!chart) throw new Error("Helm chart requires Chart.yaml");
	const metadata = object(
		Bun.YAML.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(chart.bytes),
		),
	);
	if (metadata.apiVersion !== "v2" || metadata.type === "library")
		throw new Error(
			"Only installable apiVersion v2 application charts are supported",
		);
	if (
		metadata.dependencies !== undefined ||
		entries.some((entry) => entry.path.startsWith(`charts${path.sep}`))
	)
		throw new Error(
			"Helm chart dependencies/subcharts are not frozen or fetched by this protocol",
		);
	for (const entry of entries) {
		if (!entry.path.startsWith(`templates${path.sep}`)) continue;
		const source = entry.bytes.toString("utf8");
		// Helm hooks and keep policies outlive uninstall; lookup makes rendering
		// depend on live cluster state instead of the approved frozen inputs.
		if (/helm\.sh\/(?:hook|resource-policy)/.test(source))
			throw new Error(
				"Helm hooks and resource-policy annotations outlive release cleanup and are not authorized",
			);
		if (/\{\{[^}]*\blookup\b/.test(source))
			throw new Error(
				"Helm lookup renders from live cluster state and is not authorized",
			);
	}
	for (const file of spec.values)
		if (!entries.some((entry) => entry.path === file))
			throw new Error(
				"Helm values file is not a regular file of the frozen chart",
			);
	return {
		protocol: "frozen-helm-chart-v1",
		root,
		...identity(entries),
		values: [...spec.values],
	};
}
/** Copies the approved chart into private scratch from one read of each file;
 * any byte, path or file-set drift from approval refuses before Helm runs. */
export function freezeHelmChart(capture: HelmChartCapture, scratch: string) {
	const entries = walk(capture.root),
		current = identity(entries);
	if (current.digest !== capture.digest)
		throw new Error(
			"Helm chart changed after approval; obtain a new exact plan approval",
		);
	const target = path.join(scratch, "chart");
	fs.mkdirSync(target, { mode: 0o700 });
	for (const entry of entries) {
		const file = path.join(target, entry.path);
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.writeFileSync(file, entry.bytes, { mode: 0o600, flag: "wx" });
	}
	if (identity(walk(target)).digest !== capture.digest)
		throw new Error("Frozen Helm chart copy could not be verified");
	return target;
}
