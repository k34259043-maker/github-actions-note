import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const newId = prefix => `${prefix}-${randomUUID()}`;
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Produce the canonical article text before its immutable hash is calculated.
 * Line-ending conversion is platform transport normalization. Horizontal
 * whitespace at line ends is excluded because the generation prompt forbids it
 * and rich-text editors need not preserve invisible Markdown spacing markers.
 */
export function canonicalizeArticleBody(value) {
  const lineEndingsConverted = (value.match(/\r\n|\r/g) ?? []).length;
  const withLf = value.replace(/\r\n?/g, '\n');
  const trailing = [...withLf.matchAll(/[\t ]+$/gm)];
  const body = withLf.replace(/[\t ]+$/gm, '');
  return {
    body,
    details: {
      algorithm: 'lf_and_no_trailing_horizontal_whitespace_v1',
      sourceHash: hash(value),
      canonicalHash: hash(body),
      lineEndingsConverted,
      affectedLines: trailing.length,
      charactersRemoved: trailing.reduce((sum, match) => sum + match[0].length, 0),
    },
  };
}

export const normalizeArticleBody = value => canonicalizeArticleBody(value).body;
export function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('Boolean configuration must be true or false');
}
export function articleText(article) { return `${article.title}\n\n${article.body}`; }
export function makeArticle(data) {
  if (!isObject(data) || typeof data.title !== 'string' || typeof data.body !== 'string' || !data.title.trim() || !data.body.trim()) {
    throw new Error('Article must contain a nonempty title and body');
  }
  if (data.title.includes('\n')) throw new Error('Article title must be one line');
  const canonical = canonicalizeArticleBody(data.body);
  const body = canonical.body;
  return { id: newId('article'), hash: hash({ title: data.title, body }), title: data.title, body,
    bodyNormalization: canonical.details,
    editorialChoices: data.editorialChoices ?? [], unresolved: data.unresolved ?? [] };
}
export async function loadPrompt(file) {
  const template = await readFile(file, 'utf8');
  if (!template.trim()) throw new Error('Empty prompt file');
  return { id: path.basename(file), hash: hash(template), template };
}
export async function loadConfig(env = process.env) {
  const config = JSON.parse(await readFile(env.QUALITY_CONFIG || new URL('../config/quality.json', import.meta.url), 'utf8'));
  config.generationModel = env.GENERATION_MODEL || config.generationModel;
  config.judgeModel = env.JUDGE_MODEL || config.judgeModel;
  config.research.enabled = bool(env.RESEARCH_ENABLED, config.research.enabled);
  if (config.promptCandidates.autoAdopt !== false) throw new Error('Automatic common prompt adoption is not configured; keep autoAdopt=false');
  for (const key of ['maxTokens', 'evaluationMaxTokens', 'requestTimeoutMs']) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isSafeInteger(config.research.maxSearches) || config.research.maxSearches <= 0) throw new Error('Invalid maxSearches');
  return config;
}
export function readInputs(env = process.env) {
  const inputs = Object.fromEntries(['theme','target','message','cta','tags'].map(key => [key, env[key.toUpperCase()] ?? '']));
  if (Object.values(inputs).some(value => typeof value !== 'string' || !value.trim())) throw new Error('THEME, TARGET, MESSAGE, CTA and TAGS are required');
  return inputs;
}
export function buildBrief(inputs) {
  return { requirements: [
    { id:'R1', origin:'user', content: inputs.theme },
    { id:'R2', origin:'user', content: inputs.target },
    { id:'R3', origin:'user', content: inputs.message },
    { id:'R4', origin:'user', content: inputs.cta },
  ], providedInputs:inputs, authorEvidence: '入力に明示された内容のみ。未提供の体験・実績は未確認。', inferredRequirements: [] };
}
export const RUBRIC = {
  version:'1', scope:'Japanese note editorial review; ordinal reference ratings, not calibrated probabilities',
  axes: [
    {id:'Q1',name:'読者との適合・読む理由',anchors:['対象・目的が異なる','対象語だけで場面や知識に合わない','大筋は合うが重要な前提が曖昧','読者の前提と読む理由が明確','具体的な場面に即し、目的に必要十分な内容である']},
    {id:'Q2',name:'記事の約束の達成',anchors:['約束した内容がない','重要な手順・判断材料が欠ける','一部答えるが重要箇所に追加推測が必要','示した前提で約束を満たす','必要な確認方法や適用限界まで過不足なく示す']},
    {id:'Q3',name:'理解・判断への貢献',anchors:['標語や結論だけ','例が断片的で説明につながらない','例は関連するが理由・使い分けが弱い','理由と具体例が結び付き理解・判断に使える','必要な適用条件や対比例があり誤用を防げる']},
    {id:'Q4',name:'文章としての伝わりやすさ',anchors:['文や構造が壊れている','飛躍や不自然な表現が多い','読めるが重複・順序が負担になる','自然な日本語で順序が明確','簡潔で文のつながりと分量が目的に合う']},
  ], note:'0〜4の段階評価。最高点のために不要な記述を追加しない。未確認はnull。総合点なし。'
};

