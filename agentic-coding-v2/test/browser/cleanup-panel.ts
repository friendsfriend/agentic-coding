import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Standalone browser fixture, not a native API test or live parity proof.
// bun test/browser/cleanup-panel.ts -> open the printed file URL in Chromium.
// No server, credentials, real filesystem release or runtime execution.
const built = await Bun.build({
	entrypoints: [
		new URL("../../src/web/definition-drafts.js", import.meta.url).pathname,
	],
	target: "browser",
});
if (!built.success) throw new Error("Cleanup panel fixture bundle failed");
const bundle = await built.outputs[0]?.text();
if (!bundle) throw new Error("Cleanup panel fixture bundle missing");
const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "ac-v2-cleanup-panel-"),
	),
	file = path.join(directory, "index.html");
fs.writeFileSync(
	file,
	`<!doctype html><meta charset="utf-8"><title>Disposable cleanup panel fixture</title>
<p>Canned API only. Confirmations are recorded and auto-accepted unless window.acceptConfirmation is false. First acknowledgement and release responses fail deliberately. Inspect window.calls. Change window.treeMode to current, stale or absent, then load the draft. Remove this temporary directory after use.</p>
<p id="connection"></p><script type="module">
${bundle.replaceAll("</script", "<\\/script")}
const digest = 'a'.repeat(64), attemptId = 'tree-cleanup-' + 'b'.repeat(64);
window.calls = [];
window.confirmations = [];
window.acceptConfirmation = true;
window.treeMode = 'current';
window.confirm = message => { window.confirmations.push(message); return window.acceptConfirmation; };
let ackCalls = 0, releaseCalls = 0;
const draft = () => ({id:'draft-'+'c'.repeat(64), revision:2, digest, content:'{}',
 schema:{message:'Fixture schema observation'}, baseMatches:true, destination:{state:'absent'},
 stagedTree:window.treeMode === 'absent' ? null : {treeDigest:digest, revision:window.treeMode === 'stale' ? 1 : 2,
 current:window.treeMode === 'current', fileCount:2, bytes:64, retained:{name:digest, present:true}}});
const request = async (route, body) => {
 window.calls.push({route, body: body ? structuredClone(body) : null});
 if (route === '/api/environments/drafts') return [draft()];
 if (route.startsWith('/api/environments/drafts?id=')) return draft();
 if (route.endsWith('/trees')) return {trees: [], unowned: [], cleanupAttempts: [{id:attemptId, revision:1, status:'pending', kind:'release', name:digest}]};
 if (route.endsWith('/tree-cleanup/acknowledge')) {
  ackCalls++; if (ackCalls === 1) throw Error('fixture ambiguous response');
  return {id:body.id, revision:2, status:'acknowledged'};
 }
 if (route.endsWith('/tree/release')) {
  releaseCalls++; if (releaseCalls === 1) throw Error('fixture ambiguous response');
  return {name:body.name, released:true};
 }
 throw Error('Unexpected fixture request');
};
const panel=definitionDrafts(request); panel.open=true; document.body.append(panel);
</script>`,
);
console.log(new URL(`file://${file}`).href);
