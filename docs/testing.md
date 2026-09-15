# テスト方針

変更は利用者が観測する契約を守るために検証する。行数や分岐の数字を目標にせず、障害になった境界、状態遷移、データの破損・喪失を優先する。`docs/test-traceability.md` と実機確認項目は、対応する自動テストと同じコミットで更新する。

## 層の選択

| 層 | 対象 | 例 |
| --- | --- | --- |
| Python契約 | 設定、入力、永続化、画像変換、ジョブ、更新処理の決定的な規則 | 相対パス拒否、一覧世代、候補履歴、保存receipt |
| ループバック統合 | HTTPのフレーミング、状態とSQLiteの接続、ストリーム応答 | 認証後の変更要求、保存応答、古いcatalog世代 |
| ブラウザーコード契約 | Nodeで再現できる画面外の純粋な分岐 | ブラウザー保存時のsource snapshot失敗 |
| 実機確認 | 表示、操作感、OS・ブラウザー・GPU・モデル・権限の実挙動 | Windowsダイアログ、実UNC、実GPU、検出モデル、描画とフォーカス |

最も小さい層で再現できる規則は自動化する。複数層にまたがる変更は、下位層で失敗境界を固定し、実機では利用者に見える残りだけを確認する。

## fixtureと後始末

- fixtureは各試験専用の一時ディレクトリ、DB、ポート、状態を使い、リポジトリ、利用者の設定、実画像を変更しない。
- 開いたファイル、SQLite接続、サーバー、スレッド、生成した一時ファイルは試験中に明示して閉じる。GCやプロセス終了に後始末を任せない。
- モックはOS、GPU、ネットワーク、時計など外部境界に限る。製品内部を写経するモックではなく、公開された入力と出力を確認する。Nodeの`node:test`では各試験の`context.mock`を使い、試験終了時に自動復元される範囲で置換する。
- 実GPU、実モデル、Windowsダイアログ、OS権限、実UNCはCI fixtureに置き換えない。該当する実機確認を残す。

## 回帰境界

次の境界が変わるときは、成功だけでなく失敗後の状態も検証する。

- catalogの世代、PJ切替、並列読込、古い要求、再試行
- 元画像削除、保存token、receipt、再起動後の復旧、出力所有権
- 絶対パス、旧設定移行、入力フレーミング、Windowsパスの正規化
- SQLiteの原子性、履歴、候補・手描き・非表示の永続化
- 大きな画像、ストリーム出力、空き容量、メモリ不足、更新ZIP

不具合を直したら、再現した最小の公開入力を回帰試験にし、対応する手動IDを `docs/test-traceability.md` へ追加する。完全に同じ利用者観測をCIで再現できる場合だけ手動行を削除する。それ以外は自動化済み部分と実環境部分へ分けて残す。

## CIとcoverage

CIは隔離fixtureで実行できるテストを常に実行する。Playwrightは利用者に見える画面と隔離した`BrowserContext`を使い、固定待機ではなくlocatorや応答などのweb-first条件で待つ。coverageは全対象のレポートを毎回生成し、未検証の境界を見つける補助にする。100%などの数値を合否条件にせず、損失・破損・権限・復旧の重要経路を人が確認する。数値達成のためのテスト、内部実装を固定するテスト、skipによる見かけの成功を作らない。実行時間やメモリが増える回帰は、小さいfixtureで件数に比例しないことを確認する。

## 参照

- [Python unittest](https://docs.python.org/3/library/unittest.html)
- [Python tempfile](https://docs.python.org/3/library/tempfile.html)
- [Node.js test runner](https://nodejs.org/api/test.html)
- [Playwright BrowserContext](https://playwright.dev/docs/browser-contexts)
- [Playwright best practices](https://playwright.dev/docs/best-practices)
- [Playwright web-first assertions](https://playwright.dev/docs/test-assertions)
- [GitHub ActionsでのPythonテスト](https://docs.github.com/en/actions/automating-builds-and-tests/building-and-testing-python)
- [Google Testing Blog: Code Coverage Best Practices](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html)
- [FileSystemFileHandle.getFile()](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/getFile)
