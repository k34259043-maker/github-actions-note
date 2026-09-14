import Anthropic from '@anthropic-ai/sdk';
import { appendFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig, readInputs, bool, hash } from './lib/domain.mjs';
import { runWorkflow } from './lib/pipeline.mjs';

const SAFE_RESULT_CODE = /^[A-Za-z0-9_.:=-]{1,100}$/;
const SAME_SITE_VALUES = new Set(['Strict', 'Lax', 'None']);
// The account's article list is a read-only authentication check. Do not open
// /new during preflight because whether navigation alone allocates an empty
// draft is not a documented platform contract.
const NOTE_ACCOUNT_URL = 'https://note.com/notes';

function preflightError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNoteHost(value) {
  try {
    const hostname = value.includes('://') ? new URL(value).hostname : value.replace(/^\./, '');
    return hostname === 'note.com' || hostname.endsWith('.note.com');
  } catch {
    return false;
  }
}

function validStorageState(value) {
  if (!isRecord(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) return false;
  const cookiesValid = value.cookies.every(cookie => isRecord(cookie)
    && typeof cookie.name === 'string' && cookie.name.length > 0
    && typeof cookie.value === 'string'
    && typeof cookie.domain === 'string' && cookie.domain.length > 0
    && typeof cookie.path === 'string' && cookie.path.startsWith('/')
    && Number.isFinite(cookie.expires)
    && typeof cookie.httpOnly === 'boolean'
    && typeof cookie.secure === 'boolean'
    && SAME_SITE_VALUES.has(cookie.sameSite));
  const originsValid = value.origins.every(origin => isRecord(origin)
    && typeof origin.origin === 'string' && URL.canParse(origin.origin)
    && Array.isArray(origin.localStorage)
    && origin.localStorage.every(item => isRecord(item)
      && typeof item.name === 'string' && typeof item.value === 'string'));
  const currentTime = Date.now() / 1000;
  const hasNoteCredential = value.cookies.some(cookie => isNoteHost(cookie.domain)
      && cookie.value.length > 0 && (cookie.expires === -1 || cookie.expires > currentTime))
    || value.origins.some(origin => isNoteHost(origin.origin)
      && origin.localStorage.some(item => item.value.length > 0));
  return cookiesValid && originsValid && hasNoteCredential;
}

export async function preflightNoteState({
  dryRun,
  statePath = './note-state.json',
  browserType,
  timeoutMs = 30_000,
  accountReadyTimeoutMs = 10_000,
  accountPollIntervalMs = 250,
  accountStableMs = 1_000,
}) {
  if (dryRun) return { status: 'skipped', reason: 'DRY_RUN=true' };
  let text;
  try {
    text = await readFile(statePath, 'utf8');
  } catch {
    throw preflightError('login_state_missing_or_unreadable');
  }
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    throw preflightError('login_state_invalid_json');
  }
  if (!validStorageState(state)) throw preflightError('login_state_invalid_shape');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw preflightError('login_state_preflight_timeout_invalid');
  }
  if (!Number.isFinite(accountReadyTimeoutMs) || accountReadyTimeoutMs <= 0
      || accountReadyTimeoutMs >= timeoutMs
      || !Number.isFinite(accountPollIntervalMs) || accountPollIntervalMs <= 0
      || accountPollIntervalMs > accountReadyTimeoutMs
      || !Number.isFinite(accountStableMs) || accountStableMs < 0
      || accountStableMs >= accountReadyTimeoutMs) {
    throw preflightError('login_state_preflight_readiness_invalid');
  }

  let browser;
  let failureCode = 'login_state_browser_launch_failed';
  try {
    const launcher = browserType ?? (await import('playwright')).chromium;
    browser = await launcher.launch({ headless: true, timeout: timeoutMs });
    failureCode = 'login_state_playwright_rejected';
    const context = await browser.newContext({
      storageState: statePath,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
      locale: 'ja-JP',
      serviceWorkers: 'block',
    });
    context.setDefaultTimeout(timeoutMs);
    const page = await context.newPage();
    failureCode = 'login_state_account_unreachable';
    const response = await page.goto(NOTE_ACCOUNT_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (response && response.status() >= 400) throw preflightError('login_state_account_unreachable');
    // Logged-out visitors initially receive a 200 /notes shell and are then
    // redirected client-side. Require rendered account content while the exact
    // route remains stable; do not persist or log the page text.
    failureCode = 'login_state_account_readiness_failed';
    const readinessDeadline = Date.now() + accountReadyTimeoutMs;
    const main = page.locator('main');
    let readySince = null;
    while (Date.now() < readinessDeadline) {
      let location;
      try { location = new URL(page.url()); } catch { throw preflightError('login_state_session_unusable'); }
      if (location.protocol !== 'https:' || location.hostname !== 'note.com'
          || !/^\/notes\/?$/.test(location.pathname)) {
        throw preflightError('login_state_session_unusable');
      }
      if (await main.count() === 1 && await main.first().isVisible()
          && (await main.first().innerText()).trim()) {
        readySince ??= Date.now();
        if (Date.now() - readySince >= accountStableMs) {
          return { status: 'ready', reason: 'login_state_account_ready' };
        }
      } else readySince = null;
      await page.waitForTimeout(Math.min(accountPollIntervalMs,
        Math.max(1, readinessDeadline - Date.now())));
    }
    throw preflightError('login_state_account_not_ready');
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('login_state_')) throw error;
    throw preflightError(failureCode);
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* A cleanup error does not change the preflight result. */ }
    }
  }
}

