import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

const NEW_DRAFT_URL = 'https://editor.note.com/new';
const TITLE_SELECTOR = 'textarea[placeholder="記事タイトル"]';
const BODY_SELECTOR = '[contenteditable="true"]';

// Whitespace is article content. Only platform line-ending differences are ignored.
export function normalizeEditorText(value) {
  return value.replace(/\r\n?/g, '\n');
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
  return safe && /^\/notes\/[A-Za-z0-9_-]+\/edit\/?$/.test(new URL(safe).pathname)
    ? safe
    : null;
}

function isLoginUrl(value) {
  try {
    return /\/(?:login|signin)(?:\/|$)/.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

/**
 * Create one draft and verify it by reading the same durable editor URL in a new
 * page. A timeout, input completion, or screenshot never counts as saved.
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
} = {}) {
  const result = {
    status: 'not_started',
    reason: 'not_started',
    articleId: article?.id ?? null,
    articleHash: article?.hash ?? null,
    verifiedHash: null,
    url: null,
    published: false,
    publishActionPerformed: false,
    publicationVerified: false,
    publicationReason: 'no_browser_write_performed',
    verification: null,
  };
  if (!article || typeof article.title !== 'string' || !article.title.trim()
      || typeof article.body !== 'string' || !article.body.trim()
      || typeof article.hash !== 'string' || !article.hash) {
    return { ...result, reason: 'invalid_article' };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000
      || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    return { ...result, reason: 'invalid_timeout' };
  }
  try {
    await access(statePath, constants.R_OK);
  } catch {
    return { ...result, reason: 'login_state_missing_or_unreadable' };
  }

  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error('operation_deadline_exceeded');
    return value;
  };
  const fields = async (page) => {
    const title = page.locator(TITLE_SELECTOR).first();
    const body = page.locator(BODY_SELECTOR).first();
    await title.waitFor({ state: 'visible', timeout: remaining() });
    await body.waitFor({ state: 'visible', timeout: remaining() });
    return { title, body };
  };
  const read = async ({ title, body }) => ({
    title: normalizeEditorText(await title.inputValue({ timeout: remaining() })),
    body: normalizeEditorText(await body.innerText({ timeout: remaining() })),
  });
  const expected = {
    title: normalizeEditorText(article.title),
    body: normalizeEditorText(article.body),
  };
  const matches = (value) => value.title === expected.title && value.body === expected.body;
  let browser;
  let failureReason = 'browser_launch_failed';
  try {
    const launcher = browserType ?? (await import('playwright')).chromium;
    browser = await launcher.launch({ headless: true, timeout: remaining() });
    failureReason = 'browser_context_failed';
    const context = await browser.newContext({
      storageState: statePath,
      // Keep the browser identity used by the existing working draft flow.
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
      locale: 'ja-JP',
      viewport: { width: 1440, height: 1000 },
    });
    context.setDefaultTimeout(remaining());
    const page = await context.newPage();
    failureReason = 'editor_open_failed';
    const response = await page.goto(NEW_DRAFT_URL, {
      waitUntil: 'domcontentloaded', timeout: remaining(),
    });
    result.url = editorUrl(page.url());
    if (isLoginUrl(page.url())) return { ...result, reason: 'login_required' };
    if (!result.url || (response && response.status() >= 400)) {
      return { ...result, reason: 'editor_unavailable' };
    }
    failureReason = 'editor_fields_unavailable';
    const originalFields = await fields(page);
    const initial = await read(originalFields);
    if (initial.title.trim() || initial.body.trim()) {
      return { ...result, reason: 'editor_not_empty' };
    }

    // Treat even a partially failed input as a possible remote write. Never retry
    // /new automatically after this point: that could create duplicate drafts.
    result.status = 'input_only';
    result.published = 'unknown';
    result.publicationReason = 'no_publish_action_performed_status_unverified';
    failureReason = 'title_input_failed';
    await originalFields.title.fill(article.title, { timeout: remaining() });
    failureReason = 'body_input_failed';
    await originalFields.body.click({ timeout: remaining() });
    await page.keyboard.insertText(article.body);
    if (!matches(await read(originalFields))) {
      return { ...result, url: editorUrl(page.url()), reason: 'editor_input_mismatch' };
    }
    await originalFields.title.click({ timeout: remaining() });
    result.status = 'save_unconfirmed';
    failureReason = 'durable_draft_url_unconfirmed';
    await page.waitForURL((url) => Boolean(durableEditorUrl(url.href)), {
      timeout: remaining(), waitUntil: 'domcontentloaded',
    });
    const draftUrl = durableEditorUrl(page.url());
    if (!draftUrl) return { ...result, reason: failureReason };
    result.url = draftUrl;

    failureReason = 'draft_reopen_failed';
    const verificationPage = await context.newPage();
    const reopened = await verificationPage.goto(draftUrl, {
      waitUntil: 'domcontentloaded', timeout: remaining(),
    });
    if (reopened && reopened.status() >= 400) return { ...result, reason: 'draft_reopen_http_error' };

    while (Date.now() < deadline) {
      if (isLoginUrl(verificationPage.url())) return { ...result, reason: 'draft_reopen_login_required' };
      if (durableEditorUrl(verificationPage.url()) !== draftUrl) {
        return { ...result, reason: 'draft_reopen_url_mismatch' };
      }
      failureReason = 'draft_readback_failed';
      const reopenedFields = await fields(verificationPage);
      const observed = await read(reopenedFields);
      if (matches(observed)) {
        return {
          ...result,
          status: 'saved',
          reason: 'fresh_editor_readback_matched',
          verifiedHash: article.hash,
          verification: {
            method: 'fresh_page_same_context',
            titleMatched: true,
            bodyMatched: true,
            normalization: 'CRLF_or_CR_to_LF_only',
            verifiedAt: new Date().toISOString(),
          },
        };
      }
      result.verification = {
        method: 'fresh_page_same_context',
        titleMatched: observed.title === expected.title,
        bodyMatched: observed.body === expected.body,
        normalization: 'CRLF_or_CR_to_LF_only',
      };
      failureReason = 'draft_readback_mismatch';
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
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Cleanup errors must not replace the actual save/verification outcome.
      }
    }
  }
}
