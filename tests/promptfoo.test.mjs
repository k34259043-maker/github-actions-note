import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateWithPromptfoo } from '../lib/promptfoo.mjs';

function entry(variant, caseId = 'case-1') {
  return {
    id: `${caseId}:${variant}`,
    caseId,
    variant,
    article: { id: `article:${caseId}:${variant}`, hash: `hash:${caseId}:${variant}`, title: `${variant}記事`, body: `本文 ${caseId} ${variant}` },
    inputs: { theme: 'GitHub Actions' },
    evidence: [],
    evaluatorConditions: { model: 'offline-fixture', rubricHash: 'rubric-fixture' },
  };
}

function evaluation(item, scores = [0, null, 2, 4]) {
  return {
    id: `evaluation:${item.id}`,
    articleHash: item.article.hash,
    status: 'completed',
    axes: scores.map((score, index) => ({ id: `Q${index + 1}`, score, reason: score === null ? '資料不足' : 'fixture reason', quote: item.article.body })),
    findings: [{ id: `finding:${item.id}`, severity: 'major', quote: item.article.title, reason: 'fixture only' }],
    claims: [{ id: 'claim-1', status: 'unverified', quote: '未検証の主張' }],
  };
}

async function temporary(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'note-promptfoo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('actual Promptfoo exports paired snapshots and keeps unknown distinct from zero', async (t) => {
  const dir = await temporary(t);
  const calls = [];
  const entries = [entry('before'), entry('after')];
  const result = await evaluateWithPromptfoo({
    entries,
    outputDir: dir,
    evaluator: async (item) => { calls.push(item.id); return evaluation(item); },
  });
  assert.equal(result.engine, 'promptfoo');
  assert.equal(result.status, 'completed');
  assert.equal(result.engineVersion, '0.123.0');
  assert.deepEqual(calls.sort(), entries.map((item) => item.id).sort());
  assert.deepEqual(result.entries.map((item) => item.evaluation.axes.map((axis) => axis.score)), [[0, null, 2, 4], [0, null, 2, 4]]);
  const native = JSON.parse(await readFile(result.resultsPath, 'utf8'));
  const nativeRows = native.results.results;
  assert.equal(nativeRows.length, 2);
  assert.deepEqual(new Set(nativeRows.map((row) => row.response.metadata.variant)), new Set(['before', 'after']));
  for (const row of nativeRows) {
    assert.equal(row.success, true, 'native PASS means valid record even with major findings and score zero');
    assert.equal(row.score, 1);
    const grade = row.gradingResult.componentResults[0];
    assert.equal(grade.namedScores.Q1, 0);
    assert.equal(Object.hasOwn(grade.namedScores, 'Q2'), false);
    assert.equal(grade.metadata.axes[1].rawScore, null);
    assert.equal(grade.metadata.axes[1].normalizedScore, null);
    assert.equal(grade.metadata.claims[0].status, 'unverified');
    assert.equal(grade.metadata.articleHash, row.response.metadata.articleHash);
  }
  const html = await readFile(result.htmlPath, 'utf8');
  assert.match(html, /before記事/);
  assert.match(html, /after記事/);
  assert.match(html, /公開可否/);
  const canonical = JSON.parse(await readFile(result.normalizedPath, 'utf8'));
  assert.equal(canonical.entries[1].article.hash, entries[1].article.hash);
  assert.equal(canonical.entries[1].evaluation.articleHash, entries[1].article.hash);
});

test('rejects cross-article evaluations and isolates judge exceptions without leaking messages', async (t) => {
  const dir = await temporary(t);
  const entries = [entry('mismatch'), entry('exception'), entry('valid')];
  const result = await evaluateWithPromptfoo({
    entries,
    outputDir: dir,
    evaluator: async (item) => {
      if (item.variant === 'exception') throw new Error('secret-key-must-never-be-exported');
      const value = evaluation(item);
      if (item.variant === 'mismatch') value.articleHash = 'different-article';
      return value;
    },
  });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.entries.map((item) => item.evaluation.status), ['invalid', 'failed', 'completed']);
  assert.equal(result.entries[0].evaluation.error.code, 'ARTICLE_HASH_MISMATCH');
  assert.equal(result.entries[1].evaluation.error.code, 'EVALUATOR_EXCEPTION');
  assert.ok(result.entries[0].evaluation.axes.every((axis) => axis.score === null));
  for (const file of [result.resultsPath, result.htmlPath, result.normalizedPath]) {
    assert.doesNotMatch(await readFile(file, 'utf8'), /secret-key-must-never-be-exported/);
  }
});

