import { chromium } from 'playwright';
import fs from 'fs';

const STATE_PATH = './note-state.json';

(async () => {
  console.log('=== Note Workflow テスト開始 ===');

  // note-state.json が存在するか確認
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(`note-state.json が見つかりません: ${STATE_PATH}`);
  }

  console.log('✓ note-state.json を確認しました');

  // 保存済みログイン状態を使ってブラウザ起動
  const browser = await chromium.launch({
    headless: true
  });

  const context = await browser.newContext({
    storageState: STATE_PATH
  });

  const page = await context.newPage();

  console.log('✓ Playwrightを起動しました');

  // Noteへアクセス
  await page.goto('https://note.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  console.log('✓ note.com にアクセスしました');
  console.log('URL:', page.url());
  console.log('Title:', await page.title());

  // ログインページに飛ばされていないか確認
  if (page.url().includes('/login')) {
    throw new Error(
      'Noteのログイン状態が無効です。note-state.jsonを確認してください。'
    );
  }

  console.log('✓ ログイン状態でNoteにアクセスできました');
  console.log('=== Note Workflow テスト成功 ===');

  await browser.close();
})();
