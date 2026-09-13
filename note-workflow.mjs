import Anthropic from '@anthropic-ai/sdk';
import { appendFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig, readInputs, bool, hash } from './lib/domain.mjs';
import { runWorkflow } from './lib/pipeline.mjs';

export async function main(env = process.env) {
  const inputs = readInputs(env);
  const config = await loadConfig(env);
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');
  let commit = env.GITHUB_SHA || null;
  if (!commit) {
    try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* Recorded as unknown. */ }
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: config.requestTimeoutMs });
  const lockText = await readFile(new URL('./package-lock.json', import.meta.url), 'utf8');
  const lock = JSON.parse(lockText);
  const result = await runWorkflow({
    inputs, config, client,
    dryRun: bool(env.DRY_RUN, true),
    isPublic: bool(env.IS_PUBLIC, false),
    outputDir: env.REPORT_OUTPUT_DIR || 'output/runs',
    metadata: { commit, nodeVersion: process.version, githubRunId: env.GITHUB_RUN_ID || null,
      githubRunAttempt: env.GITHUB_RUN_ATTEMPT || null, timezone: 'UTC', lockHash: hash(lockText),
      dependencyVersions: Object.fromEntries(['@anthropic-ai/sdk', 'playwright', 'promptfoo', 'diff'].map(name => [name, lock.packages[`node_modules/${name}`]?.version ?? null])) },
  });
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, result.report.summary + '\n');
  console.log(`Run status: ${result.status}`);
  console.log(`Review report: ${result.report.markdownPath}`);
  console.log(`HTML report: ${result.report.htmlPath}`);
  process.exitCode = result.exitCode;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Provider errors can include request data; detailed sanitized records live in the artifact.
    console.error('Workflow failed. Check the inputs, credentials and any preserved run report.');
    process.exitCode = 1;
  });
}
