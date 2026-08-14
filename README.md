# Mozarie

Mozarie is a local, desktop-oriented image review and mosaic editor. It keeps image work on your machine, proposes mosaic and exclusion ranges, supports hand edits and boundary refinement, and saves PNG/JPEG/WebP through the existing metadata-preserving pipeline.

## 日本語

### できること

- フォルダまたはブラウザで追加した画像の確認
- ONNX Runtimeによるモザイク対象候補と手の除外候補の検出
- 矩形・4点境界とSAMによる範囲の追加
- 手描きのモザイク追加・除外、候補ごとの有効化、削除、点滅確認
- 適用範囲の合成から除外範囲を差し引く保存処理
- PNG/JPEG/WebPの既存メタデータを保持する保存処理

### セットアップ

1. Python 3.11以降の仮想環境を用意します。
2. `pip install -r requirements.txt` を実行します。
3. `python server.py` で起動します。`--port` を付けると、その起動だけ保存済みポートを上書きできます。
4. **設定 > モデル** で、対応プロファイルのローカルモデルを選びます。

必要なローカルファイルは次の3つです。モデルは同梱も自動ダウンロードもしません。

- 7クラス・32マスク係数の対応YOLOセグメンテーションONNX
- `[batch, anchors, 5]` 出力の対応1クラス手検出ONNX
- `vit_b`、`vit_l`、`vit_h` のいずれかに対応するSAMチェックポイント

設定はGit管理しない `config/local.json` に保存されます。設定画面でCPUを選ぶと、ONNX RuntimeとSAMのどちらもCPUを使います。GPUを選んだ場合はCUDAプロバイダーが必要です。

### 操作

1. 画像を読み込み、左の一覧または画像一覧で対象を開きます。
2. 自動検出を実行し、右の「モザイク範囲」と「除外範囲」を確認します。
3. 必要に応じてブラシ、除外ブラシ、矩形境界、4点境界で修正します。
4. 点滅ボタンで範囲を確認し、確認済みにします。
5. ファイル保存でコピー保存または元画像上書きを選びます。公開前に必ず保存結果を目視確認してください。

キャッシュは `.mozarie-cache/`、ブラウザ追加画像の一時データはOSの一時フォルダに置かれます。どちらもGit管理されません。

## English

### Setup and operation

1. Create a Python 3.11+ environment and run `pip install -r requirements.txt`.
2. Start with `python server.py`. `--port` overrides the saved port for that start only.
3. In **Settings > Models**, select compatible local target-segmentation ONNX, hand-detection ONNX, and SAM checkpoint files.
4. Load images, review proposed apply and exclusion ranges, refine them with the editor, then save and inspect the result.

Mozarie accepts only its documented ONNX profiles; arbitrary ONNX exports are rejected before inference. It never downloads or bundles models. Select CPU in Settings to force both ONNX Runtime and SAM to CPU. Local settings live in ignored `config/local.json`.

Saving preserves image metadata through the existing PNG, JPEG, and WebP pipeline; inspect every output before publishing.

## Tests

Run the non-inference suite from this directory:

```powershell
python -m unittest discover -s tests -v
node tests/test_app_js.cjs
node tests/test_browser_save_contract.cjs
node tests/test_browser_save_runtime.cjs
node tests/test_import_picker_e2e.cjs
```

The tests use fixtures and mocks. They do not run model inference.

## Licensing and models

Mozarie source code is licensed under [MIT](LICENSE). Runtime dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Model weights are neither bundled nor downloaded by Mozarie; their licenses are independent, and the person selecting each local model is responsible for confirming permitted use.
