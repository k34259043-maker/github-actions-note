import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { canonicalizeArticleBody, hash, makeArticle, normalizeArticleBody } from '../lib/domain.mjs';

test('article body removes only unstable horizontal whitespace at line ends before hashing', () => {
  const source = '先頭  \n  インデントは残す\t \n末尾';
  const normalized = '先頭\n  インデントは残す\n末尾';

  assert.equal(normalizeArticleBody(source), normalized);
  const article = makeArticle({ title: 'タイトル', body: source });
  assert.equal(article.body, normalized);
  assert.equal(article.hash, hash({ title: article.title, body: normalized }));
  assert.deepEqual(article.bodyNormalization, {
    algorithm: 'lf_and_no_trailing_horizontal_whitespace_v1',
    sourceHash: hash(source),
    canonicalHash: hash(normalized),
    lineEndingsConverted: 0,
    affectedLines: 2,
    charactersRemoved: 4,
  });
});

test('article body preserves blank lines and final newlines', () => {
  const source = '一段落目\n\n二段落目\n';
  assert.equal(makeArticle({ title: 'タイトル', body: source }).body, source);
});

test('article body converts CRLF and lone CR before hashing and records the operation', () => {
  const source = '一行目  \r\n二行目\r三行目\t\r\n';
  const normalized = '一行目\n二行目\n三行目\n';
  const canonical = canonicalizeArticleBody(source);
  assert.equal(canonical.body, normalized);
  assert.equal(canonical.details.lineEndingsConverted, 3);
  assert.equal(canonical.details.affectedLines, 2);
  assert.equal(canonical.details.charactersRemoved, 3);
  assert.equal(normalizeArticleBody(source), normalized);
  const article = makeArticle({ title: 'タイトル', body: source });
  assert.equal(article.body, normalized);
  assert.equal(article.hash, hash({ title: article.title, body: normalized }));
});

test('the active generation prompt forbids unstable line-end whitespace', async () => {
  const config = JSON.parse(await readFile(new URL('../config/quality.json', import.meta.url), 'utf8'));
  assert.equal(config.generationPrompt, 'prompts/generate-v3.txt');
  const prompt = await readFile(new URL('../prompts/generate-v3.txt', import.meta.url), 'utf8');
  assert.match(prompt, /行末に半角スペースやタブを置かない/);
  assert.match(prompt, /半角スペース2個による強制改行を使わず/);
});
