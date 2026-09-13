import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRun, appendRunEvent, readRun, sanitize, contentHash } from '../lib/record-store.mjs';
import { writeReports } from '../lib/report.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'note-reporting-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createRun({ outputDir: directory, runId: 'article-1', inputs: { theme: 'テーマ' }, ...options });
}

test('run IDs and assets never overwrite records or escape their run', async (t) => {
  const run = await fixture(t);
  const second = await createRun({ outputDir: path.dirname(run.dir), runId: 'article-1' });
  assert.notEqual(run.dir, second.dir);
  assert.notEqual(run.manifest.runId, second.manifest.runId);
  const asset = await run.asset('prompts/generation.txt', 'original\n');
  assert.equal(asset.hash, contentHash('original\n'));
  assert.equal(asset.bytes, Buffer.byteLength('original\n'));
  await assert.rejects(run.asset('prompts/generation.txt', 'changed'), { code: 'EEXIST' });
  assert.equal(await readFile(asset.path, 'utf8'), 'original\n');
  for (const unsafe of ['../manifest.json', '/tmp/leak', 'x/../../leak', 'a\\b', './bad', 'a//b']) {
    await assert.rejects(run.asset(unsafe, 'bad'), /safe relative path/);
  }
  await symlink(path.dirname(run.dir), path.join(run.dir, 'assets', 'shortcut'));
  await assert.rejects(run.asset('shortcut/leak', 'bad'), /real directory/);
  await assert.rejects(createRun({ outputDir: path.dirname(run.dir), runId: '../escape' }), /Invalid runId/);
});

test('concurrent appends preserve all numbered events and late feedback honors cutoff', async (t) => {
  const run = await fixture(t);
  const before = await run.append('run.completed', { status: 'draft' });
  const manifestBefore = await readFile(path.join(run.dir, 'manifest.json'), 'utf8');
  const eventBefore = await readFile(path.join(run.dir, 'events', '00000001.json'), 'utf8');
  // Cutoff is explicitly before all subsequent records, including same-millisecond writes.
  const cutoff = new Date(Date.parse(before.recordedAt) - 1).toISOString();
  assert.equal((await readRun(run.dir, { asOf: cutoff })).events.length, 0);
  await Promise.all(Array.from({ length: 8 }, (_, index) => appendRunEvent(run.dir, 'feedback.appended', { index })));
  const { events } = await readRun(run.dir);
  assert.equal(events.length, 9);
  assert.deepEqual(events.map((event) => event.eventId), Array.from({ length: 9 }, (_, index) => `E-${String(index + 1).padStart(8, '0')}`));
  assert.equal(new Set(events.slice(1).map((event) => event.data.index)).size, 8);
  assert.equal(await readFile(path.join(run.dir, 'manifest.json'), 'utf8'), manifestBefore);
  assert.equal(await readFile(path.join(run.dir, 'events', '00000001.json'), 'utf8'), eventBefore);
  await assert.rejects(readRun(run.dir, { asOf: 'not a date' }), /asOf/);
});

test('credentials are removed without destroying model token accounting', async (t) => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'secret-value-for-report-tests';
  t.after(() => original === undefined ? delete process.env.ANTHROPIC_API_KEY : process.env.ANTHROPIC_API_KEY = original);
  const run = await fixture(t, { inputs: { theme: 'secret-value-for-report-tests' }, metadata: { cookies: [{ name: 'sid', value: 'private' }] } });
  await run.append('call.started', { apiKey: 'different-secret', request: { max_tokens: 5000, headers: { Authorization: 'Bearer private-value' }, messages: [{ role: 'user', content: 'key secret-value-for-report-tests' }] } });
  await run.append('call.completed', { usage: { input_tokens: 0, output_tokens: 42 }, error: new Error('secret-value-for-report-tests') });
  const data = await readRun(run.dir);
  assert.equal(data.manifest.inputs.theme, '[REDACTED]');
  assert.equal(data.manifest.metadata.cookies, '[REDACTED]');
  assert.equal(data.events[0].data.apiKey, '[REDACTED]');
  assert.equal(data.events[0].data.request.headers.Authorization, '[REDACTED]');
  assert.equal(data.events[0].data.request.max_tokens, 5000);
  assert.deepEqual(data.events[1].data.usage, { input_tokens: 0, output_tokens: 42 });
  assert.ok(!JSON.stringify(data).includes('secret-value-for-report-tests'));
  assert.equal(sanitize('Bearer plain-auth-value'), 'Bearer [REDACTED]');
});

