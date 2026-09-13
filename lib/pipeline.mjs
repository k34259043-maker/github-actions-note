import { createRun } from './record-store.mjs';
import { writeReports } from './report.mjs';
import { createGateway } from './claude.mjs';
import { loadPrompt, buildBrief, RUBRIC, hash } from './domain.mjs';
import { collectEvidence, generateDraft, evaluateDraft, reviseDraft, proposePromptCandidate } from './quality.mjs';
import { saveNoteDraft } from './note-save.mjs';

function completedStatus(evaluation) {
  return evaluation.status === 'completed' ? 'completed' : 'completed_with_evaluation_warning';
}

export function workflowStatus({ dryRun, note, evaluation }) {
  if (dryRun) return completedStatus(evaluation);
  if (note.status === 'saved') return completedStatus(evaluation);
  if (note.status === 'not_started') return 'note_not_started';
  if (note.status === 'input_only') return 'note_input_incomplete';
  if (note.status === 'save_unconfirmed') return 'save_unconfirmed';
  return 'note_status_unknown';
}

function hasStrongSaveVerification(note, articleHash) {
  return note.status === 'saved'
    && note.reason === 'isolated_context_readback_matched'
    && note.articleHash === articleHash
    && note.verifiedHash === articleHash
    && note.publishActionPerformed === false
    && note.diagnostics?.stage === 'verified'
    && note.verification?.method === 'isolated_context_readback'
    && note.verification.titleMatched === true
    && note.verification.bodyMatched === true;
}

const safeNoteCode = (value) => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9_.=-]{0,95}$/.test(value) ? value : 'unknown';
const safeHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value : null;
const safeBoolean = (value) => typeof value === 'boolean' ? value : null;
const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

function safeFingerprint(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    sha256: safeHash(value.sha256),
    length: safeInteger(value.length),
    lines: safeInteger(value.lines),
    newlines: safeInteger(value.newlines),
  };
}

function safeComparison(value) {
  if (!value || typeof value !== 'object') return null;
  const part = (item) => item && typeof item === 'object' ? {
    matched: safeBoolean(item.matched),
    classification: safeNoteCode(item.classification),
    firstDifference: item.firstDifference === null ? null : safeInteger(item.firstDifference),
    expected: safeFingerprint(item.expected),
    observed: safeFingerprint(item.observed),
    observedLineEndingsConverted: safeInteger(item.observedLineEndingsConverted),
  } : null;
  return { title: part(value.title), body: part(value.body) };
}

function safeSelectorPhase(value) {
  return value && typeof value === 'object'
    ? { title: safeInteger(value.title), body: safeInteger(value.body) }
    : null;
}

