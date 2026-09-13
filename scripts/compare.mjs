#!/usr/bin/env node
import Anthropic from '@anthropic-ai/sdk';
import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadPrompt, hash } from '../lib/domain.mjs';
import { runComparison, validateCases } from '../lib/compare.mjs';

export async function main(args=process.argv.slice(2),env=process.env) {
  const options={};
  const allowed=new Set(['mode','cases','baseline','candidate','baseline-model','candidate-model']);
  for(let i=0;i<args.length;i+=2) {
    const key=args[i]?.replace(/^--/,'');
    if(!args[i]?.startsWith('--')||!allowed.has(key)||!args[i+1]||args[i+1].startsWith('--')) throw new Error('Usage: npm run eval:compare -- --mode generation|judge --cases cases.json --baseline old.txt --candidate new.txt');
    options[key]=args[i+1];
  }
  if(!options.mode||!options.cases||!options.baseline||!options.candidate) throw new Error('Comparison requires mode, cases, baseline and candidate');
  const cases=JSON.parse(await readFile(options.cases,'utf8'));
  validateCases(cases,options.mode);
  const config=await loadConfig(env);
  const [baseline,candidate,judgePrompt]=await Promise.all([loadPrompt(options.baseline),loadPrompt(options.candidate),loadPrompt(config.judgePrompt)]);
  if(!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required for live comparisons');
  const client=new Anthropic({apiKey:env.ANTHROPIC_API_KEY,maxRetries:0,timeout:config.requestTimeoutMs});
  const lockText=await readFile(new URL('../package-lock.json',import.meta.url),'utf8');
  const lock=JSON.parse(lockText);
  const result=await runComparison({cases,mode:options.mode,baseline,candidate,judgePrompt,config,client,
    outputDir:env.REPORT_OUTPUT_DIR||'output/runs',baselineJudgeModel:options['baseline-model']||config.judgeModel,candidateJudgeModel:options['candidate-model']||config.judgeModel,
    metadata:{githubRunId:env.GITHUB_RUN_ID??null,githubRunAttempt:env.GITHUB_RUN_ATTEMPT??null,commit:env.GITHUB_SHA??null,nodeVersion:process.version,casesFile:options.cases,lockHash:hash(lockText),
      dependencyVersions:Object.fromEntries(['@anthropic-ai/sdk','promptfoo','diff'].map(name=>[name,lock.packages[`node_modules/${name}`]?.version??null]))}});
  if(env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,result.report.summary+'\n');
  console.log(`Comparison: ${result.status}\nReport: ${result.report.markdownPath}\nHTML: ${result.report.htmlPath}`);
  process.exitCode=result.exitCode;
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(()=>{
  console.error('Comparison failed. Check arguments and any preserved run report.');process.exitCode=1;
});
