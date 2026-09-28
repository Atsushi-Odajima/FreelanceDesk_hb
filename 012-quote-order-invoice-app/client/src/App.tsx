import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth';
import { ToastProvider, Loading } from './components/ui';
import Layout from './components/Layout';
import { LoginPage, SignupPage, RecoverPage, ResetPage } from './pages/Auth';
import DashboardPage from './pages/Dashboard';
import ProjectsPage from './pages/Projects';
import ProjectNewPage from './pages/ProjectNew';
import QuoteEditorPage from './pages/QuoteEditor';
import InvoiceEditorPage from './pages/InvoiceEditor';
import InvoicesPage from './pages/Invoices';
import InvoiceDetailPage from './pages/InvoiceDetail';
import CustomersPage, { CustomerDetailPage } from './pages/Customers';
import ItemsPage from './pages/Items';
import BankImportPage from './pages/BankImport';
import PaymentsPage from './pages/Payments';
import SearchPage from './pages/Search';
import SettingsPage from './pages/Settings';
import MenuPage from './pages/Menu';

function RequireAuth({ children }: { children: ReactNode }) {
  const { account, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!account) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { account, loading } = useAuth();
  if (loading) return <Loading />;
  if (account) {
    // 登録直後など、ログイン後の遷移先が指定されていればそこへ
    const next = sessionStorage.getItem('fd-after-login');
    sessionStorage.removeItem('fd-after-login');
    return <Navigate to={next && next.startsWith('/') ? next : '/'} replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
            <Route path="/signup" element={<PublicOnly><SignupPage /></PublicOnly>} />
            <Route path="/recover" element={<PublicOnly><RecoverPage /></PublicOnly>} />
            <Route path="/reset" element={<ResetPage />} />
            <Route element={<RequireAuth><Layout /></RequireAuth>}>
              <Route index element={<DashboardPage />} />
              <Route path="projects" element={<ProjectsPage />} />
              <Route path="projects/new" element={<ProjectNewPage />} />
              <Route path="projects/:id" element={<ProjectsPage />} />
              <Route path="projects/:id/edit" element={<ProjectNewPage />} />
              <Route path="quotes/:versionId" element={<QuoteEditorPage />} />
              <Route path="invoices" element={<InvoicesPage />} />
              <Route path="invoices/:id" element={<InvoiceDetailPage />} />
              <Route path="invoice-versions/:versionId" element={<InvoiceEditorPage />} />
              <Route path="payments" element={<PaymentsPage />} />
              <Route path="payments/import" element={<BankImportPage />} />
              <Route path="customers" element={<CustomersPage />} />
              <Route path="customers/:id" element={<CustomerDetailPage />} />
              <Route path="items" element={<ItemsPage />} />
              <Route path="search" element={<SearchPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="menu" element={<MenuPage />} />
              <Route path="*" element={<div className="empty">ページが見つかりません</div>} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}
