import fs from "node:fs";
import path from "node:path";
import type { Config } from "../../src/config.ts";
import { certificate } from "./tls.ts";

export const disposablePassword = 'disposable-sql-secret-7b5c"\\end';
/** Real disposable relational engine and PostgreSQL protocol, with a tiny TLS upgrade
 * adapter. PGlite does not establish production PostgreSQL authentication parity. */
export function installPostgres(
	config: Config,
	port: number,
	badIdentity = false,
) {
	fs.mkdirSync(config.configDir);
	certificate(
		config.configDir,
		"database",
		badIdentity ? "127.0.0.2" : "127.0.0.1",
	);
	fs.writeFileSync(
		path.join(config.configDir, ".env"),
		`DISPOSABLE_SQL_USER=postgres\nDISPOSABLE_SQL_PASSWORD=${disposablePassword}\n`,
	);
	const heartbeat = (name: string) =>
		`setInterval(()=>{try{fs.writeSync(1,'.')}catch{fs.writeFileSync(process.env.CONFIG_DIR+'/${name}-reaped','ok');process.exit(0)}},20);`;
	const source = `
 import fs from 'node:fs';import net from 'node:net';import tls from 'node:tls';
 import {PGlite} from ${JSON.stringify(import.meta.resolve("@electric-sql/pglite"))};
 import {PGLiteSocketHandler} from ${JSON.stringify(import.meta.resolve("@electric-sql/pglite-socket"))};
 const db=await PGlite.create();
 await db.exec("CREATE TABLE fixture_secrets(value text); CREATE TABLE items(n integer); INSERT INTO items SELECT generate_series(1,5); CREATE FUNCTION fixture_write() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN INSERT INTO items VALUES(999); RETURN 999; END $$;");
 await db.query('INSERT INTO fixture_secrets VALUES($1)',[process.env.PGPASSWORD]);
 const context=tls.createSecureContext({minVersion:'TLSv1.2',key:fs.readFileSync(process.env.CONFIG_DIR+'/database.key'),cert:fs.readFileSync(process.env.CONFIG_DIR+'/database.pem')});
 const server=net.createServer(socket=>{socket.on('error',()=>socket.destroy());socket.once('data',packet=>{
 if(packet.length!==8||packet.readInt32BE(0)!==8||packet.readInt32BE(4)!==80877103){socket.destroy();return;}
 const refuse=fs.existsSync(process.env.CONFIG_DIR+'/refuse-tls');socket.write(refuse?'N':'S');const secure=refuse?socket:new tls.TLSSocket(socket,{isServer:true,secureContext:context});secure.on('error',()=>secure.destroy());
 let tail='',seen=false;secure.on('data',packet=>{tail=(tail+packet.toString('utf8')).slice(-8192);if(!seen&&tail.includes('NATIVE_SQL_PROBE')){seen=true;fs.appendFileSync(process.env.CONFIG_DIR+'/sql-probes','query\\n');}});
 secure.pause();void (async()=>{await db.exec('ROLLBACK');await db.exec('DISCARD ALL');await db.exec('SET search_path TO public');if(secure.destroyed)return;const handler=new PGLiteSocketHandler({db,closeOnDetach:true});await handler.attach(secure);if(secure.destroyed)handler.detach(true);else secure.resume();})().catch(()=>secure.destroy());
 });});server.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('STORE_READY'));
 process.on('SIGTERM',()=>process.exit(0));${heartbeat("store")}
 `;
	const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`,
		command = (source: string) =>
			`${quote(process.execPath)} -e ${quote(source)}`;
	fs.writeFileSync(
		path.join(config.configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			projects: [
				{
					id: "api",
					kind: "app",
					repository: config.repositories[0],
					requires: ["store"],
					targets: [
						{
							id: "serve",
							action: "run",
							runtime: "shell",
							command: command(
								`const fs=require('node:fs');console.log('APP_READY');${heartbeat("api")}`,
							),
							readyText: "APP_READY",
						},
					],
				},
				{
					id: "store",
					kind: "infrastructure",
					repository: config.repositories[0],
					targets: [
						{
							id: "serve",
							action: "run",
							runtime: "shell",
							command: command(source),
							readyText: "STORE_READY",
							timeoutMs: 15000,
							environment: { PORT: String(port) },
							secretRefs: {
								PGUSER: "DISPOSABLE_SQL_USER",
								PGPASSWORD: "DISPOSABLE_SQL_PASSWORD",
							},
							queryConnection: {
								protocol: "postgres",
								host: "127.0.0.1",
								port,
								database: "template1",
								usernameRef: "PGUSER",
								passwordRef: "PGPASSWORD",
								caRef: "database.pem",
							},
						},
					],
				},
			],
		}),
	);
}
export function disposablePort() {
	const listener = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response("reserved"),
		}),
		port = listener.port;
	listener.stop(true);
	if (!port) throw new Error("Missing disposable database port");
	return port;
}
