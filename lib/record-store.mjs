import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, lstat, link, unlink } from 'node:fs/promises';
import path from 'node:path';

const REDACTED = '[REDACTED]';
const SECRET_KEY = /^(?:(?:[a-z]+[_-])?api[_-]?key|anthropicApiKey|openaiApiKey|authorization|proxy[_-]?authorization|cookie|cookies|set[_-]?cookie|password|passwd|secret|secrets|credentials|client[_-]?secret|access[_-]?token|refresh[_-]?token|token|note[_-]?state(?:[_-]?base64)?|storage[_-]?state|auth[_-]?state|private[_-]?key)$/i;
const SECRET_ENV = /(?:API[_-]?KEY|(?:^|_)TOKEN$|SECRET|PASSWORD|COOKIE|NOTE_STATE|PRIVATE_KEY|AUTHORIZATION)/i;
const EVENT_FILE = /^(\d{8,})\.json$/;

/** Preserve useful model settings and usage, but never persist credentials. */
export function sanitize(value, secretValues = Object.entries(process.env)
  .filter(([key]) => SECRET_ENV.test(key))
  .map(([, secret]) => secret)
  .filter((secret) => typeof secret === 'string' && secret.length >= 4)) {
  const seen = new WeakSet();
  function visit(item, key = '') {
    if (SECRET_KEY.test(key)) return REDACTED;
    if (typeof item === 'string') {
      let text = item;
      for (const secret of secretValues) text = text.split(secret).join(REDACTED);
      return text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, `Bearer ${REDACTED}`)
        .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, REDACTED);
    }
    if (item === undefined) return null;
    if (typeof item === 'bigint') return String(item);
    if (typeof item === 'number' && !Number.isFinite(item)) return null;
    if (!item || typeof item !== 'object') return item;
    if (item instanceof Date) return item.toISOString();
    if (item instanceof Error) return { name: item.name, message: visit(item.message), code: visit(item.code) };
    if (seen.has(item)) throw new TypeError('Cannot record cyclic data');
    seen.add(item);
    const result = Array.isArray(item)
      ? item.map((part) => visit(part))
      : Object.fromEntries(Object.entries(item).map(([childKey, part]) => [childKey, visit(part, childKey)]));
    seen.delete(item);
    return result;
  }
  return visit(value);
}

export function contentHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function assertDirectory(directory) {
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Expected a real directory: ${directory}`);
}

function validRelative(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)
    || relativePath.includes('\\') || relativePath.includes('\0')
    || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Asset path must be a safe relative path');
  }
  return relativePath.split('/');
}

async function safeParent(root, relativePath) {
  const parts = validRelative(relativePath);
  await assertDirectory(root);
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    try { await mkdir(parent); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await assertDirectory(parent);
  }
  return path.join(parent, parts.at(-1));
}

/** Link a complete temporary file into place atomically, without replacing any record. */
async function exclusiveWrite(root, relativePath, content) {
  const target = await safeParent(root, relativePath);
  const temporary = path.join(path.dirname(target), `.pending-${randomUUID()}`);
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  try { await link(temporary, target); } finally { await unlink(temporary); }
  return target;
}

function serialize(data) { return `${JSON.stringify(sanitize(data), null, 2)}\n`; }

/** Append an event after a run finishes, without changing its original manifest or events. */
export async function appendRunEvent(runDir, type, data = {}) {
  if (typeof type !== 'string' || !/^[a-z][a-z0-9_.-]+$/.test(type)) throw new Error('Invalid event type');
  const dir = path.resolve(runDir);
  await assertDirectory(dir);
  await readFile(path.join(dir, 'manifest.json'), 'utf8');
  const eventDir = path.join(dir, 'events');
  await assertDirectory(eventDir);
  for (;;) {
    const files = (await readdir(eventDir)).filter((file) => EVENT_FILE.test(file));
    const number = files.reduce((maximum, file) => Math.max(maximum, Number(file.match(EVENT_FILE)[1])), 0) + 1;
    const eventId = `E-${String(number).padStart(8, '0')}`;
    const event = { eventId, type, recordedAt: new Date().toISOString(), data: sanitize(data) };
    try {
      await exclusiveWrite(eventDir, `${String(number).padStart(8, '0')}.json`, serialize(event));
      return event;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

export async function createRun({ outputDir = 'output/runs', runId, mode = 'article', inputs = {}, metadata = {} } = {}) {
  const baseId = runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  if (typeof baseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(baseId)) throw new Error('Invalid runId');
  const baseDir = path.resolve(outputDir);
  await mkdir(baseDir, { recursive: true });
  await assertDirectory(baseDir);
  let actualId = baseId;
  let dir;
  for (;;) {
    dir = path.join(baseDir, actualId);
    try { await mkdir(dir, { mode: 0o700 }); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; actualId = `${baseId}-${randomUUID().slice(0, 8)}`; }
  }
  await mkdir(path.join(dir, 'events'));
  await mkdir(path.join(dir, 'assets'));
  const manifest = sanitize({ schemaVersion: 1, runId: actualId, requestedRunId: baseId,
    articleId: metadata.articleId ?? inputs.articleId ?? actualId, mode,
    startedAt: new Date().toISOString(), metadata, inputs });
  await exclusiveWrite(dir, 'manifest.json', serialize(manifest));
  let pending = Promise.resolve();
  return {
    dir, manifest,
    append(type, data) {
      const task = pending.then(() => appendRunEvent(dir, type, data));
      pending = task.catch(() => {});
      return task;
    },
    async asset(relativePath, content) {
      // Assets are text/JSON audit records; binary auth/session dumps are not accepted.
      if (typeof content !== 'string' && (!content || typeof content !== 'object' || Buffer.isBuffer(content))) {
        throw new TypeError('Audit assets must be text or JSON data');
      }
      const cleaned = typeof content === 'string' ? sanitize(content) : serialize(content);
      const filePath = await exclusiveWrite(path.join(dir, 'assets'), relativePath, cleaned);
      return { path: filePath, hash: contentHash(cleaned), bytes: Buffer.byteLength(cleaned) };
    },
  };
}

export async function readRun(runDir, { asOf } = {}) {
  const dir = path.resolve(runDir);
  await assertDirectory(dir);
  const cutoff = asOf === undefined ? Infinity : Date.parse(asOf);
  if (Number.isNaN(cutoff)) throw new Error('asOf must be an ISO date/time');
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const eventDir = path.join(dir, 'events');
  await assertDirectory(eventDir);
  const files = (await readdir(eventDir)).filter((file) => EVENT_FILE.test(file)).sort();
  const events = [];
  for (const file of files) {
    const location = path.join(eventDir, file);
    if ((await lstat(location)).isSymbolicLink()) throw new Error('Event symlinks are not supported');
    const event = JSON.parse(await readFile(location, 'utf8'));
    const time = Date.parse(event.recordedAt);
    if (Number.isNaN(time)) throw new Error(`Invalid recordedAt: ${file}`);
    if (time <= cutoff) events.push(event);
  }
  return { manifest, events };
}