test('reports preserve full prompt lineage, machine differences, and unsafe text as text', async (t) => {
  const run = await fixture(t, { inputs: { theme: '<script>alert("input")</script>' } });
  await run.append('call.started', { callId: 'generate-1', stage: 'generate', prompt: { id: 'P1', hash: 'p1', template: '全テンプレート\n{{theme}}' }, request: { model: 'test-model', messages: [{ role: 'user', content: '展開済み全メッセージ\n<script>alert("request")</script>' }] } });
  await run.append('call.completed', { callId: 'generate-1', stage: 'generate', response: 'full raw response', model: 'test-model', usage: { input_tokens: 0 }, durationMs: 0 });
  await run.append('article.created', { role: 'before', article: { id: 'A1', hash: 'h1', title: '3倍になった', body: '元の本文全部\n```yaml\nx: 1\n```\n<script>alert("article")</script>' } });
  await run.append('article.created', { role: 'after', article: { id: 'A2', hash: 'h2', title: '自動化を始める', body: '修正した本文全部\n```yaml\nx: 2\n```' } });
  await run.append('article.created', { role: 'final', article: { id: 'A2', hash: 'h2', title: '自動化を始める', body: '修正した本文全部\n```yaml\nx: 2\n```' } });
  await run.append('evaluation.completed', { evaluation: { id: 'EV2', articleHash: 'h2', status: 'completed', axes: [{ id: 'Q1', score: 0, reason: 'まだ不十分' }, { id: 'Q2', score: null, reason: '評価不能' }], findings: [{ id: 'F1', issue: '根拠不足', quote: '元の引用', diagnosis: { cause: 'input', confidence: 'hypothesis' } }] } });
  await run.append('prompt.candidate', { status: 'unverified', before: { id: 'P1', hash: 'p1', template: '魅力的なタイトル\n維持する指示' }, after: { id: 'P2', hash: 'p2', template: '裏付けのあるタイトル\n維持する指示' }, changes: [{ id: 'PC1', operation: 'rewrite', before: '魅力的なタイトル', after: '裏付けのあるタイトル', findingIds: ['F1'], reason: '提供されていない実績を創作しない', expectedEffect: '未提供の倍率が使われない' }] });
  await run.append('note.completed', { status: 'saved', published: false, articleHash: 'h2', verifiedHash: 'h2' });
  await run.append('run.completed', {});
  const first = await writeReports(run.dir);
  const second = await writeReports(run.dir);
  assert.notEqual(first.markdownPath, second.markdownPath);
  const markdown = await readFile(first.markdownPath, 'utf8');
  const html = await readFile(first.htmlPath, 'utf8');
  for (const expected of ['全テンプレート', '展開済み全メッセージ', 'full raw response', '元の本文全部', '修正した本文全部', '-魅力的なタイトル', '+裏付けのあるタイトル', 'PC1', 'F1', '維持する指示']) assert.ok(markdown.includes(expected), expected);
  assert.ok(markdown.includes('0円とは扱いません'));
  assert.match(markdown, /Q1 \| 0/);
  assert.match(markdown, /Q2 \| 評価不能/);
  assert.ok(first.summary.includes('保存確認ハッシュは対象原稿と一致'));
  assert.ok(first.summary.includes('未採用・判断待ち'));
  assert.equal((first.summary.match(/^\| /gm) ?? []).length, 7); // header, separator, five overview rows
  assert.ok(html.includes('&lt;script&gt;alert('));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('<details>'));
  assert.ok(html.includes('default-src'));
  const metadata = JSON.parse(await readFile(path.join(path.dirname(first.markdownPath), 'report.json'), 'utf8'));
  assert.equal(metadata.eventIds.length, 9);
  assert.equal((await readdir(path.join(run.dir, 'reports'))).length, 2);
});

