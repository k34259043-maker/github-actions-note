import path from 'node:path';
import { createRun } from './record-store.mjs';
import { writeReports } from './report.mjs';
import { evaluateWithPromptfoo } from './promptfoo.mjs';
import { createGateway } from './claude.mjs';
import { buildBrief, makeArticle, hash, newId, RUBRIC, readInputs } from './domain.mjs';
import { collectEvidence, generateDraft, evaluateDraft } from './quality.mjs';

export function validateCases(cases,mode) {
  if(!['generation','judge'].includes(mode)) throw new Error('Comparison mode must be generation or judge');
  if(!Array.isArray(cases)||!cases.length) throw new Error('At least one explicit comparison case is required');
  const ids=new Set();
  for(const c of cases) {
    if(typeof c.id!=='string'||!c.id.trim()||ids.has(c.id)) throw new Error('Cases need distinct nonempty IDs');
    ids.add(c.id);
    readInputs(Object.fromEntries(Object.entries(c.inputs??{}).map(([k,v])=>[k.toUpperCase(),v])));
    if(mode==='judge') makeArticle(c.article);
    if(c.evidence&&(!Array.isArray(c.evidence.sources)||c.evidence.sources.some(s=>typeof s.id!=='string'||typeof s.url!=='string'||typeof s.excerpt!=='string'))) throw new Error('Supplied evidence needs sources with id, url and excerpt');
  }
}

export async function runComparison({cases,mode,baseline,candidate,judgePrompt,config,client,outputDir='output/runs',metadata={},baselineJudgeModel=config.judgeModel,candidateJudgeModel=config.judgeModel}) {
  validateCases(cases,mode);
  const recorder=await createRun({outputDir,mode:`${mode}_compare`,inputs:{cases},metadata:{...metadata,config,baselineJudgeModel,candidateJudgeModel}});
  const result={runDir:recorder.dir,status:'failed',exitCode:1};
  try {
    const comparisonId=newId('comparison');
    await recorder.append('run.started',{mode,baseline,candidate,judgePrompt,rubric:RUBRIC,configHash:hash(config)});
    await recorder.append('comparison.planned',{comparisonId,kind:mode==='generation'?'generation_compare':'judge_compare',baseline,candidate,datasetHash:hash(cases),casePurposes:cases.map(c=>({id:c.id,purpose:c.purpose??'unspecified',expectedChanges:c.expectedChanges??null})),
      fixed:mode==='generation'?'各事例の入力・資料・生成モデル設定・評価器・基準':'各事例の入力・資料・同一原稿・基準。指定した評価指示/モデルだけ変更',
      adoptionPolicy:config.adoptionPolicy,automaticAdoption:false,conclusionLimit:'選択した事例の単発比較。因果効果や他の記事での有効性の証明ではない。'});
    const gateway=createGateway({client,recorder,config});
    const entries=[];
    for(const c of cases) {
      const brief=buildBrief(c.inputs);
      let evidence;
      if(c.evidence) {
        evidence={...c.evidence,id:c.evidence.id??newId('evidence'),origin:'supplied_snapshot',sources:c.evidence.sources};
        evidence.hash=hash(evidence);
        await recorder.append('evidence.collected',{caseId:c.id,snapshot:evidence});
      } else evidence=await collectEvidence({gateway,recorder,inputs:c.inputs,brief,config});
      // Both generation variants get exactly the same acquired snapshot.
      const common={caseId:c.id,inputs:c.inputs,brief,evidence};
      const fixedArticle=mode==='judge'?makeArticle(c.article):null;
      for(const variant of ['baseline','candidate']) {
        const variantPrompt=variant==='baseline'?baseline:candidate;
        const article=fixedArticle??await generateDraft({gateway,recorder,inputs:c.inputs,brief,evidence,prompt:variantPrompt,role:variant,caseId:c.id});
        if(fixedArticle) await recorder.append('article.created',{role:variant,caseId:c.id,article,fixedForJudgeComparison:true});
        const evaluatorPrompt=mode==='judge'?variantPrompt:judgePrompt;
        const model=mode==='judge'?(variant==='baseline'?baselineJudgeModel:candidateJudgeModel):config.judgeModel;
        entries.push({...common,id:newId('entry'),variant,article,evaluatorPrompt,evaluatorConditions:{promptHash:evaluatorPrompt.hash,model,rubricHash:hash(RUBRIC),maxTokens:config.evaluationMaxTokens,evidenceHash:evidence.hash,inputHash:hash(c.inputs)}});
      }
    }
    const evaluated=await evaluateWithPromptfoo({entries,outputDir:path.join(recorder.dir,'promptfoo'),evaluator:entry=>evaluateDraft({gateway,recorder,inputs:entry.inputs,brief:entry.brief,evidence:entry.evidence,article:entry.article,prompt:entry.evaluatorPrompt,config:{...config,judgeModel:entry.evaluatorConditions.model}})});
    const observations=cases.map(c=>{
      const pair=evaluated.entries.filter(e=>e.caseId===c.id),old=pair.find(e=>e.variant==='baseline'),next=pair.find(e=>e.variant==='candidate');
      return {caseId:c.id,beforeHash:old.article.hash,afterHash:next.article.hash,beforeEvaluationId:old.evaluation.id,afterEvaluationId:next.evaluation.id,
        beforeConditions:old.evaluation.conditions??old.evaluatorConditions,afterConditions:next.evaluation.conditions??next.evaluatorConditions,evaluationStatus:[old.evaluation.status,next.evaluation.status],
        axes:RUBRIC.axes.map(a=>({id:a.id,before:old.evaluation.axes.find(x=>x.id===a.id)?.score??null,after:next.evaluation.axes.find(x=>x.id===a.id)?.score??null})),
        expectedChanges:c.expectedChanges??null,targetedImprovement:'未判定：項目別の値だけで狙いの達成を確定しない。出力と指摘を確認する。',
        humanReference:c.humanReference??null};
    });
    await recorder.append('comparison.completed',{comparisonId,kind:mode==='generation'?'generation_compare':'judge_compare',status:evaluated.status,observations,
      promptfoo:{version:evaluated.engineVersion,resultsPath:evaluated.resultsPath,htmlPath:evaluated.htmlPath,normalizedPath:evaluated.normalizedPath,scoreMeaning:evaluated.scoreMeaning},
      conclusionLimit:mode==='generation'?'同じ入力・根拠で新規生成した出力の差。個々の指示の因果効果・一般化は未検証。':'同一原稿の判定差。人の確認との照合結果がない限り、評価精度向上とは言えない。'});
    await recorder.append('adoption.decided',{status:'held',reason:'比較結果を保存。共通プロンプトの自動採用範囲・許容する悪化・費用時間の方針が未決定のため、自動で設定へ反映しない。',comparisonId,policy:config.adoptionPolicy,baselinePromptId:baseline.id,candidatePromptId:candidate.id});
    await recorder.append('note.completed',{status:'skipped',reason:'比較実行のためnoteへの入力対象外',published:false});
    result.status=evaluated.status; result.exitCode=evaluated.status==='completed'?0:1;
    await recorder.append('run.completed',{status:result.status,exitCode:result.exitCode});
    result.comparison=evaluated;
  } catch(error) {await recorder.append('run.failed',{error:error.message});result.error=error.message;}
  finally {result.report=await writeReports(recorder.dir);}
  return result;
}