const str = { type:'string' };
const list = items => ({ type:'array', items });
const obj = properties => ({ type:'object', properties, required:Object.keys(properties), additionalProperties:false });
export const ARTICLE_SCHEMA = obj({ title:str, body:str, editorialChoices:list(obj({choice:str,reason:str})), unresolved:list(str) });
export const EVALUATION_SCHEMA = obj({
  axes:list(obj({id:{type:'string',enum:['Q1','Q2','Q3','Q4']},score:{type:['integer','null']},reason:str,quote:str})),
  claims:list(obj({id:str,quote:str,kind:{type:'string',enum:['author','external']},status:{type:'string',enum:['supported','contradicted','insufficient','unverified']},evidenceIds:list(str),inputQuote:str,reason:str})),
  findings:list(obj({id:str,category:{type:'string',enum:['factual','requirements','title','editorial','evaluation','processing']},severity:{type:'string',enum:['major','minor']},quote:str,reason:str,fix:str,autoFix:{type:'boolean'},fixTarget:{type:'string',enum:['article','evidence','generation_prompt','judge','processing','unknown']},evidenceIds:list(str),requirementId:str,preserve:list(str),cause:obj({type:{type:'string',enum:['input_evidence','generation_prompt','evaluation','processing','unknown']},certainty:{type:'string',enum:['confirmed','hypothesis','undetermined']},reason:str})})),
  preserve:list(str),unknowns:list(str)
});
export const CANDIDATE_SCHEMA = obj({ needed:{type:'boolean'},reason:str,changes:list(obj({operation:{type:'string',enum:['add','delete','rewrite','move']},before:str,after:str,findingIds:list(str),reason:str,expectedEffect:str})),template:str });
export const REVIEW_SCHEMA = obj({ resolutions:list(obj({findingId:str,status:{type:'string',enum:['resolved','partial','unresolved','unknown']},beforeQuote:str,afterQuote:str,reason:str})), regressions:list(obj({quote:str,reason:str})), lostContent:list(str),unrequestedChanges:list(str),newClaims:list(str),unknowns:list(str) });

export function parseJson(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/, '$1');
  return JSON.parse(clean);
}
export function validateEvaluation(data, article, evidence, brief) {
  const errors=[];
  if (!isObject(data)) return ['Evaluation must be an object'];
  const text=articleText(article), sources=new Set((evidence.sources??[]).map(s=>s.id)), reqs=new Set(brief.requirements.map(r=>r.id));
  for (const name of ['axes','claims','findings','preserve','unknowns']) if (!Array.isArray(data[name])) errors.push(`${name} must be an array`);
  if (errors.length) return errors;
  if (data.axes.length!==4 || new Set(data.axes.map(a=>a.id)).size!==4) errors.push('Exactly four distinct quality axes are required');
  for (const a of data.axes) {
    if (!['Q1','Q2','Q3','Q4'].includes(a.id) || !(a.score===null || Number.isInteger(a.score)&&a.score>=0&&a.score<=4)) errors.push('Invalid ordinal score');
    if (typeof a.reason!=='string' || !a.reason.trim() || typeof a.quote!=='string' || (a.score!==null && !a.quote) || (a.quote&&!text.includes(a.quote))) errors.push('Axis reason or source quote is invalid');
  }
  for (const collection of [data.claims,data.findings]) {
    if (new Set(collection.map(x=>x.id)).size!==collection.length) errors.push('Duplicate finding/claim IDs');
    for (const x of collection) {
      if (typeof x.id!=='string'||!x.id || typeof x.quote!=='string'||!x.quote||!text.includes(x.quote)) errors.push('Quoted original text does not exist');
      if (!Array.isArray(x.evidenceIds)||x.evidenceIds.some(id=>!sources.has(id))) errors.push('Unknown evidence ID');
    }
  }
  for (const c of data.claims) {
    if (!['author','external'].includes(c.kind)||!['supported','contradicted','insufficient','unverified'].includes(c.status)) errors.push('Invalid claim state');
    if (c.kind==='external'&&['supported','contradicted'].includes(c.status)&&!c.evidenceIds?.length) errors.push('External factual confirmation requires retrieved evidence');
    if(c.kind==='author'&&['supported','contradicted'].includes(c.status)) {
      const supplied=Object.values(brief.providedInputs??{}).filter(v=>typeof v==='string');
      if(typeof c.inputQuote!=='string'||!c.inputQuote.trim()||!supplied.some(v=>v.includes(c.inputQuote))) errors.push('Author claim confirmation requires an exact quote from user inputs');
      if(c.status==='supported'&&c.inputQuote!==c.quote) errors.push('Paraphrased author claims require review; supported requires the exact supplied claim');
    }
  }
  for (const f of data.findings) {
    if (!['major','minor'].includes(f.severity)||typeof f.autoFix!=='boolean'||!isObject(f.cause)||!['input_evidence','generation_prompt','evaluation','processing','unknown'].includes(f.cause?.type)||!['confirmed','hypothesis','undetermined'].includes(f.cause?.certainty)) errors.push('Invalid finding diagnosis');
    if (f.requirementId && !reqs.has(f.requirementId)) errors.push('Unknown requirement ID');
    if (typeof f.reason!=='string'||typeof f.fix!=='string'||!Array.isArray(f.preserve)) errors.push('Invalid finding explanation');
  }
  return [...new Set(errors)];
}
