# TEST_REPORT — 実施／修正済み／失敗／未実施（2026-09-28）

## 実行環境
- Linux コンテナ、Node.js 22.22.2、PostgreSQL 16.13（ローカル）
- ブラウザ：Chromium 1194（Playwright 1.63.0、ヘッドレス）。スマホは viewport＋isMobile＋hasTouch＋iPhone UA のエミュレーション
- **iPhone / Android 実機、Safari（WebKit）、Firefox では未実施**

## 結果サマリ
| 種別 | コマンド | 結果 |
|---|---|---|
| 型検査 | `npm run typecheck` | ✅ エラー0 |
| 単体 | `npx vitest run tests/unit` | ✅ 41件成功 |
| 結合（実DB） | `npx vitest run tests/integration` | ✅ 57件成功 |
| 単体＋結合 合計 | `npm test` | ✅ **98件成功 / 失敗0** |
| E2E | `npm run test:e2e` | ✅ **9件成功 / 失敗0** |
| 依存脆弱性 | `npm audit` | ✅ 0 vulnerabilities |
| 別環境への復元 | `scripts/restore-roundtrip-check.mjs`（別DB・別プロセス） | ✅ 件数17テーブル・金額5種・請求一覧が完全一致 |

## 必須テスト項目との対応
| 必須項目 | テスト | 結果 |
|---|---|---|
| 金額・小数数量・端数・値引き・税率入力・残額・過入金・期限判定 | unit/calc.test.ts（17件） | ✅ |
| 見積版・受注・納品・請求・訂正・一部入金・完済・キャンセル | integration/flow, invoices | ✅ |
| 受注再送・請求作成再送・入金割当再送・銀行CSV再取込 | integration/idempotency（同時送信5並列含む）, flow（CSV再取込・期間重複）, review-fixes | ✅ |
| 別ユーザーの ID/案件ID/添付ID 書換えで拒否 | integration/security（顧客・案件・見積・請求・版・添付・PDF・候補・割当・入金削除・検索・一覧） | ✅ |
| PDF：日本語・長い住所/品目・複数ページ・内部メモ非混入 | integration/docs-data（テキスト抽出＋**埋め込みフォントのグリフ輪郭検査**）、手動で画像化して目視 | ✅ |
| PDF：スマホ保存・共有 | e2e 添付・PDF（ダウンロード・Content-Disposition・PDFヘッダ） | 🟡 エミュレーションのみ。**実機の保存・共有シートは未確認** |
| iPhone Safari・ホーム画面PWA・Android Chrome で主要操作 | — | ⬜ **未実施（実機なし）** |
| 320〜430pxスマホ・タブレット・1366px PC で主要操作 | e2e responsive（320/375/430/768/1024/1366 × 13画面で横スクロールなし、ボタン高さ44px以上）、シナリオ1は375pxで全工程 | ✅（Chromiumのみ） |
| CSV：引用符・カンマ・改行・BOM・Shift_JIS・重複 | unit/csv.test.ts、integration（Shift_JIS取込、重複コード）、e2e シナリオ4（Shift_JIS自動判定・改行入りフィールド・BOM版の同一内容拒否） | ✅ |
| CSV出力：BOM・引用・数式インジェクション | unit/csv, integration/docs-data | ✅ |
| バックアップ：エクスポート→空環境へ復元→件数/金額一致 | integration/docs-data（同一環境の別アカウント）、別DB・別プロセスでの手動スクリプト | ✅ |

## E2E（Playwright）
| # | シナリオ | 画面幅 | 結果 |
|---|---|---|---|
| 1 | 登録→顧客→案件→見積v1(120,000)→v2(100,000)→提出→受注→タスク5件→納品→請求→30,000入金（一部入金）→70,000入金（入金済み）→完了 | 375px（タッチ） | ✅ |
| 2 | 見積提出→失注（請求書が生成されない） | 1366px | ✅ |
| 3 | 受注→納品→ホーム「未請求」に表示→請求確定で消える | 1366px | ✅ |
| 4 | 期限超過請求→銀行CSV（Shift_JIS）取込→候補（金額一致・名義一致）→利用者が確定→入金済み、同一内容CSV（UTF-8 BOM版）は拒否 | 1366px | ✅ |
| 5 | スマホで案件作成（ダブルタップ）→1件のみ→PCで編集→スマホで最新表示 | 375px / 1366px | ✅ |
| 追加 | レスポンシブ 6幅×13画面、PWA（manifest・アイコン・SW登録）、オフライン（保存不可・端末下書き保持→再接続後1件だけ登録）、写真添付（PNG・HEIC）・実行ファイル拒否、PDF保存、PCのPDFプレビュー・Escで閉じる | 各種 | ✅ |

## 開発中に見つけて修正した不具合
| 不具合 | 発見方法 | 修正 |
|---|---|---|
| **PDFの日本語グリフが大量に欠落**（Noto Sans JP を pdf-lib でサブセット埋め込み） | PDFを画像化して目視（テキスト抽出テストは通過していた） | フォントを IPA Pゴシックに変更。埋め込みフォントのグリフ輪郭検査をテストに追加 |
| DB接続の切断でサーバープロセスが落ちる | E2E準備中にDB再作成で発生 | `pool.on('error')` を追加 |
| 登録直後に事業者設定へ遷移せずホームへ戻る | E2Eシナリオ1 | ログイン後の遷移先を保持 |
| タスクの完了チェックが通信完了まで反映されない（スマホで遅く感じる） | E2E | 楽観的更新に変更 |
| 「PDFを保存」がBlob経由でiOSと相性が悪い構成 | E2E | サーバーの Content-Disposition 付きURLへ直接リンク |
| オフライン起動時にログイン画面へ戻される | 設計見直し | 前回のアカウント情報で閲覧キャッシュ表示 |
| 320px で見出しとボタンが詰まる／請求一覧の絞込が画面を占有 | スクリーンショット確認 | 見出しの折返し、絞込を折りたたみ式に |
| コードレビュー指摘10件（復元のzip爆弾・他アカウントID持ち込み・XFF偽装・同一受注の二重請求・復元添付の容量回避・デッドロック・2000件打ち切り・CSV同時取込・CSV取込の再送・期限切れデモ） | 独立レビュー | 全件修正、tests/integration/review-fixes.test.ts（9件）で回帰確認 |

## 既知の検証上の注意
- ヘッドレスChromiumでは Playwright の `download.suggestedFilename()` が常に "download" になる（`download="abc.pdf"` でも同じ）。ファイル名は Content-Disposition ヘッダで検証。
- 日付入力の表示形式（mm/dd/yyyy）はヘッドレス環境のロケールによるもの。実機では端末の表示形式になる。

## 未実施（人間の確認が必要）
- iPhone Safari・iPhoneホーム画面PWA・Android Chrome の実機確認一式（RELEASE_CHECKLIST.md B節）
- 実機でのカメラ撮影、HEIC写真の実際の扱い、PDFの共有シート・ファイルアプリ保存
- Safari(WebKit)・Firefox・Edge での確認（Chromium系以外）
- 生成PDFの Acrobat Reader / macOS プレビュー / iOS での表示（pdf.js での描画は確認済み）
- 実在の銀行CSV（各行の列構成）での取込
- 本番ホスティング上での動作・負荷（Docker イメージのビルドはこの環境で Docker デーモンが使えず**未実施**）
- 第三者による脆弱性診断
