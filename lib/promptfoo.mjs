import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { sanitize } from './record-store.mjs';

const AXIS_IDS = ['Q1', 'Q2', 'Q3', 'Q4'];
const TECHNICAL_PASS_NOTICE = 'PASS/scoreは評価記録の取得・形式・記事の一致だけを示します。記事の品質・公開可否・プロンプト採用の判定ではありません。';

function unknownAxes(reason) {
  return AXIS_IDS.map((id) => ({ id, score: null, reason, quote: '' }));
}

function failedEvaluation(entry, status, code) {
  return {
    id: `${entry.id}:promptfoo:${code}`,
    articleHash: entry.article.hash,
    status,
    axes: unknownAxes(code),
    findings: [],
    claims: [],
    error: { code },
  };
}

// The application owns the detailed editorial schema. This boundary prevents a
// malformed or differently-bound judge response from becoming a valid PF record.
function bindEvaluation(entry, value) {
  // Promptfoo's exports bypass the record store, so stop unsafe judge data at
  // this boundary rather than trusting its own best-effort export redaction.
  try {
    if (!isDeepStrictEqual(value, sanitize(value))) {
      return failedEvaluation(entry, 'invalid', 'EVALUATION_CONTAINS_RESTRICTED_DATA');
    }
  } catch {
    return failedEvaluation(entry, 'invalid', 'EVALUATION_CANNOT_BE_SAFELY_RECORDED');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return failedEvaluation(entry, 'invalid', 'EVALUATION_NOT_OBJECT');
  }
  if (value.articleHash !== entry.article.hash) {
    return failedEvaluation(entry, 'invalid', 'ARTICLE_HASH_MISMATCH');
  }
  if (!['completed', 'invalid', 'failed'].includes(value.status)) {
    return failedEvaluation(entry, 'invalid', 'INVALID_EVALUATION_STATUS');
  }
  if (typeof value.id !== 'string' || !value.id.trim()) {
    return failedEvaluation(entry, 'invalid', 'EVALUATION_ID_MISSING');
  }
  if (value.status !== 'completed') {
    return {
      ...value,
      axes: unknownAxes(`evaluation_${value.status}`),
      findings: Array.isArray(value.findings) ? value.findings : [],
      claims: Array.isArray(value.claims) ? value.claims : [],
    };
  }
  if (!Array.isArray(value.axes) || value.axes.length !== AXIS_IDS.length ||
      !AXIS_IDS.every((id) => value.axes.filter((axis) => axis?.id === id).length === 1) ||
      value.axes.some((axis) => !(axis.score === null ||
        (Number.isInteger(axis.score) && axis.score >= 0 && axis.score <= 4)) ||
        typeof axis.reason !== 'string' || typeof axis.quote !== 'string') ||
      !Array.isArray(value.findings) || !Array.isArray(value.claims)) {
    return failedEvaluation(entry, 'invalid', 'INVALID_EVALUATION_SCHEMA');
  }
  return structuredClone(value);
}

