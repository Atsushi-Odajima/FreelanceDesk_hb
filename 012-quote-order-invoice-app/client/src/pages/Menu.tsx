import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { AsyncButton } from '../components/ui';

/** スマホ用メニュー（下部ナビの「メニュー」） */
export default function MenuPage() {
  const { account, logout } = useAuth();
  const links: Array<[string, string, string]> = [
    ['/search', '検索', '案件・顧客・見積・請求を探す'],
    ['/payments', '入金一覧', '入金の登録・未割当入金の照合'],
    ['/payments/import', '銀行CSVの取込・照合', '銀行明細から入金を取り込む'],
    ['/items', '品目', 'よく使う作業・商品の登録'],
    ['/intake-templates', 'ヒアリングのテンプレート', 'FreelanceDesk ヒアリングで回収する質問・ファイルの定義'],
    ['/settings?tab=business', '事業者情報', '書類に載る名称・住所・振込先・ロゴ'],
    ['/settings?tab=data', 'データ（CSV・バックアップ）', 'CSV出力・取込、全データのバックアップと復元'],
    ['/settings?tab=account', 'アカウント', 'パスワード・復旧コード・ログアウト・削除'],
  ];
  return (
    <div>
      <div className="page-header">
        <h1>メニュー</h1>
      </div>
      <div className="list">
        {links.map(([to, title, desc]) => (
          <Link key={to} to={to} className="list-item">
            <div className="title">{title}</div>
            <div className="meta">{desc}</div>
          </Link>
        ))}
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="small muted">ログイン中：{account?.email}</div>
        <AsyncButton className="btn block" onClick={logout}>
          ログアウト
        </AsyncButton>
      </div>
    </div>
  );
}
