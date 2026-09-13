import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runComparison } from '../lib/compare.mjs';
import { readRun } from '../lib/record-store.mjs';
import { hash } from '../lib/domain.mjs';

const inputs={theme:'自動化を試す',target:'初心者',message:'確認する',cta:'試す',tags:'AI'};
const config={...JSON.parse(await readFile(new URL('../config/quality.json',import.meta.url),'utf8')),research:{enabled:false,maxSearches:3}};
const prompt=template=>({id:template,template,hash:hash(template)});
const judgePrompt=prompt('COMMON JUDGE');
function clientStub() {
  const calls=[];
  return {calls,messages:{async create(request){
    calls.push(request);
    const payload=JSON.parse(request.messages[0].content);
    const data=payload.rubric?{axes:['Q1','Q2','Q3','Q4'].map(id=>({id,score:3,quote:payload.article.body,reason:'例示内容に対応'})),claims:[],findings:[],preserve:[],unknowns:[]}
      :{title:payload.inputs.theme,body:request.system.includes('BASELINE')?'準備と手順を確認する。':'準備と手順、結果を確認する。',editorialChoices:[],unresolved:[]};
    return {model:request.model,content:[{type:'text',text:JSON.stringify(data)}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:10}};
  }}};
}
async function output(t) {const dir=await mkdtemp(path.join(os.tmpdir(),'note-comparison-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('generation comparison generates both versions with one shared evidence snapshot per case',async t=>{
  const client=clientStub();
  const result=await runComparison({cases:[{id:'one',inputs},{id:'two',inputs}],mode:'generation',baseline:prompt('BASELINE'),candidate:prompt('CANDIDATE'),judgePrompt,config,client,outputDir:await output(t)});
  assert.equal(result.exitCode,0);assert.equal(client.calls.length,8);
  const {events}=await readRun(result.runDir);
  const articles=events.filter(e=>e.type==='article.created');assert.equal(articles.length,4);
  for(const caseId of ['one','two']) {
    const pair=articles.filter(e=>e.data.caseId===caseId);assert.equal(pair.length,2);
    assert.equal(pair[0].data.evidenceHash,pair[1].data.evidenceHash);
    assert.notEqual(pair[0].data.article.hash,pair[1].data.article.hash);
  }
  const comparison=events.find(e=>e.type==='comparison.completed').data;
  assert.ok(comparison.observations.every(o=>o.beforeEvaluationId&&o.afterEvaluationId));
  assert.equal(events.find(e=>e.type==='adoption.decided').data.status,'held');
  assert.equal(events.find(e=>e.type==='note.completed').data.status,'skipped');
  assert.ok(result.comparison.htmlPath);assert.ok(result.comparison.resultsPath);
  const report=await readFile(result.report.markdownPath,'utf8');assert.ok(report.includes('one'));assert.ok(report.includes('two'));assert.ok(report.includes('BASELINE'));assert.ok(report.includes('CANDIDATE'));
});

test('judge comparison only rescores an identical article and preserves both evaluator identities',async t=>{
  const client=clientStub();
  const result=await runComparison({cases:[{id:'fixed',inputs,article:{title:'確認する',body:'手順を一つ試す。'}}],mode:'judge',baseline:prompt('OLD JUDGE'),candidate:prompt('NEW JUDGE'),judgePrompt,config,client,baselineJudgeModel:'old-model',candidateJudgeModel:'new-model',outputDir:await output(t)});
  assert.equal(result.exitCode,0);assert.equal(client.calls.length,2);
  assert.ok(client.calls.every(c=>JSON.parse(c.messages[0].content).rubric));
  const {events}=await readRun(result.runDir);
  const observation=events.find(e=>e.type==='comparison.completed').data.observations[0];
  assert.equal(observation.beforeHash,observation.afterHash);
  assert.notEqual(observation.beforeEvaluationId,observation.afterEvaluationId);
  assert.equal(observation.beforeConditions.model,'old-model');assert.equal(observation.afterConditions.model,'new-model');
  const report=await readFile(result.report.markdownPath,'utf8');assert.ok(report.includes('同一'));assert.ok(report.includes('OLD JUDGE'));assert.ok(report.includes('NEW JUDGE'));
});
