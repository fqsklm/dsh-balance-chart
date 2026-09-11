/**
 * 用**真实 app 的全局 CSS** 再渲染一遍预览页。
 *
 * preview/*.html 是用仿真表头生成的，只带了 --dsw-* 变量的一个子集；
 * 真实 GUI 里全局 CSS（index-*.css / vendor-*.css）会作用到插件自己的
 * .dbc-* 元素（table / input / scrollbar / * 之类的规则），预览页缺了这一层，
 * 于是「预览正常、真机有横条」这类差异量不出来。
 *
 *   node test/appcss-preview.mjs
 *
 * 产出 preview/appcss-*.html，可以直接丢给 overflow-probe.mjs / Chrome 截图。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');
const previewDir = join(rootDir, 'preview');
const assetsDir = 'C:/Users/1kg/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets';

const sources = ['index-b24khbeK.css', 'vendor-BNsW4eBh.css'];
let appCss = '';
for (const name of sources) {
  const file = join(assetsDir, name);
  if (!existsSync(file)) { console.log('缺少 ' + file); continue; }
  appCss += `/* ==== ${name} ==== */\n` + readFileSync(file, 'utf8') + '\n';
}
console.log(`注入 app CSS ${appCss.length} 字节`);

const targets = [
  ['card-light-settings.html', 'appcss-settings.html'],
  ['fullscreen-scroll.html', 'appcss-fullscreen-scroll.html'],
  ['fullscreen-light.html', 'appcss-fullscreen-light.html'],
  ['card-light-scroll.html', 'appcss-card-scroll.html'],
];

for (const [from, to] of targets) {
  const src = join(previewDir, from);
  if (!existsSync(src)) { console.log('SKIP ' + from); continue; }
  const html = readFileSync(src, 'utf8');
  // 放在插件自己的 <style> **之前**：这样插件样式仍然按后写的顺序覆盖 app 样式，
  // 量到的就是真机里的层叠结果。
  const injected = html.replace('<style', `<style data-src="app-global">${appCss}</style>\n<style`);
  writeFileSync(join(previewDir, to), injected, 'utf8');
  console.log('写出 preview/' + to);
}
