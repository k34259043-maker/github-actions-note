import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runWorkflow } from '../lib/pipeline.mjs';
import { readRun } from '../lib/record-store.mjs';
import { makeArticle, buildBrief, validateEvaluation, hash } from '../lib/domain.mjs';
import { eligibleFixes, selectRevision, validateReview, collectEvidence } from '../lib/quality.mjs';
import { validateCases } from '../lib/compare.mjs';

const inputs={theme:'GitHub Actionsの活用',target:'初心者',message:'作業を自動化する',cta:'テストする',tags:'GitHub,AI'};
const draft={title:'テストを自動化する',body:'準備を確認して、テストしてください。',editorialChoices:[],unresolved:[]};
const configBase=JSON.parse(await readFile(new URL('../config/quality.json',import.meta.url),'utf8'));
const settings=()=>({...structuredClone(configBase),research:{enabled:false,maxSearches:3},promptCandidates:{enabled:false,autoAdopt:false}});
const axisData=quote=>['Q1','Q2','Q3','Q4'].map(id=>({id,score:3,reason:'必要な説明がある',quote}));
const evaluated=(article=draft)=>({axes:axisData(article.body),findings:[],claims:[],preserve:[],unknowns:[]});
const response=data=>({model:'claude-sonnet-4-5',content:[{type:'text',text:JSON.stringify(data)}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:20}});
function fakeClient(queue) {
  const calls=[];
  return {calls,messages:{async create(request){calls.push(structuredClone(request));if(!queue.length)throw new Error('Unexpected model call');const next=queue.shift();if(next instanceof Error)throw next;return typeof next==='function'?next(request):next;}}};
}
async function temporary(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'note-quality-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));return dir;
}
const finding={id:'F1',category:'factual',severity:'major',quote:'私は生産性が3倍になりました。',reason:'入力に著者の実績がない',fix:'未提供の実績の文を削除する',autoFix:true,fixTarget:'article',evidenceIds:[],requirementId:'',preserve:['準備を確認して、テストしてください。'],cause:{type:'input_evidence',certainty:'confirmed',reason:'入力に該当する情報がない'}};
const authorClaim={id:'CL1',kind:'author',status:'insufficient',quote:finding.quote,evidenceIds:[],inputQuote:'',reason:'本人の提供情報がない'};

test('normal dry-run keeps exact prompts, outputs, final hash and excludes note writes',async t=>{
  const outputDir=await temporary(t),client=fakeClient([response(draft),response(evaluated())]);
  const result=await runWorkflow({inputs,config:settings(),client,outputDir,dryRun:true,saveDraft:()=>{throw new Error('Must not save in dry-run');}});
  assert.equal(result.exitCode,0);assert.equal(result.note.status,'skipped');assert.equal(client.calls.length,2);
  assert.equal(result.article.hash,result.evaluation.articleHash);
  const {events}=await readRun(result.runDir);
  assert.equal(events.filter(e=>e.type==='call.started').length,2);
  assert.equal(events.find(e=>e.type==='article.created'&&e.data.role==='final').data.article.body,draft.body);
  const md=await readFile(result.report.markdownPath,'utf8');
  assert.ok(md.includes(draft.body));assert.ok(md.includes('著者が入力で明示していない経験'));assert.ok(md.includes('Q1'));
});

test('truncated generation fails with usage and report preserved, never saves partial article',async t=>{
  const outputDir=await temporary(t),partial={...response(draft),stop_reason:'max_tokens'};
  let saves=0;
  const result=await runWorkflow({inputs,config:settings(),client:fakeClient([partial]),outputDir,dryRun:false,saveDraft:()=>{saves++;}});
  assert.equal(result.exitCode,1);assert.equal(saves,0);
  const {events}=await readRun(result.runDir);
  assert.ok(events.some(e=>e.type==='run.failed'));
  assert.equal(events.find(e=>e.type==='call.completed').data.usage.output_tokens,20);
  assert.ok(events.some(e=>e.type==='call.failed'));
  assert.ok((await readFile(result.report.markdownPath,'utf8')).includes('実行失敗'));
});

