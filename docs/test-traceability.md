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
| SD-141 | 新規設定の相対モデル・保存先を拒否し、該当タブと入力欄を案内する | `tests.test_absolute_path_regression.AbsolutePathRegressionTests.test_relative_model_and_output_paths_are_rejected_for_new_settings`、`tests/test_settings_runtime.cjs` | 実在するモデル選択時の表示 |
| SD-142 | 旧設定の相対モデル・保存先を一度だけ絶対化して保存する | `tests.test_absolute_path_regression.AbsolutePathRegressionTests.test_legacy_relative_paths_are_migrated_to_absolute_paths_once` | 実際の起動、既存local.json、利用者の作業フォルダーでの表示 |
| SV-073 | 保存応答が一つの版とtokenを返す | `tests.test_http_live_endpoints.LiveHttpEndpointTests.test_live_browser_save_render_streams_a_stable_image_response` | 遅延応答中の別タブ更新・削除、実ブラウザーのダウンロードと一時ファイル解放 |
| SV-076 | 未作成の展開先で更新ZIPを展開できる | `tests.test_updater_extract_regression.UpdaterExtractRegressionTests.test_extract_archive_allows_a_missing_destination_directory` | 実リリースZIP、実ドライブの空き容量不足と更新前バックアップ |
| SV-077 | source snapshot失敗時にコピーを残し削除・確定を開始しない | `tests/test_save_source_snapshot_contract.cjs` | File System Access APIでの実ファイル、画面の`source_restore_failed`案内 |
| ED-128 | 候補編集操作が候補ビューのロック中に無効になる | `tests/test_candidate_mutation_lock_contract.cjs` | 読み込み中・保存中・処理中の実画面表示と、完了後の操作再開 |
| DI-237 | receiptとcleanup状態を永続化し、再試行で回収する | `tests.test_save_recovery.SaveRecoveryTests.test_workspace_receipt_is_durable`、`tests.test_save_recovery.SaveRecoveryTests.test_startup_compacts_only_cancelled_rows` | 応答喪失、タブ終了、再起動後の画面復帰とCMD記録 |
| DI-239 | ack失敗時もreceiptを保持し、再ackで回収する | `tests.test_save_recovery.SaveRecoveryTests.test_receipt_ack_retries_after_workspace_delete_failure`、`tests.test_save_recovery.SaveRecoveryTests.test_ack_keeps_receipt_when_commit_cleanup_is_pending` | 複数タブ、commit/ack応答喪失、再起動後のstatusと画面の再送 |
| WS-111 | 0件フォルダーは走査集約を記録し、既存カタログを変えない | `tests.test_http_import_regression.FolderLoadLoggingContractTests.test_empty_and_unreadable_folders_keep_the_previous_catalog` | パス入力時の画面案内とCMD表示 |
| WS-112 | 正常・破損・走査中変更の混在を理由別に一行へ集約し、正常画像だけを公開する | `tests.test_http_import_regression.FolderLoadLoggingContractTests.test_folder_scan_aggregates_corrupt_and_changed_files_without_per_file_logs` | 実フォルダーのサムネイル、長い相対名、CMD表示 |
| WS-113 | 大きいPNG文字列メタデータを画像本体として検証し、破損画像が混在しても他の読込を継続できる | `tests.test_image_validation.InputImageValidationTests.test_png_with_large_text_metadata_is_inspected_from_pixels`、`tests.test_http_import_regression.FolderLoadLoggingContractTests.test_folder_scan_aggregates_corrupt_and_changed_files_without_per_file_logs` | zTXt・iTXt、CRC不一致、実ファイルでの表示 |
| WS-114 | ブラウザーフォルダー選択の読込操作をfixtureで要求し、成功後にフォルダーAPIへ渡す | `tests/test_import_picker_e2e.cjs` | 実ブラウザーの権限要求、実フォルダー配下の読込 |
| WS-115 | ブラウザーフォルダー選択の取消・拒否で一覧と読込状態を保持する | `tests/test_import_picker_e2e.cjs` | 実ブラウザーの拒否表示と権限状態 |
| WS-116 | 読込・カタログ切替中の新規フォルダー読込を拒否し、先行状態を保持する | `tests.test_server.MozarieTests.test_same_root_reload_rejects_while_import_is_preparing` | 実ブラウザーでの同時操作の案内 |
| WS-117 | 高位操作は正規化ルート、status/error_code、所要だけを記録し、ID・本文・token・headerを記録しない | `tests.test_http_import_regression.FolderLoadLoggingContractTests.test_handler_logs_normalized_routes_without_request_secrets` | 全高位操作をCMDで実行した際の表示 |
| WS-118 | pause/resume/cancelを含む処理状態は操作面と対象数を保ち、画像単位の正常処理はINFOへ出さない | `tests/test_import_picker_e2e.cjs`、`tests.test_http_import_regression.FolderLoadLoggingContractTests.test_per_image_success_logs_are_suppressed_but_failures_are_safe_warnings` | 実モデルの開始・停止、CMDの進捗表示 |
| ED-129 | 画像外で始めた各編集操作を拒否し、画像内開始後の通常ブラシ移動を端へ丸める | `tests/test_app_core_detection_coverage.cjs` | 実ブラウザーの余白、拡大率、比較表示での全編集操作 |
| ED-130 | 無名作業の履歴復元を直列に保存し、部分成功を含む失敗後は強制再選択で再同期する | `tests/test_editor_masks_behavior.cjs` | 実ブラウザーと実サーバー通信での表示・再同期順 |

## active

| 手動ID | 実機で確認する理由 |
| --- | --- |

Windowsダイアログ、実GPU、実モデルによる検出、視覚的な描画・フォーカス、OS権限、実UNC、実ブラウザーのユーザー操作、WS-138のフォルダー入力はactiveの実機確認として残す。個々の行は `docs/manual-verification.md` 配下にある。

## retired

現在はなし。retiredに移すときは、対応する手動行を削除し、同じ利用者観測を再現するCIテスト名と実行層をこの表へ残す。
