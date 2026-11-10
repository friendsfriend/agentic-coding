/** Disposable API/controller simulation only: no cluster, scheduler or pod code. */
export const deploymentClient = `import fs from "node:fs";
const file=process.env.FIXTURE_STATE,calls=process.env.FIXTURE_CALLS;
const s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{deployments:{},services:{},descendants:{},serial:0};
s.deployments??={};s.services??={};s.descendants??={};s.serial??=0;
const args=process.argv.slice(2),method=args.find(v=>["get","create","delete"].includes(v));
if(!args.includes("--raw")||!method)process.exit(2);
const url=new URL(args[args.indexOf("--raw")+1],"https://127.0.0.1"),key=url.pathname.includes("/deployments")?"deployments":"services",kind=key==="deployments"?"Deployment":"Service",apiVersion=key==="deployments"?"apps/v1":"v1";
const input=method==="get"?undefined:JSON.parse(fs.readFileSync(0,"utf8"));
if(calls)fs.appendFileSync(calls,JSON.stringify({method,path:url.pathname,query:url.search,body:input})+"\\n");
console.error("private-controller-client-output");
const uid=()=>"11111111-2222-3333-4444-"+String(++s.serial).padStart(12,"0");let result;
if(method==="get"){
 const filter=url.searchParams.get("fieldSelector");if(!filter?.startsWith("metadata.name="))process.exit(2);const name=filter.slice("metadata.name=".length),resource=s[key][name];
 result={apiVersion,kind:s.wrongList?"PodList":kind+"List",items:resource?[resource]:[]};
}else if(method==="create"){
 const name=input.metadata.name;if(s[key][name])process.exit(1);input.metadata.uid=uid();input.metadata.resourceVersion=String(s.serial);
 if(kind==="Deployment"){
 input.metadata.generation=s.staleGeneration?2:1;input.status={observedGeneration:1,updatedReplicas:input.spec.replicas,readyReplicas:input.spec.replicas,availableReplicas:input.spec.replicas,conditions:[{type:"Available",status:"True"}]};
 const rs=uid();s.descendants[input.metadata.uid]=[{kind:"ReplicaSet",uid:rs,owner:input.metadata.uid},...Array.from({length:input.spec.replicas},()=>({kind:"Pod",uid:uid(),owner:rs}))];
 }else{input.spec.clusterIP="10.96.0.5";input.status={};}
 s[key][name]=input;result=structuredClone(input);if(kind==="Deployment"&&s.invalidReceipt)delete result.metadata.uid;
 fs.writeFileSync(file,JSON.stringify(s));
}else{
 const name=decodeURIComponent(url.pathname.split("/").at(-1)),resource=s[key][name];
 if(kind==="Deployment"&&s.replaceOnDelete&&resource){resource.metadata.uid=uid();resource.metadata.resourceVersion=String(s.serial);fs.writeFileSync(file,JSON.stringify(s));}
 if(!resource||input.preconditions?.uid!==resource.metadata.uid||input.propagationPolicy!=="Foreground")process.exit(1);
 delete s.descendants[resource.metadata.uid];delete s[key][name];fs.writeFileSync(file,JSON.stringify(s));result={apiVersion:"v1",kind:"Status",status:"Success"};
}
console.log(JSON.stringify(result));`;
