# Lets Censoring

Lets Censoring は、ローカルの画像を確認し、モザイク候補の検出・調整・保存を行うブラウザアプリです。ComfyUI とは独立して動作し、ComfyUI 本体や `custom_nodes` を起動・停止・変更しません。

対応形式は PNG、JPEG（`.jpg` / `.jpeg`）、WebP です。自動検出の結果は候補であり、検出精度を保証するものではありません。販売用などに使う前には、すべての画像を人間が確認してください。

## 必要環境と起動

このアプリは、既存の ComfyUI Portable に含まれる Python を使用します。`run.bat` を実行するとサーバーを起動し、既定のブラウザで次のアドレスを開きます。

`http://127.0.0.1:8765`

`run.bat` は現在、次の Python を参照しています。

`G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\python_embeded\python.exe`

Python 環境には `Pillow`、`numpy`、`opencv-python`、`torch`、`ultralytics`、`segment_anything` が必要です。Lets Censoring 自身は、起動時にパッケージを追加インストールしません。

## 自動検出モデル

自動検出では次の primary モデルを使用します。ファイルが存在する場合だけ、secondary モデルも併用します。

| 種別 | パス |
| --- | --- |
| primary | `G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\ComfyUI\models\ultralytics\segm\ntd11_anime_nsfw_segm_v5-variant1.pt` |
| optional secondary | `G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\ComfyUI\models\ultralytics\sensitive_detect_v07.pt` |

secondary は必須ではありません。primary だけでも起動できますが、対象や構図によっては検出漏れ・誤検出が起きます。

## 境界選択用の SAM

「境界」ツールは SAM ViT-B を使います。Meta の公式チェックポイントをダウンロードして、次の場所へ配置してください。

- 入手元: [Segment Anything の公式モデルチェックポイント](https://github.com/facebookresearch/segment-anything#model-checkpoints)
- 直接ダウンロード: `https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth`
- 配置先: `G:\AI\doujin-ai-lab\tools\MosaicStudio\models\sam_vit_b_01ec64.pth`

## 基本操作

1. 上部で画像フォルダを選び、「読み込む」を押します。指定フォルダ配下の PNG / JPEG / WebP を一覧へ読み込みます。
2. ギャラリーには複数ファイルをドラッグ＆ドロップできます。ディレクトリをドロップした場合は、その直下にある対応画像だけを追加します。
3. ドロップした画像は、読み込み中のフォルダ内にある `.mosaicstudio_imports` へ元のバイト列のままコピーされ、一覧へ追加されます。ドラッグ追加の前にフォルダを読み込んでください。
4. 「自動検出」で現在の画像を検出し、「全画像を自動検出」で一覧全体を検出します。右側の候補一覧で、適用する候補の ON / OFF と表示色を変更できます。判定しきい値は 0.30～0.90 で、初期値は 0.60 です。
5. 「境界」を選び、対象の周囲をドラッグして白い範囲を作ります。その範囲内の対象をクリックすると、SAM が輪郭候補を追加します。境界候補も通常の候補一覧で ON / OFF できます。
6. 「ブラシ」はモザイクを追加する範囲を描きます。「消しゴム」は、ブラシや候補から外す範囲を描きます。
7. ギャラリーで画像を選択し「選択画像にモザイクを適用」、または現在画像の「モザイクを適用」を押して、適用モーダルから保存します。

「モザイククリア」と「全画像のモザイククリア」は、未適用の自動検出候補・境界候補・手描き範囲を消します。すでに画像ファイルへ焼き込んで保存したモザイクを元に戻す機能ではありません。

「画像一覧をクリア」は画面上の画像一覧だけを空にします。ディスク上の画像ファイルは削除しません。

## 適用モーダル

モザイク適用では次を設定できます。

- **コピー保存**: 初期値です。元画像と同じフォルダに `censored_` を先頭へ付けたコピーを保存します。
- **ファイル名の先頭**: コピー保存時の prefix を指定します。
- **元画像を上書き**: 元画像へ直接保存します。
- **コピー保存後に元画像を削除**: コピー保存が成功した場合だけ、元画像を削除します。上書き時には使えません。
- **モザイク粗さ**: モザイクのブロックサイズをピクセルで指定します。

コピー名が既に存在する場合は、自動で連番を付けます。適用中は進捗と現在処理中のファイル名を表示し、「一時停止」「再開」「キャンセル」を利用できます。一時停止とキャンセルは、処理中の1枚を安全に終えた後で反映されます。完了した画像は巻き戻しません。

## ショートカットとキャンバス操作

- `Space` を押している間: 画像をドラッグして移動
- 中ボタンドラッグ: 画像を移動
- ホイール: 拡大・縮小
- `Shift` + ホイール: ブラシ径を変更
- `Ctrl` + `Z`: 元に戻す
- `Ctrl` + `Shift` + `Z`: やり直す
- 左クリック／ドラッグ: 選択中のブラシ、消しゴム、境界ツールを操作
- 右クリック: 描画しない

## 保存時の安全性

保存ではモザイク部分だけを書き換え、元画像のメタデータ保持とデコード確認を行ってから置き換えます。

- PNG: `IDAT` だけを置換し、ComfyUI の `prompt` / `workflow` を含む ancillary chunks を保持・検証します。
- JPEG: APP0-APP15 と COM セグメントを保持・検証します。
- WebP: ICCP / EXIF / XMP を保持・検証します。アニメーション WebP と未対応・未知のチャンク構成を持つ WebP は保存を拒否します。
- 保存後は元のタイムスタンプを引き継ぎます。
- 一時ファイルを検証してから原子的な置換を行います。メタデータ不一致やデコード失敗時は、置換前に中止するため原本は変更しません。

ただし、画像形式やファイルシステムのすべての障害を防げるわけではありません。重要な原本は別途バックアップを残した上で使ってください。

## 別の PC で使う場合

現在の実装は Windows の絶対パスに依存しています。別の PC や別のフォルダへ移す場合は、環境に合わせて以下を確認・変更してください。

- `run.bat` の `PYTHON`
- `server.py` の `MODEL_PATH`
- `server.py` の `SECOND_MODEL_PATH`
- 必要に応じて SAM の配置先 `models\sam_vit_b_01ec64.pth`

## テスト

リポジトリのルートで実行します。

```powershell
& 'G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\python_embeded\python.exe' -m unittest discover -s tests -v
node tests/test_app_js.cjs
```
