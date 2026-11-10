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
if(verb==="get"&&command[1]==="metadata"){
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
 s.releases[key(name)]={name,namespace:ns,revision:1,status,labels};save();
 if(s.installFails){console.error("Error: resources not ready");process.exit(1);}
 const out={name,namespace:ns,version:s.wrongRevision?2:1,info:{status,description:"Install complete"},manifest:"private-rendered-manifest",config:{}};
 if(s.invalidReceipt)delete out.version;
 console.log(JSON.stringify(out));
}else if(verb==="uninstall"){
 const name=command[1],r=s.releases[key(name)];if(!r){console.error("Error: not found");process.exit(1);}
 if(s.keepOnUninstall){console.log("release uninstalled");process.exit(0);}
 delete s.releases[key(name)];save();console.log("release \\""+name+"\\" uninstalled");
}else process.exit(2);`;