test('judge API failure stays unknown while one-click draft creation continues',async t=>{
  const outputDir=await temporary(t),client=fakeClient([response(draft),new Error('Judge unavailable')]);
  let saved;
  const result=await runWorkflow({inputs,config:settings(),client,outputDir,dryRun:false,saveDraft:async a=>{saved=a;return {status:'saved',articleHash:a.hash,verifiedHash:a.hash,published:'unknown'};}});
  assert.equal(result.status,'completed_with_evaluation_warning');assert.equal(result.evaluation.status,'failed');
  assert.equal(result.article.hash,saved.hash);assert.equal(client.calls.length,2);
  const {events}=await readRun(result.runDir);assert.ok(events.some(e=>e.type==='evaluation.failed'));
});

test('source-backed targeted revision saves exactly the reevaluated final article',async t=>{
  const outputDir=await temporary(t),before={...draft,body:`${finding.quote}\n${draft.body}`};
  const first={...evaluated(before),findings:[finding],claims:[authorClaim]};
  const review={resolutions:[{findingId:'F1',status:'resolved',beforeQuote:finding.quote,afterQuote:'',reason:'未提供の実績を削除した'}],regressions:[],lostContent:[],unrequestedChanges:[],newClaims:[],unknowns:[]};
  const client=fakeClient([response(before),response(first),response(draft),response(evaluated()),response(review)]);
  let saved;
  const result=await runWorkflow({inputs,config:settings(),client,outputDir,dryRun:false,saveDraft:async a=>{saved=a;return {status:'saved',articleHash:a.hash,verifiedHash:a.hash,published:'unknown'};}});
  assert.equal(result.exitCode,0);assert.equal(result.article.body,draft.body);assert.equal(client.calls.length,5);
  assert.equal(result.article.hash,result.evaluation.articleHash);assert.equal(saved.hash,result.article.hash);
  const {events}=await readRun(result.runDir);
  assert.equal(events.find(e=>e.type==='revision.decided').data.selected,'after');
  const md=await readFile(result.report.markdownPath,'utf8');assert.ok(md.includes(finding.quote));assert.ok(md.includes('diff'));
});

test('saved status without matching verification hashes cannot become workflow success',async t=>{
  const result=await runWorkflow({inputs,config:settings(),client:fakeClient([response(draft),response(evaluated())]),outputDir:await temporary(t),dryRun:false,
    saveDraft:async()=>({status:'saved',articleHash:'different',verifiedHash:'different',published:'unknown'})});
  assert.equal(result.exitCode,1);assert.equal(result.note.status,'save_unconfirmed');assert.equal(result.note.verifiedHash,null);
});

test('factual support needs real source or exact provided author claim, and quotes must exist',()=>{
  const article=makeArticle({...draft,body:finding.quote});
  const base={...evaluated(article),claims:[{...authorClaim,status:'supported'}]};
  assert.ok(validateEvaluation(base,article,{sources:[]},buildBrief(inputs)).some(x=>x.includes('Author claim')));
  const supplied={...inputs,message:finding.quote};
  base.claims[0].inputQuote=finding.quote;
  assert.deepEqual(validateEvaluation(base,article,{sources:[]},buildBrief(supplied)),[]);
  base.claims[0]={id:'CL1',kind:'external',quote:article.body,status:'supported',evidenceIds:['invented'],inputQuote:'',reason:'Claimed support'};
  assert.ok(validateEvaluation(base,article,{sources:[]},buildBrief(inputs)).includes('Unknown evidence ID'));
  base.axes[0].quote='存在しない引用';
  assert.ok(validateEvaluation(base,article,{sources:[]},buildBrief(inputs)).some(x=>x.includes('quote')));
});

test('equal problem counts do not hide a new major problem or unsupported claim',()=>{
  const common={status:'completed',conditions:{model:'same'},axes:axisData(draft.body),claims:[],findings:[]};
  const review={resolutions:[{findingId:'F1',status:'resolved'}],regressions:[],lostContent:[],unrequestedChanges:[],newClaims:[],unknowns:[]};
  const before={...common,findings:[finding],claims:[authorClaim]};
  let after={...common,findings:[{...finding,id:'F2',quote:'別の重大な問題'}]};
  assert.equal(selectRevision({before,after,review,targets:[finding]}).selected,'before');
  after={...common,claims:[{...authorClaim,quote:'別の未確認主張'}]};
  assert.equal(selectRevision({before,after,review,targets:[finding]}).selected,'before');
});

