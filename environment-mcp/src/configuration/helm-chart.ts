import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_FILES = 512;
const MAX_BYTES = 2 * 1024 * 1024;
const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const text = (value: unknown) =>
	typeof value === "string" ? value : undefined;
const valuePath =
	/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*){0,15}$/;
const releaseName = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type HelmSpec = {
	chart: string;
	release: string;
	values: string[];
	setString: Record<string, string>;
};
type Entry = { path: string; bytes: Buffer };

export function readHelmSpec(raw: unknown): HelmSpec {
	const data = object(raw);
	if (
		Object.keys(data).some(
			(key) => !["chart", "release", "values", "setString"].includes(key),
		)
	)
		throw new Error(
			"Unsupported Helm field; only chart/release/values/setString are supported",
		);
	const chart = text(data.chart);
	const release = text(data.release);
	if (!chart || path.isAbsolute(chart) || chart.split(/[\\/]/).includes(".."))
		throw new Error("Helm charts must be repository-relative directories");
	if (!release || release.length > 53 || !releaseName.test(release))
		throw new Error(
			"Helm release names must be DNS labels of at most 53 characters",
		);
	if (
		data.values !== undefined &&
		(!Array.isArray(data.values) || data.values.length > 8)
	)
		throw new Error("Helm values require at most 8 chart-relative files");
	const values = (Array.isArray(data.values) ? data.values : []).map(
		(value) => {
			const file = text(value);
			if (
				!file ||
				path.isAbsolute(file) ||
				file.split(/[\\/]/).includes("..") ||
				!/\.ya?ml$/.test(file)
			)
				throw new Error("Helm values files must be chart-relative YAML files");
			return path.normalize(file);
		},
	);
	if (new Set(values).size !== values.length)
		throw new Error("Helm values files must be distinct");
	const literal = object(data.setString ?? {});
	if (Object.keys(literal).length > 32)
		throw new Error("Helm setString accepts at most 32 literals");
	const setString = Object.fromEntries(
		Object.entries(literal).map(([key, value]) => {
			if (!valuePath.test(key))
				throw new Error("Helm setString keys must be plain dotted paths");
			const selected = text(value);
			if (
				selected === undefined ||
				selected.length > 1024 ||
				/[,\\\n\r\0]/.test(selected) ||
				selected.includes("{")
			)
				throw new Error("Invalid Helm setString value");
			return [key, selected];
		}),
	);
	return { chart: path.normalize(chart), release, values, setString };
}

function walk(root: string): Entry[] {
	const entries: Entry[] = [];
	let total = 0;
	const visit = (relative: string) => {
		const absolute = path.join(root, relative);
		for (const item of fs
			.readdirSync(absolute, { withFileTypes: true })
			.sort((left, right) => left.name.localeCompare(right.name))) {
			const child = relative ? path.join(relative, item.name) : item.name;
			if (item.isSymbolicLink())
				throw new Error("Helm charts cannot contain links");
			if (item.isDirectory()) {
				if (child === "crds")
					throw new Error("Helm CRDs are cluster-scoped and not authorized");
				if (child === "charts")
					throw new Error("Helm subcharts are not authorized");
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
	return { digest: digest(JSON.stringify(files)) };
}

export type HelmChartCapture = {
	root: string;
	digest: string;
	values: string[];
};

export function captureHelmChart(
	repository: string,
	spec: HelmSpec,
): HelmChartCapture {
	const root = fs.realpathSync(path.resolve(repository, spec.chart));
	if (!root.startsWith(`${fs.realpathSync(repository)}${path.sep}`))
		throw new Error("Helm chart must stay inside the repository");
	if (!fs.lstatSync(root).isDirectory())
		throw new Error("Helm chart must be a directory");
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
	if (metadata.dependencies !== undefined)
		throw new Error("Helm chart dependencies are not authorized");
	for (const entry of entries) {
		if (!entry.path.startsWith(`templates${path.sep}`)) continue;
		const source = entry.bytes.toString("utf8");
		if (/helm\.sh\/(?:hook|resource-policy)/.test(source))
			throw new Error("Helm hooks and resource policies are not authorized");
		if (/\{\{[^}]*\blookup\b/.test(source))
			throw new Error("Helm lookup is not authorized");
	}
	for (const file of spec.values)
		if (!entries.some((entry) => entry.path === file))
			throw new Error("Helm values file is not part of the chart");
	return { root, digest: identity(entries).digest, values: [...spec.values] };
}

export function verifyHelmChart(chart: string, expected: string) {
	const root = fs.realpathSync(chart);
	if (!fs.lstatSync(root).isDirectory())
		throw new Error("Helm chart is unavailable");
	if (identity(walk(root)).digest !== expected)
		throw new Error("Helm chart changed after approval");
}
