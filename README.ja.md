[English](README.md)

# Mozarie

Mozarieは、複数画像のモザイク範囲をローカルで確認・編集するWindowsアプリです。性器領域の候補を自動検出し、最終判断と手動修正は利用者が行えます。PNG、JPEG、WebPを保存できます。

[最新版リリース](https://github.com/norqis/mozarie/releases/latest) · [セットアップ](#セットアップ) · [モデルのダウンロード](#モデルのダウンロード)

## できること

- 画像・フォルダーの読み込み、現在の画像・全画像の自動検出、長時間処理の一時停止・再開・キャンセル
- 候補の確認、非表示、クリア、一括操作、ブラシ・消しゴム・境界ツールでの修正
- コピー保存または確認後の元画像上書き。対応する元画像メタ情報を結果へ引き継ぎます

## セットアップ

1. WindowsにPython 3.11以降を入れます。
2. 依存関係を入れます。

   ```powershell
   python -m pip install -r requirements.txt
   ```

3. 互換性のある基本モデルの`.onnx`ファイルを用意します。
4. 起動します。

   ```powershell
   .\run.bat
   ```

5. **設定 > 検出**で基本モデルを**参照**から指定します。SAMと手モデルは見出し横の**ダウンロード**、手元にあるファイルは**参照**から指定できます。画像を読み込み、自動検出、候補確認、必要な修正を行って保存します。

ダウンロードは利用者が操作したときだけ実行します。対応モデルはプロジェクトの`Mozarie\models\`へ保存し、ダウンロード時に固定したサイズとSHA-256を確認してから利用可能にします。これは固定配布物の改ざん検知であり、ファイルの無害性を絶対に保証するものではありません。起動時や検出時にハッシュを再確認することはありません。

## モデルのダウンロード

| 機能 | 指定するファイル | ダウンロード / 配布元 |
| --- | --- | --- |
| 必須: 性器の自動検出 | 互換性のある`.onnx`ファイル | 設定の**参照**から指定します。 |
| 任意: 輪郭補正・境界ツール・手の除外 | `sam_vit_b_01ec64.pth`、`sam_vit_l_0b3195.pth`、`sam_vit_h_4b8939.pth` | 選択中の種類をMozarieでダウンロード、または[公式SAMチェックポイント](https://github.com/facebookresearch/segment-anything#model-checkpoints)から取得。保存先: `Mozarie\models\` |
| 任意: アニメ手検出 | `hand_detect_v1.0_s.onnx` | Mozarieでダウンロード、または[固定配布元](https://huggingface.co/deepghs/anime_hand_detection/resolve/dba2c5bec15fcee9ac4909b244a84e8783cf46a2/hand_detect_v1.0_s/model.onnx)から取得。保存先: `Mozarie\models\ultralytics\anime-hand-v1.0-s.onnx` |
| 任意: HandSegNetの手輪郭 | `handsegnet_vit_b_best.safetensors` | Mozarieでダウンロード、または[固定配布元](https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl/resolve/77ff734683306141e56aef9d491958a82508b41a/handsegnet_vit_b_best.safetensors)から取得。保存先: `Mozarie\models\handsegnet\handsegnet_vit_b_best.safetensors` |

基本モデルは1280入力、43チャンネル軸を持つrank-3予測出力、32チャンネルのrank-4プロトタイプ出力が必要です。クラス順は`anus`、`nipple`、`penis`、`vagina`、`female face`、`male face`、`pubic hair`です。

SAMは設定で選んだ`vit_b`、`vit_l`、`vit_h`と同じ種類のファイルを指定してください。HandSegNetは任意で、手の検出をONにした場合だけ使えます。NTD11とSensitiveは任意の補助モデルです。

NTD11は基本モデルを補う任意のONNXモデルです。[Anime NSFW Detection / ADetailer All-in-One v5.0-variant1](https://civitai.com/models/1313556?modelVersionId=2350456)の`ntd11_anime_nsfw_segm_v5-variant1.onnx`を**参照**から指定します。Sensitiveは[固定配布元](https://huggingface.co/sugarknight/sensitive-detect/tree/b7ec7a528841aac3d52411fb4d031d51a8225e40)の`sensitive_detect_v07.pt`をONNXへ変換してから指定します。

```powershell
python -m pip install ultralytics
yolo export model="C:\...\sensitive_detect_v07.pt" format=onnx imgsz=1024 simplify=False opset=17 end2end=False device=cpu
```

## 使い方

1. 画像またはフォルダーを読み込みます。
2. 現在の画像または全画像に自動検出を実行します。
3. 候補を確認し、必要に応じてブラシ・消しゴム・境界ツールで修正します。手の除外は検出した手の輪郭全体です。各除外候補の**除外を強制**をONにすると、その範囲へモザイクを追加しても除外を優先します。
4. コピー保存または元画像上書きを選びます。コピーの同名ファイルには自動で連番を付けます。

GPU処理は**設定 > 検出**で対応GPUを選びます。1件目の検出完了後は残り時間を表示し、一時停止中の時間は見積りから除きます。GPUメモリが不足した場合は同時処理数を1に下げ、別GPUまたはCPUを選んでください。

## アップデート

設定の**更新を確認**、または`update.bat`を使います。更新を適用する前にMozarieを終了してください。設定、モデルパス、キャッシュ、作業画像はローカルに残ります。

## 困ったとき

- **モデルを読めない:** 指定したファイルと、設定のSAM種類を確認してください。
- **GPUメモリ・CUDA/providerエラー:** 同時処理数を下げる、CPUへ切り替える、または対応するONNX Runtime GPU/PyTorch環境を入れてください。
- **解決しない:** エラー文と選択中のproviderを添えて[GitHub Issues](https://github.com/norqis/mozarie/issues)へ報告してください。

## 開発

```powershell
python -m unittest discover -s tests -v
npm ci
npm test
```

## ライセンス

Mozarieは[MIT License](LICENSE)で公開しています。第三者コンポーネントとモデル配布元は[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)を確認してください。
