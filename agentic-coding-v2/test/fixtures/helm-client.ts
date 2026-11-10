/** Disposable Helm release-store simulation only: no cluster, rendering,
 * controllers or chart execution. It records argv and environment names
 * (never values) and checks the frozen chart path it was given. */
export const helmClient = `import fs from "node:fs";
import path from "node:path";
const file=process.env.FIXTURE_STATE,calls=process.env.FIXTURE_CALLS;
const s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{releases:{}};
s.releases??={};
const args=process.argv.slice(2);
const at=(flag)=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
const ns=at("--namespace");
const valued=new Set(["--kubeconfig","--kube-context","--kube-apiserver","--namespace","--values","--set-string","--set","--labels","--timeout","--filter","--cascade","-o"]);
const command=args.filter((v,i)=>!v.startsWith("-")&&!valued.has(args[i-1]));
const verb=command[0];
const record={verb,args,env:Object.keys(process.env).filter(k=>k.startsWith("HELM_")).sort(),helmHome:process.env.HELM_CONFIG_HOME};
if(verb==="install"){const chart=command[2];record.chartFiles=fs.existsSync(chart)?fs.readdirSync(chart,{recursive:true}).map(String).sort():null;record.values=args.flatMap((v,i)=>v==="--values"?[fs.existsSync(args[i+1])?fs.readFileSync(args[i+1],"utf8"):null]:[]);}
if(calls)fs.appendFileSync(calls,JSON.stringify(record)+"\\n");
const key=(name)=>ns+"/"+name;
const save=()=>fs.writeFileSync(file,JSON.stringify(s));
const defaultManifest="---\\n# Source: fixture/templates/deployment.yaml\\napiVersion: apps/v1\\nkind: Deployment\\nmetadata:\\n  name: api\\n  namespace: "+ns+"\\n---\\napiVersion: external-secrets.io/v1beta1\\nkind: ExternalSecret\\nmetadata:\\n  name: api\\n";
const manifest=()=>s.manifest??defaultManifest;
if(verb==="template"){console.log(manifest());}
else if(verb==="get"&&command[1]==="manifest"){
 const r=s.releases[key(command[2])];if(!r){console.error("Error: release: not found");process.exit(1);}
 console.log(s.installedManifest??r.manifest);
}else if(verb==="get"&&command[1]==="metadata"){
 const r=s.releases[key(command[2])];if(!r){console.error("Error: release: not found");process.exit(1);}
 if(s.metadataFails){console.error("transient");process.exit(1);}
 console.log(JSON.stringify({name:r.name,chart:"fixture",version:"0.1.0",appVersion:"0.1.0",labels:r.labels,namespace:r.namespace,revision:r.revision,status:r.status,deployedAt:"2026-01-01T00:00:00Z"}));
}else if(verb==="list"){
 const filter=new RegExp(at("--filter")??".*");
 console.log(JSON.stringify(Object.values(s.releases).filter(r=>r.namespace===ns&&filter.test(r.name)).map(r=>({name:r.name,namespace:r.namespace,revision:String(r.revision),status:r.status}))));
}else if(verb==="install"){
 const name=command[1];if(s.releases[key(name)]){console.error("Error: cannot re-use a name that is still in use");process.exit(1);}
 const labels=Object.fromEntries((at("--labels")??"").split(",").filter(Boolean).map(v=>v.split("=")));
 const status=s.installFails?"failed":"deployed";
 s.releases[key(name)]={name,namespace:ns,revision:1,status,labels,manifest:manifest()};save();
 if(s.installFails){console.error("Error: resources not ready");process.exit(1);}
 const out={name,namespace:ns,version:s.wrongRevision?2:1,info:{status,description:"Install complete"},manifest:"private-rendered-manifest",config:{}};
 if(s.invalidReceipt)delete out.version;
 console.log(JSON.stringify(out));
}else if(verb==="uninstall"){
 const name=command[1],r=s.releases[key(name)];if(!r){console.error("Error: not found");process.exit(1);}
 if(s.keepOnUninstall){console.log("release uninstalled");process.exit(0);}
 delete s.releases[key(name)];save();console.log("release \\""+name+"\\" uninstalled");
}else process.exit(2);`;

/** Deployment reads for releases in the same state file: Helm ownership
 * annotations come from the stored release; Available follows FIXTURE state. */
export const helmDeploymentClient = `import fs from "node:fs";
const s=JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE,"utf8"));
const args=process.argv.slice(2),at=(f)=>{const i=args.indexOf(f);return i<0?undefined:args[i+1];};
const ns=at("--namespace"),i=args.indexOf("deployment");
if(args[args.indexOf("--request-timeout=8s")+1]!=="get"||i<0)process.exit(2);
const names=args.slice(i+1).filter((v,j,a)=>!v.startsWith("-")&&!["--namespace","-o"].includes(a[j-1]));
const items=[];
for(const r of Object.values(s.releases)){if(r.namespace!==ns)continue;for(const name of names){if(!r.manifest.includes("name: "+name))continue;
 const owner=s.foreignDeployment?"other":r.name;
 items.push({metadata:{name,namespace:ns,generation:1,annotations:{"meta.helm.sh/release-name":owner,"meta.helm.sh/release-namespace":ns}},status:{observedGeneration:1,conditions:[{type:"Available",status:s.unavailable?"False":"True"}]}});}}
if(items.length!==names.length){console.error("NotFound");process.exit(1);}
fs.appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({verb:"kubectl-get",names})+"\\n");
console.log(JSON.stringify(names.length===1?items[0]:{kind:"List",items}));`;
