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

// ========================================
// Claudeで記事生成
// ========================================

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

  return response.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');
}

// ========================================
// Markdown記事をタイトルと本文に分離
// ========================================

function parseArticle(article) {
  const lines = article.split('\n');

  const titleIndex = lines.findIndex(line =>
    line.trim().startsWith('# ')
  );

  if (titleIndex === -1) {
    throw new Error('記事タイトルが見つかりません');
  }

  const title = lines[titleIndex]
    .replace(/^#\s+/, '')
    .trim();

  const body = lines
    .slice(titleIndex + 1)
    .join('\n')
    .trim();

  if (!title) {
    throw new Error('タイトルが空です');
  }

  if (!body) {
    throw new Error('本文が空です');
  }

  return {
    title,
    body,
  };
}

// ========================================
// Noteへ下書き保存
// ========================================

async function saveNoteDraft(title, body) {
  console.log('=== Note下書き保存開始 ===');

  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(
      `note-state.json が見つかりません: ${STATE_PATH}`
    );
  }

  console.log('✓ note-state.json を確認しました');

  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const context = await browser.newContext({
      storageState: STATE_PATH,
    });

    const page = await context.newPage();

    console.log('✓ Playwrightを起動しました');

    await page.goto('https://note.com/notes/new', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    console.log('Note URL:', page.url());

    // ログインページへ飛ばされた場合
    if (page.url().includes('/login')) {
      throw new Error(
        'Noteのログイン状態が無効です。note-state.jsonを確認してください。'
      );
    }

    console.log('✓ Noteにログイン済みです');

    // ページの読み込みを少し待つ
    await page.waitForTimeout(3000);

    // タイトル入力欄を探す
    const titleInput = page.locator(
      'input[placeholder*="タイトル"], textarea[placeholder*="タイトル"]'
    ).first();

    await titleInput.waitFor({
      state: 'visible',
      timeout: 30000,
    });

    await titleInput.fill(title);

    console.log('✓ タイトルを入力しました');

    // 本文エディタを探す
    const editor = page.locator(
      '[contenteditable="true"]'
    ).first();

    await editor.waitFor({
      state: 'visible',
      timeout: 30000,
    });

    // Markdownをそのまま貼り付ける
    await editor.click();

    await page.keyboard.insertText(body);

    console.log('✓ 本文を入力しました');

    // 自動保存を待つ
    console.log('下書き保存を待っています...');
    await page.waitForTimeout(5000);

    console.log('✓ 下書き保存処理を待機しました');

    console.log('========================================');
    console.log('Note下書き保存完了');
    console.log('タイトル:', title);
    console.log('URL:', page.url());
    console.log('========================================');

  } finally {
    await browser.close();
  }
}

// ========================================
// メイン処理
// ========================================

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

  const { title, body } = parseArticle(article);

  console.log('タイトル:', title);

  // DRY_RUN=trueならNoteへアクセスしない
  if (DRY_RUN === 'true') {
    console.log('');
    console.log('✓ DRY_RUN=true');
    console.log('✓ Noteには投稿しません');
    console.log('=== 記事生成テスト成功 ===');
    return;
  }

  // Noteへ下書き保存
  await saveNoteDraft(title, body);

  console.log('=== Note Workflow 成功 ===');
})();
