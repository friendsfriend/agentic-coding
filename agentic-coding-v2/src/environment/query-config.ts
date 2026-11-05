import path from "node:path";
import { object, text } from "../config.ts";

function hasControl(value: string, sql = false) {
	return [...value].some((char) => {
		const code = char.charCodeAt(0);
		return code === 127 || (code < 32 && !(sql && "\t\r\n".includes(char)));
	});
}
export type QueryConnection = {
	protocol: "postgres";
	host: "127.0.0.1" | "::1";
	port: number;
	database: string;
	usernameRef: string;
	passwordRef: string;
	caRef?: string;
};
/** References only. The live process resolves and freezes credentials at startup. */
export function readQueryConnection(
	raw: unknown,
	refs: Record<string, string>,
): QueryConnection | undefined {
	if (raw === undefined) return undefined;
	const data = object(raw);
	if (
		Object.keys(data).some(
			(key) =>
				![
					"protocol",
					"host",
					"port",
					"database",
					"usernameRef",
					"passwordRef",
					"caRef",
				].includes(key),
		) ||
		data.protocol !== "postgres" ||
		(data.host !== "127.0.0.1" && data.host !== "::1") ||
		!Number.isSafeInteger(data.port) ||
		Number(data.port) < 1 ||
		Number(data.port) > 65535
	)
		throw new Error(
			"Query connection requires explicit PostgreSQL numeric loopback host/port; unknown fields are refused",
		);
	const database = text(data.database, "query database", 128),
		usernameRef = text(data.usernameRef, "query username reference", 128),
		passwordRef = text(data.passwordRef, "query password reference", 128);
	if (
		hasControl(database) ||
		![usernameRef, passwordRef].every((ref) => Object.hasOwn(refs, ref))
	)
		throw new Error(
			"Query credentials require declared secret references, not literal values",
		);
	const caRef =
		data.caRef === undefined
			? undefined
			: text(data.caRef, "query public CA reference", 4096);
	if (caRef && (path.isAbsolute(caRef) || caRef.split(/[\\/]/).includes("..")))
		throw new Error(
			"Query public CA reference must stay inside the configuration directory",
		);
	return {
		protocol: "postgres",
		host: data.host,
		port: Number(data.port),
		database,
		usernameRef,
		passwordRef,
		...(caRef ? { caRef } : {}),
	};
}
export type QueryInput = {
	infra: string;
	sql: string;
	limit: number;
	schema?: string;
	app?: string;
};
export function queryInput(
	infra: string,
	sql: string,
	limit = 50,
	schema?: string,
	app?: string,
): QueryInput {
	if (
		typeof sql !== "string" ||
		Buffer.byteLength(sql) > 20000 ||
		hasControl(sql, true) ||
		!/^(SELECT|WITH)\b/i.test(sql.trim())
	)
		throw new Error(
			"Query requires one SELECT/WITH statement, at most 20 KiB, without leading comments or disallowed control bytes",
		);
	if (/\$\d/.test(sql))
		throw new Error(
			"SQL parameter-like $digits text is unsupported, including inside literals/comments; the driver binding is reserved for the row cap",
		);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
		throw new Error("Query limit must be an integer from 1 to 200");
	if (
		schema !== undefined &&
		(typeof schema !== "string" ||
			!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(schema))
	)
		throw new Error(
			"Query schema must be a PostgreSQL identifier of at most 63 characters",
		);
	if (
		app !== undefined &&
		(typeof app !== "string" ||
			!app.length ||
			app.length > 64 ||
			hasControl(app))
	)
		throw new Error(
			"SQL requiring app must be an exact nonempty application ID of at most 64 characters",
		);
	return {
		infra,
		sql,
		limit,
		...(schema === undefined ? {} : { schema }),
		...(app === undefined ? {} : { app }),
	};
}