test('uncertain title/style proposals and unrelated resolution quotes are not auto-applied',()=>{
  const evaluation={status:'completed',claims:[],findings:[{...finding,category:'title',cause:{type:'generation_prompt',certainty:'undetermined'}}]};
  assert.deepEqual(eligibleFixes(evaluation),[]);
  const before=makeArticle({...draft,body:finding.quote+'\n'+draft.body}),after=makeArticle(draft);
  const review={resolutions:[{findingId:'F1',status:'resolved',beforeQuote:draft.body,afterQuote:draft.body}],regressions:[],lostContent:[],unrequestedChanges:[],newClaims:[],unknowns:[]};
  assert.throws(()=>validateReview(review,before,after,[finding]),/targeted/);
});

test('comparison input distinguishes new generation from rescore of an existing article',()=>{
  assert.doesNotThrow(()=>validateCases([{id:'case1',inputs}],'generation'));
  assert.throws(()=>validateCases([{id:'case1',inputs}],'judge'),/Article/);
  assert.doesNotThrow(()=>validateCases([{id:'case1',inputs,article:draft}],'judge'));
  assert.throws(()=>validateCases([{id:'case1',inputs},{id:'case1',inputs}],'generation'),/distinct/);
  assert.equal(hash({title:draft.title,body:draft.body}),makeArticle(draft).hash);
});

test('prompt candidates retain exact old/new text and finding lineage without changing the active prompt',async t=>{
  const outputDir=await temporary(t),config=settings();config.promptCandidates.enabled=true;
  const original=await readFile(config.generationPrompt,'utf8');
  const generationFinding={...finding,quote:draft.body,category:'editorial',severity:'minor',autoFix:false,fixTarget:'generation_prompt',cause:{type:'generation_prompt',certainty:'hypothesis',reason:'指示に確認方法の明示が不足する可能性'}};
  const extra='比較前に確認する対象を明示する。';
  const client=fakeClient([response(draft),response({...evaluated(),findings:[generationFinding]}),request=>{
    const payload=JSON.parse(request.messages[0].content);
    return response({needed:true,reason:'確認対象の明示を試す',template:original+'\n'+extra,changes:[{operation:'add',before:'',after:extra,findingIds:[payload.findings[0].id],reason:'曖昧な指示の解消を試す',expectedEffect:'確認する対象が明確になる可能性'}]});
  }]);
  const result=await runWorkflow({inputs,config,client,outputDir});
  const {events}=await readRun(result.runDir),candidate=events.find(e=>e.type==='prompt.candidate').data;
  assert.equal(candidate.status,'unverified');assert.equal(candidate.before.template,original);assert.equal(candidate.after.template,original+'\n'+extra);
  assert.equal(candidate.automaticAdoption,false);assert.ok(candidate.changes[0].findingIds[0].endsWith('/F1'));
  assert.equal(await readFile(config.generationPrompt,'utf8'),original);
  const report=await readFile(result.report.markdownPath,'utf8');assert.ok(report.includes(extra));assert.ok(report.includes('PC1'));assert.ok(report.includes('diff'));
});

test('search tool errors and missing citations remain partial/unavailable rather than verified facts',async()=>{
  const captured=[];
  const recorder={append:async(type,data)=>captured.push({type,data})};
  const gateway={call:async()=>({callId:'mock-research',text:'取得した範囲の要約',response:{content:[
    {type:'text',text:'要約',citations:[{type:'web_search_result_location',url:'https://example.com/source',title:'Mock source',cited_text:'取得した原文の抜粋'}]},
    {type:'web_search_tool_result',content:{type:'web_search_tool_result_error',error_code:'max_uses_exceeded'}},
  ]}})};
  const snapshot=await collectEvidence({gateway,recorder,inputs,brief:buildBrief(inputs),config:{research:{enabled:true,maxSearches:3}}});
  assert.equal(snapshot.status,'partial');assert.equal(snapshot.sources[0].excerpt,'取得した原文の抜粋');assert.ok(snapshot.errors.includes('max_uses_exceeded'));
  assert.equal(captured[0].type,'evidence.collected');
  gateway.call=async()=>{throw new Error('Research unavailable');};
  const failed=await collectEvidence({gateway,recorder,inputs,brief:buildBrief(inputs),config:{research:{enabled:true,maxSearches:3}}});
  assert.equal(failed.status,'unavailable');assert.deepEqual(failed.sources,[]);
});