test('failed and incomplete runs do not appear successful or receive invented scores', async (t) => {
  const run = await fixture(t);
  await run.append('call.started', { callId: 'evaluate-1', stage: 'evaluate', request: {} });
  await run.append('call.failed', { callId: 'evaluate-1', stage: 'evaluate', error: 'invalid response', durationMs: 17 });
  await run.append('evaluation.failed', { error: 'invalid response' });
  const report = await writeReports(run.dir);
  assert.ok(report.summary.includes('処理失敗'));
  assert.ok(report.summary.includes('実行完了記録なし'));
  assert.ok(report.summary.includes('問題の有無は未確認'));
  assert.ok(report.summary.includes('noteへの入力・保存・公開は未確認'));
  assert.ok(!report.summary.includes('0点'));
});

test('late adoption only affects reports at or after its recorded time', async (t) => {
  const run = await fixture(t);
  await run.append('prompt.candidate', { status: 'unverified', before: { id: 'P1', template: 'before' }, after: { id: 'P2', template: 'after' } });
  await run.append('run.completed', {});
  const originalReport = await writeReports(run.dir);
  const originalText = await readFile(originalReport.markdownPath, 'utf8');
  const feedback = await appendRunEvent(run.dir, 'adoption.decided', { status: '保留', reason: '別の記事で確認が必要' });
  const earlierReport = await writeReports(run.dir, { asOf: new Date(Date.parse(feedback.recordedAt) - 1).toISOString() });
  const currentReport = await writeReports(run.dir);
  assert.ok(!earlierReport.summary.includes('別の記事で確認が必要'));
  assert.ok(currentReport.summary.includes('別の記事で確認が必要'));
  assert.equal(await readFile(originalReport.markdownPath, 'utf8'), originalText);
});

test('invalid final evaluations are held and final evaluation ID prevents same-hash substitution', async (t) => {
  const run = await fixture(t);
  const article = { id: 'A', hash: 'same-hash', title: '原稿', body: '同じ本文' };
  await run.append('article.created', { role: 'before', article });
  await run.append('evaluation.completed', { evaluation: { id: 'E-valid', articleHash: article.hash, status: 'completed', axes: [{ id: 'Q1', score: 4, reason: 'valid', quote: '同じ本文' }], findings: [] } });
  await run.append('evaluation.completed', { evaluation: { id: 'E-invalid', articleHash: article.hash, status: 'invalid', axes: [{ id: 'Q1', score: 4, reason: 'invalid reason', quote: '存在しない' }], findings: [], validationErrors: ['quote not in article'] } });
  await run.append('article.created', { role: 'final', article, evaluationId: 'E-invalid' });
  await run.append('run.completed', { status: 'completed_with_evaluation_warning' });
  const invalidReport = await writeReports(run.dir);
  const text = await readFile(invalidReport.markdownPath, 'utf8');
  assert.ok(invalidReport.summary.includes('E-invalid / invalid'));
  const invalidSection = text.split('### 評価 E-invalid')[1].split('## 後日の判断')[0];
  assert.match(invalidSection, /Q1 \| 判定保留/);
  assert.doesNotMatch(invalidSection, /Q1 \| 4/);
  await run.append('article.created', { role: 'final', article, evaluationId: 'E-missing' });
  const missingReport = await writeReports(run.dir);
  assert.ok(missingReport.summary.includes('対象原稿の評価記録がない'));
  await run.append('evaluation.failed', { evaluation: { id: 'E-missing', articleHash: article.hash, status: 'failed', axes: [], findings: [], unknowns: ['API error'] } });
  const failedReport = await writeReports(run.dir);
  assert.ok(failedReport.summary.includes('E-missing / failed'));
});

