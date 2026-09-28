// PWAアイコン（PNG）を生成します。Chromium で SVG を描画してスクリーンショット。
// 使い方: node scripts/make-icons.mjs   （PLAYWRIGHT_CHROMIUM に実行ファイルのパスを指定可）
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const svg = (pad) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${pad ? 0 : 96}" fill="#1f5fbf"/>
  <g transform="translate(256 256) scale(${pad ? 0.72 : 0.9}) translate(-256 -256)">
    <rect x="136" y="96" width="240" height="310" rx="22" fill="#ffffff"/>
    <rect x="172" y="150" width="168" height="18" rx="9" fill="#1f5fbf"/>
    <rect x="172" y="196" width="130" height="14" rx="7" fill="#9fb8e3"/>
    <rect x="172" y="232" width="150" height="14" rx="7" fill="#9fb8e3"/>
    <rect x="172" y="268" width="110" height="14" rx="7" fill="#9fb8e3"/>
    <circle cx="330" cy="352" r="62" fill="#22a06b"/>
    <path d="M300 352 l22 22 l40 -44" fill="none" stroke="#fff" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

const exe = process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined });
const page = await browser.newPage();
const out = 'client/public/icons';
fs.mkdirSync(out, { recursive: true });
for (const [name, size, pad] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(pad).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `${out}/${name}`, omitBackground: !pad, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', name);
}
await browser.close();
