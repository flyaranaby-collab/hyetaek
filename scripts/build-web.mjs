// 웹앱 빌드: data/*.mjs 를 템플릿에 인라인해서 단일 HTML 생성
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const strip = src => src.replace(/^import .*$/gm, '').replace(/^export /gm, '');
const data = strip(readFileSync(join(root, 'data/catalog.mjs'), 'utf8')) + '\n' + strip(readFileSync(join(root, 'data/logic.mjs'), 'utf8'));
const html = readFileSync(join(root, 'web/template.html'), 'utf8').replace('/*__DATA__*/', () => data);
for (const out of ['dist/index.html', 'server/public/index.html']) {
  mkdirSync(dirname(join(root, out)), { recursive: true });
  writeFileSync(join(root, out), html);
}
console.log('built', html.length, 'bytes');
