import fs from "node:fs";
import path from "node:path";
import type { Config } from "../../src/config.ts";
/** Disposable local client boundary: no kubeconfig credentials or live API calls. */
export function configureLocalCluster(
	config: Config,
	script: string,
	environment: Record<string, string> = {},
) {
	fs.mkdirSync(config.configDir, { recursive: true });
	const bin = path.join(config.configDir, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(
		path.join(bin, "kubectl"),
		`#!${process.execPath}\n${script}`,
		{ mode: 0o700 },
	);
	fs.writeFileSync(
		path.join(config.configDir, "local.json"),
		JSON.stringify({
			apiVersion: "v1",
			kind: "Config",
			clusters: [
				{ name: "fixture", cluster: { server: "https://127.0.0.1:6443" } },
			],
			contexts: [{ name: "explicit-fixture", context: { cluster: "fixture" } }],
			users: [],
		}),
	);
	fs.writeFileSync(
		path.join(config.configDir, "clusters.json"),
		JSON.stringify({
			version: 1,
			clusters: [
				{
					id: "local",
					repository: config.repositories[0],
					kubeconfig: "local.json",
					context: "explicit-fixture",
					environment: {
						PATH: `${bin}:${process.env.PATH ?? ""}`,
						...environment,
					},
				},
			],
		}),
	);
}

/** Bounded PodList/UID-preconditioned-delete/log/port-forward client: no
 * scheduler, container runtime or cluster networking. `port-forward` is a real
 * loopback TCP proxy to FIXTURE_FORWARD_HOST:FIXTURE_FORWARD_PORT. */
export const podClient = `import fs from "node:fs";
import net from "node:net";
const file=process.env.FIXTURE_STATE,s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{pods:{},serial:0};
const args=process.argv.slice(2);
if(args.includes("port-forward")){
const pair=args.find((value)=>/^\\d+:\\d+$/.test(value));
if(!pair)process.exit(2);
const local=Number(pair.split(":")[0]);
const server=net.createServer((socket)=>{
const upstream=net.connect(Number(process.env.FIXTURE_FORWARD_PORT),process.env.FIXTURE_FORWARD_HOST??"127.0.0.1");
socket.on("error",()=>socket.destroy());upstream.on("error",()=>upstream.destroy());
socket.pipe(upstream);upstream.pipe(socket);
});
server.listen(local,"127.0.0.1",()=>console.log("Forwarding from 127.0.0.1:"+local));
if(process.env.FIXTURE_FORWARD_EXIT_MS)setTimeout(()=>{server.close();process.exit(0);},Number(process.env.FIXTURE_FORWARD_EXIT_MS));
else setInterval(()=>{},1000);
}
else if(args.includes("logs")){const lines=JSON.parse(process.env.FIXTURE_LOG_LINES??"[]");for(const line of lines)console.log(line);if(args.includes("--follow"))setInterval(()=>{},1000);process.exitCode=0;}
else{
const method=args.find(v=>["get","create","delete"].includes(v)),uri=args[args.indexOf("--raw")+1],url=new URL(uri,"https://127.0.0.1"),name=url.pathname.split("/").at(-1);
console.error("private-api-output");let result;
if(method==="get"){const filter=url.searchParams.get("fieldSelector");if(!filter?.startsWith("metadata.name="))process.exit(2);const pod=s.pods[filter.slice("metadata.name=".length)];result={kind:"PodList",items:pod?[pod]:[]};}
else{const body=JSON.parse(fs.readFileSync(0,"utf8"));if(method==="create"){const podName=body.metadata.name;if(s.pods[podName])process.exit(1);body.metadata.uid="11111111-2222-3333-4444-"+String(++s.serial).padStart(12,"0");body.metadata.resourceVersion=String(s.serial);body.status={phase:"Running",conditions:[{type:"Ready",status:"True"}],containerStatuses:[]};s.pods[podName]=body;result=body;}
else if(method==="delete"){const pod=s.pods[name];if(!pod||body.preconditions?.uid!==pod.metadata.uid||body.preconditions?.resourceVersion!==pod.metadata.resourceVersion)process.exit(1);delete s.pods[name];result={kind:"Status",status:"Success"};}else process.exit(2);}
if(method!=="get")fs.writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify(result));}`;
/** Bounded namespace create/delete client: creation assigns a UUID identity,
 * recreating an existing name fails, deleting a missing name fails. No
 * scheduler, workload or cluster networking. */
export const namespaceClient = `import fs from "node:fs";
const file=process.env.FIXTURE_STATE,s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{namespaces:{},serial:0};
const args=process.argv.slice(2);
if(process.env.FIXTURE_CALLS)fs.appendFileSync(process.env.FIXTURE_CALLS,args.join(" ")+"\\n");
const verb=args.find((v)=>v==="create"||v==="delete");
if(!verb||process.env.FIXTURE_DOWN==="yes")process.exit(1);
const at=args.indexOf("namespace"),name=args[at+1];
if(at<0||!name)process.exit(2);
console.error("private-api-output");
if(verb==="create"){if(s.namespaces[name])process.exit(1);const uid="11111111-2222-3333-4444-"+String(++s.serial).padStart(12,"0");s.namespaces[name]={uid};fs.writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify({kind:"Namespace",metadata:{name,uid}}));}
else{if(!s.namespaces[name])process.exit(1);delete s.namespaces[name];fs.writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify({kind:"Status",status:"Success"}));}`;