export function safeResultCode(value) {
  return typeof value === 'string' && SAFE_RESULT_CODE.test(value) ? value : 'unknown';
}

export function noteResultSummary(result) {
  const runStatus = safeResultCode(result?.status);
  const status = safeResultCode(result?.note?.status);
  const reason = safeResultCode(result?.note?.reason);
  return {
    runStatus,
    status,
    reason,
    markdown: `## note保存結果\n\n- Run status: \`${runStatus}\`\n- Note status: \`${status}\`\n- Note reason: \`${reason}\``,
  };
}

export async function main(env = process.env, dependencies = {}) {
  const createClient = dependencies.createClient ?? (options => new Anthropic(options));
  const workflow = dependencies.runWorkflow ?? runWorkflow;
  const log = dependencies.log ?? console.log;
  const inputs = readInputs(env);
  const config = await loadConfig(env);
  const dryRun = bool(env.DRY_RUN, true);
  const noteStatePath = env.NOTE_STATE_PATH || './note-state.json';
  try {
    await preflightNoteState({ dryRun, statePath: noteStatePath, browserType: dependencies.browserType,
      accountReadyTimeoutMs: dependencies.accountReadyTimeoutMs,
      accountPollIntervalMs: dependencies.accountPollIntervalMs,
      accountStableMs: dependencies.accountStableMs });
  } catch (error) {
    const reason = safeResultCode(error?.code);
    const noteSummary = noteResultSummary({ status: 'note_not_started', note: { status: 'not_started', reason } });
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${noteSummary.markdown}\n`);
    log('Run status: note_not_started');
    log(`Note status: ${noteSummary.status}`);
    log(`Note reason: ${noteSummary.reason}`);
    throw error;
  }
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');
  let commit = env.GITHUB_SHA || null;
  if (!commit) {
    try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* Recorded as unknown. */ }
  }
  const client = createClient({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: config.requestTimeoutMs });
  const lockText = await readFile(new URL('./package-lock.json', import.meta.url), 'utf8');
  const lock = JSON.parse(lockText);
  const result = await workflow({
    inputs, config, client,
    dryRun,
    isPublic: bool(env.IS_PUBLIC, false),
    noteStatePath,
    outputDir: env.REPORT_OUTPUT_DIR || 'output/runs',
    metadata: { commit, nodeVersion: process.version, githubRunId: env.GITHUB_RUN_ID || null,
      githubRunAttempt: env.GITHUB_RUN_ATTEMPT || null, timezone: 'UTC', lockHash: hash(lockText),
      dependencyVersions: Object.fromEntries(['@anthropic-ai/sdk', 'playwright', 'promptfoo', 'diff'].map(name => [name, lock.packages[`node_modules/${name}`]?.version ?? null])) },
  });
  const noteSummary = noteResultSummary(result);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${result.report.summary}\n\n${noteSummary.markdown}\n`);
  log(`Run status: ${safeResultCode(result.status)}`);
  log(`Note status: ${noteSummary.status}`);
  log(`Note reason: ${noteSummary.reason}`);
  log(`Review report: ${result.report.markdownPath}`);
  log(`HTML report: ${result.report.htmlPath}`);
  process.exitCode = result.exitCode;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Provider errors can include request data; detailed sanitized records live in the artifact.
    if (SAFE_RESULT_CODE.test(error?.code ?? '')) console.error(`Note preflight failed: ${error.code}`);
    else console.error('Workflow failed. Check the inputs, credentials and any preserved run report.');
    process.exitCode = 1;
  });
}
