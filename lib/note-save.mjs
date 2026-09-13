import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { hash, normalizeArticleBody } from './domain.mjs';

const NEW_DRAFT_URL = 'https://editor.note.com/new';
const TITLE_SELECTOR = 'textarea[placeholder="記事タイトル"]';
const BODY_SELECTOR = '[contenteditable="true"]';

// The article is already canonical and hashed before this module receives it.
// Only normalize line endings observed from the browser for comparison.
export function normalizeEditorText(value) {
  return value.replace(/\r\n?/g, '\n');
}

function fingerprint(value) {
  return {
    sha256: hash(value),
    length: value.length,
    lines: value === '' ? 0 : value.split('\n').length,
    newlines: (value.match(/\n/g) ?? []).length,
  };
}

function firstDifference(left, right) {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index++) if (left[index] !== right[index]) return index;
  return left.length === right.length ? null : limit;
}

function comparison(expected, observed) {
  const matched = expected === observed;
  return {
    matched,
    classification: matched ? 'exact_match' : 'content_or_structure_mismatch',
    firstDifference: firstDifference(expected, observed),
    expected: fingerprint(expected),
    observed: fingerprint(observed),
  };
}

function observedEditorText(value) {
  return {
    value: normalizeEditorText(value),
    lineEndingsConverted: (value.match(/\r\n|\r/g) ?? []).length,
  };
}

function routeKind(value) {
  if (isLoginUrl(value)) return 'login';
  if (durableEditorUrl(value)) return 'durable_editor';
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'editor.note.com' && url.pathname === '/new') return 'new_editor';
    return url.protocol === 'https:' && url.hostname === 'editor.note.com' ? 'other_editor' : 'external';
  } catch {
    return 'invalid';
  }
}

function editorUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'editor.note.com') return null;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function durableEditorUrl(value) {
  const safe = editorUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  if (!/^\/notes\/[A-Za-z0-9_-]+\/edit\/?$/.test(url.pathname)) return null;
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.href;
}

