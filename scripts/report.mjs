#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { appendRunEvent } from '../lib/record-store.mjs';
import { writeReports } from '../lib/report.mjs';

export async function main(args = process.argv.slice(2)) {
  let runDir;
  let asOf;
  let feedbackPath;
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--as-of' && args[i + 1]) asOf = args[++i];
    else if (argument === '--feedback' && args[i + 1]) feedbackPath = args[++i];
    else if (!argument.startsWith('-') && !runDir) runDir = argument;
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  if (!runDir) throw new Error('Usage: node scripts/report.mjs <run-directory> [--as-of ISO-time] [--feedback feedback.json]');
  if (asOf && Number.isNaN(Date.parse(asOf))) throw new Error('--as-of must be an ISO date/time');
  if (feedbackPath) {
    const supplied = JSON.parse(await readFile(feedbackPath, 'utf8'));
    const type = supplied.type ?? 'feedback.appended';
    if (!['feedback.appended', 'adoption.decided'].includes(type)) throw new Error('Feedback may only append feedback.appended or adoption.decided events');
    const data = supplied.data ?? supplied;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Feedback data must be a JSON object');
    await appendRunEvent(runDir, type, data);
  }
  const result = await writeReports(runDir, { asOf });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`Report generation failed: ${error.message}\n`); process.exitCode = 1; });
}
