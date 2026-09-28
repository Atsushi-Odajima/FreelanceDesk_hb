// サーバーを1ファイルにバンドルし、マイグレーションSQLとフォントを同梱します。
import { build } from 'esbuild';
import fs from 'node:fs';

await build({
  entryPoints: ['server/src/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: false,
  legalComments: 'none',
});
const tools = ['create-signup-codes', 'reset-link'];
for (const t of tools) {
  await build({
    entryPoints: [`server/src/tools/${t}.ts`],
    outfile: `dist/server/tools/${t}.js`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    packages: 'external',
  });
}
fs.cpSync('server/src/migrations', 'dist/server/migrations', { recursive: true });
fs.cpSync('server/assets/fonts', 'dist/server/assets/fonts', { recursive: true });
console.log('server built → dist/server');
