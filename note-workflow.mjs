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
 * Claudeで記事を生成
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
   * ログイン状態確認
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
      viewport: {
        width: 1440,
        height: 1000,
      },
    });

    const page = await context.newPage();


    /* ----------------------------------------
     * エラー監視
     * ---------------------------------------- */

    const pageErrors = [];
    const consoleErrors = [];
    const requestFailures = [];
    const httpErrors = [];

    page.on('pageerror', error => {
      const message = error.message || String(error);

      pageErrors.push(message);

      console.log(
        'PAGE ERROR:',
        message
      );
    });

    page.on('console', message => {
      if (message.type() === 'error') {
        const text = message.text();

        consoleErrors.push(text);

        console.log(
          'CONSOLE ERROR:',
          text
        );
      }
    });

    page.on('requestfailed', request => {
      const failure = request.failure();

      const message =
        `${request.method()} ${request.url()} :: ` +
        `${failure?.errorText || 'unknown error'}`;

      requestFailures.push(message);

      console.log(
        'REQUEST FAILED:',
        message
      );
    });

    page.on('response', response => {
      const status = response.status();
      const url = response.url();

      if (status >= 400) {
        const message =
          `${status} ${url}`;

        httpErrors.push(message);

        console.log(
          'HTTP ERROR:',
          message
        );
      }
    });


    /* ----------------------------------------
     * Noteへアクセス
     * ---------------------------------------- */

    console.log(
      '✓ Playwrightを起動しました'
    );

    console.log(
      '=== Noteへアクセス開始 ==='
    );

    const response = await page.goto(
      'https://editor.note.com/new',
      {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      }
    );

    console.log(
      'Note URL:',
      page.url()
    );

    console.log(
      'HTTPステータス:',
      response
        ? response.status()
        : 'responseなし'
    );


    /* ----------------------------------------
     * ログイン確認
     * ---------------------------------------- */

    if (page.url().includes('/login')) {
      throw new Error(
        'Noteのログイン状態が無効です。' +
        'note-state.jsonを確認してください。'
      );
    }

    console.log(
      '✓ Noteにログイン済みです'
    );


    /* ----------------------------------------
     * 編集画面の生成を待つ
     * ---------------------------------------- */

    console.log(
      '=== Note編集画面の生成を待っています ==='
    );

    await page.waitForTimeout(15000);

    console.log(
      '✓ 15秒待機完了'
    );


    /* ----------------------------------------
     * DOM調査
     * ---------------------------------------- */

    console.log(
      '=== Note編集画面DOM調査開始 ==='
    );

    const textareaCount =
      await page.locator('textarea').count();

    const titleTextareaCount =
      await page.locator(
        'textarea[placeholder="記事タイトル"]'
      ).count();

    const noteTitleCount =
      await page.locator(
        '[data-testid="note-title"]'
      ).count();

    const inputCount =
      await page.locator('input').count();

    const contenteditableCount =
      await page.locator(
        '[contenteditable="true"]'
      ).count();

    const iframeCount =
      await page.locator('iframe').count();

    console.log(
      'textarea:',
      textareaCount
    );

    console.log(
      '記事タイトルtextarea:',
      titleTextareaCount
    );

    console.log(
      'data-testid="note-title":',
      noteTitleCount
    );

    console.log(
      'input:',
      inputCount
    );

    console.log(
      'contenteditable:',
      contenteditableCount
    );

    console.log(
      'iframe:',
      iframeCount
    );


    /* ----------------------------------------
     * Body確認
     * ---------------------------------------- */

    console.log(
      '=== Body確認 ==='
    );

    try {
      const bodyText =
        await page.locator('body').innerText();

      console.log(
        bodyText.slice(0, 3000)
      );
    } catch (error) {
      console.log(
        'Body取得エラー:',
        error.message
      );
    }


    /* ----------------------------------------
     * Frame確認
     * ---------------------------------------- */

    console.log(
      '=== Frame確認 ==='
    );

    for (
      const [i, frame]
      of page.frames().entries()
    ) {
      console.log(
        `FRAME ${i}:`
      );

      console.log(
        '  URL:',
        frame.url()
      );

      try {
        console.log(
          '  textarea:',
          await frame.locator(
            'textarea'
          ).count()
        );

        console.log(
          '  input:',
          await frame.locator(
            'input'
          ).count()
        );

        console.log(
          '  contenteditable:',
          await frame.locator(
            '[contenteditable="true"]'
          ).count()
        );
      } catch (error) {
        console.log(
          '  Frame調査エラー:',
          error.message
        );
      }
    }


    /* ----------------------------------------
     * スクリーンショット
     * ---------------------------------------- */

    console.log(
      '=== スクリーンショット保存 ==='
    );

    await page.screenshot({
      path: 'note-debug.png',
      fullPage: true,
    });

    console.log(
      '✓ note-debug.png を保存しました'
    );


    /* ----------------------------------------
     * HTML保存
     * ---------------------------------------- */

    try {
      const html =
        await page.content();

      fs.writeFileSync(
        'note-debug.html',
        html,
        'utf8'
      );

      console.log(
        '✓ note-debug.html を保存しました'
      );
    } catch (error) {
      console.log(
        'HTML保存エラー:',
        error.message
      );
    }


    /* ----------------------------------------
     * エラー情報表示
     * ---------------------------------------- */

    console.log(
      '=== エラー情報 ==='
    );

    console.log(
      'Page Error:',
      pageErrors.length
    );

    for (const error of pageErrors) {
      console.log(
        '  ',
        error
      );
    }

    console.log(
      'Console Error:',
      consoleErrors.length
    );

    for (const error of consoleErrors) {
      console.log(
        '  ',
        error
      );
    }

    console.log(
      'Request Failure:',
      requestFailures.length
    );

    for (const error of requestFailures) {
      console.log(
        '  ',
        error
      );
    }

    console.log(
      'HTTP Error:',
      httpErrors.length
    );

    for (const error of httpErrors) {
      console.log(
        '  ',
        error
      );
    }


    /* ----------------------------------------
     * タイトル入力欄確認
     *
     * Chromeで確認したDOMでは
     *
     * textarea[placeholder="記事タイトル"]
     *
     * が存在する。
     *
     * まずこれを直接確認する。
     * ---------------------------------------- */

    console.log(
      '=== タイトル入力欄確認 ==='
    );

    const titleInput =
      page.locator(
        'textarea[placeholder="記事タイトル"]'
      ).first();

    const titleExists =
      await titleInput.count();

    console.log(
      '記事タイトル欄:',
      titleExists
    );


    /* ----------------------------------------
     * タイトル欄が存在しない場合
     *
     * ここで終了して、原因調査情報を残す。
     * セレクタを無限に増やさない。
     * ---------------------------------------- */

    if (titleExists === 0) {
      console.log(
        '=== タイトル入力欄が存在しません ==='
      );

      console.log(
        'Note編集画面が正常に生成されていない可能性があります。'
      );

      throw new Error(
        'Noteの編集画面が正常に生成されていません。' +
        'note-debug.png / note-debug.html / ' +
        'Page Error / Console Error / HTTP Errorを確認してください。'
      );
    }


    /* ----------------------------------------
     * タイトル欄の表示待ち
     * ---------------------------------------- */

    await titleInput.waitFor({
      state: 'visible',
      timeout: 60000,
    });

    console.log(
      '✓ タイトル入力欄を確認しました'
    );


    /* ----------------------------------------
     * タイトル入力
     * ---------------------------------------- */

    await titleInput.click();

    await titleInput.fill(title);

    console.log(
      '✓ タイトルを入力しました'
    );

    console.log(
      '入力タイトル:',
      title
    );


    /* ----------------------------------------
     * 本文エディタ確認
     * ---------------------------------------- */

    console.log(
      '=== 本文エディタ確認 ==='
    );

    const editorSelectors = [
      '[contenteditable="true"]',
      '[role="textbox"]',
      '.ProseMirror',
      '[data-placeholder*="本文"]',
    ];

    let editor = null;

    for (
      const selector
      of editorSelectors
    ) {
      const locator =
        page.locator(selector).first();

      const count =
        await locator.count();

      console.log(
        `検索: ${selector} -> ${count}`
      );

      if (count > 0) {
        try {
          await locator.waitFor({
            state: 'visible',
            timeout: 10000,
          });

          editor = locator;

          console.log(
            '✓ 本文エディタを発見:',
            selector
          );

          break;
        } catch {
          console.log(
            '存在しますが表示されていません:',
            selector
          );
        }
      }
    }


    /* ----------------------------------------
     * 本文エディタが見つからない
     * ---------------------------------------- */

    if (!editor) {
      throw new Error(
        'Noteの本文エディタを見つけられませんでした。'
      );
    }


    /* ----------------------------------------
     * 本文入力
     * ---------------------------------------- */

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

    await page.waitForTimeout(10000);

    console.log(
      '✓ 下書き保存処理を10秒待機しました'
    );


    /* ----------------------------------------
     * 最終スクリーンショット
     * ---------------------------------------- */

    await page.screenshot({
      path: 'note-draft-result.png',
      fullPage: true,
    });

    console.log(
      '✓ 最終スクリーンショットを保存しました'
    );

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

    console.log(
      '✓ ブラウザを終了しました'
    );
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
   * タイトル抽出
   * ---------------------------------------- */

  const lines = article
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  let title = 'AIで作る記事';


  /*
   * 「# タイトル」の次の行をタイトルにする
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
     * 最初の見出しをタイトルにする
     */

    const firstHeading =
      lines.find(
        line =>
          /^#\s+/.test(line)
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
