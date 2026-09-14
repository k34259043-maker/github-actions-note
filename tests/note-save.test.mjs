import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../lib/domain.mjs';
import { normalizeEditorText, saveNoteDraft } from '../lib/note-save.mjs';

const articleContent = { title: '記事タイトル', body: '本文です。\n\n次の段落です。' };
const article = { id: 'article-1', hash: hash(articleContent), ...articleContent };
const durable = 'https://editor.note.com/notes/n123abc/edit';
const fast = { settleDelayMs: 0, settleTimeoutMs: 30, autosaveDebounceMs: 0, pollIntervalMs: 1 };

function fakeBrowser(options = {}) {
  const calls = {
    closed: 0, launches: 0, pages: [], inserted: [], navigations: [], buttonClicks: [],
    buttonLookups: [], contextOptions: [], contextCreatedAt: [], contextsClosed: [],
    storageStateCalls: 0, waits: [], bodyInsertedAt: null,
  };
  const browserType = {
    async launch() {
      calls.launches++;
      return {
        async newContext(contextOptions) {
          const contextIndex = calls.contextOptions.length;
          calls.contextOptions.push(contextOptions);
          calls.contextCreatedAt.push(Date.now());
          if (contextIndex === 0 && options.contextFail) throw new Error('storage state secret');
          if (contextIndex === 1 && options.verificationContextFail) throw new Error('private verifier failure');
          const verifying = contextIndex === 1;
          let saveState = 'ready';
          return {
            setDefaultTimeout() {},
            async storageState() {
              calls.storageStateCalls++;
              return { cookies: [{ name: 'session', value: 'private' }], origins: [] };
            },
            async close() { calls.contextsClosed.push(contextIndex); },
            async newPage() {
              const state = {
                title: verifying ? (options.readTitle ?? article.title) : (options.initialTitle ?? ''),
                body: verifying ? (options.readBody ?? article.body) : (options.initialBody ?? ''),
                url: '',
              };
              const field = (kind) => ({
                first() { return this; },
                async count() {
                  if (kind === 'title') {
                    return verifying
                      ? (options.verificationTitleCount ?? options.titleCount ?? 1)
                      : (options.titleCount ?? 1);
                  }
                  return verifying
                    ? (options.verificationBodyCount ?? options.bodyCount ?? 1)
                    : (options.bodyCount ?? 1);
                },
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
                    : verifying ? (options.reopenUrl ?? `${url}${options.reopenTrailingSlash ? '/' : ''}`)
                      : 'https://editor.note.com/new';
                  return { status: () => verifying && options.reopenStatus ? options.reopenStatus : 200 };
                },
                url: () => state.url,
                locator(selector) { return field(selector.startsWith('textarea') ? 'title' : 'body'); },
                getByRole(role, locatorOptions) {
                  calls.buttonLookups.push({ role, name: locatorOptions?.name, exact: locatorOptions?.exact });
                  const ready = role === 'button' && locatorOptions?.name === '下書き保存' && locatorOptions?.exact === true;
                  const saving = role === 'button' && locatorOptions?.name === '保存中…' && locatorOptions?.exact === true;
                  return {
                    first() { return this; },
                    async count() {
                      if (!(ready || saving)) return 0;
                      if (ready && options.saveButtonCount !== undefined) return options.saveButtonCount;
                      return options.saveButton ? 1 : 0;
                    },
                    async isVisible() {
                      if (ready) return options.saveVisible !== false && saveState === 'ready';
                      return saving && saveState === 'saving';
                    },
                    async isEnabled() { return ready && options.saveEnabled !== false && saveState === 'ready'; },
                    async click() {
                      calls.buttonClicks.push(locatorOptions.name);
                      if (options.saveClickFail) throw new Error('private save failure');
                      saveState = options.savingTransition ? 'saving' : 'ready';
                    },
                  };
                },
                keyboard: {
                  async insertText(value) {
                    calls.inserted.push(value);
                    calls.bodyInsertedAt = Date.now();
                    if (options.inputFail) throw new Error('private article text');
                    state.body = options.inputMismatch ? value + ' ' : value;
                    state.url = options.noDurable ? state.url : `${durable}?secret=credential#private`;
                  },
                },
                async waitForTimeout(ms) {
                  calls.waits.push(ms);
                  await new Promise((resolve) => setTimeout(resolve, ms));
                  if (saveState === 'saving' && !options.saveStuck) saveState = 'ready';
                },
                async reload() {
                  if (options.bodyAfterReload !== undefined) state.body = options.bodyAfterReload;
                },
              };
              calls.pages.push({ contextIndex, page });
              return page;
            },
          };
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

test('saved requires an isolated context to reopen the durable URL and match both fields', async () => {
  await withState(async (statePath) => {
    const { browserType, calls } = fakeBrowser();
    const result = await saveNoteDraft(article, { statePath, browserType, ...fast });
    assert.equal(result.status, 'saved');
    assert.equal(result.verifiedHash, article.hash);
    assert.equal(Object.hasOwn(result, 'url'), false);
    assert.equal(result.published, 'unknown');
    assert.equal(result.publishActionPerformed, false);
    assert.equal(result.publicationVerified, false);
    assert.equal(result.verification.method, 'isolated_context_readback');
    assert.deepEqual(calls.navigations, ['https://editor.note.com/new', durable]);
    assert.deepEqual(calls.inserted, [article.body]);
    assert.equal(calls.pages[0].page.state.title, article.title);
    assert.equal(calls.pages[0].page.state.body.includes(article.title), false);
    assert.equal(calls.contextOptions.length, 2);
    assert.equal(calls.storageStateCalls, 0);
    assert.equal(typeof calls.contextOptions[0].storageState, 'string');
    assert.equal(calls.contextOptions[1].storageState, statePath);
    assert.equal(calls.contextOptions[1].serviceWorkers, 'block');
    assert.deepEqual(calls.contextsClosed, [1, 0]);
    assert.equal(calls.closed, 1);
  });
});

test('line endings are normalized but whitespace is not silently discarded', async () => {
  assert.equal(normalizeEditorText('a\r\nb\rc\n'), 'a\nb\nc\n');
  assert.equal(normalizeEditorText(' a \n\n'), ' a \n\n');
  await withState(async (statePath) => {
    const { browserType } = fakeBrowser({ readBody: article.body.replaceAll('\n', '\r\n') });
    const result = await saveNoteDraft(article, { statePath, browserType, ...fast });
    assert.equal(result.status, 'saved');
    assert.ok(result.diagnostics.readback.body.observedLineEndingsConverted > 0);
  });
});

test('noncanonical body and hash mismatch are rejected before launching a browser', async () => {
  const noncanonicalBody = '1行目  \r\n2行目';
  const noncanonical = {
    ...article,
    body: noncanonicalBody,
    hash: hash({ title: article.title, body: noncanonicalBody }),
  };
  const first = fakeBrowser();
  const noncanonicalResult = await saveNoteDraft(noncanonical, {
    statePath: '/not-needed-for-preflight.json', browserType: first.browserType, ...fast,
  });
  assert.equal(noncanonicalResult.reason, 'noncanonical_article_body');
  assert.equal(first.calls.launches, 0);

  const hashMismatch = fakeBrowser();
  const hashResult = await saveNoteDraft({ ...article, hash: 'wrong' }, {
    statePath: '/not-needed-for-preflight.json', browserType: hashMismatch.browserType, ...fast,
  });
  assert.equal(hashResult.reason, 'article_hash_mismatch');
  assert.equal(hashMismatch.calls.launches, 0);
});

test('the exact draft-save button is clicked and its observable saving-to-ready transition settles', async () => {
  await withState(async (statePath) => {
    const { browserType, calls } = fakeBrowser({ saveButton: true, savingTransition: true });
    const result = await saveNoteDraft(article, { statePath, browserType, ...fast });
    assert.equal(result.status, 'saved');
    assert.deepEqual(calls.buttonClicks, ['下書き保存']);
    assert.equal(calls.buttonLookups.some(({ name }) => /公開|投稿/.test(name)), false);
    assert.deepEqual(result.diagnostics.saveControl, {
      candidates: 1,
      found: true, visible: true, enabled: true, clicked: true,
      savingObserved: true, readyObservedAfterSaving: true,
    });
    assert.equal(result.diagnostics.settleMode, 'explicit_save');
  });
});

test('a durable URL does not bypass the configured autosave debounce', async () => {
  await withState(async (statePath) => {
    const { browserType, calls } = fakeBrowser();
    const result = await saveNoteDraft(article, {
      statePath, browserType, ...fast, autosaveDebounceMs: 12, settleTimeoutMs: 30,
    });
    assert.equal(result.status, 'saved');
    assert.equal(result.diagnostics.settleMode, 'autosave');
    assert.ok(result.diagnostics.settleElapsedMs >= 12);
    assert.ok(calls.contextCreatedAt[1] - calls.bodyInsertedAt >= 12);
  });
});

test('trailing slash redirects identify the same durable draft', async () => {
  await withState(async (statePath) => {
    const { browserType } = fakeBrowser({ reopenTrailingSlash: true });
    const result = await saveNoteDraft(article, { statePath, browserType, ...fast });
    assert.equal(result.status, 'saved');
    assert.equal(Object.hasOwn(result, 'url'), false);
  });
});

test('multiple exact draft-save controls fail safely without clicking one', async () => {
  await withState(async (statePath) => {
    const { browserType, calls } = fakeBrowser({ saveButton: true, saveButtonCount: 2 });
    const result = await saveNoteDraft(article, { statePath, browserType, ...fast });
    assert.equal(result.status, 'save_unconfirmed');
    assert.equal(result.reason, 'explicit_save_control_ambiguous');
    assert.equal(result.diagnostics.saveControl.candidates, 2);
    assert.deepEqual(calls.buttonClicks, []);
  });
});

test('multiple visible body candidates fail safely before any input', async () => {
  await withState(async (statePath) => {
    const { browserType, calls } = fakeBrowser({ bodyCount: 2 });
    const result = await saveNoteDraft(article, { statePath, browserType, ...fast });
    assert.equal(result.status, 'not_started');
    assert.equal(result.reason, 'body_selector_ambiguous');
    assert.deepEqual(result.diagnostics.selectorCandidates.editor, { title: 1, body: 2 });
    assert.deepEqual(calls.inserted, []);
    assert.deepEqual(calls.contextsClosed, [0]);
  });
});

test('ambiguous body candidates in the isolated verifier cannot confirm a save', async () => {
  await withState(async (statePath) => {
    const { browserType, calls } = fakeBrowser({ verificationBodyCount: 2 });
    const result = await saveNoteDraft(article, { statePath, browserType, ...fast });
    assert.equal(result.status, 'save_unconfirmed');
    assert.equal(result.reason, 'body_selector_ambiguous');
    assert.deepEqual(result.diagnostics.selectorCandidates.verification, { title: 1, body: 2 });
    assert.deepEqual(calls.contextsClosed, [1, 0]);
  });
});

test('save mismatch diagnostics contain fingerprints without article text or browser errors', async () => {
  await withState(async (statePath) => {
    const { browserType } = fakeBrowser({ inputMismatch: true });
    const result = await saveNoteDraft(article, { statePath, browserType, ...fast });
    const serialized = JSON.stringify(result);
    assert.equal(result.reason, 'editor_input_mismatch');
    assert.equal(result.diagnostics.input.body.classification, 'content_or_structure_mismatch');
    assert.equal(typeof result.diagnostics.input.body.firstDifference, 'number');
    assert.equal(serialized.includes(article.body), false);
    assert.equal(serialized.includes('private article text'), false);
  });
});

for (const difference of [
  { readTitle: '別の記事タイトル' },
  { readBody: article.body + ' ' },
]) {
  test(`a reopened content mismatch cannot claim verified saved: ${Object.keys(difference)[0]}`, async () => {
    await withState(async (statePath) => {
      const { browserType, calls } = fakeBrowser(difference);
      const result = await saveNoteDraft(article, { statePath, browserType, timeoutMs: 200, pollIntervalMs: 5, ...fast });
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
  const result = await saveNoteDraft(article, { statePath: '/nonexistent/note-save-test-state.json', browserType, ...fast });
  assert.equal(result.status, 'not_started');
  assert.equal(result.reason, 'login_state_missing_or_unreadable');
  assert.equal(calls.launches, 0);
});

test('autosave lag is handled by rereading the same draft, without creating another', async () => {
  await withState(async (statePath) => {
    const { browserType, calls } = fakeBrowser({ readBody: '', bodyAfterReload: article.body });
    const result = await saveNoteDraft(article, { statePath, browserType, pollIntervalMs: 1, ...fast });
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
  [{ saveButton: true, saveClickFail: true }, 'save_unconfirmed', 'explicit_save_click_failed'],
  [{ saveButton: true, savingTransition: true, saveStuck: true }, 'save_unconfirmed', 'explicit_save_state_unsettled'],
  [{ noDurable: true }, 'save_unconfirmed', 'durable_draft_url_unconfirmed'],
  [{ verificationContextFail: true }, 'save_unconfirmed', 'verification_context_failed'],
  [{ reopenFail: true }, 'save_unconfirmed', 'draft_reopen_failed'],
  [{ reopenUrl: 'https://editor.note.com/notes/nOTHER/edit' }, 'save_unconfirmed', 'draft_reopen_url_mismatch'],
]) {
  test(`${reason} preserves uncertainty and closes the browser`, async () => {
    await withState(async (statePath) => {
      const { browserType, calls } = fakeBrowser(options);
      const result = await saveNoteDraft(article, { statePath, browserType, ...fast });
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
