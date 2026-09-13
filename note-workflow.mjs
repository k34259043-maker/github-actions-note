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

    await page.goto('https://editor.note.com/new', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    console.log('Note URL:', page.url());

    if (page.url().includes('/login')) {
      throw new Error(
        'Noteのログイン状態が無効です。note-state.jsonを確認してください。'
      );
    }

    console.log('✓ Noteにログイン済みです');

    await page.waitForTimeout(5000);

    console.log('=== Note編集画面調査開始 ===');

    console.log(
      'iframe数:',
      await page.locator('iframe').count()
    );

    console.log(
      'textarea数:',
      await page.locator('textarea').count()
    );

    console.log(
      'input数:',
      await page.locator('input').count()
    );

    console.log(
      'contenteditable数:',
      await page.locator('[contenteditable="true"]').count()
    );

    for (const [i, frame] of page.frames().entries()) {
      console.log(`FRAME ${i}:`);
      console.log('  URL:', frame.url());

      console.log(
        '  textarea:',
        await frame.locator('textarea').count()
      );

      console.log(
        '  input:',
        await frame.locator('input').count()
      );

      console.log(
        '  contenteditable:',
        await frame.locator('[contenteditable="true"]').count()
      );
    }

    console.log('=== Note編集画面調査終了 ===');

    await page.screenshot({
      path: 'note-debug.png',
      fullPage: true,
    });

    console.log('✓ Note編集画面のスクショを保存しました');

    /*
     * ここからタイトル入力欄を探す
     */

    let titleInput = null;

    const titleSelectors = [
      'textarea[placeholder*="記事タイトル"]',
      'textarea[placeholder*="タイトル"]',
      'input[placeholder*="記事タイトル"]',
      'input[placeholder*="タイトル"]',
      '[data-placeholder="タイトル"]',
      '[data-testid="note-title"]',
      '[aria-label*="タイトル"]',
    ];

    for (const selector of titleSelectors) {
      const locator = page.locator(selector).first();

      if (await locator.count() > 0) {
        console.log('タイトル候補発見:', selector);

        try {
          await locator.waitFor({
            state: 'visible',
            timeout: 5000,
          });

          titleInput = locator;
          break;
        } catch {
          console.log(
            '候補は存在しますが表示されていません:',
            selector
          );
        }
      }
    }

    /*
     * iframe内も調べる
     */

    if (!titleInput) {
      console.log('通常ページにタイトル欄がありません');
      console.log('iframe内を検索します');

      for (const [i, frame] of page.frames().entries()) {
        console.log(`iframe/frame ${i} を検索中`);

        for (const selector of titleSelectors) {
          const locator = frame.locator(selector).first();

          if (await locator.count() > 0) {
            console.log(
              'iframe内タイトル候補発見:',
              selector
            );

            try {
              await locator.waitFor({
                state: 'visible',
                timeout: 5000,
              });

              titleInput = locator;
              break;
            } catch {
              console.log(
                'iframe内にありますが表示されていません:',
                selector
              );
            }
          }
        }

        if (titleInput) {
          break;
        }
      }
    }

    if (!titleInput) {
      throw new Error(
        'Noteのタイトル入力欄を見つけられませんでした。note-debug.png とDOM情報を確認してください。'
      );
    }

    await titleInput.click();
    await titleInput.fill(title);

    console.log('✓ タイトルを入力しました');

    /*
     * 本文エディタを探す
     */

    let editor = null;

    const editorSelectors = [
      '[contenteditable="true"]',
      '[role="textbox"]',
      '.ProseMirror',
      '[data-placeholder*="本文"]',
    ];

    for (const [i, frame] of page.frames().entries()) {
      console.log(`本文エディタ検索 FRAME ${i}`);

      for (const selector of editorSelectors) {
        const locator = frame.locator(selector).first();

        if (await locator.count() > 0) {
          console.log(
            '本文候補発見:',
            selector
          );

          try {
            await locator.waitFor({
              state: 'visible',
              timeout: 5000,
            });

            editor = locator;
            break;
          } catch {
            console.log(
              '本文候補は存在しますが表示されていません:',
              selector
            );
          }
        }
      }

      if (editor) {
        break;
      }
    }

    if (!editor) {
      throw new Error(
        'Noteの本文エディタを見つけられませんでした。'
      );
    }

    await editor.click();

    await page.keyboard.insertText(body);

    console.log('✓ 本文を入力しました');

    console.log('下書き保存を待っています...');

    await page.waitForTimeout(5000);

    console.log('✓ 下書き保存処理を待機しました');

    console.log('========================================');
    console.log('Note下書き保存テスト完了');
    console.log('========================================');

  } finally {
    await browser.close();
  }
}

(async () => {
  console.log('=== Note Workflow 開始 ===');

  console.log('テーマ:', THEME);
  console.log('想定読者:', TARGET);
  console.log('公開:', IS_PUBLIC);
  console.log('DRY_RUN:', DRY_RUN);

  const article = await generateArticle();

  console.log('');
  console.log('========================================');
  console.log('生成された記事');
  console.log('========================================');
  console.log(article);
  console.log('========================================');
  console.log('');

  if (DRY_RUN === 'true') {
    console.log(
      '✓ DRY_RUN=true のため、Noteには投稿しません'
    );

    console.log('=== 記事生成テスト成功 ===');

    return;
  }

  /*
   * タイトルを記事本文から取得
   */

  const lines = article
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  let title = lines[0] || 'AIで作る記事';

  if (title.startsWith('#')) {
    title = title.replace(/^#+\s*/, '');
  }

  console.log('タイトル:', title);

  await saveNoteDraft(title, article);

  console.log('=== Note Workflow 成功 ===');
})();
