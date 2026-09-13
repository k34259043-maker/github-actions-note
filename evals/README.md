# Promptfoo による評価と比較

このリポジトリは `lib/promptfoo.mjs` から、固定したバージョンの Promptfoo の **実際の Node API** を呼び出します。記事生成は既存の生成処理が担当し、Promptfoo の custom provider はその実行で保存した記事を返します。記事本文を評価の途中で再生成しません。

## 実行単位と比較の意味

| 実行の種類 | 同じ条件にするもの | 比較するもの | 結果から言えること |
| --- | --- | --- | --- |
| 1 本の記事を修正 | 元記事と修正の根拠、評価基準 | 修正前後の記事 | 指摘が解消したか、新しい問題が生じたか |
| 生成プロンプトを比較 | 入力、根拠資料、生成モデル・設定、評価条件 | 旧・新プロンプトからそれぞれ新規生成した記事 | この条件・事例での観測差。別の記事にも有効とは断定しない |
| 評価プロンプトを比較 | 記事の本文・ハッシュ | 旧・新の評価条件による評価 | 採点・指摘の違い。記事が改善したことは意味しない |

`entries` の `variant` が表の列、`caseId` が行になります。同じ事例の before/after を並べられます。繰り返し試行には別の `caseId` を割り当てます。存在しない組み合わせは `not_evaluated` として残し、記事や採点を補いません。

## 記録されるファイル

実行ごとに別の `outputDir` を使います。同じ実行先への再保存は、モデルを呼び出す前に拒否します。

| ファイル | 内容 |
| --- | --- |
| `promptfoo-invocation.json` | 開始時刻、入力した記事 ID/ハッシュ、case/variant、評価条件、実行設定 |
| `promptfoo-results.json` | Promptfoo がエクスポートした実際の生データと採点 metadata |
| `promptfoo-results.html` | Promptfoo 標準の、記事を並べて見られる HTML |
| `evaluations.json` | アプリ側の正規化結果。記事のスナップショット、軸別評価、事実確認状態、指摘、失敗を含む |

全文プロンプトやその差分、変更理由、採用判断は、アプリ側の実行記録とレポートが担当します。Promptfoo の出力設定に保存される inline function の表示から、元の生成・評価プロンプトを復元した扱いにはしません。

## 点数と PASS の読み方

- Q1〜Q4 は **0〜4 の順序尺度**です。`null` は未評価・判断不能として残し、0 点には変換しません。
- Promptfoo の `namedScores` には、値のある軸だけを `score / 4` で渡します。元の値と `null` は `gradingResult.componentResults[].metadata.axes` と `evaluations.json` に保持します。
- 標準 HTML/JSON の総合 `score` と `PASS` は、**評価記録が取得でき、形式が正しく、評価対象の記事ハッシュが一致したか**だけを示す 0/1 です。品質の総合点、公開許可、プロンプト採用許可ではありません。重大な指摘や未確認の主張があっても、評価記録として有効なら技術的には PASS です。
- `claims` の裏付けあり・反証あり・資料不足・未確認は軸別の点数と別に保持します。モデルが「裏付けあり」と書いたことだけで事実確認完了とはしません。参照資料との対応は呼び出し側の評価検証で確認します。

## 評価処理の契約

```javascript
const result = await evaluateWithPromptfoo({
  outputDir: runSpecificDirectory,
  entries: [{
    id: 'run-123:case-1:before',
    variant: 'before',
    caseId: 'case-1',
    article: { id: 'article-123', hash: recordedHash, title, body },
    inputs: recordedInputs,
    evidence: recordedEvidence,
    evaluatorConditions: recordedJudgeConditions,
  }],
  evaluator: async (entry) => evaluateUnderRecordedConditions(entry),
});
```

`evaluator` は対象記事の `articleHash`、`status`、Q1〜Q4、`findings`、`claims` を返します。記事 1 件につき 1 回呼び出し、4 軸のために 4 回のモデル呼び出しを行いません。呼び出しごとにメモ化の範囲を閉じているため、同じ記事を別の評価基準で採点する場合に古い評価を流用しません。入力に既存の `evaluation` が入っていても、自動では再利用しません。

`evaluator` の例外はその記事の `failed`、ハッシュ不一致や不正な採点形式は `invalid` として残し、別の記事の評価を続けます。モデル API の例外メッセージをそのままエクスポートしません。Promptfoo 自体が失敗した場合は `status: failed` と正規化記録を返し、完成していない HTML/JSON のパスは `null` になります。

実行記録と同じ `sanitize` で、Promptfoo に渡す入力・記事・条件を事前に検査します。機密情報の除去などで内容が変わる場合は、ファイル作成や評価実行の前に拒否します。本文だけを伏せ字にして元のハッシュで評価を続けることはありません。評価結果に機密情報が返った場合も、生の結果をエクスポートせず、元の記事ハッシュに対応する `invalid` と汎用エラーコードを記録します。

## 再現性と実行環境

- Node.js 24 と `package-lock.json` に固定した Promptfoo を使用します。`npm ci` で同じ依存関係をインストールします。
- `cache: false`、`writeLatestResults: false`、`sharing: false` で実行します。共有クラウドへの記事のアップロードや latest 評価履歴の上書きを行いません。
- 評価モデルや採点条件は明示的な `evaluator` が担当します。環境に API キーがあるという理由で Promptfoo に評価モデルを選ばせません。
- 同じ条件でもモデル出力・モデル評価の再現性は保証されません。モデル名、設定、根拠・基準・入力のハッシュと試行 ID はアプリ側の実行記録と合わせて確認します。
- テストは固定の評価結果を返す関数を注入し、実 Promptfoo エンジンを通して保存・比較を検証します。モデル API は呼びません。

Promptfoo 0.123.0 の標準エクスポーターは、DB に保存しない実行でも trace DB を参照しようとして、trace テーブルがないという警告を出す場合があります。記事・軸別評価の JSON/HTML 出力に成功したこととは分けて確認してください。`PROMPTFOO_DISABLE_TELEMETRY=1` と更新確認の無効化を設定していますが、この版の内部実装には opt-out 自体を知らせるイベントの送信が残っています。記事を Promptfoo Cloud に共有する設定は無効です。

共通プロンプトの自動最適化・自動採用はこのモジュールでは行いません。変更案の採用基準と実際の採用履歴はアプリ側の判断記録が担当します。

## 参照した公式仕様

- [Node package](https://www.promptfoo.dev/docs/usage/node-package/)
- [Node API reference](https://www.promptfoo.dev/docs/usage/node-api-reference/)
- [Custom JavaScript provider](https://www.promptfoo.dev/docs/providers/custom-api/)
- [Output formats](https://www.promptfoo.dev/docs/configuration/outputs/)

実装は上記の仕様と、インストールした Promptfoo 0.123.0 の Node API・出力処理のソースで確認しています。
