import { createRun } from './record-store.mjs';
import { writeReports } from './report.mjs';
import { createGateway } from './claude.mjs';
import { loadPrompt, buildBrief, RUBRIC, hash } from './domain.mjs';
import { collectEvidence, generateDraft, evaluateDraft, reviseDraft, proposePromptCandidate } from './quality.mjs';
import { saveNoteDraft } from './note-save.mjs';

export async function runWorkflow({inputs,config,client,dryRun=true,isPublic=false,outputDir='output/runs',metadata={},saveDraft=saveNoteDraft}) {
  const recorder=await createRun({outputDir,mode:'article',inputs,metadata:{...metadata,config,dryRun,isPublic,adoptionPolicy:config.adoptionPolicy}});
  const result={runDir:recorder.dir,status:'failed',exitCode:1};
  try {
    const [prompt,judgePrompt]=await Promise.all([loadPrompt(config.generationPrompt),loadPrompt(config.judgePrompt)]);
    const brief=buildBrief(inputs);
    await recorder.append('run.started',{brief,rubric:RUBRIC,prompt,judgePrompt,configHash:hash(config)});
    const gateway=createGateway({client,recorder,config});
    const evidence=await collectEvidence({gateway,recorder,inputs,brief,config});
    const before=await generateDraft({gateway,recorder,inputs,brief,evidence,prompt});
    const initialEvaluation=await evaluateDraft({gateway,recorder,inputs,brief,evidence,article:before,prompt:judgePrompt,config});
    const revised=await reviseDraft({gateway,recorder,inputs,brief,evidence,before,evaluation:initialEvaluation,judgePrompt,config});
    if(revised.evaluation.articleHash!==revised.article.hash) throw new Error('Final evaluation does not refer to the final article');
    await recorder.append('article.created',{role:'final',article:revised.article,evaluationId:revised.evaluation.id});
    await recorder.asset('final-article.json',revised.article);
    await recorder.asset('final-article.md',`# ${revised.article.title}\n\n${revised.article.body}\n`);
    await proposePromptCandidate({gateway,recorder,prompt,evaluations:revised.evaluation.id===initialEvaluation.id?[initialEvaluation]:[initialEvaluation,revised.evaluation],config});
    let note;
    if(dryRun) note={status:'skipped',reason:'DRY_RUN=true',published:false,articleHash:revised.article.hash,verifiedHash:null};
    else {
      try {note=await saveDraft(revised.article);}
      catch(error) {note={status:'not_started',reason:'note_save_exception',published:'unknown',articleHash:revised.article.hash,verifiedHash:null};await recorder.append('note.failed',{error:error.message});}
    }
    if(note.status==='saved'&&(note.articleHash!==revised.article.hash||note.verifiedHash!==revised.article.hash)) {
      note={...note,status:'save_unconfirmed',reportedStatus:'saved',reason:'verification_hash_mismatch',verifiedHash:null};
    }
    await recorder.append('note.completed',{...note,requestedPublic:isPublic,publicationPolicy:'This workflow creates a draft; no public publish action is implemented.'});
    const exitCode=dryRun||note.status==='saved'?0:1;
    const status=exitCode?'save_unconfirmed':revised.evaluation.status==='completed'?'completed':'completed_with_evaluation_warning';
    await recorder.append('run.completed',{status,exitCode,finalArticleHash:revised.article.hash,finalEvaluationId:revised.evaluation.id,noteStatus:note.status});
    Object.assign(result,{status,exitCode,article:revised.article,evaluation:revised.evaluation,note});
  } catch(error) {
    await recorder.append('run.failed',{error:error.message});
    result.error=error.message;
  } finally {
    result.report=await writeReports(recorder.dir);
  }
  return result;
}