function isLoginUrl(value) {
  try {
    return /\/(?:login|signin)(?:\/|$)/.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

/**
 * Create one draft and verify it by reading the same durable editor URL in an
 * isolated BrowserContext. A timeout, input completion, or screenshot never
 * counts as saved.
 *
 * article.hash is supplied by the immutable article recorder. verifiedHash is
 * returned only when both supplied title and body match the reopened editor.
 * This verifies editor readback, not rich-text rendering or publication status.
 * No publish button, draft-creation retry, DOM dump, screenshot, or raw error log.
 */
export async function saveNoteDraft(article, {
  statePath = './note-state.json',
  browserType,
  timeoutMs = 60_000,
  pollIntervalMs = 1_000,
  settleDelayMs = 1_500,
  settleTimeoutMs = 20_000,
  autosaveDebounceMs = 11_000,
} = {}) {
  const result = {
    status: 'not_started',
    reason: 'not_started',
    articleId: article?.id ?? null,
    articleHash: article?.hash ?? null,
    verifiedHash: null,
    published: false,
    publishActionPerformed: false,
    publicationVerified: false,
    publicationReason: 'no_browser_write_performed',
    verification: null,
    diagnostics: {
      stage: 'not_started',
      route: 'unvisited',
      articleValidation: { bodyCanonical: null, hashMatched: null },
      selectorCandidates: { editor: null, verification: null },
      saveControl: {
        candidates: null,
        found: false, visible: false, enabled: false, clicked: false,
        savingObserved: false, readyObservedAfterSaving: false,
      },
      settleMode: null,
      input: null,
      readback: null,
    },
  };
  if (!article || typeof article.title !== 'string' || !article.title.trim()
      || typeof article.body !== 'string' || !article.body.trim()
      || typeof article.hash !== 'string' || !article.hash) {
    result.diagnostics.stage = 'invalid_article';
    return { ...result, reason: 'invalid_article' };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000
      || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0
      || !Number.isFinite(settleDelayMs) || settleDelayMs < 0 || settleDelayMs > 20_000
      || !Number.isFinite(settleTimeoutMs) || settleTimeoutMs <= 0 || settleTimeoutMs > 60_000
      || settleDelayMs > settleTimeoutMs
      || !Number.isFinite(autosaveDebounceMs) || autosaveDebounceMs < 0
      || autosaveDebounceMs > settleTimeoutMs) {
    result.diagnostics.stage = 'invalid_timeout';
    return { ...result, reason: 'invalid_timeout' };
  }

  result.diagnostics.articleValidation.bodyCanonical = normalizeArticleBody(article.body) === article.body;
  if (!result.diagnostics.articleValidation.bodyCanonical) {
    result.diagnostics.stage = 'noncanonical_article_body';
    return { ...result, reason: 'noncanonical_article_body' };
  }
  result.diagnostics.articleValidation.hashMatched = hash({ title: article.title, body: article.body }) === article.hash;
  if (!result.diagnostics.articleValidation.hashMatched) {
    result.diagnostics.stage = 'article_hash_mismatch';
    return { ...result, reason: 'article_hash_mismatch' };
  }
  try {
    await access(statePath, constants.R_OK);
  } catch {
    result.diagnostics.stage = 'login_state_missing_or_unreadable';
    return { ...result, reason: 'login_state_missing_or_unreadable' };
  }

  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error('operation_deadline_exceeded');
    return value;
  };
  const fields = async (page, phase) => {
    const titleCandidates = page.locator(TITLE_SELECTOR);
    const bodyCandidates = page.locator(BODY_SELECTOR);
    const titleCount = await titleCandidates.count();
    const bodyCount = await bodyCandidates.count();
    result.diagnostics.selectorCandidates[phase] = { title: titleCount, body: bodyCount };
    if (titleCount !== 1) {
      stage(titleCount === 0 ? 'title_selector_missing' : 'title_selector_ambiguous');
      throw new Error('editor_selector_invalid');
    }
    if (bodyCount !== 1) {
      stage(bodyCount === 0 ? 'body_selector_missing' : 'body_selector_ambiguous');
      throw new Error('editor_selector_invalid');
    }
    const title = titleCandidates.first();
    const body = bodyCandidates.first();
    await title.waitFor({ state: 'visible', timeout: remaining() });
    await body.waitFor({ state: 'visible', timeout: remaining() });
    return { title, body };
  };
  const read = async ({ title, body }) => {
    const observedTitle = observedEditorText(await title.inputValue({ timeout: remaining() }));
    const observedBody = observedEditorText(await body.innerText({ timeout: remaining() }));
    return {
      title: observedTitle.value,
      body: observedBody.value,
      normalization: {
        titleLineEndingsConverted: observedTitle.lineEndingsConverted,
        bodyLineEndingsConverted: observedBody.lineEndingsConverted,
      },
    };
  };
  const expected = {
    title: article.title,
    body: article.body,
  };
  const compare = (value) => ({
    title: {
      ...comparison(expected.title, value.title),
      observedLineEndingsConverted: value.normalization.titleLineEndingsConverted,
    },
    body: {
      ...comparison(expected.body, value.body),
      observedLineEndingsConverted: value.normalization.bodyLineEndingsConverted,
    },
  });
  const matches = (value) => value.title.matched && value.body.matched;
  let browser;
  let editorContext;
  let verificationContext;
  let failureReason = 'browser_launch_failed';
  const stage = (value) => {
    failureReason = value;
    result.diagnostics.stage = value;
  };
  try {
    stage('browser_launch_failed');
    const launcher = browserType ?? (await import('playwright')).chromium;
    browser = await launcher.launch({ headless: true, timeout: remaining() });
    stage('browser_context_failed');
    const contextIdentity = {
      // Keep the browser identity used by the existing working draft flow.
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
      locale: 'ja-JP',
      viewport: { width: 1440, height: 1000 },
    };
    editorContext = await browser.newContext({
      storageState: statePath,
      ...contextIdentity,
    });
    editorContext.setDefaultTimeout(remaining());
    const page = await editorContext.newPage();
    stage('editor_open_failed');
    const response = await page.goto(NEW_DRAFT_URL, {
      waitUntil: 'domcontentloaded', timeout: remaining(),
    });
    const openedEditorUrl = editorUrl(page.url());
    result.diagnostics.route = routeKind(page.url());
    if (isLoginUrl(page.url())) {
      stage('login_required');
      return { ...result, reason: 'login_required' };
    }
    if (!openedEditorUrl || (response && response.status() >= 400)) {
      stage('editor_unavailable');
      return { ...result, reason: 'editor_unavailable' };
    }
    stage('editor_fields_unavailable');
    const originalFields = await fields(page, 'editor');
    const initial = await read(originalFields);
    if (initial.title.trim() || initial.body.trim()) {
      stage('editor_not_empty');
      return { ...result, reason: 'editor_not_empty' };
    }

    // Treat even a partially failed input as a possible remote write. Never retry
    // /new automatically after this point: that could create duplicate drafts.
    result.status = 'input_only';
    result.published = 'unknown';
    result.publicationReason = 'no_publish_action_performed_status_unverified';
    stage('title_input_failed');
    await originalFields.title.fill(article.title, { timeout: remaining() });
    stage('body_input_failed');
    await originalFields.body.click({ timeout: remaining() });
    await page.keyboard.insertText(article.body);
    const inputComparison = compare(await read(originalFields));
    result.diagnostics.input = inputComparison;
    if (!matches(inputComparison)) {
      stage('editor_input_mismatch');
      return { ...result, reason: 'editor_input_mismatch' };
    }
    stage('editor_blur_failed');
    await originalFields.title.click({ timeout: remaining() });
    result.status = 'save_unconfirmed';

    // Click only the explicit draft-save control. In editor versions without
    // this control, leave autosave untouched and verify its persisted result.
    stage('save_control_detection_failed');
    const saveControlCandidates = page.getByRole('button', { name: '下書き保存', exact: true });
    const saveControlCount = await saveControlCandidates.count();
    result.diagnostics.saveControl.candidates = saveControlCount;
    result.diagnostics.saveControl.found = saveControlCount > 0;
    if (saveControlCount > 1) {
      stage('explicit_save_control_ambiguous');
      return { ...result, reason: failureReason };
    }
    const saveControl = saveControlCandidates.first();
    if (saveControlCount === 1) {
      result.diagnostics.saveControl.visible = await saveControl.isVisible();
      result.diagnostics.saveControl.enabled = result.diagnostics.saveControl.visible
        ? await saveControl.isEnabled()
        : false;
      if (result.diagnostics.saveControl.visible && result.diagnostics.saveControl.enabled) {
        stage('explicit_save_click_failed');
        await saveControl.click({ timeout: remaining() });
        result.diagnostics.saveControl.clicked = true;
      }
    }

    // A durable URL identifies which draft to reopen; it does not prove the
    // latest edit is stored. Wait for the observed save state or the autosave
    // debounce before creating an isolated verification context.
    stage('save_settle_observation_failed');
    const settleStartedAt = Date.now();
    const settleLimit = Math.min(deadline, settleStartedAt + settleTimeoutMs);
    const savingControl = page.getByRole('button', { name: '保存中…', exact: true }).first();
    result.diagnostics.settleMode = result.diagnostics.saveControl.clicked ? 'explicit_save' : 'autosave';
    let draftUrl = durableEditorUrl(page.url());
    let quietSince = settleStartedAt;
    while (Date.now() < settleLimit) {
      result.diagnostics.route = routeKind(page.url());
      draftUrl = durableEditorUrl(page.url());

      if (result.diagnostics.saveControl.clicked) {
        const savingVisible = await savingControl.count() > 0 && await savingControl.isVisible();
        if (savingVisible && !result.diagnostics.saveControl.savingObserved) {
          result.diagnostics.saveControl.savingObserved = true;
          quietSince = Date.now();
        }
        const readyVisible = await saveControl.count() > 0
          && await saveControl.isVisible()
          && await saveControl.isEnabled();
        if (result.diagnostics.saveControl.savingObserved && readyVisible
            && !result.diagnostics.saveControl.readyObservedAfterSaving) {
          result.diagnostics.saveControl.readyObservedAfterSaving = true;
          quietSince = Date.now();
        }
      }

      const explicitSettled = result.diagnostics.saveControl.clicked
        && (!result.diagnostics.saveControl.savingObserved
          || result.diagnostics.saveControl.readyObservedAfterSaving)
        && Date.now() - quietSince >= settleDelayMs;
      const autosaveSettled = !result.diagnostics.saveControl.clicked
        && Date.now() - settleStartedAt >= Math.max(autosaveDebounceMs, settleDelayMs);
      if (draftUrl && (explicitSettled || autosaveSettled)) break;
      await page.waitForTimeout(Math.min(250, pollIntervalMs, remaining(), Math.max(1, settleLimit - Date.now())));
    }
    result.diagnostics.settleElapsedMs = Date.now() - settleStartedAt;
    if (result.diagnostics.saveControl.clicked
        && result.diagnostics.saveControl.savingObserved
        && !result.diagnostics.saveControl.readyObservedAfterSaving) {
      stage('explicit_save_state_unsettled');
      return { ...result, reason: failureReason };
    }
    if (!draftUrl) {
      stage('durable_draft_url_unconfirmed');
      return { ...result, reason: failureReason };
    }
    stage('verification_context_failed');
    verificationContext = await browser.newContext({
      // Reuse the pre-run authentication snapshot, not post-input localStorage,
      // so client-side editor state cannot masquerade as server persistence.
      storageState: statePath,
      ...contextIdentity,
      serviceWorkers: 'block',
    });
    verificationContext.setDefaultTimeout(remaining());
    const verificationPage = await verificationContext.newPage();
    stage('draft_reopen_failed');
    const reopened = await verificationPage.goto(draftUrl, {
      waitUntil: 'domcontentloaded', timeout: remaining(),
    });
    if (reopened && reopened.status() >= 400) {
      stage('draft_reopen_http_error');
      return { ...result, reason: 'draft_reopen_http_error' };
    }

    while (Date.now() < deadline) {
      result.diagnostics.route = routeKind(verificationPage.url());
      if (isLoginUrl(verificationPage.url())) {
        stage('draft_reopen_login_required');
        return { ...result, reason: 'draft_reopen_login_required' };
      }
      if (durableEditorUrl(verificationPage.url()) !== draftUrl) {
        stage('draft_reopen_url_mismatch');
        return { ...result, reason: 'draft_reopen_url_mismatch' };
      }
      stage('draft_readback_failed');
      const reopenedFields = await fields(verificationPage, 'verification');
      const observed = await read(reopenedFields);
      const readbackComparison = compare(observed);
      result.diagnostics.readback = readbackComparison;
      if (matches(readbackComparison)) {
        stage('verified');
        return {
          ...result,
          status: 'saved',
          reason: 'isolated_context_readback_matched',
          verifiedHash: article.hash,
          verification: {
            method: 'isolated_context_readback',
            titleMatched: true,
            bodyMatched: true,
            normalization: 'CRLF_or_CR_to_LF_on_observed_editor_text_only',
            verifiedAt: new Date().toISOString(),
          },
        };
      }
      result.verification = {
        method: 'isolated_context_readback',
        titleMatched: readbackComparison.title.matched,
        bodyMatched: readbackComparison.body.matched,
        normalization: 'CRLF_or_CR_to_LF_on_observed_editor_text_only',
      };
      stage('draft_readback_mismatch');
      await verificationPage.waitForTimeout(Math.min(pollIntervalMs, remaining()));
      if (Date.now() >= deadline) break;
      await verificationPage.reload({ waitUntil: 'domcontentloaded', timeout: remaining() });
    }
    return { ...result, reason: failureReason };
  } catch {
    // Errors from browser pages can contain tokens, article text, or private URLs.
    // Keep a stable stage code; do not persist or print exception messages.
    return { ...result, reason: failureReason };
  } finally {
    if (verificationContext) {
      try {
        await verificationContext.close();
      } catch {
        // Cleanup errors must not replace the actual save/verification outcome.
      }
    }
    if (editorContext) {
      try {
        await editorContext.close();
      } catch {
        // Cleanup errors must not replace the actual save/verification outcome.
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Cleanup errors must not replace the actual save/verification outcome.
      }
    }
  }
}
