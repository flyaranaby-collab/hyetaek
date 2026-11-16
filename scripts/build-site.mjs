// GitHub Pages용 사이트 조립: 앱 화면 + 설치용 파일(PWA) → site/
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site');
mkdirSync(join(out, 'data'), { recursive: true });
copyFileSync(join(root, 'dist/index.html'), join(out, 'index.html'));
// PC 서버(server/public)에도 같은 설치 파일을 넣어 둠
for (const dir of [out, join(root, 'server/public')]) for (const f of readdirSync(join(root, 'web/pwa'))) {
  if (f === 'sw.js') writeFileSync(join(dir, f), readFileSync(join(root, 'web/pwa', f), 'utf8').replace('__BUILD__', Date.now().toString(36)));
  else copyFileSync(join(root, 'web/pwa', f), join(dir, f));
}
writeFileSync(join(out, '.nojekyll'), '');
console.log('site/ 준비 완료');