test('changed judges re-evaluate identical snapshots and prior artifacts cannot be overwritten', async (t) => {
  const dir = await temporary(t);
  const same = entry('before');
  same.evaluation = evaluation(same, [4, 4, 4, 4]);
  let calls = 0;
  const run = (outputDir, score) => evaluateWithPromptfoo({
    entries: [same], outputDir,
    evaluator: async (item) => { calls += 1; return evaluation(item, [score, score, score, score]); },
  });
  const first = await run(path.join(dir, 'judge-a'), 0);
  const second = await run(path.join(dir, 'judge-b'), 3);
  assert.equal(calls, 2, 'no cache or incoming evaluation may bypass changed judge');
  assert.equal(first.entries[0].evaluation.axes[0].score, 0);
  assert.equal(second.entries[0].evaluation.axes[0].score, 3);
  const original = await readFile(first.normalizedPath, 'utf8');
  await assert.rejects(run(path.join(dir, 'judge-a'), 4), { code: 'EEXIST' });
  assert.equal(calls, 2, 'collision must stop before another model call');
  assert.equal(await readFile(first.normalizedPath, 'utf8'), original);
});

test('missing comparison cells are explicit and do not fabricate evaluations', async (t) => {
  const dir = await temporary(t);
  const entries = [entry('before', 'case-1'), entry('after', 'case-1'), entry('before', 'case-2')];
  let calls = 0;
  const result = await evaluateWithPromptfoo({
    entries, outputDir: dir,
    evaluator: async (item) => { calls += 1; return evaluation(item); },
  });
  assert.equal(calls, 3);
  assert.equal(result.status, 'partial');
  assert.equal(result.entries.length, 3);
  assert.deepEqual(result.comparison.missingCells, [{ caseId: 'case-2', variant: 'after', status: 'not_evaluated' }]);
  const native = JSON.parse(await readFile(result.resultsPath, 'utf8'));
  assert.equal(native.results.results.filter((row) => row.response?.error?.includes('NOT_EVALUATED')).length, 1);
});

test('configured secrets are rejected before exporting snapshots and invalidated in judge output', async (t) => {
  const dir = await temporary(t);
  const secret = 'configured-test-secret-that-must-not-be-exported';
  const previous = process.env.NOTE_PROMPTFOO_TEST_SECRET;
  process.env.NOTE_PROMPTFOO_TEST_SECRET = secret;
  t.after(() => {
    if (previous === undefined) delete process.env.NOTE_PROMPTFOO_TEST_SECRET;
    else process.env.NOTE_PROMPTFOO_TEST_SECRET = previous;
  });
  let calls = 0;
  for (const target of ['article', 'input']) {
    const unsafe = entry('before');
    if (target === 'article') unsafe.article.body = `本文 ${secret}`;
    else unsafe.inputs.theme = `テーマ ${secret}`;
    const outputDir = path.join(dir, target);
    await assert.rejects(evaluateWithPromptfoo({
      entries: [unsafe], outputDir,
      evaluator: async (item) => { calls += 1; return evaluation(item); },
    }), (error) => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.match(error.message, /restricted data/);
      return true;
    });
    await assert.rejects(access(outputDir), { code: 'ENOENT' });
  }
  assert.equal(calls, 0, 'unsafe snapshots must not reach the engine or evaluator');

  const safe = entry('before');
  const printed = [];
  const originalOut = process.stdout.write;
  const originalError = process.stderr.write;
  const capture = (chunk, encoding, callback) => {
    printed.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) done();
    return true;
  };
  process.stdout.write = capture;
  process.stderr.write = capture;
  let result;
  try {
    result = await evaluateWithPromptfoo({
      entries: [safe], outputDir: path.join(dir, 'judge'),
      evaluator: async (item) => {
        calls += 1;
        const value = evaluation(item);
        value.axes[0].reason = `秘密を含む理由 ${secret}`;
        return value;
      },
    });
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalError;
  }
  assert.equal(calls, 1);
  assert.equal(result.status, 'partial');
  assert.equal(result.entries[0].article.hash, safe.article.hash);
  assert.equal(result.entries[0].article.body, safe.article.body);
  assert.equal(result.entries[0].evaluation.articleHash, safe.article.hash);
  assert.equal(result.entries[0].evaluation.status, 'invalid');
  assert.equal(result.entries[0].evaluation.error.code, 'EVALUATION_CONTAINS_RESTRICTED_DATA');
  assert.doesNotMatch(printed.join(''), new RegExp(secret));
  for (const file of [result.manifestPath, result.resultsPath, result.htmlPath, result.normalizedPath]) {
    assert.doesNotMatch(await readFile(file, 'utf8'), new RegExp(secret));
  }
});
