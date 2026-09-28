// DB行（snake_case）→ API応答（camelCase）。トップレベルのキーのみ変換（JSON列の中身はそのまま）
export function camelRow<T = any>(row: Record<string, any> | null | undefined): T {
  if (!row) return row as T;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase())] = v;
  }
  return out as T;
}

export function camelRows<T = any>(rows: Record<string, any>[]): T[] {
  return rows.map((r) => camelRow<T>(r));
}

/** 内部専用の列を取り除く */
export function omit<T extends Record<string, any>>(obj: T, keys: string[]): Partial<T> {
  const o = { ...obj };
  for (const k of keys) delete o[k];
  return o;
}
