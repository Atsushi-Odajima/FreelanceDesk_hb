import { useState } from 'react';
import { del, errorMessage, newRequestId, post, put } from '../api';
import { useApi, useIsMobile } from '../hooks';
import { AsyncButton, Empty, ErrorBanner, Field, Loading, Modal, Money, YenInput } from '../components/ui';

const empty = { code: '', name: '', description: '', unitPrice: 0 as number | '', unit: '式', taxRate: '10' };

function ItemForm({ initial, id, onSaved }: { initial: typeof empty; id?: string; onSaved: () => void }) {
  const [f, setF] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId());
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          const body = { ...f, unitPrice: f.unitPrice === '' ? 0 : f.unitPrice };
          if (id) await put(`/api/items/${id}`, body);
          else await post('/api/items', { ...body, requestId });
          onSaved();
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <ErrorBanner message={error} />
      <div className="form-grid cols-2">
        <Field label="品名（必須）" className="span-2">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={200} />
        </Field>
        <Field label="コード（任意）">
          <input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} maxLength={50} />
        </Field>
        <Field label="単位">
          <input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} maxLength={20} />
        </Field>
        <Field label="標準単価（円）">
          <YenInput value={f.unitPrice} onChange={(v) => setF({ ...f, unitPrice: v })} allowEmpty />
        </Field>
        <Field label="税率（%）" hint="例：10 / 8 / 0。税務上の区分は各自でご確認ください">
          <input inputMode="decimal" value={f.taxRate} onChange={(e) => setF({ ...f, taxRate: e.target.value })} />
        </Field>
        <Field label="説明" className="span-2">
          <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={1000} />
        </Field>
      </div>
      <button className="btn primary">保存</button>
      <p className="small muted" style={{ margin: 0 }}>
        品目を変更しても、確定済みの見積書・請求書には影響しません。案件ごとの見積で単価等を変更できます。
      </p>
    </form>
  );
}

export default function ItemsPage() {
  const [archived, setArchived] = useState(false);
  const { data, error, loading, reload } = useApi<{ items: any[] }>(`/api/items?archived=${archived ? '1' : '0'}`);
  const [editing, setEditing] = useState<any | null>(null);
  const mobile = useIsMobile();
  const rows = data?.items ?? [];
  return (
    <div>
      <div className="page-header">
        <h1>品目</h1>
        <button className="btn primary" onClick={() => setEditing({})}>
          ＋ 品目を登録
        </button>
      </div>
      <div className="chips">
        <button className={`chip ${!archived ? 'active' : ''}`} onClick={() => setArchived(false)}>
          有効
        </button>
        <button className={`chip ${archived ? 'active' : ''}`} onClick={() => setArchived(true)}>
          アーカイブ
        </button>
      </div>
      <ErrorBanner message={error} />
      {loading && !data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>品目がありません。よく使う作業や商品を登録すると、見積の明細入力が速くなります。</Empty>
      ) : (
        <div className={mobile ? 'list' : 'card table-wrap'} style={mobile ? undefined : { padding: 0 }}>
          {mobile ? (
            rows.map((it) => (
              <button key={it.id} className="list-item" style={{ textAlign: 'left', font: 'inherit' }} onClick={() => setEditing(it)}>
                <div className="row between">
                  <span className="title">{it.name}</span>
                  <Money v={Number(it.unitPrice)} />
                </div>
                <div className="meta">
                  {it.code && <span>{it.code}</span>}
                  <span>/{it.unit}</span>
                  <span>税率{it.taxRate}%</span>
                </div>
              </button>
            ))
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>コード</th>
                  <th>品名</th>
                  <th>説明</th>
                  <th className="right">標準単価</th>
                  <th>単位</th>
                  <th>税率</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((it) => (
                  <tr key={it.id}>
                    <td>{it.code}</td>
                    <td>{it.name}</td>
                    <td className="small muted">{it.description}</td>
                    <td className="right">
                      <Money v={Number(it.unitPrice)} />
                    </td>
                    <td>{it.unit}</td>
                    <td>{it.taxRate}%</td>
                    <td className="nowrap">
                      <button className="btn sm" onClick={() => setEditing(it)}>
                        編集
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {editing && (
        <Modal title={editing.id ? '品目を編集' : '品目を登録'} onClose={() => setEditing(null)}>
          <ItemForm
            id={editing.id}
            initial={editing.id ? { code: editing.code, name: editing.name, description: editing.description, unitPrice: Number(editing.unitPrice), unit: editing.unit, taxRate: editing.taxRate } : empty}
            onSaved={async () => {
              setEditing(null);
              await reload();
            }}
          />
          {editing.id && (
            <div className="btn-row" style={{ marginTop: 12 }}>
              <AsyncButton
                className="btn"
                onClick={async () => {
                  await post(`/api/items/${editing.id}/${editing.archivedAt ? 'unarchive' : 'archive'}`);
                  setEditing(null);
                  await reload();
                }}
              >
                {editing.archivedAt ? 'アーカイブを解除' : 'アーカイブ'}
              </AsyncButton>
              <AsyncButton
                className="btn danger"
                confirm="この品目を削除しますか？（書類で使用済みの場合は削除できません）"
                onClick={async () => {
                  await del(`/api/items/${editing.id}`);
                  setEditing(null);
                  await reload();
                }}
              >
                削除
              </AsyncButton>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
