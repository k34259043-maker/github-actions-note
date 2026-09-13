import { chromium } from 'playwright';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

const STATE_PATH = './note-state.json';

const {
  THEME,
  TARGET,
  MESSAGE,
  CTA,
  TAGS,
  IS_PUBLIC,
  DRY_RUN,
} = process.env;

async function generateArticle() {
  console.log('=== Claudeで記事生成開始 ===');

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY が設定されていません');
  }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const prompt = `
あなたは日本語のNote記事を書くプロの編集者です。

以下の条件で、読みやすく実用的なNote記事を作成してください。

【記事テーマ】
${THEME}

【想定読者】
${TARGET}

【読者に伝えたい核心メッセージ】
${MESSAGE}

【記事を読んだ後のアクション】
${CTA}

【タグ】
${TAGS}

以下の構成で作成してください。

# タイトル

読者が思わず読みたくなるタイトルを1つ。

# 導入

読者の悩みや問題提起から始める。

# 本文

具体例を入れながら、初心者にも分かるように説明する。
見出しを使って読みやすくする。

# まとめ

記事のポイントを簡潔に整理する。

# CTA

最後に「${CTA}」につながる自然な一文を書く。

タイトルと本文だけを出力してください。
余計な説明や「以下が記事です」などの前置きは不要です。
`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 5000,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const article = response.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');

  return article;
}

(async () => {
  console.log('=== Note Workflow 開始 ===');

  console.log('テーマ:', THEME);
  console.log('想定読者:', TARGET);
  console.log('公開:', IS_PUBLIC);
  console.log('DRY_RUN:', DRY_RUN);

  // Claudeで記事生成
  const article = await generateArticle();

  console.log('');
  console.log('========================================');
  console.log('生成された記事');
  console.log('========================================');
  console.log(article);
  console.log('========================================');
  console.log('');

  // DRY_RUN=trueならここで終了
  if (DRY_RUN === 'true') {
    console.log('✓ DRY_RUN=true のため、Noteには投稿しません');
    console.log('=== 記事生成テスト成功 ===');
    return;
  }

  // Note投稿処理は次のステップで追加
  console.log('Noteへの投稿処理はまだ実装していません。');
})();
