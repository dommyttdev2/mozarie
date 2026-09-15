# 自動テストと実機確認の対応

この表は、利用者向けの確認項目とCIで固定した規則の境界を示す。対応する製品変更、テスト、手動項目は同じコミットで更新する。

| 状態 | 意味 |
| --- | --- |
| active | CIで代替できない実機確認。対応する自動テストはない、または別の規則だけを確認する。 |
| split | 決定的な規則はCIで確認済み。表示、OS、実ブラウザー、実モデル、実ネットワークなどを手動で残す。 |
| retired | CIが同じ利用者観測を完全に再現するため、手動行を削除した状態。 |

## split

| 手動ID | CIで確認する規則 | 実テスト | 手動で残す部分 |
| --- | --- | --- | --- |
| SD-141 | 新規設定の相対モデル・保存先を拒否する | `tests.test_absolute_path_regression.AbsolutePathRegressionTests.test_relative_model_and_output_paths_are_rejected_for_new_settings` | 設定画面の入力案内と、実在するモデル選択時の表示 |
| SD-142 | 旧設定の相対モデル・保存先を一度だけ絶対化して保存する | `tests.test_absolute_path_regression.AbsolutePathRegressionTests.test_legacy_relative_paths_are_migrated_to_absolute_paths_once` | 実際の起動、既存local.json、利用者の作業フォルダーでの表示 |
| SV-073 | 保存応答が一つの版とtokenを返す | `tests.test_http_live_endpoints.LiveHttpEndpointTests.test_live_browser_save_render_streams_a_stable_image_response` | 遅延応答中の別タブ更新・削除、実ブラウザーのダウンロードと一時ファイル解放 |
| SV-076 | 未作成の展開先で更新ZIPを展開できる | `tests.test_updater_extract_regression.UpdaterExtractRegressionTests.test_extract_archive_allows_a_missing_destination_directory` | 実リリースZIP、実ドライブの空き容量不足と更新前バックアップ |
| SV-077 | source snapshot失敗時にコピーを残し削除・確定を開始しない | `tests/test_save_source_snapshot_contract.cjs` | File System Access APIでの実ファイル、画面の`source_restore_failed`案内 |
| ED-128 | 候補編集操作が候補ビューのロック中に無効になる | `tests/test_candidate_mutation_lock_contract.cjs` | 読み込み中・保存中・処理中の実画面表示と、完了後の操作再開 |
| DI-237 | receiptとcleanup状態を永続化し、再試行で回収する | `tests.test_save_recovery.SaveRecoveryTests.test_workspace_receipt_is_durable`、`tests.test_save_recovery.SaveRecoveryTests.test_startup_compacts_only_cancelled_rows` | 応答喪失、タブ終了、再起動後の画面復帰とCMD記録 |
| DI-239 | ack失敗時もreceiptを保持し、再ackで回収する | `tests.test_save_recovery.SaveRecoveryTests.test_receipt_ack_retries_after_workspace_delete_failure`、`tests.test_save_recovery.SaveRecoveryTests.test_ack_keeps_receipt_when_commit_cleanup_is_pending` | 複数タブ、commit/ack応答喪失、再起動後のstatusと画面の再送 |

## active

Windowsダイアログ、実GPU、実モデルによる検出、視覚的な描画・フォーカス、OS権限、実UNC、実ブラウザーのユーザー操作、WS-138のフォルダー入力はactiveの実機確認として残す。個々の行は `docs/manual-verification.md` 配下にある。

## retired

現在はなし。retiredに移すときは、対応する手動行を削除し、同じ利用者観測を再現するCIテスト名と実行層をこの表へ残す。
