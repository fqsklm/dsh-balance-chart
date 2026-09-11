/**
 * 滚动条诊断：找出「不该出现的横向长条（滚动条）」是哪个元素。
 *
 * 已有的 render-preview.mjs --probe 是带 `--hide-scrollbars` 跑的，
 * 所以它量不到滚动条本身带来的高度 / 宽度损失；本脚本**故意不隐藏滚动条**，
 * 按真实浏览器（Windows 经典滚动条，约 15px）量：
 *   node test/overflow-probe.mjs [变体名 ...]
 *
 * 输出每个「有横向/纵向滚动条」的元素，以及每个横向溢出祖先的元素（rect.right）。
 */

import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');
const previewDir = join(rootDir, 'preview');

const PROBE = `<pre id="dbc-overflow" style="display:none"></pre>
<script>
(function(){
  var out={variant:null, vw:innerWidth, vh:innerHeight};
  var de=document.documentElement;
  out.doc={
    scrollW:de.scrollWidth, clientW:de.clientWidth,
    scrollH:de.scrollHeight, clientH:de.clientHeight,
    hbar:de.offsetWidth-(de.clientWidth+de.clientLeft*2),
    vbar:de.offsetHeight-(de.clientHeight+de.clientTop*2)
  };
  function cls(el){ return (el.className&&typeof el.className==='string')?el.className:(el.getAttribute('class')||''); }
  function desc(el){ return el.tagName.toLowerCase()+(cls(el)?('.'+cls(el).trim().replace(/\\s+/g,'.')):''); }
  function px(v){ return +Number(v).toFixed(2); }
  out.scrollers=[]; out.overflowing=[];
  var all=document.querySelectorAll('*');
  for(var i=0;i<all.length;i++){
    var el=all[i];
    var cs=getComputedStyle(el);
    var bl=parseFloat(cs.borderLeftWidth)||0, br=parseFloat(cs.borderRightWidth)||0;
    var bt=parseFloat(cs.borderTopWidth)||0, bb=parseFloat(cs.borderBottomWidth)||0;
    // offsetWidth-clientWidth = 左右边框 + 纵向滚动条；offsetHeight-clientHeight = 上下边框 + 横向滚动条。
    var vbar=el.offsetWidth-el.clientWidth-bl-br;
    var hbar=el.offsetHeight-el.clientHeight-bt-bb;
    var overX=el.scrollWidth-el.clientWidth;
    var overY=el.scrollHeight-el.clientHeight;
    var b=el.getBoundingClientRect();
    var styleFix=cs.position==='absolute'||cs.position==='fixed'||cs.position==='sticky';
    if(vbar>0||hbar>0||overX>1||overY>1){
      out.scrollers.push({
        el:desc(el), pos:cs.position, ov:cs.overflowX+'/'+cs.overflowY,
        vbar:px(vbar), hbar:px(hbar), overX:px(overX), overY:px(overY),
        w:px(b.width), h:px(b.height), sw:el.scrollWidth, cw:el.clientWidth,
        sh:el.scrollHeight, ch:el.clientHeight,
        rectRight:px(b.right), rectBottom:px(b.bottom),
        outOfViewportX:b.right>innerWidth+0.5, outOfViewportY:b.bottom>innerHeight+0.5
      });
    }
    // 真正越出视口右边、且没有被滚动容器接住的元素（横向长条常见来源）。
    if(b.right>innerWidth+0.5&&b.width>0&&b.height>0&&!styleFix){
      out.overflowing.push({el:desc(el), ov:cs.overflowX+'/'+cs.overflowY, x:px(b.x), w:px(b.width), right:px(b.right), h:px(b.height)});
    }
  }
  var rep=document.getElementById('dbc-overflow');
  rep.textContent=JSON.stringify(out);
})();
</script>`;

function findBrowser() {
  return [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find((p) => { try { readFileSync(p); return true; } catch { return false; } });
}

// 参数可以写成 `变体名@宽x高` 覆盖窗口尺寸（例如 fullscreen-scroll@1000x700），
// 用来量窄窗口下会不会多出横向滚动条。
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const variants = (wanted.length > 0
  ? wanted
  : ['card-light-settings', 'fullscreen-light', 'fullscreen-scroll', 'card-light-scroll', 'card-light-1440'])
  .map((spec) => {
    const at = spec.lastIndexOf('@');
    if (at < 0) return { name: spec, size: null };
    const m = /^(\d+)x(\d+)$/.exec(spec.slice(at + 1));
    return { name: spec.slice(0, at), size: m === null ? null : [Number(m[1]), Number(m[2])] };
  });

const browser = findBrowser();
if (browser === undefined) { console.log('没找到 Chrome/Edge'); process.exit(1); }
console.log('browser: ' + browser);

const sizes = {
  'card-light-settings': [1440, 820],
  'fullscreen-light': [1440, 900],
  'fullscreen-scroll': [1440, 900],
  'fullscreen-hover': [1440, 900],
  'appcss-settings': [1440, 820],
  'appcss-fullscreen-scroll': [1440, 900],
  'appcss-fullscreen-light': [1440, 900],
  'appcss-card-scroll': [1440, 420],
};
const defaults = [1440, 420];

for (const spec of variants) {
  const name = spec.name;
  const src = join(previewDir, name + '.html');
  let html;
  try { html = readFileSync(src, 'utf8'); } catch { console.log('SKIP ' + name + '（没有预览页）'); continue; }
  const tmp = join(previewDir, name + '.probe.html');
  writeFileSync(tmp, html.replace('</body>', PROBE + '</body>'), 'utf8');
  const [w, h] = spec.size || sizes[name] || defaults;
  const domPath = join(previewDir, name + '.probe.dom.html');
  const fd = openSync(domPath, 'w');
  try {
    spawnSync(browser, [
      '--headless=new', '--disable-gpu', '--force-device-scale-factor=1',
      '--no-sandbox', '--disable-crash-reporter', '--disable-breakpad',
      '--no-first-run', '--no-default-browser-check',
      '--disable-features=Crashpad,Translate,OptimizationHints',
      `--user-data-dir=${join(previewDir, '.browser-profile')}`,
      `--window-size=${w},${h}`,
      '--dump-dom', 'file:///' + tmp.replace(/\\/g, '/'),
    ], { stdio: ['ignore', fd, 'ignore'], timeout: 60000 });
  } finally { closeSync(fd); }
  const dom = readFileSync(domPath, 'utf8');
  rmSync(domPath, { force: true });
  rmSync(tmp, { force: true });
  const m = /<pre id="dbc-overflow"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
  if (m === null) { console.log('FAIL ' + name + ': 没有产出报告'); continue; }
  const rep = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  console.log('\n=== ' + name + '  window ' + w + 'x' + h + '  viewport ' + rep.vw + 'x' + rep.vh + ' ===');
  console.log(`document: scrollW=${rep.doc.scrollW} clientW=${rep.doc.clientW} scrollH=${rep.doc.scrollH} clientH=${rep.doc.clientH} pageHbar=${rep.doc.hbar} pageVbar=${rep.doc.vbar}`);
  for (const s of rep.scrollers) {
    console.log(`  -- ${s.el}\n     pos=${s.pos} overflow=${s.ov} hbar=${s.hbar} vbar=${s.vbar} overX=${s.overX} overY=${s.overY} box=${s.w}x${s.h} scroll=${s.sw}x${s.sh} client=${s.cw}x${s.ch}`);
  }
  for (const s of rep.overflowing) {
    console.log(`  >> 越出视口右边: ${s.el} overflow=${s.ov} x=${s.x} w=${s.w} right=${s.right} h=${s.h}`);
  }
}