function assertionResult(evaluation) {
  const completed = evaluation.status === 'completed';
  const namedScores = {};
  const axes = evaluation.axes.map((axis) => {
    const normalizedScore = axis.score === null ? null : axis.score / 4;
    if (normalizedScore !== null) namedScores[axis.id] = normalizedScore;
    return { ...axis, rawScore: axis.score, normalizedScore };
  });
  const summary = axes.map((axis) => `${axis.id}: ${axis.rawScore === null ? '未評価' : `${axis.rawScore}/4`}`).join(' / ');
  const unknownClaims = evaluation.claims.filter((claim) =>
    !['supported', 'contradicted'].includes(claim.status)).length;
  return {
    pass: completed,
    score: completed ? 1 : 0,
    reason: `${TECHNICAL_PASS_NOTICE}\n状態: ${evaluation.status}\n${summary}\n裏付け・反証の確定していない主張: ${unknownClaims}件`,
    namedScores,
    metadata: {
      evaluationId: evaluation.id,
      articleHash: evaluation.articleHash,
      evaluationStatus: evaluation.status,
      axes,
      findings: evaluation.findings,
      claims: evaluation.claims,
      scoreMeaning: 'evaluation_record_validity_only',
    },
  };
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('Promptfoo requires at least one article entry.');
  }
  const ids = new Set();
  const cells = new Set();
  for (const entry of entries) {
    if (!entry || !['id', 'variant', 'caseId'].every((key) => typeof entry[key] === 'string' && entry[key].trim()) ||
        !entry.article || !['id', 'hash', 'title', 'body'].every((key) => typeof entry.article[key] === 'string') ||
        !entry.article.id || !entry.article.hash) {
      throw new TypeError('Each entry requires id, variant, caseId and article id/hash/title/body.');
    }
    if (ids.has(entry.id)) throw new TypeError(`Duplicate entry ID: ${entry.id}`);
    const cell = JSON.stringify([entry.caseId, entry.variant]);
    if (cells.has(cell)) throw new TypeError('One entry per case/variant is required; give repeated trials distinct case IDs.');
    ids.add(entry.id);
    cells.add(cell);
  }
}

/**
 * Evaluate already-created, immutable article snapshots through Promptfoo.
 *
 * Providers are variants (before/after, old/new judge); cases are table rows.
 * The injected evaluator is invoked once per entry, never once per axis.
 * Its closure must use the recorded conditions for that entry. Results are not
 * reused across invocations, even when article text and IDs are unchanged.
 */
