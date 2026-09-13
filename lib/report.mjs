import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { readRun } from './record-store.mjs';

const UNKNOWN = '未取得・未確認';
const escapeHtml = (value) => String(value ?? UNKNOWN).replace(/[&<>"']/g,
  (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const json = (value) => JSON.stringify(value ?? null, null, 2);
const display = (value) => value === undefined || value === null ? UNKNOWN
  : typeof value === 'object' ? json(value) : String(value);
const cell = (value) => escapeHtml(display(value)).replace(/\|/g, '&#124;').replace(/\r?\n/g, '<br>');
const fence = (value, language = '') => {
  const text = display(value);
  const ticks = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((item) => item.length + 1)));
  return `${ticks}${language}\n${text}\n${ticks}`;
};
const last = (items) => items.at(-1);
const eventsOf = (events, type) => events.filter((event) => event.type === type);
const concise = (value, limit = 240) => {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…（全文は詳細参照）` : text;
};
const list = (value) => Array.isArray(value) ? value : value && typeof value === 'object'
  ? Object.entries(value).map(([id, item]) => typeof item === 'object' ? { id, ...item } : { id, score: item }) : [];

// note-save reports stable machine-readable codes. Keep diagnostics useful while
// avoiding arbitrary browser text, editor contents, or URLs in the summary.
const safeDiagnosticCode = (value) => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9_.=-]{0,95}$/.test(value) ? value : UNKNOWN;
const booleanResult = (value) => value === true ? 'はい' : value === false ? 'いいえ' : UNKNOWN;
const nonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0 ? value : UNKNOWN;

function safeSelectorCandidates(value) {
  const phase = (item) => item && typeof item === 'object'
    ? { title: nonnegativeInteger(item.title), body: nonnegativeInteger(item.body) }
    : UNKNOWN;
  return value && typeof value === 'object'
    ? { editor: phase(value.editor), verification: phase(value.verification) }
    : UNKNOWN;
}

function safeComparison(value) {
  if (!value || typeof value !== 'object') return UNKNOWN;
  const part = (item) => item && typeof item === 'object' ? {
    matched: booleanResult(item.matched),
    classification: safeDiagnosticCode(item.classification),
    firstDifference: Number.isSafeInteger(item.firstDifference) && item.firstDifference >= 0
      ? item.firstDifference : item.firstDifference === null ? '差分なし' : UNKNOWN,
  } : UNKNOWN;
  return { title: part(value.title), body: part(value.body) };
}

function safeVerification(value) {
  if (!value || typeof value !== 'object') return UNKNOWN;
  return {
    method: safeDiagnosticCode(value.method),
    titleMatched: booleanResult(value.titleMatched),
    bodyMatched: booleanResult(value.bodyMatched),
    normalization: safeDiagnosticCode(value.normalization),
    verifiedAt: typeof value.verifiedAt === 'string' && !Number.isNaN(Date.parse(value.verifiedAt))
      ? value.verifiedAt : UNKNOWN,
  };
}

function triStateAnd(...values) {
  if (values.includes(false)) return false;
  return values.every((value) => value === true) ? true : null;
}

function noteResult(data, article) {
  const finalHash = typeof article?.hash === 'string' ? article.hash : null;
  const hashMatch = (value) => typeof value === 'string' && finalHash !== null ? value === finalHash : null;
  const hashesMatch = triStateAnd(hashMatch(data?.articleHash), hashMatch(data?.verifiedHash));
  const verification = data?.verification;
  const verificationValue = (key) => typeof verification?.[key] === 'boolean' ? verification[key] : null;
  const methodMatches = typeof verification?.method === 'string'
    ? verification.method === 'isolated_context_readback' : null;
  const stageMatches = typeof data?.diagnostics?.stage === 'string'
    ? data.diagnostics.stage === 'verified' : null;
  const reasonMatches = typeof data?.reason === 'string'
    ? data.reason === 'isolated_context_readback_matched' : null;
  const noPublishAction = typeof data?.publishActionPerformed === 'boolean'
    ? data.publishActionPerformed === false : null;
  const isolatedReadbackVerified = verification && typeof verification === 'object'
    ? triStateAnd(methodMatches, verificationValue('titleMatched'),
      verificationValue('bodyMatched'), stageMatches, reasonMatches, noPublishAction)
    : null;
  const statusMatches = typeof data?.status === 'string' ? data.status === 'saved' : null;
  const saveVerified = triStateAnd(statusMatches, hashesMatch, isolatedReadbackVerified);
  if (saveVerified) return { label: '保存確認済み', hashesMatch, isolatedReadbackVerified, saveVerified };
  const labels = {
    skipped: '対象外',
    not_started: '未開始',
    input_only: '入力処理開始・保存未確認',
    save_unconfirmed: '保存未確認',
  };
  return { label: labels[data?.status] ?? '保存状態未確認', hashesMatch, isolatedReadbackVerified, saveVerified };
}

function makeDocument() {
  const markdown = [];
  const html = [];
  return {
    heading(text, level = 2) { markdown.push(`${'#'.repeat(level)} ${text}`); html.push(`<h${level}>${escapeHtml(text)}</h${level}>`); },
    paragraph(text) { markdown.push(text); html.push(`<p>${escapeHtml(text)}</p>`); },
    table(headers, rows) {
      markdown.push([`| ${headers.map(cell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`,
        ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n'));
      html.push(`<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(display(value))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    },
    full(title, value, language = '') {
      markdown.push(`### ${title}\n\n${fence(value, language)}`);
      html.push(`<details><summary>${escapeHtml(title)}</summary><pre><code>${escapeHtml(display(value))}</code></pre></details>`);
    },
    get markdown() { return `${markdown.join('\n\n')}\n`; },
    get html() { return html.join('\n'); },
  };
}

function articleText(article) { return `# ${article?.title ?? ''}\n\n${article?.body ?? ''}`; }

function findingDescription(finding) {
  return [finding.id ?? finding.findingId ?? 'ID未取得', finding.severity, finding.issue ?? finding.problem ?? finding.description ?? finding.message ?? finding.reason,
    finding.quote ? `原文「${concise(finding.quote, 120)}」` : null]
    .filter(Boolean).map((value) => concise(value)).join('：');
}

function finalEvaluation(events) {
  const articles = eventsOf(events, 'article.created');
  const finalEvent = last(articles.filter((event) => event.data.role === 'final'));
  const latestArticle = finalEvent?.data.article ?? last(articles)?.data.article;
  const evaluations = evaluationRecords(events);
  if (!latestArticle?.hash) return { article: latestArticle, evaluation: undefined };
  const evaluation = finalEvent?.data.evaluationId
    ? last(evaluations.filter((item) => item.id === finalEvent.data.evaluationId && item.articleHash === latestArticle?.hash))
    : last(evaluations.filter((item) => item.articleHash === latestArticle?.hash));
  return { article: latestArticle, evaluation };
}

function evaluationRecords(events) {
  return events.filter((event) => /^evaluation\.(completed|failed)$/.test(event.type))
    .map((event) => ({ eventId: event.eventId, ...event.data.evaluation,
      articleHash: event.data.evaluation?.articleHash ?? event.data.articleHash,
      status: event.data.evaluation?.status ?? (event.type === 'evaluation.failed' ? 'failed' : 'unknown') }));
}

const usableEvaluation = (evaluation) => evaluation?.status === 'completed' && !evaluation.validationErrors?.length;

function summaryRows(manifest, events) {
  const { article, evaluation } = finalEvaluation(events);
  const findings = usableEvaluation(evaluation) ? list(evaluation.findings) : [];
  const failed = events.filter((event) => /\.failed$/.test(event.type));
  const finished = last(events.filter((event) => /^run\.(completed|failed)$/.test(event.type)));
  const candidates = eventsOf(events, 'prompt.candidate');
  const candidate = last(candidates)?.data;
  const adoption = last(eventsOf(events, 'adoption.decided'));
  const comparisons = eventsOf(events, 'comparison.completed');
  const revision = last(eventsOf(events, 'revision.decided'));
  const note = last(events.filter((event) => /^note\.(completed|failed)$/.test(event.type)));
  const importantFindings = [...findings].sort((a, b) => (a.severity === 'major' ? 0 : 1) - (b.severity === 'major' ? 0 : 1));
  let first = evaluation && !usableEvaluation(evaluation)
    ? `対象原稿の評価は判定保留：${evaluation.id ?? 'ID未取得'} / ${evaluation.status}（${evaluation.eventId}）。未検証の点数・指摘を採用しません。`
    : evaluation
    ? findings.length ? importantFindings.slice(0, 3).map(findingDescription).join('\n')
      + (findings.length > 3 ? `\nほか${findings.length - 3}件。すべての指摘は詳細を参照。` : '')
      : `記録された指摘は0件。評価状態：${display(evaluation.status)}。確認範囲は評価記録を参照。`
    : '対象原稿の評価記録がないため、問題の有無は未確認。';
  if (failed.length) first += `\n処理失敗：${failed.map((event) => `${event.eventId} ${event.type}`).join('、')}`;
  if (evaluation?.validationErrors?.length) first += `\n評価の検証エラー：${evaluation.validationErrors.join('、')}。この判定は保留。`;
  if (!finished) first += '\n実行完了記録なし：未完了または記録が途切れています。';
  if (finished?.type === 'run.failed') first += '\n実行失敗。取得済みの記録のみ表示。';
  const changes = [];
  if (revision) changes.push(`記事修正の選択：${display(revision.data.selected)}。${display(revision.data.reason)}（${revision.eventId}）`);
  if (comparisons.length) changes.push(`比較完了記録：${comparisons.map((event) => event.eventId).join('、')}。結論の範囲は比較の種類・条件に限定。`);
  if (candidate) changes.push(`生成プロンプト候補：${display(candidate.status)}。記事修正と共通版の採用は別。`);
  let unresolved = evaluation && !usableEvaluation(evaluation)
    ? `最終対象の評価が${evaluation.status}のため、問題の解消・悪化は判定できません。`
    : evaluation
    ? findings.length ? `最終対象の指摘${findings.length}件。新しい問題・失った内容の確認結果は比較記録を参照。`
      : `記録された最終対象の指摘は0件。未確認の主張や評価範囲は詳細を参照。`
    : '再評価・最終確認が未取得のため、解消・悪化の有無は未確認。';
  const unknownClaims = list(evaluation?.claims).filter((claim) => ['unverified', 'insufficient'].includes(claim.status));
  if (unknownClaims.length) unresolved += `\n根拠不足・未確認の主張：${unknownClaims.map((claim) => claim.id ?? 'ID未取得').join('、')}`;
  if (evaluation?.unknowns?.length) unresolved += `\n評価の未確認事項：${evaluation.unknowns.join('、')}`;
  for (const comparison of comparisons) {
    const review = comparison.data.review;
    if (!review) continue;
    const regressions = list(review.regressions);
    if (regressions.length) unresolved += `\n悪化の指摘：${regressions.map((item) => item.reason ?? item.quote).join('、')}（${comparison.eventId}）`;
    if (review.lostContent?.length) unresolved += `\n失われた内容：${review.lostContent.join('、')}（${comparison.eventId}）`;
    if (review.unknowns?.length) unresolved += `\n比較の未確認事項：${review.unknowns.join('、')}（${comparison.eventId}）`;
  }
  let adoptionText = adoption
    ? `${display(adoption.data.status ?? adoption.data.decision ?? adoption.data.selected)}：${display(adoption.data.reason)}（${adoption.eventId}）`
    : candidate?.status === 'not_needed' ? `変更不要：${display(candidate.reason)}`
      : candidate ? `未採用・判断待ち。候補状態：${display(candidate.status)}。自動採用の記録なし。`
        : '候補の作成・採用記録なし。';
  if (manifest.mode === 'article' && !candidate) adoptionText = '生成プロンプトの比較・採用は今回の記録にありません。';
  let noteText = 'noteへの入力・保存・公開は未確認。記録なし。';
  if (note?.type === 'note.failed') noteText = `note処理失敗：${safeDiagnosticCode(note.data.reason ?? note.data.error)}（${note.eventId}）`;
  if (note?.type === 'note.completed') {
    const data = note.data;
    const result = noteResult(data, article);
    const matches = result.hashesMatch === true ? '記録された保存ハッシュは対象原稿と一致'
      : result.hashesMatch === false ? '記録された保存ハッシュが対象原稿と不一致'
        : '保存内容との一致は未確認';
    const reason = safeDiagnosticCode(data.reason);
    const stage = safeDiagnosticCode(data.diagnostics?.stage);
    const verificationMethod = safeDiagnosticCode(data.verification?.method);
    noteText = `結果：${result.label}（status: ${safeDiagnosticCode(data.status)}）。理由：${reason}。診断段階：${stage}。検証方法：${verificationMethod}。公開：${data.published === true ? '公開済みの記録' : data.published === false ? '未公開の記録' : '未確認'}。${matches}。最終対象の評価：${evaluation ? `${evaluation.id ?? 'ID未取得'}（${display(evaluation.status)}）` : '未取得'}（${note.eventId}）`;
  }
  const rows = [['先に確認する問題', first], ['主な変更と結果', changes.join('\n') || '変更・比較の完了記録なし。'],
    ['未解決・悪化', unresolved], ['候補の採用状況', adoptionText], ['noteの状態', noteText]];
  if (['generation_compare', 'judge_compare'].includes(manifest.mode)) {
    const evaluations = evaluationRecords(events);
    const valid = evaluations.filter(usableEvaluation);
    const invalid = evaluations.filter((item) => !usableEvaluation(item));
    const allFindings = valid.flatMap((item) => list(item.findings).map((finding) => ({ ...finding, id: `${item.id}/${finding.id ?? 'ID未取得'}` })));
    const important = allFindings.sort((a, b) => (a.severity === 'major' ? 0 : 1) - (b.severity === 'major' ? 0 : 1));
    const latestComparison = last(comparisons);
    let problems = important.length ? important.slice(0, 3).map(findingDescription).join('\n')
      + (important.length > 3 ? `\nほか${important.length - 3}件。事例別の全指摘は詳細参照。` : '')
      : valid.length ? '形式と原文参照の検証を通った評価には、記録された指摘は0件。未確認範囲は事例別の詳細を参照。'
        : '検証済みの評価記録なし。比較対象の問題の有無は未確認。';
    if (invalid.length) problems += `\n判定保留：${invalid.map((item) => `${item.id ?? item.eventId}（${item.status}）`).join('、')}`;
    if (!latestComparison || latestComparison.data.status !== 'completed') problems += `\n比較の状態：${latestComparison?.data.status ?? '未完了'}。未実行の評価を成功に数えません。`;
    if (!finished || finished.type === 'run.failed') problems += `\n実行：${finished?.type === 'run.failed' ? '失敗' : '未完了'}。`;
    rows[0][1] = problems;
    rows[1][1] = `${manifest.mode === 'judge_compare' ? '同じ原稿への旧・新評価器の判定差' : '同じ入力・根拠から旧・新生成プロンプトで作成した出力差'}。${latestComparison ? `比較記録：${latestComparison.eventId}（${display(latestComparison.data.status)}）` : '比較完了記録なし'}。`;
    rows[2][1] = `比較元・先の記録された指摘は合計${allFindings.length}件（同じ問題の重複を含み、最終原稿の件数ではありません）。判定保留の評価${invalid.length}件。狙いの達成・悪化・未確認事項は事例ごとに確認してください。`;
    if (note?.data.status === 'skipped') rows[4][1] = `対象外：${display(note.data.reason)}。noteの入力・保存・公開は比較処理では実行しません。`;
  }
  return rows;
}

function renderFinding(doc, finding, evaluation, eventId) {
  doc.heading(`指摘 ${finding.id ?? finding.findingId ?? 'ID未取得'}`, 3);
  doc.table(['欄', '内容'], [
    ['対象・判断根拠', `${evaluation.id ?? UNKNOWN} / ${evaluation.articleHash ?? UNKNOWN} / ${eventId}`],
    ['観察した問題', finding.issue ?? finding.problem ?? finding.description ?? finding.message ?? finding.reason],
    ['原文の位置・引用', finding.location ?? finding.quote ?? finding.excerpt],
    ['判断の種類・影響', { kind: finding.category ?? finding.kind ?? finding.type, severity: finding.severity, impact: finding.impact }],
    ['原因の候補・確かさ', finding.diagnosis ?? finding.cause ?? finding.causeCandidates ?? '未切り分け'],
    ['原因を判断した根拠', finding.causeEvidence ?? finding.cause?.reason ?? finding.evidence ?? '未確認'],
    ['根拠資料・要件', { evidenceIds: finding.evidenceIds, requirementId: finding.requirementId }],
    ['修正先・範囲', finding.target ?? finding.fixTarget ?? finding.scope],
    ['修正案', finding.suggestion ?? finding.fix ?? finding.recommendation],
    ['残す内容', finding.preserve],
    ['自動修正の扱い', finding.autoFix ?? finding.autoFixable ?? finding.action],
  ]);
  doc.full(`指摘の完全な記録 ${finding.id ?? ''}`, json(finding), 'json');
}

function renderCandidate(doc, event) {
  const candidate = event.data;
  doc.heading(`生成プロンプト候補 ${event.eventId}`);
  doc.table(['欄', '内容'], [['状態', candidate.status], ['変更前ID・ハッシュ', { id: candidate.before?.id, hash: candidate.before?.hash }],
    ['変更後ID・ハッシュ', { id: candidate.after?.id, hash: candidate.after?.hash }], ['理由', candidate.reason]]);
  if (candidate.before) doc.full('改善前の生成プロンプト全文', candidate.before.template);
  if (candidate.after) doc.full('改善後の生成プロンプト全文', candidate.after.template);
  if (typeof candidate.before?.template === 'string' && typeof candidate.after?.template === 'string') {
    doc.full('生成プロンプトの機械的な全文差分', createTwoFilesPatch(
      `${candidate.before.id ?? 'before'}.txt`, `${candidate.after.id ?? 'candidate'}.txt`,
      candidate.before.template, candidate.after.template, '', '', { context: Infinity }), 'diff');
  }
  for (const change of list(candidate.changes)) {
    doc.heading(`プロンプトの変更 ${change.id ?? 'ID未取得'}`, 3);
    doc.table(['欄', '内容'], [['操作', change.operation], ['改善前の指示・位置', change.before], ['改善後の指示・位置', change.after],
      ['きっかけ・指摘', change.findingIds], ['変更理由', change.reason], ['期待する変化（仮説）', change.expectedEffect],
      ['観察された変化', change.observedEffect ?? '未実行・未確認。期待だけでは改善と判定しません。'],
      ['採否・未確認事項', change.status ?? candidate.status]]);
  }
  doc.full('候補の完全な記録', json(candidate), 'json');
}

/** Build a dated, immutable view. No AI-generated reconstruction of historical records. */
export async function writeReports(runDir, { asOf } = {}) {
  const generatedAt = new Date().toISOString();
  const cutoff = asOf === undefined ? generatedAt : new Date(asOf).toISOString();
  const { manifest, events } = await readRun(runDir, { asOf: cutoff });
  const note = last(events.filter((event) => /^note\.(completed|failed)$/.test(event.type)));
  const reportId = `report-${generatedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const doc = makeDocument();
  doc.heading('note作成・評価・改善の実行レポート', 1);
  doc.paragraph(`実行：${manifest.runId} / 記事：${manifest.articleId} / 種類：${manifest.mode}`);
  doc.paragraph(`表示基準時点：${cutoff} / 生成日時：${generatedAt}（UTC） / レポートID：${reportId}`);
  doc.paragraph('実行時の固定記録と、表示基準時点までの追記から機械生成。未取得は0点・0円・成功へ変換しません。');
  if (Date.parse(cutoff) < Date.parse(manifest.startedAt)) doc.paragraph('表示基準時点はこの実行の開始前です。実行内容はまだ存在しません。');
  const summaryDoc = makeDocument();
  summaryDoc.table(['項目', '要点'], summaryRows(manifest, events));
  doc.table(['項目', '要点'], summaryRows(manifest, events));

  doc.heading('実行前の入力と前提');
  doc.table(['入力項目', '入力された値'], Object.entries(manifest.inputs ?? {}));
  doc.full('実行条件・入力の完全な記録', json(manifest), 'json');
  for (const event of eventsOf(events, 'run.started')) {
    if (event.data.brief) doc.full(`要件・出所・未確認の前提 ${event.eventId}`, json(event.data.brief), 'json');
    if (event.data.rubric) doc.full(`評価基準全文・段階別の定義 ${event.eventId}`, json(event.data.rubric), 'json');
  }
  for (const event of eventsOf(events, 'evidence.collected')) {
    doc.full(`根拠資料の取得記録 ${event.eventId}`, json(event.data.snapshot ?? event.data), 'json');
  }

  const calls = eventsOf(events, 'call.started');
  if (calls.length) doc.heading('実際に使った指示・応答と使用量');
  for (const event of calls) {
    const request = event.data;
    const outcomes = events.filter((item) => /^call\.(completed|failed)$/.test(item.type) && item.data.callId === request.callId);
    const outcome = last(outcomes);
    doc.heading(`処理 ${request.callId}：${request.stage}`, 3);
    doc.table(['欄', '内容'], [['開始・終了記録', `${event.eventId} → ${outcome?.eventId ?? '未完了'}`],
      ['状態', outcome?.type === 'call.completed' ? '応答取得済み（記事品質・note保存の合格を意味しません）' : outcome?.type === 'call.failed' ? '失敗' : '未完了'],
      ['モデル', outcome?.data.model ?? request.request?.model], ['プロンプトID・ハッシュ', request.prompt && { id: request.prompt.id, hash: request.prompt.hash }],
      ['使用量', outcome?.data.usage], ['所要時間 ms', outcome?.data.durationMs], ['料金・算出根拠', outcome?.data.cost ?? '未取得。0円とは扱いません。'],
      ['エラー', outcome?.type === 'call.failed' ? outcome.data.error : '該当する失敗記録なし']]);
    if (request.prompt?.template !== undefined) doc.full(`${request.stage}：プロンプトテンプレート全文`, request.prompt.template);
    doc.full(`${request.stage}：展開後の要求全文（役割・順序・設定を含む）`, json(request.request), 'json');
    for (const result of outcomes) doc.full(`${request.stage}：応答・失敗の完全な記録 ${result.eventId}`, json(result.data), 'json');
  }

  const articles = eventsOf(events, 'article.created');
  if (articles.length) doc.heading('出力した原稿の全文');
  for (const event of articles) {
    const { article, role } = event.data;
    doc.heading(`原稿 ${role}：${article?.id ?? 'ID未取得'}`, 3);
    doc.table(['欄', '内容'], [['イベント', event.eventId], ['原稿ハッシュ', article?.hash], ['タイトル', article?.title],
      ['本文正規化', article?.bodyNormalization ?? UNKNOWN]]);
    doc.full(`${role}：本文全文`, article?.body, 'markdown');
  }

  const pairs = [['記事の修正前後', last(articles.filter((event) => event.data.role === 'before')), last(articles.filter((event) => event.data.role === 'after'))]];
  for (const comparison of eventsOf(events, 'comparison.completed')) {
    if (!['generation_compare', 'judge_compare'].includes(comparison.data.kind)) continue;
    for (const observation of comparison.data.observations ?? []) {
      const before = last(articles.filter((event) => event.data.role === 'baseline' && event.data.article?.hash === observation.beforeHash
        && (!event.data.caseId || event.data.caseId === observation.caseId)));
      const after = last(articles.filter((event) => event.data.role === 'candidate' && event.data.article?.hash === observation.afterHash
        && (!event.data.caseId || event.data.caseId === observation.caseId)));
      if (comparison.data.kind === 'generation_compare') pairs.push([`生成プロンプト比較の出力：${observation.caseId}`, before, after]);
      else {
        doc.heading(`評価器の比較：${observation.caseId}`);
        doc.paragraph(`対象原稿ハッシュ：${observation.beforeHash}。旧・新の対象一致：${observation.beforeHash === observation.afterHash ? '一致' : '不一致：比較の前提を満たしません'}。記事を書き換えた結果ではありません。`);
        doc.table(['欄', '内容'], [['旧評価ID', observation.beforeEvaluationId], ['新評価ID', observation.afterEvaluationId],
          ['評価状態（旧・新）', observation.evaluationStatus], ['人の確認との照合根拠', observation.humanReference]]);
      }
    }
  }
  for (const [name, before, after] of pairs) if (before && after) {
    doc.heading(name);
    doc.paragraph(`比較元：${before.eventId} / 比較先：${after.eventId}。この差分だけでは変更の原因や他の記事での改善を証明しません。`);
    doc.full('原稿の機械的な全文差分', createTwoFilesPatch(
      `${before.data.article?.id ?? 'before'}.md`, `${after.data.article?.id ?? 'after'}.md`,
      articleText(before.data.article), articleText(after.data.article), '', '', { context: Infinity }), 'diff');
  }

  const evaluations = events.filter((event) => /^evaluation\.(completed|failed)$/.test(event.type));
  doc.heading('評価観点・判定と原因の切り分け');
  doc.paragraph('点数は観点ごとの記録です。総合100点への集計はしません。根拠不足・未確認・評価失敗を記事の誤りと同一視しません。');
  if (!evaluations.length) doc.paragraph('完了した評価記録なし。評価不能・失敗の理由は詳細ログを参照してください。');
  for (const event of evaluations) {
    const evaluation = event.data.evaluation ?? {};
    doc.heading(`評価 ${evaluation.id ?? event.eventId}`, 3);
    doc.table(['欄', '内容'], [['対象原稿ハッシュ', evaluation.articleHash], ['評価モデル', evaluation.model],
      ['評価基準ハッシュ', evaluation.rubricHash], ['状態', evaluation.status], ['原稿との対応',
        articles.some((article) => article.data.article?.hash === evaluation.articleHash) ? 'この実行の原稿ハッシュと一致' : 'この実行の原稿との一致を確認できません']]);
    if (!usableEvaluation(evaluation)) doc.paragraph(`判定保留：評価状態 ${evaluation.status ?? '不明'}。以下の数値・指摘は評価結果として採用しません。検証前の応答は完全な記録に保持しています。`);
    const axes = list(evaluation.axes);
    if (axes.length) doc.table(['観点', '点数', '判断理由・原文参照'], axes.map((axis) => [axis.id ?? axis.name,
      !usableEvaluation(evaluation) ? '判定保留' : axis.score === null || axis.score === undefined ? '評価不能・未取得' : axis.score,
      { reason: axis.reason ?? axis.rationale ?? axis.evidence, quote: axis.quote }]));
    if (usableEvaluation(evaluation)) for (const finding of list(evaluation.findings)) renderFinding(doc, finding, evaluation, event.eventId);
    doc.full(`評価・主張照合の完全な記録 ${event.eventId}`, json(evaluation), 'json');
  }

  if (manifest.mode === 'article' && note) {
    doc.heading('noteへの入力・保存確認');
    if (note.type === 'note.failed') {
      doc.table(['欄', '内容'], [['イベント', note.eventId], ['結果', 'note処理失敗'],
        ['理由', safeDiagnosticCode(note.data.reason ?? note.data.error)], ['保存確認', '未確認']]);
    } else {
      const data = note.data;
      const result = noteResult(data, finalEvaluation(events).article);
      doc.table(['欄', '内容'], [
        ['イベント', note.eventId],
        ['結果', result.label],
        ['状態コード', safeDiagnosticCode(data.status)],
        ['理由コード', safeDiagnosticCode(data.reason)],
        ['診断段階', safeDiagnosticCode(data.diagnostics?.stage)],
        ['画面種別', safeDiagnosticCode(data.diagnostics?.route)],
        ['原稿検証', {
          bodyCanonical: booleanResult(data.diagnostics?.articleValidation?.bodyCanonical),
          hashMatched: booleanResult(data.diagnostics?.articleValidation?.hashMatched),
        }],
        ['検出した入力欄候補数', safeSelectorCandidates(data.diagnostics?.selectorCandidates)],
        ['保存操作', {
          controlCandidates: nonnegativeInteger(data.diagnostics?.saveControl?.candidates),
          controlFound: booleanResult(data.diagnostics?.saveControl?.found),
          controlVisible: booleanResult(data.diagnostics?.saveControl?.visible),
          controlEnabled: booleanResult(data.diagnostics?.saveControl?.enabled),
          controlClicked: booleanResult(data.diagnostics?.saveControl?.clicked),
          savingObserved: booleanResult(data.diagnostics?.saveControl?.savingObserved),
          readyObservedAfterSaving: booleanResult(data.diagnostics?.saveControl?.readyObservedAfterSaving),
        }],
        ['保存待機', {
          mode: safeDiagnosticCode(data.diagnostics?.settleMode),
          elapsedMs: nonnegativeInteger(data.diagnostics?.settleElapsedMs),
        }],
        ['入力直後の一致判定', safeComparison(data.diagnostics?.input)],
        ['再読込時の一致判定', safeComparison(data.diagnostics?.readback)],
        ['保存検証', safeVerification(data.verification)],
        ['対象原稿とのハッシュ一致', booleanResult(result.hashesMatch)],
        ['隔離コンテキストでの再読込確認', booleanResult(result.isolatedReadbackVerified)],
        ['公開操作を実行していない', booleanResult(data.publishActionPerformed === false
          ? true : data.publishActionPerformed === true ? false : null)],
        ['公開状態', data.published === true ? '公開済みの記録' : data.published === false ? '未公開の記録' : '未確認'],
      ]);
      doc.paragraph(result.saveVerified === true
        ? '元の編集画面とは隔離したブラウザーコンテキストで同じ下書きを再読込し、タイトルと本文が対象原稿に一致した記録です。'
        : '入力処理、保存操作、保存表示、下書きURL、ハッシュだけでは保存済みと判定しません。隔離したブラウザーコンテキストでタイトルと本文が一致した確認記録はありません。');
    }
  }

  for (const event of eventsOf(events, 'prompt.candidate')) renderCandidate(doc, event);
  const changes = events.filter((event) => /^(?:revision|comparison)\./.test(event.type));
  if (changes.length) {
    doc.heading('記事の修正判断・比較条件と確認結果');
    doc.paragraph('記事修正は対象原稿の問題解消を確認します。生成プロンプト比較は同じ入力・根拠で新規生成します。評価器比較は同じ原稿の判定差を確認し、記事の改善とは呼びません。');
    for (const event of changes) {
      if (event.type === 'comparison.planned' && event.data.baseline && event.data.candidate) {
        const { baseline, candidate, kind } = event.data;
        const label = kind === 'judge_compare' ? '評価プロンプト' : '生成プロンプト';
        doc.heading(`比較で使った${label}の旧版・候補版 ${event.eventId}`, 3);
        doc.table(['欄', '内容'], [['旧版ID・ハッシュ', { id: baseline.id, hash: baseline.hash }],
          ['候補版ID・ハッシュ', { id: candidate.id, hash: candidate.hash }], ['意図する変更・事例の用途', event.data.casePurposes],
          ['固定する条件', event.data.fixed], ['採用方針', event.data.adoptionPolicy]]);
        doc.full(`比較元の${label}全文`, baseline.template);
        doc.full(`比較先の${label}全文`, candidate.template);
        if (typeof baseline.template === 'string' && typeof candidate.template === 'string') doc.full(`${label}の機械的な全文差分`,
          createTwoFilesPatch(`${baseline.id ?? 'baseline'}.txt`, `${candidate.id ?? 'candidate'}.txt`, baseline.template, candidate.template, '', '', { context: Infinity }), 'diff');
      }
      if (event.type === 'comparison.completed' && Array.isArray(event.data.observations)) {
        for (const observation of event.data.observations) {
          doc.heading(`事例別の比較結果 ${observation.caseId}`, 3);
          doc.table(['欄', '内容'], [['比較元・先の評価ID', { before: observation.beforeEvaluationId, after: observation.afterEvaluationId }],
            ['対象原稿ハッシュ', { before: observation.beforeHash, after: observation.afterHash }],
            ['評価状態（旧・新）', observation.evaluationStatus], ['期待する変化', observation.expectedChanges],
            ['狙った改善の確認', observation.targetedImprovement], ['人の確認との照合根拠', observation.humanReference]]);
          if (Array.isArray(observation.axes)) doc.table(['観点', '比較元', '比較先'], observation.axes.map((axis) => [axis.id,
            observation.evaluationStatus?.[0] === 'completed' ? axis.before ?? '評価不能・未取得' : '判定保留',
            observation.evaluationStatus?.[1] === 'completed' ? axis.after ?? '評価不能・未取得' : '判定保留']));
        }
      }
      const review = event.data.review;
      if (event.type === 'comparison.completed' && review) {
        doc.heading(`比較結果 ${event.eventId}：${event.data.kind ?? '種類未確認'}`, 3);
        doc.table(['欄', '内容'], [['比較元・先', { beforeHash: event.data.beforeHash, afterHash: event.data.afterHash }],
          ['選択・判断理由', { selected: event.data.selected, reason: event.data.reason }],
          ['新たな問題', review.regressions], ['失われた内容', review.lostContent],
          ['指示に対応しない変更', review.unrequestedChanges], ['新たな主張', review.newClaims], ['未確認', review.unknowns]]);
        for (const resolution of list(review.resolutions)) {
          doc.heading(`記事の変更：指摘 ${resolution.findingId ?? 'ID未取得'}`, 3);
          doc.table(['欄', '内容'], [['関連する指摘', resolution.findingId], ['修正前の原文', resolution.beforeQuote],
            ['修正後の原文', resolution.afterQuote], ['確認結果', resolution.status], ['判断理由', resolution.reason],
            ['比較記録', event.eventId]]);
        }
      }
      doc.full(`${event.type} ${event.eventId}`, json(event.data), 'json');
    }
  }

  doc.heading('後日の判断・次回への引き継ぎ');
  const followups = events.filter((event) => /^(?:feedback|adoption)\./.test(event.type));
  if (!followups.length) doc.paragraph('本人の見直し・採否の追記は、この表示基準時点では未取得です。');
  for (const event of followups) doc.full(`${event.type} ${event.eventId}（記録日時 ${event.recordedAt}）`, json(event.data), 'json');
  doc.paragraph('候補の採否は、重大な問題 → 狙った改善 → 別の箇所・記事の悪化 → 費用・時間の順に根拠を確認します。採用方針や許容範囲が未決定の場合は保留し、現行版を維持します。');
  doc.paragraph('壁打ちする必要がある項目：良化と悪化が混在した場合の優先順位、共通プロンプトの自動採用範囲、比較の予算・時間、長期保存の方法。実行記録に明示された決定がない事項は未決定です。');

  doc.heading('元記録とイベント履歴');
  doc.table(['イベント', '記録日時 UTC', '種類'], events.map((event) => [event.eventId, event.recordedAt, event.type]));
  doc.paragraph(`使用した記録：manifest.json と ${events.length}件のイベント。API要求・応答・原稿・プロンプト・根拠資料は、以下の全文記録からも確認できます。`);
  for (const event of events) doc.full(`完全なイベント ${event.eventId} ${event.type}`, json(event), 'json');

  const reportDir = path.join(path.resolve(runDir), 'reports', reportId);
  await mkdir(reportDir, { recursive: true });
  const markdownPath = path.join(reportDir, 'report.md');
  const htmlPath = path.join(reportDir, 'report.html');
  const metadata = { reportId, runId: manifest.runId, generatedAt, asOf: cutoff, eventIds: events.map((event) => event.eventId) };
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>note実行レポート ${escapeHtml(manifest.runId)}</title><style>body{font-family:system-ui,sans-serif;max-width:1040px;margin:32px auto;padding:0 20px;color:#172d35;line-height:1.65;background:#fbfcfd}h1{font-size:1.65rem}h2{margin-top:2.2rem;border-bottom:2px solid #3a7d86;padding-bottom:.35rem}h3{font-size:1.08rem;margin-top:1.5rem}table{border-collapse:collapse;width:100%;margin:12px 0;font-size:.92rem}th,td{border:1px solid #cad7dc;padding:10px;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#e9f1f3}td:first-child{min-width:120px}.table-wrap{overflow-x:auto}details{border:1px solid #cad7dc;border-radius:6px;padding:10px 14px;margin:12px 0;background:white}summary{font-weight:600;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.85rem;line-height:1.65;background:#f3f6f8;padding:16px;tab-size:2}p{overflow-wrap:anywhere}@media print{body{max-width:none}details{break-inside:avoid}summary{color:#333}}</style></head><body>${doc.html}</body></html>\n`;
  await writeFile(markdownPath, doc.markdown, { flag: 'wx', mode: 0o600 });
  await writeFile(htmlPath, html, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(reportDir, 'report.json'), `${json(metadata)}\n`, { flag: 'wx', mode: 0o600 });
  return { markdownPath, htmlPath, summary: summaryDoc.markdown, reportId };
}
