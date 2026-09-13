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


/* ========================================
 * Claudeで記事生成
 * ======================================== */

async function generateArticle() {
  console.log('=== Claudeで記事生成開始 ===');

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY が設定されていません'
    );
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


/* ========================================
 * Note下書き保存
 * ======================================== */

async function saveNoteDraft(title, body) {
  console.log('=== Note下書き保存開始 ===');

  /* ----------------------------------------
   * note-state.json確認
   * ---------------------------------------- */

  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(
      `note-state.json が見つかりません: ${STATE_PATH}`
    );
  }

  console.log('✓ note-state.json を確認しました');


  /* ----------------------------------------
   * ブラウザ起動
   * ---------------------------------------- */

  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const context = await browser.newContext({
      storageState: STATE_PATH,
      locale: 'ja-JP',
    });

    const page = await context.newPage();

    console.log('✓ Playwrightを起動しました');


    /* ----------------------------------------
     * Note側APIエラー監視
     * ---------------------------------------- */

    const apiErrors = [];

    page.on('response', response => {
      const status = response.status();
      const url = response.url();

      if (
        status >= 400 &&
        (
          url.includes('/api/') ||
          url.includes('/graphql')
        )
      ) {
        const error = `${status} ${url}`;

        apiErrors.push(error);

        console.log(
          '❌ Note API ERROR:',
          error
        );
      }
    });


    /* ----------------------------------------
     * 新規記事作成ページへ
     * ---------------------------------------- */

    console.log(
      'Note新規記事作成ページへ移動します...'
    );

    await page.goto(
      'https://note.com/notes/new',
      {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      }
    );

    console.log(
      'Note URL:',
      page.url()
    );


    /* ----------------------------------------
     * ログイン確認
     * ---------------------------------------- */

    if (page.url().includes('/login')) {
      throw new Error(
        'Noteのログイン状態が無効です。note-state.jsonを確認してください。'
      );
    }

    console.log(
      '✓ Noteにログイン済みです'
    );


    /* ----------------------------------------
     * 編集画面の生成を待つ
     * ---------------------------------------- */

    console.log(
      'Note編集画面の生成を待っています...'
    );

    await page.waitForTimeout(10000);

    console.log(
      '10秒後のURL:',
      page.url()
    );


    /* ----------------------------------------
     * DOM調査
     * ---------------------------------------- */

    console.log('');
    console.log('=== Note編集画面DOM確認 ===');

    console.log(
      'iframe:',
      await page.locator('iframe').count()
    );

    console.log(
      'textarea:',
      await page.locator('textarea').count()
    );

    console.log(
      'input:',
      await page.locator('input').count()
    );

    console.log(
      'contenteditable:',
      await page.locator(
        '[contenteditable="true"]'
      ).count()
    );

    console.log(
      'h1:',
      await page.locator('h1').count()
    );

    console.log(
      'role=textbox:',
      await page.locator(
        '[role="textbox"]'
      ).count()
    );

    console.log('');


    /* ----------------------------------------
     * Body確認
     * ---------------------------------------- */

    console.log('=== BODY TEXT ===');

    const bodyText =
      await page.locator('body').innerText();

    console.log(
      bodyText.slice(0, 3000)
    );

    console.log('');


    /* ----------------------------------------
     * スクリーンショット
     * ---------------------------------------- */

    await page.screenshot({
      path: 'note-debug.png',
      fullPage: true,
    });

    console.log(
      '✓ note-debug.png を保存しました'
    );


    /* ----------------------------------------
     * タイトル入力欄を探す
     * ---------------------------------------- */

    console.log('');
    console.log(
      '=== タイトル入力欄を検索 ==='
    );

    let titleInput = null;

    const titleSelectors = [
      'textarea[placeholder*="記事タイトル"]',
      'textarea[placeholder*="タイトル"]',

      'input[placeholder*="記事タイトル"]',
      'input[placeholder*="タイトル"]',

      '[data-placeholder="タイトル"]',
      '[data-placeholder*="タイトル"]',

      '[data-testid="note-title"]',

      '[aria-label*="タイトル"]',

      'h1[contenteditable="true"]',

      '[contenteditable="true"][aria-label*="タイトル"]',

      '[role="textbox"][aria-label*="タイトル"]',
    ];


    /* ----------------------------------------
     * 通常ページを検索
     * ---------------------------------------- */

    for (const selector of titleSelectors) {

      console.log(
        '検索:',
        selector
      );

      const locator =
        page.locator(selector).first();

      if (
        await locator.count() === 0
      ) {
        continue;
      }

      try {

        await locator.waitFor({
          state: 'visible',
          timeout: 5000,
        });

        titleInput = locator;

        console.log(
          '✓ タイトル欄発見:',
          selector
        );

        break;

      } catch {
        console.log(
          '候補は存在しますが表示されていません:',
          selector
        );
      }
    }


    /* ----------------------------------------
     * iframeを検索
     * ---------------------------------------- */

    if (!titleInput) {

      console.log('');
      console.log(
        '通常ページにタイトル欄がありません'
      );

      console.log(
        'iframe/frameを検索します'
      );

      for (
        const [i, frame]
        of page.frames().entries()
      ) {

        console.log(
          `FRAME ${i}:`,
          frame.url()
        );

        for (
          const selector
          of titleSelectors
        ) {

          const locator =
            frame.locator(selector).first();

          if (
            await locator.count() === 0
          ) {
            continue;
          }

          try {

            await locator.waitFor({
              state: 'visible',
              timeout: 5000,
            });

            titleInput = locator;

            console.log(
              '✓ iframe内タイトル欄発見:',
              selector
            );

            break;

          } catch {
            console.log(
              'iframe内にありますが表示されていません:',
              selector
            );
          }
        }

        if (titleInput) {
          break;
        }
      }
    }


    /* ----------------------------------------
     * タイトルが見つからない
     * ---------------------------------------- */

    if (!titleInput) {

      console.log('');
      console.log(
        '=== タイトル入力欄が見つかりません ==='
      );

      if (apiErrors.length > 0) {

        console.log(
          '検出されたNote APIエラー:'
        );

        console.log(
          apiErrors.join('\n')
        );

      } else {

        console.log(
          'Note APIエラーは検出されませんでした'
        );

      }

      throw new Error(
        'Noteのタイトル入力欄を見つけられませんでした。'
        + ' Note編集画面が正常に生成されているか確認してください。'
      );
    }


    /* ----------------------------------------
     * タイトル入力
     * ---------------------------------------- */

    console.log(
      'タイトルを入力します...'
    );

    await titleInput.click();

    await titleInput.fill(title);

    console.log(
      '✓ タイトルを入力しました:',
      title
    );


    /* ----------------------------------------
     * 本文エディタを探す
     * ---------------------------------------- */

    console.log('');
    console.log(
      '=== 本文エディタ検索 ==='
    );

    let editor = null;

    const editorSelectors = [
      '[contenteditable="true"]',
      '[role="textbox"]',
      '.ProseMirror',
      '[data-placeholder*="本文"]',
      '[data-placeholder*="入力"]',
    ];


    for (
      const [i, frame]
      of page.frames().entries()
    ) {

      console.log(
        `本文エディタ検索 FRAME ${i}`
      );

      for (
        const selector
        of editorSelectors
      ) {

        const locator =
          frame.locator(selector).first();

        if (
          await locator.count() === 0
        ) {
          continue;
        }

        console.log(
          '本文候補:',
          selector
        );

        try {

          await locator.waitFor({
            state: 'visible',
            timeout: 5000,
          });

          editor = locator;

          console.log(
            '✓ 本文エディタ発見:',
            selector
          );

          break;

        } catch {
          console.log(
            '本文候補は存在しますが表示されていません:',
            selector
          );
        }
      }

      if (editor) {
        break;
      }
    }


    /* ----------------------------------------
     * 本文エディタがない
     * ---------------------------------------- */

    if (!editor) {

      throw new Error(
        'Noteの本文エディタを見つけられませんでした。'
      );
    }


    /* ----------------------------------------
     * 本文入力
     * ---------------------------------------- */

    console.log(
      '本文を入力します...'
    );

    await editor.click();

    await page.keyboard.insertText(body);

    console.log(
      '✓ 本文を入力しました'
    );


    /* ----------------------------------------
     * 下書き保存待機
     * ---------------------------------------- */

    console.log(
      '下書き保存を待っています...'
    );

    await page.waitForTimeout(5000);

    console.log(
      '✓ 下書き保存処理を待機しました'
    );


    /* ----------------------------------------
     * 完了
     * ---------------------------------------- */

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      'Note下書き保存テスト完了'
    );

    console.log(
      '========================================'
    );

  } finally {

    await browser.close();

  }
}


