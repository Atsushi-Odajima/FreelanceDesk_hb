# FreelanceDesk — 見積から入金確認まで

問い合わせ・見積・受注・納品・請求・入金確認を、同じ案件情報でつなぐフリーランス向けWebアプリです。

実装ブランチ：`claude/merge-intakemint`。アプリ本体は `012-quote-order-invoice-app/`。

## できること

- 見積改訂、案件進行、請求書・入金確認、帳票出力
- 統合済みのクライアントポータル、画像ピン、写真セレクト
- ヒアリング・提出ファイル・不足確認と、出典付き案件開始パック

## 現在の範囲・制限

- 自動銀行接続・実決済・自動メール送信は含みません。
- 統合ヒアリングは条件分岐JSON編集などの最小UIです。外部AI・リマインド・大容量ストレージ等は未統合で、実機確認も残っています。

## 実装の見どころ

**構成：** React / TypeScript / Vite、Node.js、PostgreSQL、PWA。

- [012-quote-order-invoice-app/server](./012-quote-order-invoice-app/server)
- [012-quote-order-invoice-app/client/src/pages](./012-quote-order-invoice-app/client/src/pages)
- [012-quote-order-invoice-app/tests](./012-quote-order-invoice-app/tests)

## ローカルで試す

Node.js 22以上、PostgreSQL。ローカルDB補助スクリプトにはBashが必要です。

実装ブランチを取得し、次のディレクトリで作業します。

```sh
git clone --branch claude/merge-intakemint https://github.com/Atsushi-Odajima/FreelanceDesk_hb.git
cd FreelanceDesk_hb/012-quote-order-invoice-app
npm ci
```

DEVELOPMENT.mdで開発DB・環境変数と移行を設定してから npm run dev を実行します。サンプル投入は専用DBで行ってください。

環境設定・初期化の詳細：[セットアップ手順](./012-quote-order-invoice-app/DEVELOPMENT.md)。

## 検証方法

`012-quote-order-invoice-app/` の `package.json` に定義された主な確認コマンドです。DB・ブラウザ・外部ツールを要するものは、開発手順の事前設定が必要です。

```sh
npm run typecheck
npm run test
npm run test:e2e
npm run build
```

試験の実施環境・結果・未実施項目は、下記の記録を参照してください。画面エミュレーションと実機確認、モックと外部サービスでの確認を区別しています。

## 資料

- [012-quote-order-invoice-app/DEVELOPMENT.md](./012-quote-order-invoice-app/DEVELOPMENT.md)
- [012-quote-order-invoice-app/NEXT_STEPS.txt](./012-quote-order-invoice-app/NEXT_STEPS.txt)
- [012-quote-order-invoice-app/README.md](./012-quote-order-invoice-app/README.md)
- [012-quote-order-invoice-app/TEST_REPORT.md](./012-quote-order-invoice-app/TEST_REPORT.md)
- [012-quote-order-invoice-app/RELEASE_CHECKLIST.md](./012-quote-order-invoice-app/RELEASE_CHECKLIST.md)
- [012-quote-order-invoice-app/DATA_MODEL.md](./012-quote-order-invoice-app/DATA_MODEL.md)
- [012-quote-order-invoice-app/DECISIONS.md](./012-quote-order-invoice-app/DECISIONS.md)
- [012-quote-order-invoice-app/SECURITY.md](./012-quote-order-invoice-app/SECURITY.md)
- [012-quote-order-invoice-app/OPERATIONS.md](./012-quote-order-invoice-app/OPERATIONS.md)
- [012-quote-order-invoice-app/THIRD_PARTY_NOTICES.txt](./012-quote-order-invoice-app/THIRD_PARTY_NOTICES.txt)

## 制作・利用条件

制作・管理：**Atsushi Odajima**。実装・資料作成にはAI支援を利用しています。
ソース・同梱ライブラリ・フォント・モデル等の利用条件は、各ライセンスと第三者表記を参照してください。リポジトリの閲覧可能性と、再配布・商用利用の許諾は別です。
