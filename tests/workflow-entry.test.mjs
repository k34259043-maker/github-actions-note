import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { main, noteResultSummary, preflightNoteState } from '../note-workflow.mjs';

async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'note-entry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const inputs = {
  THEME: 'GitHub Actionsの活用',
  TARGET: '初心者',
  MESSAGE: '作業を自動化する',
  CTA: 'テストする',
  TAGS: 'GitHub,AI',
};

test('workflow names distinguish the current draft-only path from legacy publish-capable paths', async () => {
  const workflowDir = new URL('../.github/workflows/', import.meta.url);
  const files = ['main.yml', 'note.yaml', 'note-perplexity.yaml'];
  const names = [];
  for (const file of files) {
    const workflow = YAML.parse(await readFile(new URL(file, workflowDir), 'utf8'));
    names.push(workflow.name);
  }
  assert.equal(new Set(names).size, names.length);
  assert.match(names[0], /Current - Draft Only/);
  assert.match(names[1], /Legacy.*Can Publish/);
  assert.match(names[2], /Legacy.*Can Publish/);
});

function fakeBrowserType({
  url = 'https://note.com/notes',
  status = 200,
  mainText = '記事一覧',
  settledUrl,
} = {}) {
  const state = { closed: false, urls: [], waits: 0 };
  let currentUrl = url;
  return {
    state,
    async launch() {
      return {
        async newContext() {
          return {
            setDefaultTimeout() {},
            async newPage() {
              return {
                async goto(target) { state.urls.push(target); return { status: () => status }; },
                url: () => currentUrl,
                locator: selector => ({
                  count: async () => selector === 'main' ? 1 : 0,
                  first() { return this; },
                  async isVisible() { return selector === 'main'; },
                  async innerText() { return selector === 'main' ? mainText : ''; },
                }),
                async waitForTimeout() {
                  state.waits++;
                  if (settledUrl) currentUrl = settledUrl;
                },
              };
            },
          };
        },
        async close() { state.closed = true; },
      };
    },
  };
}

test('non-dry run rejects missing login state before client creation or workflow calls', async t => {
  const dir = await temporary(t);
  let clients = 0;
  let workflowCalls = 0;
  await assert.rejects(
    main({ ...inputs, DRY_RUN: 'false', ANTHROPIC_API_KEY: 'unused', NOTE_STATE_PATH: path.join(dir, 'missing.json') }, {
      createClient: () => { clients += 1; return {}; },
      log: () => {},
      runWorkflow: async () => { workflowCalls += 1; },
    }),
    error => error.code === 'login_state_missing_or_unreadable',
  );
  assert.equal(clients, 0);
  assert.equal(workflowCalls, 0);
});

test('note-state preflight distinguishes invalid JSON and invalid Playwright state shape', async t => {
  const dir = await temporary(t);
  const statePath = path.join(dir, 'note-state.json');
  await writeFile(statePath, '{not-json', 'utf8');
  await assert.rejects(preflightNoteState({ dryRun: false, statePath }),
    error => error.code === 'login_state_invalid_json');
  await writeFile(statePath, JSON.stringify({ cookies: 'hidden', origins: [] }), 'utf8');
  await assert.rejects(preflightNoteState({ dryRun: false, statePath }),
    error => error.code === 'login_state_invalid_shape');
  await writeFile(statePath, JSON.stringify({ cookies: [], origins: [] }), 'utf8');
  await assert.rejects(preflightNoteState({ dryRun: false, statePath }),
    error => error.code === 'login_state_invalid_shape');
  await writeFile(statePath, JSON.stringify({
    cookies: [{ name: 'session', value: 'value', domain: '.note.com', path: '/', expires: -1,
      httpOnly: true, secure: true, sameSite: 'INVALID' }],
    origins: [],
  }), 'utf8');
  await assert.rejects(preflightNoteState({ dryRun: false, statePath }),
    error => error.code === 'login_state_invalid_shape');
  await writeFile(statePath, JSON.stringify({
    cookies: [{ name: 'session', value: 'expired', domain: '.note.com', path: '/', expires: 1,
      httpOnly: true, secure: true, sameSite: 'Lax' }],
    origins: [],
  }), 'utf8');
  await assert.rejects(preflightNoteState({ dryRun: false, statePath }),
    error => error.code === 'login_state_invalid_shape');
});