test('generation comparison reports every case and retains the actual prompt pair', async (t) => {
  const run = await fixture(t, { mode: 'generation_compare' });
  await run.append('comparison.planned', { kind: 'generation_compare', baseline: { id: 'old', template: '旧い指示' }, candidate: { id: 'new', template: '新しい指示' } });
  const observations = [];
  for (const id of ['case1', 'case2']) {
    for (const variant of ['baseline', 'candidate']) {
      await run.append('article.created', { caseId: id, role: variant, article: { id: `${id}-${variant}`, hash: `${id}-${variant}`, title: id, body: `${variant}本文${id}` } });
      await run.append('evaluation.completed', { evaluation: { id: `E-${id}-${variant}`, articleHash: `${id}-${variant}`, status: 'completed', axes: [], findings: id === 'case1' && variant === 'baseline' ? [{ id: 'F1', severity: 'major', reason: '第一事例だけの問題', quote: 'baseline本文case1' }] : [] } });
    }
    observations.push({ caseId: id, beforeHash: `${id}-baseline`, afterHash: `${id}-candidate`, beforeEvaluationId: `E-${id}-baseline`, afterEvaluationId: `E-${id}-candidate`, evaluationStatus: ['completed', 'completed'], axes: [] });
  }
  await run.append('comparison.completed', { kind: 'generation_compare', status: 'completed', observations });
  await run.append('run.completed', {});
  const report = await writeReports(run.dir);
  const text = await readFile(report.markdownPath, 'utf8');
  assert.ok(report.summary.includes('第一事例だけの問題'));
  assert.ok(text.includes('生成プロンプト比較の出力：case1'));
  assert.ok(text.includes('生成プロンプト比較の出力：case2'));
  assert.ok(text.includes('-旧い指示'));
  assert.ok(text.includes('+新しい指示'));
  assert.ok(text.includes('-baseline本文case1'));
  assert.ok(text.includes('+candidate本文case2'));
});

test('same-article judge comparisons report verdict changes without suggesting article edits', async (t) => {
  const run = await fixture(t, { mode: 'judge_compare' });
  await run.append('comparison.planned', { kind: 'judge_compare', baseline: { id: 'old-judge', template: '旧基準' }, candidate: { id: 'new-judge', template: '新基準' } });
  const article = { id: 'A', hash: 'fixed', title: '原稿', body: '同一原稿' };
  await run.append('article.created', { caseId: 'case1', role: 'baseline', article, fixedForJudgeComparison: true });
  await run.append('article.created', { caseId: 'case1', role: 'candidate', article, fixedForJudgeComparison: true });
  await run.append('evaluation.completed', { evaluation: { id: 'old-result', articleHash: 'fixed', status: 'completed', axes: [], findings: [{ id: 'F-old', severity: 'major', reason: '旧評価器の指摘', quote: '同一原稿' }] } });
  await run.append('evaluation.completed', { evaluation: { id: 'new-result', articleHash: 'fixed', status: 'invalid', axes: [{ id: 'Q1', score: 4 }], findings: [], validationErrors: ['bad quote'] } });
  await run.append('comparison.completed', { kind: 'judge_compare', status: 'partial', observations: [{ caseId: 'case1', beforeHash: 'fixed', afterHash: 'fixed', beforeEvaluationId: 'old-result', afterEvaluationId: 'new-result', evaluationStatus: ['completed', 'invalid'], axes: [{ id: 'Q1', before: 2, after: 4 }] }] });
  await run.append('note.completed', { status: 'skipped', reason: '比較実行のため対象外', published: false });
  await run.append('run.completed', { status: 'partial' });
  const report = await writeReports(run.dir);
  const text = await readFile(report.markdownPath, 'utf8');
  assert.ok(report.summary.includes('旧評価器の指摘'));
  assert.ok(report.summary.includes('比較の状態：partial'));
  assert.ok(report.summary.includes('同じ原稿への旧・新評価器の判定差'));
  assert.ok(text.includes('評価器の比較：case1'));
  assert.ok(text.includes('-旧基準'));
  assert.ok(text.includes('+新基準'));
  assert.ok(!text.includes('生成プロンプト比較の出力'));
  assert.match(text, /Q1 \| 2 \| 判定保留/);
});
