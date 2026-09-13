import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeEditorText, saveNoteDraft } from '../lib/note-save.mjs';

const article = { id: 'article-1', hash: 'recorded-article-hash', title: '記事タイトル', body: '本文です。\n\n次の段落です。' };
const durable = 'https://editor.note.com/notes/n123abc/edit';

function fakeBrowser(options = {}) {
  const calls = { closed: 0, launches: 0, pages: [], inserted: [], navigations: [] };
  const context = {
    setDefaultTimeout() {},
    async newPage() {
      const verifying = calls.pages.length > 0;
      const state = {
        title: verifying ? (options.readTitle ?? article.title) : (options.initialTitle ?? ''),
        body: verifying ? (options.readBody ?? article.body) : (options.initialBody ?? ''),
        url: '',
      };
      const field = (kind) => ({
        first() { return this; },
        async waitFor() { if (options.fieldsFail) throw new Error('private DOM token'); },
        async inputValue() { return state.title; },
        async innerText() { return state.body; },
        async fill(value) { state[kind] = value; },
        async click() {},
      });
      const page = {
        state,
        async goto(url) {
          calls.navigations.push(url);
          if (verifying && options.reopenFail) throw new Error('private token in URL');
          state.url = options.login && !verifying ? 'https://note.com/login?token=secret'
            : verifying ? (options.reopenUrl ?? url) : 'https://editor.note.com/new';
          return { status: () => 200 };
        },
        url: () => state.url,
        locator(selector) { return field(selector.startsWith('textarea') ? 'title' : 'body'); },
        keyboard: {
          async insertText(value) {
            calls.inserted.push(value);
            if (options.inputFail) throw new Error('private article text');
            state.body = options.inputMismatch ? value + ' ' : value;
            state.url = options.noDurable ? state.url : `${durable}?secret=credential#private`;
          },
        },
        async waitForURL(predicate) {
          if (!predicate(new URL(state.url))) throw new Error('url timeout');
        },
        async waitForTimeout(ms) { await new Promise((resolve) => setTimeout(resolve, ms)); },
        async reload() {
          if (options.bodyAfterReload !== undefined) state.body = options.bodyAfterReload;
        },
      };
      calls.pages.push(page);
      return page;
    },
  };
  const browserType = {
    async launch() {
      calls.launches++;
      return {
        async newContext() {
          if (options.contextFail) throw new Error('storage state secret');
          return context;
        },
        async close() { calls.closed++; },
      };
    },
  };
  return { browserType, calls };
}

async function withState(run) {
  const dir = await mkdtemp(join(tmpdir(), 'note-save-test-'));
  const statePath = join(dir, 'state.json');
  await writeFile(statePath, '{"cookies":[],"origins":[]}');
  try { await run(statePath); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('saved requires a separate page to reopen the durable URL and match both fields', async () => {
  await withState(async (statePath) => {
    const { browserType, calls } = fakeBrowser();
    const result = await saveNoteDraft(article, { statePath, browserType });
    assert.equal(result.status, 'saved');
    assert.equal(result.verifiedHash, article.hash);
    assert.equal(result.url, durable);
    assert.equal(result.published, 'unknown');
    assert.equal(result.publishActionPerformed, false);
    assert.equal(result.publicationVerified, false);
    assert.deepEqual(calls.navigations, ['https://editor.note.com/new', durable]);
    assert.deepEqual(calls.inserted, [article.body]);
    assert.equal(calls.pages[0].state.title, article.title);
    assert.equal(calls.pages[0].state.body.includes(article.title), false);
    assert.equal(calls.closed, 1);
  });
});

test('line endings are normalized but whitespace is not silently discarded', async () => {
  assert.equal(normalizeEditorText('a\r\nb\rc\n'), 'a\nb\nc\n');
  assert.equal(normalizeEditorText(' a \n\n'), ' a \n\n');
  await withState(async (statePath) => {
    const { browserType } = fakeBrowser({ readBody: article.body.replaceAll('\n', '\r\n') });
    assert.equal((await saveNoteDraft(article, { statePath, browserType })).status, 'saved');
  });
});

for (const difference of [
  { readTitle: '別の記事タイトル' },
  { readBody: article.body + ' ' },
]) {
  test(`a reopened content mismatch cannot claim verified saved: ${Object.keys(difference)[0]}`, async () => {
    await withState(async (statePath) => {
      const { browserType, calls } = fakeBrowser(difference);
      const result = await saveNoteDraft(article, { statePath, browserType, timeoutMs: 200, pollIntervalMs: 5 });
      assert.equal(result.status, 'save_unconfirmed');
      assert.equal(result.reason, 'draft_readback_mismatch');
      assert.equal(result.verifiedHash, null);
      assert.equal(calls.closed, 1);
      assert.equal(calls.navigations.filter((url) => url.endsWith('/new')).length, 1);
    });
  });
}

test('missing login state performs no browser action', async () => {
  const { browserType, calls } = fakeBrowser();
  const result = await saveNoteDraft(article, { statePath: '/nonexistent/note-save-test-state.json', browserType });
  assert.equal(result.status, 'not_started');
  assert.equal(result.reason, 'login_state_missing_or_unreadable');
  assert.equal(calls.launches, 0);
});

test('autosave lag is handled by rereading the same draft, without creating another', async () => {
  await withState(async (statePath) => {
    const { browserType, calls } = fakeBrowser({ readBody: '', bodyAfterReload: article.body });
    const result = await saveNoteDraft(article, { statePath, browserType, pollIntervalMs: 1 });
    assert.equal(result.status, 'saved');
    assert.equal(result.verifiedHash, article.hash);
    assert.equal(calls.pages.length, 2);
    assert.deepEqual(calls.navigations, ['https://editor.note.com/new', durable]);
    assert.equal(calls.closed, 1);
  });
});

for (const [options, status, reason] of [
  [{ login: true }, 'not_started', 'login_required'],
  [{ contextFail: true }, 'not_started', 'browser_context_failed'],
  [{ initialBody: '既存の記事本文' }, 'not_started', 'editor_not_empty'],
  [{ inputFail: true }, 'input_only', 'body_input_failed'],
  [{ inputMismatch: true }, 'input_only', 'editor_input_mismatch'],
  [{ noDurable: true }, 'save_unconfirmed', 'durable_draft_url_unconfirmed'],
  [{ reopenFail: true }, 'save_unconfirmed', 'draft_reopen_failed'],
  [{ reopenUrl: 'https://editor.note.com/notes/nOTHER/edit' }, 'save_unconfirmed', 'draft_reopen_url_mismatch'],
]) {
  test(`${reason} preserves uncertainty and closes the browser`, async () => {
    await withState(async (statePath) => {
      const { browserType, calls } = fakeBrowser(options);
      const result = await saveNoteDraft(article, { statePath, browserType });
      assert.equal(result.status, status);
      assert.equal(result.reason, reason);
      assert.equal(result.verifiedHash, null);
      assert.equal(calls.closed, 1);
      assert.equal(JSON.stringify(result).includes('secret'), false);
      assert.equal(JSON.stringify(result).includes('private'), false);
      assert.equal(calls.navigations.filter((url) => url.endsWith('/new')).length, options.contextFail ? 0 : 1);
    });
  });
}