// Persist an allowlisted projection. In particular, never copy an editor URL,
// browser exception, DOM text, or arbitrary future saver fields into artifacts.
export function noteEventData(note) {
  const verification = note?.verification && typeof note.verification === 'object' ? {
    method: safeNoteCode(note.verification.method),
    titleMatched: safeBoolean(note.verification.titleMatched),
    bodyMatched: safeBoolean(note.verification.bodyMatched),
    normalization: safeNoteCode(note.verification.normalization),
    verifiedAt: typeof note.verification.verifiedAt === 'string'
      && !Number.isNaN(Date.parse(note.verification.verifiedAt)) ? note.verification.verifiedAt : null,
  } : null;
  const diagnostics = note?.diagnostics && typeof note.diagnostics === 'object' ? {
    stage: safeNoteCode(note.diagnostics.stage),
    route: safeNoteCode(note.diagnostics.route),
    articleValidation: {
      bodyCanonical: safeBoolean(note.diagnostics.articleValidation?.bodyCanonical),
      hashMatched: safeBoolean(note.diagnostics.articleValidation?.hashMatched),
    },
    selectorCandidates: {
      editor: safeSelectorPhase(note.diagnostics.selectorCandidates?.editor),
      verification: safeSelectorPhase(note.diagnostics.selectorCandidates?.verification),
    },
    saveControl: {
      candidates: safeInteger(note.diagnostics.saveControl?.candidates),
      found: safeBoolean(note.diagnostics.saveControl?.found),
      visible: safeBoolean(note.diagnostics.saveControl?.visible),
      enabled: safeBoolean(note.diagnostics.saveControl?.enabled),
      clicked: safeBoolean(note.diagnostics.saveControl?.clicked),
      savingObserved: safeBoolean(note.diagnostics.saveControl?.savingObserved),
      readyObservedAfterSaving: safeBoolean(note.diagnostics.saveControl?.readyObservedAfterSaving),
    },
    settleMode: safeNoteCode(note.diagnostics.settleMode),
    settleElapsedMs: safeInteger(note.diagnostics.settleElapsedMs),
    input: safeComparison(note.diagnostics.input),
    readback: safeComparison(note.diagnostics.readback),
  } : null;
  return {
    status: safeNoteCode(note?.status),
    reason: safeNoteCode(note?.reason),
    articleId: typeof note?.articleId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(note.articleId)
      ? note.articleId : null,
    articleHash: safeHash(note?.articleHash),
    verifiedHash: safeHash(note?.verifiedHash),
    published: note?.published === 'unknown' ? 'unknown' : safeBoolean(note?.published),
    publishActionPerformed: safeBoolean(note?.publishActionPerformed),
    publicationVerified: safeBoolean(note?.publicationVerified),
    publicationReason: safeNoteCode(note?.publicationReason),
    verification,
    diagnostics,
    reportedStatus: note?.reportedStatus === undefined ? null : safeNoteCode(note.reportedStatus),
    reportedVerifiedHash: safeHash(note?.reportedVerifiedHash),
  };
}

export async function runWorkflow({inputs,config,client,dryRun=true,isPublic=false,outputDir='output/runs',metadata={},saveDraft=saveNoteDraft,noteStatePath='./note-state.json'}) {
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
    if(dryRun) note={status:'skipped',reason:'DRY_RUN=true',published:false,publishActionPerformed:false,
      publicationVerified:false,publicationReason:'dry_run_no_browser_write',articleHash:revised.article.hash,verifiedHash:null};
    else {
      try {note=await saveDraft(revised.article,{statePath:noteStatePath});}
      catch {note={status:'save_unconfirmed',reason:'note_save_exception',published:'unknown',publishActionPerformed:false,
        publicationVerified:false,publicationReason:'no_publish_action_implemented',articleHash:revised.article.hash,verifiedHash:null};
        await recorder.append('note.failed',{reason:'note_save_exception',stage:'unknown_after_save_started'});}
    }
    if(note.status==='saved'&&!hasStrongSaveVerification(note,revised.article.hash)) {
      const hashesMatch=note.articleHash===revised.article.hash&&note.verifiedHash===revised.article.hash;
      note={...note,status:'save_unconfirmed',reportedStatus:'saved',reportedVerifiedHash:note.verifiedHash??null,
        reason:hashesMatch?'verification_proof_missing_or_invalid':'verification_hash_mismatch',verifiedHash:null};
    }
    await recorder.append('note.completed',{...noteEventData(note),requestedPublic:isPublic,
      publicationPolicy:'This workflow creates a draft; no public publish action is implemented.'});
    const exitCode=dryRun||note.status==='saved'?0:1;
    const status=workflowStatus({dryRun,note,evaluation:revised.evaluation});
    await recorder.append('run.completed',{status,exitCode,finalArticleHash:revised.article.hash,
      finalEvaluationId:revised.evaluation.id,noteStatus:safeNoteCode(note.status),noteReason:safeNoteCode(note.reason)});
    Object.assign(result,{status,exitCode,article:revised.article,evaluation:revised.evaluation,note});
  } catch(error) {
    await recorder.append('run.failed',{error:error.message});
    result.error=error.message;
  } finally {
    result.report=await writeReports(recorder.dir);
  }
  return result;
}