test('note-state preflight rejects invalid account readiness timing before browser launch', async t => {
  const dir = await temporary(t);
  const statePath = path.join(dir, 'note-state.json');
  await writeFile(statePath, JSON.stringify({
    cookies: [{ name: 'session', value: 'value', domain: '.note.com', path: '/', expires: -1,
      httpOnly: true, secure: true, sameSite: 'Lax' }],
    origins: [],
  }), 'utf8');
  const browserType = fakeBrowserType();
  await assert.rejects(preflightNoteState({
    dryRun: false,
    statePath,
    browserType,
    timeoutMs: 1_000,
    accountReadyTimeoutMs: 1_000,
    accountPollIntervalMs: 1,
  }), error => error.code === 'login_state_preflight_readiness_invalid');
  assert.deepEqual(browserType.state.urls, []);
});

test('dry-run does not require note-state', async t => {
  const dir = await temporary(t);
  assert.deepEqual(await preflightNoteState({ dryRun: true, statePath: path.join(dir, 'missing.json') }),
    { status: 'skipped', reason: 'DRY_RUN=true' });
  assert.deepEqual(noteResultSummary({ status: 'completed', note: { status: 'skipped', reason: 'DRY_RUN=true' } }), {
    runStatus: 'completed',
    status: 'skipped',
    reason: 'DRY_RUN=true',
    markdown: '## note保存結果\n\n- Run status: `completed`\n- Note status: `skipped`\n- Note reason: `DRY_RUN=true`',
  });
});

test('main logs and writes safe note status and reason', async t => {
  const dir = await temporary(t);
  const statePath = path.join(dir, 'note-state.json');
  const summaryPath = path.join(dir, 'summary.md');
  await writeFile(statePath, JSON.stringify({
    cookies: [{ name: 'session', value: 'secret-value', domain: '.note.com', path: '/', expires: -1,
      httpOnly: true, secure: true, sameSite: 'Lax' }],
    origins: [],
  }), 'utf8');
  const logs = [];
  const browserType = fakeBrowserType();
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; });
  const result = await main({
    ...inputs,
    DRY_RUN: 'false',
    ANTHROPIC_API_KEY: 'unused',
    NOTE_STATE_PATH: statePath,
    GITHUB_STEP_SUMMARY: summaryPath,
  }, {
    browserType,
    accountStableMs: 0,
    createClient: () => ({ fake: true }),
    log: value => logs.push(value),
    runWorkflow: async options => {
      assert.equal(options.noteStatePath, statePath);
      return {
        status: 'note_input_incomplete',
        exitCode: 1,
        note: { status: 'input_only', reason: 'editor_input_mismatch' },
        report: { summary: '既存の評価概要', markdownPath: '/safe/report.md', htmlPath: '/safe/report.html' },
      };
    },
  });
  assert.equal(result.status, 'note_input_incomplete');
  assert.ok(logs.includes('Note status: input_only'));
  assert.ok(logs.includes('Note reason: editor_input_mismatch'));
  assert.ok(!logs.join('\n').includes('secret-value'));
  const summary = await readFile(summaryPath, 'utf8');
  assert.match(summary, /Run status: `note_input_incomplete`/);
  assert.match(summary, /Note status: `input_only`/);
  assert.match(summary, /Note reason: `editor_input_mismatch`/);
  assert.ok(!summary.includes('secret-value'));
  assert.deepEqual(browserType.state.urls, ['https://note.com/notes']);
});

