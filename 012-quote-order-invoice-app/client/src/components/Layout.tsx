import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { onOfflineData } from '../api';
import { useOnline } from '../hooks';
import { IconBank, IconBox, IconFolder, IconGear, IconHome, IconMenu, IconSearch, IconUsers, IconYen } from './icons';

const NAV = [
  { to: '/', label: 'ホーム', icon: IconHome, end: true },
  { to: '/projects', label: '案件', icon: IconFolder },
  { to: '/invoices', label: '請求・入金', icon: IconYen },
  { to: '/payments/import', label: '銀行CSV照合', icon: IconBank, pcOnly: true },
  { to: '/customers', label: '顧客', icon: IconUsers },
  { to: '/items', label: '品目', icon: IconBox, pcOnly: true },
  { to: '/intake-templates', label: 'ヒアリング設定', icon: IconFolder, pcOnly: true },
  { to: '/search', label: '検索', icon: IconSearch, pcOnly: true },
  { to: '/settings', label: '設定・データ', icon: IconGear, pcOnly: true },
];

export default function Layout() {
  const { account } = useAuth();
  const online = useOnline();
  const [offlineData, setOfflineData] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => {
    const off = onOfflineData(setOfflineData);
    return () => {
      off();
    };
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [loc.pathname]);

  return (
    <div className="app">
      <aside className="sidebar" aria-label="メインメニュー">
        <Link to="/" className="brand">
          Freelance Desk
        </Link>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav ${isActive ? 'active' : ''}`}>
            <n.icon />
            {n.label}
          </NavLink>
        ))}
        <div className="foot">
          {account?.businessName || account?.email}
          {account?.isDemo && <div className="badge yellow">デモ（架空データ）</div>}
        </div>
      </aside>

      <header className="topbar">
        <Link to="/" className="brand">
          {account?.businessName || 'Freelance Desk'}
        </Link>
        <button className="icon-btn" aria-label="検索" onClick={() => nav('/search')}>
          <IconSearch />
        </button>
      </header>

      <main className="main">
        {!online && <div className="banner warn">オフラインです。表示は端末に残っている最新の情報です。保存・確定・入金の登録はできません。</div>}
        {online && offlineData && <div className="banner warn">通信できないため、端末に保存された以前の表示を出しています。</div>}
        {account?.isDemo && (
          <div className="banner info">
            デモアカウント（架空データ）です。{account.demoExpiresAt ? '一定時間後に自動削除されます。' : ''}本番利用は「新規登録」から始めてください。
          </div>
        )}
        <Outlet />
      </main>

      <nav className="bottom-nav" aria-label="メインメニュー">
        {[
          { to: '/', label: 'ホーム', icon: IconHome, end: true },
          { to: '/projects', label: '案件', icon: IconFolder },
          { to: '/invoices', label: '請求・入金', icon: IconYen },
          { to: '/customers', label: '顧客', icon: IconUsers },
          { to: '/menu', label: 'メニュー', icon: IconMenu },
        ].map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <n.icon />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
