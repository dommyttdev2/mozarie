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

自動検出では、精密性器セグメンテーションを最優先で使います。精密モデルは全画像を一度だけ 1280 px で検出し、`penis` と `vagina`（画面上は従来どおり `pussy`）だけを候補にします。旧モデルはタイル検出の補助として残るため、精密モデルが取りこぼした部位も候補になります。

同じクラスの候補が重なった場合は、精密モデルのマスクを採用し、旧モデルの広いマスクと合成しません。これにより、精液・手・周囲の衣服まで一緒にモザイクされる量を減らします。精液専用の信頼できるアニメ向けセグメンテーションモデルは確認できなかったため、色や明るさによる推測処理は行いません。

| 種別 | パス |
| --- | --- |
| precise genital segmentation | `models\ultralytics\nsfw-anime-xl-x1280.onnx` |
| anime hand detection | `models\ultralytics\anime-hand-v1.0-s.onnx` |
| optional primary fallback | `G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\ComfyUI\models\ultralytics\segm\ntd11_anime_nsfw_segm_v5-variant1.pt` |
| optional secondary fallback | `G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\ComfyUI\models\ultralytics\sensitive_detect_v07.pt` |

精密モデルと手モデルは起動中に自動ダウンロードしません。初回読込前にファイルサイズと SHA-256 を検証し、不一致なら検出を止めます。ONNX Runtime の `CUDAExecutionProvider` が実際に選ばれなかった場合も、CPUで長時間実行せず日本語エラーで停止します。

| モデル | 入手元（固定revision） | サイズ | SHA-256 | ライセンス |
| --- | --- | ---: | --- | --- |
| precise | `https://huggingface.co/01miku/anime-nsfw-segm-yolo26/resolve/1697d5d1827b6a818b350b44bf3ec27f08837a2a/nsfw-anime-xl-x1280.onnx` | 126350117 | `92046f77852b3e3d3a3ddf74575dd9d11f79f832af8d2d3e7eac186ba379194a` | MIT |
| hand | `https://huggingface.co/deepghs/anime_hand_detection/resolve/0c4ab4d/hand_detect_v1.0_s/model.onnx` | 44583229 | `408750ad39645fcdc0c5e774aa45a73941b2e785fc5611fb7d3d9790a41899c0` | OpenRAIL |

旧primary/secondaryは精密モデルの検出漏れを補います。手検出は旧モデル候補にだけ使い、手の矩形そのものではなくSAMが返す輪郭だけを候補外へ減算します。性器マスクの中心部は保護し、候補面積の20%を超える除外は適用しません。

## 境界選択用の SAM

「境界」ツールは SAM ViT-B を使います。Meta の公式チェックポイントをダウンロードして、次の場所へ配置してください。

- 入手元: [Segment Anything の公式モデルチェックポイント](https://github.com/facebookresearch/segment-anything#model-checkpoints)
- 直接ダウンロード: `https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth`
- 配置先: `G:\AI\doujin-ai-lab\tools\MosaicStudio\models\sam_vit_b_01ec64.pth`

## 基本操作

1. 上部の「参照...」から「フォルダを選択」または「画像を選択」を選びます。フォルダを選んだ場合は指定フォルダ配下の PNG / JPEG / WebP を一覧へ読み込みます。
2. ギャラリーには複数ファイルをドラッグ＆ドロップできます。ディレクトリをドロップした場合は、その直下にある対応画像だけを追加します。
3. 「画像を選択」またはドラッグで追加した画像は、読み込み中のフォルダ内にある `.mosaicstudio_imports` へ元のバイト列のままコピーされ、一覧へ追加されます。画像追加の前にフォルダを読み込んでください。
4. 「自動検出」で現在の画像を検出し、「全画像を自動検出」で一覧全体を検出します。右側の候補一覧で、適用する候補を ON / OFF できます。判定しきい値は 0.10～0.90、初期値は 0.50 です。自動候補に出すクラスは `penis` と `pussy` だけです。
5. 「境界」を選び、対象の周囲をドラッグして白い範囲を作ります。その範囲内の対象をクリックすると、SAM が輪郭候補を追加します。候補の追加に成功すると範囲は消え、失敗した場合は同じ範囲で再試行できます。境界候補も通常の候補一覧で ON / OFF できます。
6. 中央ツールバーの「モザイク表示」で実際のモザイクプレビューだけを表示・非表示にできます。候補、手描き、除外、保存対象は変わりません。
7. 「ブラシ」はモザイクを追加する範囲を描きます。「消しゴム」は、ブラシや候補から外す範囲を描きます。
8. 編集中は候補・手描き範囲に実際のモザイクがプレビューされます。「モザイク適用済」タブには、最終合成マスクが残っている画像だけが出ます。「全画像保存」はその画像だけを対象にし、現在画像は「ファイル保存」から個別に保存できます。

「モザイククリア」と「全画像のモザイククリア」は、未適用の自動検出候補・境界候補・手描き範囲を消します。すでに画像ファイルへ焼き込んで保存したモザイクを元に戻す機能ではありません。

「画像一覧をクリア」は画面上の画像一覧だけを空にします。ディスク上の画像ファイルは削除しません。

## 保存モーダル

ファイル保存では次を設定できます。

- **コピー保存**: 初期値です。元画像と同じフォルダに `_censored` を拡張子の直前へ付けたコピーを保存します。`image.png` は `image_censored.png` になります。
- **ファイル名の末尾**: コピー保存時に拡張子の直前へ付ける文字列を指定します。`image.sample.png` のような複数ドットの名前も保ちます。
- **元画像を上書き**: 元画像へ直接保存します。
- **コピー保存後に元画像を削除**: コピー保存が成功した場合だけ、元画像を削除します。上書き時には使えません。
- **モザイク粗さ**: `1 / 100` のように分母を指定します。画像ごとに `max(4, ceil(長辺 / 分母))` のブロックサイズを自動で使います。たとえば 832×1216 の画像では `1 / 100` が 13 px です。

コピー名が既に存在する場合は、自動で連番を付けます。保存中は進捗と現在処理中のファイル名を表示し、「一時停止」「再開」「キャンセル」を利用できます。一時停止とキャンセルは、処理中の1枚を安全に終えた後で反映されます。完了した画像は巻き戻しません。

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