test('an unusable live note session stops before client creation or workflow calls', async t => {
  const dir = await temporary(t);
  const statePath = path.join(dir, 'note-state.json');
  await writeFile(statePath, JSON.stringify({
    cookies: [{ name: 'session', value: 'secret-value', domain: '.note.com', path: '/', expires: -1,
      httpOnly: true, secure: true, sameSite: 'Lax' }],
    origins: [],
  }), 'utf8');
  let clients = 0;
  let workflowCalls = 0;
  const browserType = fakeBrowserType({ url: 'https://note.com/login' });
  await assert.rejects(main({
    ...inputs,
    DRY_RUN: 'false',
    ANTHROPIC_API_KEY: 'unused',
    NOTE_STATE_PATH: statePath,
  }, {
    browserType,
    createClient: () => { clients += 1; return {}; },
    log: () => {},
    runWorkflow: async () => { workflowCalls += 1; },
  }), error => error.code === 'login_state_session_unusable');
  assert.equal(clients, 0);
  assert.equal(workflowCalls, 0);
  assert.equal(browserType.state.closed, true);
});

test('a delayed client-side login redirect fails before model work', async t => {
  const dir = await temporary(t);
  const statePath = path.join(dir, 'note-state.json');
  await writeFile(statePath, JSON.stringify({
    cookies: [{ name: 'session', value: 'expired-looking-but-shaped', domain: '.note.com', path: '/', expires: -1,
      httpOnly: true, secure: true, sameSite: 'Lax' }],
    origins: [],
  }), 'utf8');
  let clients = 0;
  let workflowCalls = 0;
  await assert.rejects(main({
    ...inputs,
    DRY_RUN: 'false',
    ANTHROPIC_API_KEY: 'unused',
    NOTE_STATE_PATH: statePath,
  }, {
    browserType: fakeBrowserType({ mainText: '一時的に描画された画面', settledUrl: 'https://note.com/login?redirectPath=%2Fnotes' }),
    accountReadyTimeoutMs: 20,
    accountPollIntervalMs: 1,
    accountStableMs: 5,
    createClient: () => { clients += 1; return {}; },
    log: () => {},
    runWorkflow: async () => { workflowCalls += 1; },
  }), error => error.code === 'login_state_session_unusable');
  assert.equal(clients, 0);
  assert.equal(workflowCalls, 0);
});

test('an unresolved empty account shell fails before model work', async t => {
  const dir = await temporary(t);
  const statePath = path.join(dir, 'note-state.json');
  await writeFile(statePath, JSON.stringify({
    cookies: [{ name: 'session', value: 'shaped-but-unverified', domain: '.note.com', path: '/', expires: -1,
      httpOnly: true, secure: true, sameSite: 'Lax' }],
    origins: [],
  }), 'utf8');
  let clients = 0;
  await assert.rejects(main({
    ...inputs,
    DRY_RUN: 'false',
    ANTHROPIC_API_KEY: 'unused',
    NOTE_STATE_PATH: statePath,
  }, {
    browserType: fakeBrowserType({ mainText: '' }),
    accountReadyTimeoutMs: 5,
    accountPollIntervalMs: 1,
    accountStableMs: 0,
    createClient: () => { clients += 1; return {}; },
    log: () => {},
  }), error => error.code === 'login_state_account_not_ready');
  assert.equal(clients, 0);
});

test('unsafe status text is replaced before logs or step summaries are rendered', () => {
  const summary = noteResultSummary({ status: 'completed\nTOKEN=secret', note: { status: 'saved\nTOKEN=secret', reason: '${{ secrets.NOTE_STATE_BASE64 }}' } });
  assert.equal(summary.runStatus, 'unknown');
  assert.equal(summary.status, 'unknown');
  assert.equal(summary.reason, 'unknown');
  assert.ok(!summary.markdown.includes('secret'));
});
