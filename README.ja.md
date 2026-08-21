[English](README.md)

# Mozarie

複数画像のモザイク範囲をローカルで確認・編集するWindowsアプリです。自動検出で候補を出し、候補の確認や手動修正をしてから保存できます。対応形式では保存時に元画像のメタ情報を保持します。

## 最短手順

1. Python 3.11以降をインストールします。
2. 依存関係を入れます。

   ```powershell
   python -m pip install -r requirements.txt
   ```

3. 下の「必須」モデルを2つダウンロードします。
4. Mozarieを起動します。

   ```powershell
   .\run.bat
   ```

5. **設定 > 検出**で2つのモデルファイルを指定し、画像またはフォルダを読み込みます。
6. 自動検出、候補確認、必要な手動修正を行い、保存します。

## モデルの準備

### 必須

| 用途 | ファイル | ダウンロード | 配布元 |
| --- | --- | --- | --- |
| 性器を自動検出 | `nsfw-anime-xl-x1280.onnx` | [ダウンロード](https://huggingface.co/01miku/anime-nsfw-segm-yolo26/resolve/1697d5d1827b6a818b350b44bf3ec27f08837a2a/nsfw-anime-xl-x1280.onnx) | [モデルページ](https://huggingface.co/01miku/anime-nsfw-segm-yolo26) |
| 輪郭を整える・境界ツールに使う | `sam_vit_b_01ec64.pth` | [ダウンロード](https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth) | [Segment Anything](https://github.com/facebookresearch/segment-anything) |

輪郭モデルは、高精度での自動検出、境界ツール、手の除外で物体の輪郭を取るためにも使います。

### 任意: 検出漏れを補う

NTD11とSensitiveは、基本モデルで検出漏れが多いときだけ追加する性器検出モデルです。

| モデル | 配布元 |
| --- | --- |
| `ntd11_anime_nsfw_segm_v5-variant1` | [Anime NSFW Detection / ADetailer All-in-One](https://civitai.com/models/1313556/anime-nsfw-detection-adetailer-all-in-one) |
| `sensitive_detect_v07` | [sugarknight/sensitive-detect](https://huggingface.co/sugarknight/sensitive-detect/tree/main) |

この2つには1024pxのraw segmentation ONNXが必要です。配布元に互換ONNXがない場合だけ、ダウンロードした`.pt`をUltralyticsで`end2end=False`として変換し、**設定 > 検出**で生成された`.onnx`を指定してください。

```powershell
python -m pip install ultralytics
yolo export model="path\to\model.pt" format=onnx imgsz=1024 end2end=False
```

### 任意: 重なった手を除外

性器に重なった手をモザイクから外したい場合だけ有効にします。手の検出ONNXが必要で、上記の輪郭モデルと組み合わせて重なった部分だけを除外します。

| モデル | 配布元 |
| --- | --- |
| 手の検出 | [anime_hand_detection](https://huggingface.co/deepghs/anime_hand_detection/tree/0c4ab4d58aafbd56794c82a9c1fe424f86c5780d/hand_detect_v1.0_s) |

### 任意: HandSegNet anime SDXL

手の検出をONにした場合は、手の輪郭に固定版の[HandSegNet anime SDXL](https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl/resolve/77ff734683306141e56aef9d491958a82508b41a/handsegnet_vit_b_best.safetensors)を任意で使えます。Mozarieはモデルを同梱・自動ダウンロードしません。手動でダウンロードし、revision `77ff734683306141e56aef9d491958a82508b41a` と SHA-256 `64b35e5ee09aac8737e2554f15e73503f94ce9bf443dde4864255e14b7ca9c14` を確認してください。固定版の[LICENSE_WEIGHTS.txt](https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl/blob/77ff734683306141e56aef9d491958a82508b41a/LICENSE_WEIGHTS.txt)はモデル重みに適用され、配布元リポジトリの推論・変換スクリプトには適用されません。

### 任意: 白い体液候補を検出

追加モデルは使いません。検出されたペニス範囲の中で、白色かつ小さい領域を色と面積で判定し、初期状態がOFFの除外候補として追加する実験的な処理です。白いハイライトや明るい小物も候補になることがあるため、確認してから必要な候補だけONにしてください。

モデルファイルはこのリポジトリに含まれず、自動ダウンロードもしません。利用前に各配布元の利用条件とライセンスを確認してください。

## 使い方

1. 画像またはフォルダを読み込みます。
2. 現在の画像、または全画像に自動検出を実行します。
3. モザイク範囲の候補を確認し、不要な候補を外します。
4. ブラシで追加・削除するか、境界ツールで物体の輪郭を選びます。
5. 1枚ずつ、またはまとめて保存します。

PNG、JPEG、WebPでは対応する元画像メタ情報を保持して保存します。公開前に保存画像を確認してください。

## アップデート

`update.bat`をダブルクリックすると公開されているGitHub Releaseを確認します。更新がある場合はMozarieを終了してから実行してください。ローカル設定、モデル、キャッシュ、作業画像は保持されます。

## 開発

リリースを公開する前に、`VERSION`をGitHub Releaseタグと同じセマンティックバージョンへ更新してください。

```powershell
python -m unittest discover -s tests -v
node tests/test_app_js.cjs
node tests/test_browser_save_contract.cjs
node tests/test_browser_save_runtime.cjs
node tests/test_import_picker_e2e.cjs
```

## ライセンス

Mozarieは[MIT License](LICENSE)で公開しています。第三者コンポーネントとモデル配布元については[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)を確認してください。