export async function evaluateWithPromptfoo({ entries, outputDir, evaluator }) {
  // Never redact an article and continue under the original article hash. A
  // sanitized snapshot would be different text from what the caller recorded.
  // This check precedes validation, file creation and any engine/model calls.
  let safeEntries;
  try { safeEntries = sanitize(entries); }
  catch { throw new TypeError('Promptfoo entries cannot be safely recorded.'); }
  if (!isDeepStrictEqual(entries, safeEntries)) {
    throw new TypeError('Promptfoo entries contain restricted data and cannot be exported.');
  }
  validateEntries(entries);
  if (typeof evaluator !== 'function') throw new TypeError('An explicit evaluator function is required.');
  if (typeof outputDir !== 'string' || !outputDir) throw new TypeError('An execution-specific outputDir is required.');
  const snapshots = structuredClone(entries);
  const variants = [...new Set(snapshots.map((entry) => entry.variant))];
  const caseIds = [...new Set(snapshots.map((entry) => entry.caseId))];
  const byCell = new Map(snapshots.map((entry) => [JSON.stringify([entry.caseId, entry.variant]), entry]));
  const evaluated = new Map();
  const pending = new Map();
  const absoluteDir = path.resolve(outputDir);
  await mkdir(absoluteDir, { recursive: true });
  const resultsPath = path.join(absoluteDir, 'promptfoo-results.json');
  const htmlPath = path.join(absoluteDir, 'promptfoo-results.html');
  const normalizedPath = path.join(absoluteDir, 'evaluations.json');
  const manifestPath = path.join(absoluteDir, 'promptfoo-invocation.json');
  const missingCells = caseIds.flatMap((caseId) => variants
    .filter((variant) => !byCell.has(JSON.stringify([caseId, variant])))
    .map((variant) => ({ caseId, variant, status: 'not_evaluated' })));
  const startedAt = new Date().toISOString();
  // Reserve the directory before any evaluation. Retries must use another dir;
  // do not overwrite the last run or reconstruct it from the latest prompt.
  await writeFile(manifestPath, `${JSON.stringify({
    startedAt,
    cache: false,
    writeLatestResults: false,
    sharing: false,
    scoreMeaning: 'evaluation_record_validity_only',
    entries: snapshots.map((entry) => ({
      id: entry.id, variant: entry.variant, caseId: entry.caseId,
      articleId: entry.article.id, articleHash: entry.article.hash,
      evaluatorConditions: entry.evaluatorConditions ?? null,
    })),
    missingCells,
  }, null, 2)}\n`, { flag: 'wx' });

  const evaluateOnce = async (entry) => {
    if (!pending.has(entry.id)) {
      pending.set(entry.id, (async () => {
        let evaluation;
        try {
          evaluation = bindEvaluation(entry, await evaluator(structuredClone(entry)));
        } catch {
          // API error messages can contain request content or credentials. The
          // caller's execution ledger captures sanitized operational details.
          evaluation = failedEvaluation(entry, 'failed', 'EVALUATOR_EXCEPTION');
        }
        evaluated.set(entry.id, evaluation);
        return evaluation;
      })());
    }
    return pending.get(entry.id);
  };

  // No model is selected implicitly from ambient credentials. The custom
  // provider only returns supplied snapshots; all judging uses the given hook.
  process.env.PROMPTFOO_DISABLE_TELEMETRY = '1';
  process.env.PROMPTFOO_DISABLE_UPDATE_CHECK = '1';
  let engineError = null;
  let engineVersion = null;
  let summary = null;
  try {
    const require = createRequire(import.meta.url);
    const packagePath = path.resolve(path.dirname(require.resolve('promptfoo')), '../../package.json');
    engineVersion = JSON.parse(await readFile(packagePath, 'utf8')).version;
    const promptfooModule = await import('promptfoo');
    const engine = promptfooModule.default ?? promptfooModule;
    const providers = variants.map((variant) => ({
      id: () => `article-snapshot:${variant}`,
      label: variant,
      callApi: async (_prompt, context) => {
        const entry = byCell.get(JSON.stringify([context.vars.caseId, variant]));
        if (!entry) return { error: 'NOT_EVALUATED: no article exists for this case/variant.' };
        return {
          output: `# ${entry.article.title}\n\n${entry.article.body}`,
          metadata: { entryId: entry.id, articleId: entry.article.id, articleHash: entry.article.hash, variant },
        };
      },
    }));
    const record = await engine.evaluate({
      description: TECHNICAL_PASS_NOTICE,
      prompts: [{ raw: '{{caseId}}', label: 'Recorded article snapshot' }],
      providers,
      tests: caseIds.map((caseId) => ({
        description: caseId,
        vars: { caseId },
        assert: [{
          type: 'javascript',
          metric: 'evaluation_record_valid',
          value: async (_output, context) => {
            const entryId = context.providerResponse?.metadata?.entryId;
            const entry = snapshots.find((item) => item.id === entryId);
            if (!entry) return { pass: false, score: 0, reason: 'ARTICLE_ENTRY_NOT_FOUND' };
            return assertionResult(await evaluateOnce(entry));
          },
        }],
      })),
      writeLatestResults: false,
      sharing: false,
      outputPath: [resultsPath, htmlPath],
    }, {
      cache: false,
      maxConcurrency: 1,
      showProgressBar: false,
    });
    summary = await record.toEvaluateSummary();
  } catch {
    engineError = { code: 'PROMPTFOO_ENGINE_FAILED' };
  }
  const normalizedEntries = snapshots.map((entry) => ({
    ...entry,
    evaluation: evaluated.get(entry.id) ?? failedEvaluation(entry, 'failed', 'PROMPTFOO_ENTRY_NOT_EXECUTED'),
  }));
  const result = {
    engine: 'promptfoo',
    engineVersion,
    engineError,
    startedAt,
    completedAt: new Date().toISOString(),
    scoreMeaning: 'evaluation_record_validity_only',
    entries: normalizedEntries,
    comparison: { variants, caseIds, missingCells },
  };
  await writeFile(normalizedPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return {
    ...result,
    status: engineError ? 'failed' : !missingCells.length && normalizedEntries.every((entry) => entry.evaluation.status === 'completed') ? 'completed' : 'partial',
    resultsPath: summary ? resultsPath : null,
    htmlPath: summary ? htmlPath : null,
    normalizedPath,
    manifestPath,
  };
}