/* ========================================
 * メイン処理
 * ======================================== */

(async () => {

  console.log(
    '=== Note Workflow 開始 ==='
  );

  console.log(
    'テーマ:',
    THEME
  );

  console.log(
    '想定読者:',
    TARGET
  );

  console.log(
    '公開:',
    IS_PUBLIC
  );

  console.log(
    'DRY_RUN:',
    DRY_RUN
  );


  /* ----------------------------------------
   * Claudeで記事生成
   * ---------------------------------------- */

  const article =
    await generateArticle();


  console.log('');

  console.log(
    '========================================'
  );

  console.log(
    '生成された記事'
  );

  console.log(
    '========================================'
  );

  console.log(article);

  console.log(
    '========================================'
  );

  console.log('');


  /* ----------------------------------------
   * DRY_RUN
   * ---------------------------------------- */

  if (DRY_RUN === 'true') {

    console.log(
      '✓ DRY_RUN=true のため、Noteには投稿しません'
    );

    console.log(
      '=== 記事生成テスト成功 ==='
    );

    return;
  }


  /* ----------------------------------------
   * タイトルを記事本文から取得
   * ---------------------------------------- */

  const lines = article
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  let title = 'AIで作る記事';


  /*
   * 「# タイトル」の次の行を
   * 実際のタイトルとして取得
   */

  const titleIndex =
    lines.findIndex(
      line =>
        /^#\s*タイトル\s*$/.test(line)
    );


  if (
    titleIndex !== -1 &&
    lines[titleIndex + 1]
  ) {

    title =
      lines[titleIndex + 1];

  } else {

    /*
     * 「# タイトル」がない場合
     * 最初の見出しをタイトルとして使用
     */

    const firstHeading =
      lines.find(
        line => /^#\s+/.test(line)
      );

    if (firstHeading) {

      title =
        firstHeading.replace(
          /^#+\s*/,
          ''
        );

    }
  }


  console.log(
    'タイトル:',
    title
  );


  /* ----------------------------------------
   * Note下書き保存
   * ---------------------------------------- */

  await saveNoteDraft(
    title,
    article
  );


  console.log(
    '=== Note Workflow 成功 ==='
  );

})();
