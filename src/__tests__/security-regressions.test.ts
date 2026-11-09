import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderContextDocument, applyContextDocument } from '../context-document.ts';
import { attachSubagentsAdapter } from '../icl/subagents-adapter.ts';
import type { LiveContextMessage } from '../types.ts';

function context() {
 return renderContextDocument([
  {role:'user',content:'synthetic audit',timestamp:1},
  {role:'assistant',content:[{type:'toolCall',id:'a',name:'read',arguments:{path:'A'}},{type:'toolCall',id:'b',name:'read',arguments:{path:'B'}}],timestamp:2},
  ...['a','b'].map((id,i)=>({role:'toolResult',toolCallId:id,toolName:'read',isError:id==='b',content:[{type:'text',text:'ORIGINAL_'+id}],timestamp:3+i})),
  {role:'user',content:'continue',timestamp:5},
 ] as LiveContextMessage[]);
}
for (const reverse of [false,true]) {
 for (const editBoth of [false,true]) {
  test(`source identity survives edits: reverse=${reverse}, both=${editBoth}`,()=>{
   const snap=context();const blocks=snap.text.split(/(?=\[\[CTX_TURN )/);
   const a=blocks.findIndex(b=>b.includes('ORIGINAL_a')), b=blocks.findIndex(b=>b.includes('ORIGINAL_b'));
   blocks[a]=blocks[a]!.replace('ORIGINAL_a','EDITED_a');
   if(editBoth) blocks[b]=blocks[b]!.replace('ORIGINAL_b','EDITED_b');
   if(reverse) [blocks[a],blocks[b]]=[blocks[b]!,blocks[a]!];
   const result=applyContextDocument(blocks.join(''),snap,{editingMode:'clm'});
   assert.equal(result.accepted,true,result.reason);
   const results=result.messages.filter(m=>m.role==='toolResult');assert.equal(results.length,2);
   for(const message of results){
    const id=message.toolCallId;
    assert.match(JSON.stringify(message.content),new RegExp('_'+id));
    assert.equal(message.toolName,'read');assert.equal(message.isError,id==='b');
   }
  });
 }
}
test('deleting one result cannot reassign the surviving result',()=>{
 const snap=context();const blocks=snap.text.split(/(?=\[\[CTX_TURN )/).filter(b=>!b.includes('ORIGINAL_a'));
 const result=applyContextDocument(blocks.join('').replace('ORIGINAL_b','EDITED_b'),snap,{editingMode:'clm'});
 assert.equal(result.accepted,true,result.reason);
 assert.ok(!result.messages.some(m=>m.role==='toolResult' && m.toolCallId==='a'));
});

async function fixture() {
 const dir=await mkdtemp(join(tmpdir(),'clm-registration-test-'));
 const file=join(dir,'registry.mjs');
 await writeFile(file,`export const events=[]; export function registerRequiredChildExtensions(p){ events.push('register:'+p.sessionId); return {dispose(){events.push('dispose:'+p.sessionId)}} }`);
 const module=await import(pathToFileURL(file).href);
 const adapter=attachSubagentsAdapter({PI_CLM_SUBAGENTS_MODULE:file,PI_CLM_SUBAGENTS:'on'},m=>{throw Error(m)});
 return {dir,module,adapter};
}
test('dispose invalidates a registration awaiting module resolution',async()=>{
 const {dir,module,adapter}=await fixture();
 try {const pending=adapter.register({sessionId:'old'});adapter.dispose();assert.equal((await pending).registered,false);assert.deepEqual(module.events,[]);assert.equal(adapter.registration,null);} finally {adapter.dispose();await rm(dir,{recursive:true,force:true});}
});
test('session changes dispose old registration and late work cannot replace the new one',async()=>{
 const {dir,module,adapter}=await fixture();
 try {
  await adapter.register({sessionId:'first'});
  const old=adapter.register({sessionId:'stale'});const latest=adapter.register({sessionId:'latest'});
  assert.equal((await old).registered,false);assert.equal((await latest).registered,true);
  await adapter.register({sessionId:'latest'});adapter.dispose();adapter.dispose();
  assert.deepEqual(module.events,['register:first','dispose:first','register:latest','dispose:latest']);
 }finally{adapter.dispose();await rm(dir,{recursive:true,force:true});}
});
