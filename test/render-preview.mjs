/**
 * 渲染预览 + 布局量测。
 *
 * 把客户端 bundle 真正跑一遍、展开成 DOM、序列化成独立 HTML，然后交给真实浏览器：
 *   node test/render-preview.mjs            # 生成 preview/*.html 和截图
 *   node test/render-preview.mjs --probe    # 用 --dump-dom 回读真实布局几何并断言
 *
 * 每个变体都会**重新物化一次 bundle**（新的假 DOM / 新的假 React），
 * 因为快照是模块级状态，复用实例会让所有变体渲染出同一份数据。
 *
 * 生成的页面里带一份仿真的 DSH 会话标题栏（padding / flex / min-width 照抄
 * ConversationRoot.module.css 的真实取值），所以能判断卡片会不会把面包屑挤扁。
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');
const outDir = join(rootDir, 'preview');
const bundleSource = readFileSync(join(rootDir, 'lib', 'client.js'), 'utf8');

/* ------------------------------------------------------------ 页面内量测 */

/**
 * 把真实布局几何写进 <pre id="dbc-report">，用 `chrome --dump-dom` 回读。
 * 本机模型读不了图，所以量数字比看图靠得住，而且能进回归测试。
 */
const PROBE_SCRIPT = `<pre id="dbc-report" style="display:none"></pre>
<script>
(function(){
  var out={variant:"__VARIANT__"};
  function r(el){ if(!el) return null; var b=el.getBoundingClientRect(); return {x:+b.x.toFixed(2),y:+b.y.toFixed(2),w:+b.width.toFixed(2),h:+b.height.toFixed(2),right:+b.right.toFixed(2),bottom:+b.bottom.toFixed(2)}; }
  function q(s){ return document.querySelector(s); }
  try{
    out.viewport={w:innerWidth,h:innerHeight};
    out.docScrollWidth=document.documentElement.scrollWidth;
    out.bodyScrollsHorizontally=document.documentElement.scrollWidth>innerWidth+1;
    var card=q('.dbc-card');
    out.card=r(card);
    out.cardClass=card?card.className:null;
    out.slot=r(q('.dbc-slot'));
    if(card){
      var cs=getComputedStyle(card);
      out.cardStyle={bg:cs.backgroundColor,radius:cs.borderTopLeftRadius,borderW:cs.borderTopWidth,position:cs.position};
      out.cardOverflowsViewport=card.getBoundingClientRect().right>innerWidth+0.5;
      // 居中：卡片中心 vs 标题栏（.fx-header，position:relative）中心。
      out.cardCenterX=+(out.card.x+out.card.w/2).toFixed(2);
      var hdr=q('.fx-header')||q('.dbc-fs');
      var hb=hdr?hdr.getBoundingClientRect():null;
      out.headerCenterX=hb?+(hb.x+hb.width/2).toFixed(2):null;
      out.centerOffset=hb?+(out.cardCenterX-(hb.x+hb.width/2)).toFixed(2):null;
    }
    out.headerRow=r(q('.fx-titleRow'));
    out.titleCluster=r(q('.fx-titleCluster'));
    var crumbs=q('.fx-crumbs');
    out.crumbs=crumbs?Object.assign(r(crumbs),{overflowing:crumbs.scrollWidth>crumbs.clientWidth+1}):null;
    out.headerUtils=r(q('.fx-utils'));
    out.headerActions=r(q('.fx-actions'));
    out.headerTabs=r(q('.fx-tabs'));
    // 「对话 / 轨迹」这几个字的真实文字盒（不是按钮盒：按钮带 11px 下内边距，
    // 用按钮盒量会把卡片算低一大截）。卡片要和文字盒垂直对齐。
    var tabBtn=q('.fx-tab');
    out.tabText=null;
    if(tabBtn&&tabBtn.firstChild){
      var range=document.createRange();
      try{ range.selectNodeContents(tabBtn); out.tabText=r(range); }catch(e){ out.tabText=null; }
    }
    if(out.tabText&&out.card){
      out.tabTextCenterY=+(out.tabText.y+out.tabText.h/2).toFixed(2);
      out.cardCenterY=+(out.card.y+out.card.h/2).toFixed(2);
      out.tabAlignOffset=+(out.cardCenterY-out.tabTextCenterY).toFixed(2);
    }
    // 标签行容器的盒子在展开态会被插件的留高规则撑到整块高度，
    // 所以「有没有压住标签」要和标签按钮比，不是和容器比。
    out.tabsRight=null;
    var tabEls=document.querySelectorAll('.fx-tab');
    for(var ti=0;ti<tabEls.length;ti++){ var tr=tabEls[ti].getBoundingClientRect(); if(out.tabsRight===null||tr.right>out.tabsRight) out.tabsRight=+tr.right.toFixed(2); }
    // 居中后的卡片会不会压住标题栏左侧的内容（面包屑 / Session 日志按钮）。
    function hits(a,b){ return !!a&&!!b&&a.x<b.right-0.5&&b.x<a.right-0.5&&a.y<b.bottom-0.5&&b.y<a.bottom-0.5; }
    out.hitsCrumbs=hits(out.card,out.crumbs);
    out.hitsActions=hits(out.card,out.headerActions);
    out.hitsTabs=hits(out.card,out.headerTabs);

    var peakEl=q('.dbc-peak');
    out.peakStrip=peakEl?r(peakEl):null;
    out.peakStripText=peakEl?peakEl.textContent:null;
    if(peakEl){
      var pcs=getComputedStyle(peakEl);
      out.peakStripStyle={borderW:pcs.borderTopWidth,radius:pcs.borderTopLeftRadius,bgImage:pcs.backgroundImage,bgColor:pcs.backgroundColor};
    }
    out.peakTrack=r(q('.dbc-peak-track'));
    out.peakSpendStyle=null;
    var spendEl=q('.dbc-peak-spend');
    if(spendEl){
      var scs=getComputedStyle(spendEl);
      out.peakSpendStyle={color:scs.color,fontSize:scs.fontSize,fontWeight:scs.fontWeight,textAlign:scs.textAlign};
    }
    // 文字离轨道有多远（用户嫌太远：标签列右对齐 + 数值列左对齐，两边都只隔一个 gap）。
    if(out.peakTrack){
      out.peakTagGap=(q('.dbc-peak-tag')&&out.peakTrack)?+(out.peakTrack.x-q('.dbc-peak-tag').getBoundingClientRect().right).toFixed(2):null;
      out.peakValueGap=(spendEl&&out.peakTrack)?+(spendEl.getBoundingClientRect().x-out.peakTrack.right).toFixed(2):null;
    }
    out.peakTagStyle=null;
    var tagEl=q('.dbc-peak-tag');
    if(tagEl){
      var tcs=getComputedStyle(tagEl);
      out.peakTagStyle={text:tagEl.textContent,color:tcs.color,peak:tagEl.classList.contains('is-peak'),textAlign:tcs.textAlign};
      out.peakTagBox=r(tagEl);
    }
    var lastBtn=document.querySelectorAll('.dbc-btn');
    out.btnRight=lastBtn.length>0?+lastBtn[lastBtn.length-1].getBoundingClientRect().right.toFixed(2):null;
    var cursorEl=q('.dbc-peak-cursor');
    out.peakCursor=null;
    if(cursorEl){
      var ccs=getComputedStyle(cursorEl);
      out.peakCursor={w:+cursorEl.getBoundingClientRect().width.toFixed(2),color:ccs.backgroundColor};
    }
    var offCell=q('.dbc-peak-cell:not(.is-peak)'), peakCellEl=q('.dbc-peak-cell.is-peak');
    out.peakColors={
      off:offCell?getComputedStyle(offCell).backgroundColor:null,
      peak:peakCellEl?getComputedStyle(peakCellEl).backgroundColor:null,
    };
    var cells=document.querySelectorAll('.dbc-peak-cell');
    out.peakCells={count:cells.length,minW:null};
    for(var i=0;i<cells.length;i++){ var cw=cells[i].getBoundingClientRect().width; if(out.peakCells.minW===null||cw<out.peakCells.minW) out.peakCells.minW=+cw.toFixed(2); }

    var plot=q('.dbc-plot')||q('.dbc-fs-plot');
    var upper=q('.dbc-upper'), lower=q('.dbc-lower');
    out.plot=r(plot); out.upper=r(upper); out.lower=r(lower);
    if(upper&&lower){
      var svgU=upper.querySelector('svg');
      out.upperSvg=r(svgU); out.lowerSvg=null;
      // 关键不变量：上层容器要给横向滚动条留位，clientHeight 不能小于 SVG 高度，
      // 否则柱子底部会被裁掉。
      out.upperClientHeight=upper.clientHeight;
      out.upperClipped=svgU?upper.clientHeight < svgU.getBoundingClientRect().height-0.6:null;
      var barTrackEl=lower.querySelector('.dbc-bartrack');
      // 余额条现在是 HTML（和时段条同一套 flex 列），所以「没被裁掉」= 11px 的轨道装得下。
      out.lowerClipped=barTrackEl?lower.clientHeight < barTrackEl.getBoundingClientRect().height-0.6:null;
      out.scrollNeeded=upper.scrollWidth>upper.clientWidth+1;
      out.upperScrollWidth=upper.scrollWidth; out.upperClientWidth=upper.clientWidth;
      out.upperSvgAttrW=svgU?+svgU.getAttribute('width'):null;
      // 上层容器比里面的 SVG 高出多少 == 为横向滚动条让出的空间（不滚动时应为 0）。
      out.upperReserve=svgU?+(upper.getBoundingClientRect().height-svgU.getBoundingClientRect().height).toFixed(2):null;
      // 横向滚动条的**真实**高度（.dbc-upper 没有边框，offsetHeight-clientHeight 就是它）。
      // 断言拿它和 upperReserve 对比：预留必须正好等于真机滚动条高度，否则柱子会被裁、
      // 或者白占高度（0.65 的比例承诺跟着破）。
      out.upperBarH=+(upper.offsetHeight-upper.clientHeight).toFixed(2);
      // 真正装上下两层的那一层（卡片 = .dbc-plot，全屏 = 内层 .dbc-fs-plot）：
      // 它要么真的装得下两层，要么必须自己裁剪——不然多出来的部分会横在下面的图例和
      // 明细表头上（「一条不滚动的长条挡住视线」就是这么来的）。
      var rowsBox=upper.parentElement;
      if(rowsBox){
        var rowsStyle=getComputedStyle(rowsBox), rowsRect=rowsBox.getBoundingClientRect();
        out.rowsOverflowY=rowsStyle.overflowY;
        out.rowsBottom=+rowsRect.bottom.toFixed(2);
        out.rowsFit=+(lower.getBoundingClientRect().bottom.toFixed(2));
        out.rowsFit=out.rowsFit<=out.rowsBottom+0.5;
      }
      if(svgU){
        // 两层比例按「上层 SVG 高 / (上层 SVG 高 + 下层容器高)」算：
        // 余额条不再是 SVG，所以下层的层高直接取容器，滚动条让位不会污染这个比值。
        var uh=svgU.getBoundingClientRect().height, lh=lower.getBoundingClientRect().height;
        out.ratio=+(uh/(uh+lh)).toFixed(4);
      }
      var bad=[], texts=document.querySelectorAll('.dbc-upper text, .dbc-lower text');
      for(var t=0;t<texts.length;t++){
        var el=texts[t], bb=null;
        try{ bb=el.getBBox(); }catch(e){ continue; }
        var svg=el.ownerSVGElement; if(!svg) continue;
        var vb=svg.viewBox.baseVal;
        if(bb.x < vb.x-0.5 || (bb.x+bb.width) > (vb.x+vb.width)+0.5) bad.push({text:el.textContent,x:+bb.x.toFixed(1),w:+bb.width.toFixed(1),vbW:vb.width});
      }
      out.clippedTexts=bad;
      var rects=svgU?svgU.querySelectorAll('rect'):[], bars=[];
      var BAR_FILLS=['#4d6bfe','#ff7a2a','#94a3b8'];
      for(var k=0;k<rects.length;k++){
        var rr=rects[k], hh=rr.getAttribute('height');
        // 只认柱子：按系列色过滤，免得把悬停的列底 / 提示面板也数成柱子。
        if(BAR_FILLS.indexOf(rr.getAttribute('fill'))<0) continue;
        if(rr.getAttribute('rx')!==null && hh!==null && parseFloat(hh)>0.5) bars.push({y:+parseFloat(rr.getAttribute('y')).toFixed(2),h:+parseFloat(hh).toFixed(2),w:+parseFloat(rr.getAttribute('width')).toFixed(2)});
      }
      out.bars={count:bars.length,minY:bars.length?Math.min.apply(null,bars.map(function(b){return b.y;})):null,minW:bars.length?Math.min.apply(null,bars.map(function(b){return b.w;})):null};
      var poly=svgU?svgU.querySelector('polyline'):null;
      if(poly){
        var pts=poly.getAttribute('points').trim().split(/\\s+/);
        var ly=parseFloat(pts[pts.length-1]);
        out.polyPoints=pts.length/2;
        out.polyLastY=isFinite(ly)?+ly.toFixed(2):null;
      }
      // 余额条：现在是 HTML（和时段条同一套 flex 列），所以量 div 的盒子和计算样式。
      if(barTrackEl){
        var fillEl=barTrackEl.querySelector('.dbc-barfill');
        var trackBox=barTrackEl.getBoundingClientRect(), fillBox=fillEl?fillEl.getBoundingClientRect():null;
        out.balance={trackW:+trackBox.width.toFixed(2),fillW:fillBox?+fillBox.width.toFixed(2):null,
          fillRatio:fillBox?+(fillBox.width/trackBox.width).toFixed(4):(trackBox.width>0?1:null)};
        // 余额条轨道在页面里的真实位置（要和上面时段条的轨道比对）。
        out.balanceTrack=r(barTrackEl);
        var tcs2=getComputedStyle(barTrackEl), fcs2=fillEl?getComputedStyle(fillEl):null;
        out.balanceGeometry={
          trackH:+parseFloat(tcs2.height).toFixed(2),
          trackR:+parseFloat(tcs2.borderTopLeftRadius).toFixed(2),
          fillH:fillBox?+fillBox.height.toFixed(2):null,
          fillR:fcs2?+parseFloat(fcs2.borderTopLeftRadius).toFixed(2):null,
          fillColor:null,
          fillComputed:fcs2?fcs2.backgroundColor:null,
        };
        var valueText=q('.dbc-balrow .dbc-peak-spend');
        out.balanceValueStyle=valueText?{fill:getComputedStyle(valueText).color,fontSize:getComputedStyle(valueText).fontSize,fontWeight:getComputedStyle(valueText).fontWeight,textAlign:getComputedStyle(valueText).textAlign}:null;
        var labelEl=q('.dbc-balrow-label');
        out.balanceLabel=labelEl?Object.assign(r(labelEl),{textAlign:getComputedStyle(labelEl).textAlign,text:labelEl.textContent}):null;
        if(labelEl&&out.balanceTrack){
          out.balanceLabelGap=+(out.balanceTrack.x-labelEl.getBoundingClientRect().right).toFixed(2);
        }
        if(valueText&&out.balanceTrack){
          out.balanceValueRight=+valueText.getBoundingClientRect().right.toFixed(2);
        }
        // 数值文字的真实墨迹盒（Range）：看它离轨道到底多远，而不是看那个固定宽的外框。
        var spendEl2=q('.dbc-balrow .dbc-peak-spend')||q('.dbc-peak-spend');
        var inkRange=document.createRange();
        function inkOf(el){ if(!el||!el.firstChild) return null; try{ inkRange.selectNodeContents(el); return inkRange.getBoundingClientRect(); }catch(e){ return null; } }
        var spendInk=inkOf(spendEl), balanceInk=inkOf(spendEl2);
        if(spendInk&&balanceInk&&out.peakTrack&&out.balanceTrack){
          out.valueInkGaps={
            spend:+(spendInk.x-out.peakTrack.right).toFixed(2),
            balance:+(balanceInk.x-out.balanceTrack.right).toFixed(2),
          };
          out.valueInkLefts={spend:+spendInk.x.toFixed(2),balance:+balanceInk.x.toFixed(2)};
        }
        // 按钮离数值文字多远（“把几个设置按键都移近过来”）。
        var btns=document.querySelectorAll('.dbc-btn');
        if(btns.length>0&&spendInk){
          out.btnGapFromText=+(btns[0].getBoundingClientRect().x-spendInk.right).toFixed(2);
        }
      }
      // 悬停反馈：静态页里没有 React，所以悬停态由渲染期触发（见 instance.hover），
      // 这里只读回提示面板的文字和几何，验证它出现、有内容、且不被画布裁掉。
      if(svgU){
        var svgBox=svgU.getBoundingClientRect();
        var tip=svgU.querySelector('.dbc-tip');
        var tipBox=tip?tip.querySelector('rect').getBoundingClientRect():null;
        var tipTexts=[];
        if(tip){ var tipTextEls=tip.querySelectorAll('text'); for(var tt=0;tt<tipTextEls.length;tt++) tipTexts.push(tipTextEls[tt].textContent); }
        if(tip===null){ out.hoverTip=null; }
        else {
          out.hoverTip={rows:tipTexts,box:tipBox?{x:+(tipBox.x-svgBox.x).toFixed(2),y:+(tipBox.y-svgBox.y).toFixed(2),w:+tipBox.width.toFixed(2),h:+tipBox.height.toFixed(2)}:null};
          if(tipBox){
            out.hoverTip.insideCanvas=tipBox.x>=svgBox.x-0.5&&tipBox.right<=svgBox.right+0.5&&tipBox.y>=svgBox.y-0.5&&tipBox.bottom<=svgBox.bottom+0.5;
          }
          out.hoveredBars=svgU.querySelectorAll('rect[fill-opacity="0.55"]').length;
        }
      }
    }
    var pop=q('.dbc-pop');
    out.settings=r(pop);
    if(pop){ out.settingsFits=pop.getBoundingClientRect().bottom<=innerHeight+0.5&&pop.getBoundingClientRect().right<=innerWidth+0.5; out.settingsScrolls=pop.scrollHeight>pop.clientHeight+1; }
    // 滚动会话，看「吸顶的代码块表头」有没有盖在设置菜单上面。
    // 这是命中测试（elementFromPoint），不是看样式——谁在上面就是谁。
    // 注意：探针是一个大函数，var 是函数级作用域，所以新变量一律带 pop 前缀，
    // 免得和上面 function hits(...) 之类的名字撞车（撞了就是整段脚本 SyntaxError）。
    var popScroller=q('.fx-scroll');
    if(pop&&popScroller){
      var popKeepScroll=popScroller.scrollTop;
      popScroller.scrollTop=Math.min(300, Math.max(0, popScroller.scrollHeight-popScroller.clientHeight));
      var popBox=pop.getBoundingClientRect();
      var popBannerEl=q('.fx-codebanner');
      var popBand=null;
      if(popBannerEl){ var popBannerBox=popBannerEl.getBoundingClientRect(); popBand={top:+popBannerBox.top.toFixed(1),bottom:+popBannerBox.bottom.toFixed(1),z:getComputedStyle(popBannerEl).zIndex}; }
      var popPts=[];
      if(popBand) popPts.push([popBox.left+popBox.width/2, (popBand.top+popBand.bottom)/2]);
      popPts.push([popBox.left+popBox.width/2, popBox.top+popBox.height*0.5]);
      popPts.push([popBox.left+12, popBox.top+30]);
      var popHits=[];
      for(var popI=0;popI<popPts.length;popI++){
        var popEl=document.elementFromPoint(popPts[popI][0], popPts[popI][1]);
        popHits.push({x:+popPts[popI][0].toFixed(1),y:+popPts[popI][1].toFixed(1),
          hit:popEl?((popEl.className&&String(popEl.className))||popEl.tagName):null,
          inside:!!(popEl&&popEl.closest&&popEl.closest('.dbc-pop'))});
      }
      out.popupCover={scrolledBy:+popScroller.scrollTop.toFixed(1),banner:popBand,hits:popHits,
        allInside:popHits.length>0&&popHits.every(function(x){return x.inside===true;})};
      popScroller.scrollTop=popKeepScroll;
    }
    var fsp=q('.dbc-fs-panel');
    out.fullscreenPanel=r(fsp);
    if(fsp) out.fullscreenFits=fsp.getBoundingClientRect().width<=innerWidth+0.5&&fsp.getBoundingClientRect().height<=innerHeight+0.5;
    var det=q('.dbc-fs-detail');
    if(det){ out.detailRows=det.querySelectorAll('tbody tr').length; out.detailScrolls=det.scrollHeight>det.clientHeight+1; }
    // 明细表表头必须**跟着数据一起滚**：以前是 position:sticky，钉在滚动区顶部不动，
    // 实心底色还把滚上来的数据盖住（用户报的「一行不滚动、覆盖在数据上面」）。
    // 所以这里真的把明细区滚一段，量表头行和数据行各自的位移是否相等。
    var th=det?det.querySelector('thead th'):null, firstRow=det?det.querySelector('tbody tr'):null;
    if(det&&th&&firstRow){
      var cs=getComputedStyle(th);
      out.detailHead={position:cs.position,top:cs.top,bg:cs.backgroundColor,text:th.textContent};
      var keep=det.scrollTop;
      var beforeTh=th.getBoundingClientRect().top, beforeRow=firstRow.getBoundingClientRect().top;
      det.scrollTop=Math.min(120, Math.max(0, det.scrollHeight-det.clientHeight));
      var moved=det.scrollTop;
      out.detailHead.scrolledBy=+moved.toFixed(2);
      out.detailHead.thMoved=+((beforeTh-th.getBoundingClientRect().top)).toFixed(2);
      out.detailHead.rowMoved=+((beforeRow-firstRow.getBoundingClientRect().top)).toFixed(2);
      det.scrollTop=keep;
    }
    out.ok=true;
  }catch(e){ out.ok=false; out.error=String(e&&e.message||e); }
  document.getElementById('dbc-report').textContent=JSON.stringify(out);
})();
</script>`;

/* ------------------------------------------------------------------ 数据 */

function makeSnapshot(options) {
  const cycle = [0.0312, 0.0088, 0.125, 0.0042, 0.0611, 0.0193];
  const barTotal = options.bars ?? 12;
  const points = [];
  let cumulative = 0;
  for (let i = 0; i < barTotal; i += 1) {
    const cost = cycle[i % cycle.length];
    cumulative = Math.round((cumulative + cost) * 10000) / 10000;
    points.push({
      id: 'p' + i,
      ts: Date.now() - (barTotal - i) * 3 * 60000,
      cost,
      cum: cumulative,
      estimate: Math.round(cost * 1.4 * 10000) / 10000,
      delta: cost,
      peak: i % 3 === 0,
      synthetic: options.syntheticAt === i,
      turn: i + 1,
      model: 'deepseek-v4-flash',
      tokens: { uncachedInput: 11458 + i * 733, output: 31487 + i * 211, cacheRead: 7647744, cacheWrite: 0, reasoning: 18221 },
    });
  }
  return {
    ok: true,
    now: Date.now(),
    day: '2026-09-11',
    balance: { ok: true, currency: 'CNY', total: options.total, granted: 0, toppedUp: 67.01, available: true, at: Date.now(), error: null },
    config: {
      maxBalance: options.maxBalance ?? 50, chartRatio: options.chartRatio ?? 0.62, pollMs: 15000, currency: 'CNY', accounting: 'delta',
      collapse: options.collapse === true,
      peakWindows: [[9, 12], [14, 18]], peakWeekdaysOnly: true,
      rates: { peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 }, offpeak: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 } },
      usageUrl: 'https://platform.deepseek.com/usage',
    },
    today: { spent: cumulative, pending: options.pending ?? 0.42, trimmed: options.trimmed ?? 0, count: points.length, points, lastTurnCost: points.length > 0 ? points[points.length - 1].cost : null, topUp: 0 },
    peak: { isPeak: true, windows: [[9, 12], [14, 18]], weekdaysOnly: true },
    status: { lastSampleAt: Date.now(), keyMissing: false, openTurn: 1 },
  };
}

/* ------------------------------------------------ 每个变体一个全新实例 */

/**
 * 重新物化一次客户端 bundle：新的假 DOM、假 React、假 fetch，并跑完首次数据拉取。
 * 返回渲染函数，产出的是「有数据」的 DOM 树，而不是加载态。
 * @param snapshot - 该实例要拿到的 `/dsh-balance/state` 响应。
 * @param box - 模拟 ResizeObserver 量到的尺寸（真实运行时由布局决定）。
 * @returns 渲染卡片 / 全屏视图的函数。
 */
async function createInstance(snapshot, box) {
  const pendingEffects = [];

  const head = { children: [], appendChild(c) { this.children.push(c); } };
  const makeElement = (tag) => ({
    tagName: String(tag).toUpperCase(), dataset: {}, children: [], attributes: {}, textContent: '',
    style: { setProperty() {}, removeProperty() {} },
    setAttribute(n, v) { this.attributes[n] = String(v); },
    removeAttribute(n) { delete this.attributes[n]; },
    hasAttribute(n) { return Object.hasOwn(this.attributes, n); },
    appendChild(c) { this.children.push(c); return c; }, append() {}, remove() {},
    getBoundingClientRect: () => ({ width: box.width, height: box.height, top: 0, left: 0, right: box.width, bottom: box.height }),
  });

  globalThis.document = {
    head, body: makeElement('body'),
    createElement: makeElement, querySelector: () => null,
    addEventListener() {}, removeEventListener() {},
  };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    open() {}, innerWidth: box.viewportWidth ?? 1440, innerHeight: box.viewportHeight ?? 900,
    __ModuleLoader__: { load: (value) => { entry = value; } },
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, async text() { return JSON.stringify(snapshot); } });

  const React = (() => {
    // 极简 hook 运行时：每个组件函数一个持久的状态槽数组，渲染时索引归零。
    // 没有这个，useState 的 setter 就是空操作，useMeasure 量到的尺寸永远进不来。
    const hookStore = new Map();
    let active = null;
    function withHooks(component, fn) {
      let slot = hookStore.get(component);
      if (slot === undefined) { slot = { states: [] }; hookStore.set(component, slot); }
      const previous = active;
      active = slot;
      slot.index = 0;
      try { return fn(); } finally { active = previous; }
    }
    const nextIndex = () => active.index++;
    return {
      createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat(Infinity) }; },
      useState(initial) {
        const slot = active;
        const i = nextIndex();
        if (!(i in slot.states)) slot.states[i] = typeof initial === 'function' ? initial() : initial;
        return [slot.states[i], (value) => { slot.states[i] = typeof value === 'function' ? value(slot.states[i]) : value; }];
      },
      useEffect(effect) { pendingEffects.push(effect); return undefined; },
      // 真实 React 会把 DOM 节点写进 ref.current；给个假元素好让 useMeasure 读得到。
      useRef() {
        const slot = active;
        const i = nextIndex();
        if (!(i in slot.states)) slot.states[i] = { current: makeElement('div') };
        return slot.states[i];
      },
      withHooks,
    };
  })();

  let entry = null;
  vm.runInThisContext(bundleSource, { filename: 'lib/client.js' });
  const exportsValue = entry.factory((spec) => {
    if (spec === 'react') return React;
    throw new Error('unexpected require ' + spec);
  });

  const registrations = new Map();
  exportsValue.apply({
    slots: {
      inject(key, callback) { const d = callback(); return () => { if (typeof d === 'function') d(); }; },
      register(spec, component) { registrations.set(spec.id, component); return () => registrations.delete(spec.id); },
    },
  });

  const ChartCard = registrations.get('dsh-balance-chart');
  const FullscreenView = registrations.get('dsh-balance-chart-fullscreen');

  function expand(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(expand).filter((c) => c !== null);
    const type = node.type;
    const props = node.props ?? {};
    const own = Array.isArray(node.children) && node.children.length > 0 ? node.children : props.children !== undefined ? [props.children] : [];
    if (typeof type === 'function') return expand(React.withHooks(type, () => type({ ...props, children: own.length === 1 ? own[0] : own })));
    if (typeof type !== 'string') return null;
    return { type, props, children: own.map(expand).filter((c) => c !== null) };
  }

  function findFirst(node, predicate) {
    if (node === null || node === undefined || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const c of node) { const hit = findFirst(c, predicate); if (hit !== null) return hit; } return null; }
    if (predicate(node)) return node;
    for (const c of node.children ?? []) { const hit = findFirst(c, predicate); if (hit !== null) return hit; }
    return null;
  }

  /** 从组件函数渲染（必须走 expand，hook 作用域才建立得起来）。 */
  const renderComponent = (fn) => expand({ type: fn, props: {}, children: [] });

  async function settle() {
    for (const effect of pendingEffects.splice(0, pendingEffects.length)) effect();
    await new Promise((resolve) => setTimeout(resolve, 90));
  }

  // 三轮渲染：1) 建立 hook 槽并触发 pull() 2) 让 useMeasure 的量测落地
  // 3) 数据与尺寸都到位，才是「有数据」的最终样子。
  for (let pass = 0; pass < 3; pass += 1) {
    renderComponent(ChartCard);
    await settle();
  }

  return {
    card: () => renderComponent(ChartCard),
    withSettingsOpen() {
      const tree = renderComponent(ChartCard);
      const btn = findFirst(tree, (n) => n.props && n.props.title === '图表设置' && typeof n.props.onClick === 'function');
      if (btn !== null) btn.props.onClick();
      return renderComponent(ChartCard);
    },
    fullscreen() {
      const tree = renderComponent(ChartCard);
      const btn = findFirst(tree, (n) => n.props && n.props.title === '全屏查看' && typeof n.props.onClick === 'function');
      if (btn !== null) btn.props.onClick();
      return renderComponent(FullscreenView);
    },
    /** 悬停态快照：找到图表 svg，按「第 index 列的中心」造一个假 mousemove，再重新渲染。 */
    hover(index) {
      const tree = renderComponent(ChartCard);
      const svg = findFirst(tree, (n) => typeof n.props.onMouseMove === 'function');
      if (svg !== null) {
        const contentWidth = Number(svg.props.width);
        const step = Number(svg.props.height) > 200 ? 22 : 12; // 全屏用 22，卡片用 12
        svg.props.onMouseMove({
          clientX: 1 + step * index + step / 2,
          currentTarget: { getBoundingClientRect: () => ({ left: 0, width: contentWidth }) },
        });
      }
      return renderComponent(ChartCard);
    },
    fullscreenHover(index) {
      const tree = renderComponent(ChartCard);
      const btn = findFirst(tree, (n) => n.props && n.props.title === '全屏查看' && typeof n.props.onClick === 'function');
      if (btn !== null) btn.props.onClick();
      const fs = renderComponent(FullscreenView);
      const svg = findFirst(fs, (n) => typeof n.props.onMouseMove === 'function');
      if (svg !== null) {
        const contentWidth = Number(svg.props.width);
        svg.props.onMouseMove({
          clientX: 1 + 22 * index + 11,
          currentTarget: { getBoundingClientRect: () => ({ left: 0, width: contentWidth }) },
        });
      }
      return renderComponent(FullscreenView);
    },
    pluginCss: head.children[0]?.textContent ?? '',
  };
}

/* -------------------------------------------------------------- 序列化 */

const SVG_CAMEL_KEEP = new Set(['viewBox', 'preserveAspectRatio']);
const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'source']);
const DROP_PROPS = new Set(['key', 'onClick', 'onKeyDown', 'onChange', 'children', 'dangerouslySetInnerHTML', 'ref']);

const kebab = (name) => name.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
const escapeText = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (t) => escapeText(t).replace(/"/g, '&quot;');
const styleString = (style) => Object.entries(style)
  .filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => `${k.startsWith('--') ? k : kebab(k)}:${v}`)
  .join(';');

function serialize(node, out) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') { out.push(escapeText(node)); return; }
  if (Array.isArray(node)) { for (const c of node) serialize(c, out); return; }
  const { type, props, children } = node;
  const attrs = [];
  for (const [k, v] of Object.entries(props)) {
    if (DROP_PROPS.has(k) || v === undefined || v === null || v === false) continue;
    if (k === 'style') { if (v !== null && typeof v === 'object') { const s = styleString(v); if (s.length > 0) attrs.push(`style="${escapeAttr(s)}"`); } continue; }
    const name = k === 'className' ? 'class' : SVG_CAMEL_KEEP.has(k) ? k : kebab(k);
    if (v === true) { attrs.push(name); continue; }
    attrs.push(`${name}="${escapeAttr(v)}"`);
  }
  out.push(`<${type}${attrs.length > 0 ? ' ' + attrs.join(' ') : ''}>`);
  if (VOID_TAGS.has(type)) return;
  for (const c of children ?? []) serialize(c, out);
  out.push(`</${type}>`);
}

const toHtml = (node) => { const out = []; serialize(node, out); return out.join(''); };

/* ------------------------------------------------------------ 主题 token */

// 仅用于预览：DSH 真实 token 是运行时算出来的，这里给一组近似值，
// 目的是看布局而不是看配色。
const LIGHT_TOKENS = `:root{
  --dsw-alias-bg-base:#ffffff;
  --dsw-alias-label-primary:#0f1115;
  --dsw-alias-label-secondary:#5b6270;
  --dsw-alias-label-tertiary:#8b93a1;
  --dsw-alias-label-caption:#98a0ae;
  --dsw-alias-border-l1:rgba(15,17,21,.10);
  --dsw-alias-border-l2:rgba(15,17,21,.18);
  --dsw-alias-interactive-bg-hover:rgba(15,17,21,.06);
  --dsw-alias-scrollbar-bg-l2:rgba(15,17,21,.28);
  --dsw-font-family:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
}`;

const DARK_TOKENS = `body[data-ds-dark-theme]{
  --dsw-alias-bg-base:#1b1d22;
  --dsw-alias-label-primary:#f3f4f6;
  --dsw-alias-label-secondary:#b9bec7;
  --dsw-alias-label-tertiary:#8b93a1;
  --dsw-alias-label-caption:#7c828d;
  --dsw-alias-border-l1:rgba(255,255,255,.12);
  --dsw-alias-border-l2:rgba(255,255,255,.20);
  --dsw-alias-interactive-bg-hover:rgba(255,255,255,.08);
  --dsw-alias-scrollbar-bg-l2:rgba(255,255,255,.30);
}`;

/** 仿真表头：取值照抄 ConversationRoot.module.css。 */
const FIXTURE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--dsw-alias-bg-base);font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary)}
.fx-frame{height:100vh;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base)}
.fx-header{flex:none;position:relative;padding:12px 28px 0 20px;border-bottom:1px solid transparent}
.fx-header:after{content:"";position:absolute;bottom:1px;left:0;right:0;height:.5px;background:var(--dsw-alias-border-l2)}
.fx-titleRow{display:flex;align-items:center;gap:0;min-height:32px}
.fx-titleCluster{flex:1;min-width:0;display:flex;align-items:center;gap:10px}
.fx-crumbs{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;white-space:nowrap}
.fx-crumb{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:0 0;border:none;border-radius:12px;padding:4px 8px;font-size:14px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.fx-crumb.current{color:var(--dsw-alias-label-primary);font-weight:500}
.fx-actions{flex:none;display:flex;align-items:center;gap:8px}
.fx-logbtn{min-width:111px;height:32px;border:.5px solid var(--dsw-alias-border-l2);border-radius:18px;background:0 0;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer}
.fx-utils{flex:none;display:flex;align-items:center;gap:8px;margin-left:20px}
.fx-tabs{display:flex;gap:36px;margin-top:4px;padding-left:8px}
.fx-tab{border:none;background:0 0;padding:0 0 11px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-tertiary)}
.fx-tab.current{color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.fx-body{flex:1;min-height:0;display:flex;color:var(--dsw-alias-label-secondary);font-size:13px}
.fx-scroll{flex:1;min-height:0;overflow:auto;padding:14px 28px}
.fx-msg{padding:6px 0}
.fx-tall{height:1100px}
/* 仿真「代码模块」：表头 position:sticky;top:0;z-index:6 —— 取值照抄真实 GUI 的
   ._bannerWrap_5swpp_23（dsh-web-frontend 的 index-*.css），它正是滚动会话时
   把插件设置菜单盖住的那一条。卡片 / 设置菜单必须盖在它上面。 */
.fx-code{position:relative;margin:16px 0;border-radius:12px;background:var(--dsw-alias-markdown-code-block,#f4f5f7)}
.fx-codebanner{position:sticky;top:0;z-index:6;background-color:var(--dsw-alias-bg-base);border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center;padding:9px 14px;font:11px/18px var(--dsw-font-family);color:var(--dsw-alias-label-tertiary)}
.fx-codebody{margin:0;padding:12px 14px;min-height:520px;font:11px/18px ui-monospace,Consolas,monospace;white-space:pre-wrap;color:var(--dsw-alias-label-secondary)}
.fx-note{font:11px/1.6 var(--dsw-font-family);color:var(--dsw-alias-label-caption);padding:6px 20px 0}
`;

function page(bodyHtml, options, pluginCss) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${options.title}</title>
<style>${LIGHT_TOKENS}${DARK_TOKENS}${FIXTURE_CSS}</style>
<style>${pluginCss}</style>
</head>
<body${options.dark ? ' data-ds-dark-theme' : ''}>
${bodyHtml}
${PROBE_SCRIPT.replace('__VARIANT__', options.title)}
</body></html>`;
}

function headerFixture(cardHtml) {
  // 真实 GUI 里 header 是插槽入口 div[data-slot]（display:contents）的子节点，
  // 而且这个子节点是 <header> 元素（不是 div），第二个孩子才是「对话 / 轨迹」标签行，
  // 标题行右侧还挂着「标准模式」「后台任务」这些 header.actions 里的控件。
  // 这几条都照抄，插件里那些结构选择器才真的被验到。
  return `<div class="fx-frame">
  <div data-slot="conversation.session.header" style="display:contents">
  <header class="fx-header">
    <div class="fx-titleRow">
      <div class="fx-titleCluster">
        <nav class="fx-crumbs"><button class="fx-crumb">上一个会话</button><span>/</span><button class="fx-crumb current">在 DSH 里装一个余额图表插件</button></nav>
        <div class="fx-actions"><button class="fx-chip">标准模式</button><button class="fx-chip">后台任务</button></div>
      </div>
      <div class="fx-utils">${cardHtml}</div>
    </div>
    <div class="fx-tabs"><button class="fx-tab current">对话</button><button class="fx-tab">轨迹</button></div>
  </header>
  </div>
  <div class="fx-note">↑ 仿真的 DSH 会话标题栏（padding:12px 28px 0 20px / titleRow min-height:32px / titleCluster flex:1 / 第二行是标签行），用来判断卡片会不会压住标题、标准模式/后台任务、或者标签。下面是对话区。</div>
  <div class="fx-body">
    <div class="fx-scroll">
      <div class="fx-msg">对话消息区……下面这个「代码模块」是仿真的：它的表头和真实 GUI 一样是
        <code>position:sticky;top:0;z-index:6</code>，滚动会话时它会吸在对话区顶部——
        插件的卡片 / 设置菜单必须盖在它上面（以前卡片是 z-index:2，被它盖住）。</div>
      <div class="fx-code">
        <div class="fx-codebanner"><span>powershell</span><span class="fx-copy">复制</span></div>
        <pre class="fx-codebody">PS&gt; node test/render-preview.mjs --probe
布局检查通过
（下面这些行只是把代码块撑高：sticky 表头要一直吸在滚动口顶部，才能
和真实 GUI 一样压在设置菜单上——代码块太矮的话，滚过去以后表头会
跟着包含块自然解开，那就测不到「盖住菜单」这件事了）
1  2  3  4  5  6  7  8  9  10
11 12 13 14 15 16 17 18 19 20
21 22 23 24 25 26 27 28 29 30
31 32 33 34 35 36 37 38 39 40
41 42 43 44 45 46 47 48 49 50
51 52 53 54 55 56 57 58 59 60
61 62 63 64 65 66 67 68 69 70
71 72 73 74 75 76 77 78 79 80
81 82 83 84 85 86 87 88 89 90
91 92 93 94 95 96 97 98 99 100
101 102 103 104 105 106 107 108 109 110</pre>
      </div>
      <div class="fx-msg fx-tall">更长的占位内容（滚动用）……</div>
    </div>
  </div>
</div>`;
}

/* ------------------------------------------------------------------ 生成 */

mkdirSync(outDir, { recursive: true });

// measureBox 用**真实渲染出来的容器宽度**（卡片内容宽 640 / 472 / 364），
// 因为图表现在是「容器宽 - 左右两列缩进」，给的数不准会让「和轨道对齐」这条断言假失败。
const BOX_WIDE = { width: 640, height: 120, viewportWidth: 1440, viewportHeight: 420 };
const VARIANTS = [
  { name: 'card-light-1440', options: { total: 64.65, syntheticAt: 3 }, width: 1440, height: 420, box: BOX_WIDE, expectScroll: false, expectFill: 1 },
  { name: 'card-dark-1440', options: { total: 64.65, syntheticAt: 3, dark: true }, width: 1440, height: 420, box: BOX_WIDE, expectScroll: false, expectFill: 1 },
  // 900 / 700 两个窄窗口：卡片宽被 54vw 钳住（实测 471.95 / 363.95），box 取实测减 4。
  { name: 'card-light-900', options: { total: 64.65, syntheticAt: 3 }, width: 900, height: 420, box: { width: 472, height: 120, viewportWidth: 900, viewportHeight: 420 }, expectScroll: false, expectFill: 1 },
  { name: 'card-light-700', options: { total: 64.65, syntheticAt: 3 }, width: 700, height: 420, box: { width: 364, height: 120, viewportWidth: 700, viewportHeight: 420 }, expectScroll: false, expectFill: 1 },
  { name: 'card-light-few-bars', options: { total: 12.3, syntheticAt: -1, pending: 0, bars: 2 }, width: 1440, height: 420, box: BOX_WIDE, expectScroll: false, expectFill: 0.246 },
  { name: 'card-light-many-bars', options: { total: 30.5, syntheticAt: 7, bars: 40 }, width: 1440, height: 420, box: BOX_WIDE, expectScroll: false, expectFill: 0.61 },
  // 130 根 × 12px 远超容器宽度 -> 真的会出现横向滚动条，用来验证「让位 7px」那条修复。
  { name: 'card-light-scroll', options: { total: 88.4, syntheticAt: 11, bars: 130 }, width: 1440, height: 420, box: BOX_WIDE, expectScroll: true, expectFill: 1 },
  { name: 'card-light-compact', options: { total: 6.2, bars: 1, pending: 0 }, width: 1440, height: 420, box: { width: 640, height: 60, viewportWidth: 1440, viewportHeight: 420 }, expectScroll: false, expectFill: 0.124 },
  { name: 'card-light-collapsed', options: { total: 64.65, collapse: true, bars: 6 }, width: 1440, height: 200, box: BOX_WIDE },
  // 悬停态：静态页里没有 React，所以这一份是「渲染时就点着第 3 列」的快照，
  // 用来量提示面板的文字和几何（会不会被画布裁掉）。
  { name: 'card-light-hover', options: { total: 64.65, syntheticAt: 3 }, width: 1440, height: 420, box: BOX_WIDE, hover: 3 },
  { name: 'card-light-settings', options: { total: 64.65, syntheticAt: 3, openSettings: true }, width: 1440, height: 820, box: { ...BOX_WIDE, viewportHeight: 820 }, expectScroll: false, expectFill: 1 },
  // 设置项真的会改变几何：改比例、改 100% 基准之后重新量一遍。
  // 上层占比锁死 0.65：这两个变体故意在快照里塞别的值，验证渲染不跟着快照走。
  { name: 'card-ratio-80', options: { total: 12.3, syntheticAt: -1, bars: 8, chartRatio: 0.8, maxBalance: 20 }, width: 1440, height: 420, box: BOX_WIDE, expectScroll: false, expectRatio: 0.65, expectFill: 0.615 },
  { name: 'card-ratio-35', options: { total: 30.5, syntheticAt: -1, bars: 8, chartRatio: 0.35 }, width: 1440, height: 420, box: BOX_WIDE, expectScroll: false, expectRatio: 0.65, expectFill: 0.61 },
  { name: 'fullscreen-light', options: { total: 64.65, syntheticAt: 3, trimmed: 1.87, bars: 24, fullscreen: true }, width: 1440, height: 900, box: { width: 1350, height: 439, viewportWidth: 1440, viewportHeight: 900 }, expectScroll: false, expectFill: 1 },
  { name: 'fullscreen-hover', options: { total: 64.65, syntheticAt: 3, trimmed: 1.87, bars: 24, fullscreen: true }, width: 1440, height: 900, box: { width: 1350, height: 439, viewportWidth: 1440, viewportHeight: 900 }, fullscreenHover: 5 },
  // 全屏 step=22，120 根也会溢出 -> 验证全屏下的让位逻辑。
  { name: 'fullscreen-scroll', options: { total: 88.4, syntheticAt: 5, trimmed: 2.5, bars: 120, fullscreen: true }, width: 1440, height: 900, box: { width: 1350, height: 439, viewportWidth: 1440, viewportHeight: 900 }, expectScroll: true, expectFill: 1 },
];

const generated = [];
for (const variant of VARIANTS) {
  const instance = await createInstance(makeSnapshot(variant.options), variant.box);
  let body;
  if (variant.fullscreenHover !== undefined) {
    body = `<div class="fx-frame" style="position:relative">${toHtml(instance.fullscreenHover(variant.fullscreenHover))}</div>`;
  } else if (variant.options.fullscreen === true) {
    body = `<div class="fx-frame" style="position:relative">${toHtml(instance.fullscreen())}</div>`;
  } else if (variant.hover !== undefined) {
    body = headerFixture(toHtml(instance.hover(variant.hover)));
  } else if (variant.options.openSettings === true) {
    body = headerFixture(toHtml(instance.withSettingsOpen()));
  } else {
    body = headerFixture(toHtml(instance.card()));
  }
  const file = join(outDir, variant.name + '.html');
  writeFileSync(file, page(body, { title: variant.name, dark: variant.options.dark === true }, instance.pluginCss), 'utf8');
  generated.push({ ...variant, file });
}

console.log(`生成 ${generated.length} 个预览页面 -> ${outDir}`);
for (const v of generated) console.log(`  ${v.name}.html  (${v.width}x${v.height})`);

/* ----------------------------------------------------------- 浏览器驱动 */

function findBrowser() {
  return [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find((p) => { try { readFileSync(p); return true; } catch { return false; } });
}

function browserFlags(v) {
  // 故意**不加** `--hide-scrollbars`：隐藏滚动条会让滚动条高度量成 0，于是
  // 「容器给滚动条让位够不够」这类断言永远通过——上一版就是这么把「预留 7px、
  // 真机滚动条 10px、柱子底部被裁掉」藏过去的。量测必须在有滚动条的浏览器里跑。
  return [
    '--headless=new', '--disable-gpu', '--force-device-scale-factor=1',
    '--no-sandbox', '--disable-crash-reporter', '--disable-breakpad',
    '--no-first-run', '--no-default-browser-check',
    '--disable-features=Crashpad,Translate,OptimizationHints',
    `--user-data-dir=${join(outDir, '.browser-profile')}`,
    `--window-size=${v.width},${v.height}`,
  ];
}

/* --------------------------------------------------------------- 截图 */

if (process.argv.includes('--shots')) {
  const browser = findBrowser();
  if (browser === undefined) { console.log('没找到 Chrome/Edge'); process.exit(1); }
  const shotDir = join(outDir, 'shots');
  mkdirSync(shotDir, { recursive: true });
  for (const v of generated) {
    const out = join(shotDir, v.name + '.png');
    spawnSync(browser, [...browserFlags(v), `--screenshot=${out}`, 'file:///' + v.file.replace(/\\/g, '/')], { stdio: 'ignore', timeout: 60000 });
    const ok = (() => { try { return readFileSync(out).length > 0; } catch { return false; } })();
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${v.name}.png`);
  }
}

/* ----------------------------------------------------------- 布局量测 */

if (process.argv.includes('--probe')) {
  const browser = findBrowser();
  if (browser === undefined) { console.log('没找到 Chrome/Edge'); process.exit(1); }
  const reports = {};
  for (const v of generated) {
    // 不用管道接 Chrome 的 stdout（受限模式禁止命名管道）：直接把 fd 指到文件。
    const domPath = join(outDir, v.name + '.dom.html');
    const fd = openSync(domPath, 'w');
    try {
      spawnSync(browser, [...browserFlags(v), '--dump-dom', 'file:///' + v.file.replace(/\\/g, '/')], { stdio: ['ignore', fd, 'ignore'], timeout: 60000 });
    } finally { closeSync(fd); }
    const dom = readFileSync(domPath, 'utf8');
    rmSync(domPath, { force: true });
    const m = /<pre id="dbc-report"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
    if (m === null) { console.log(`FAIL ${v.name}: 页面没有产出量测报告`); continue; }
    reports[v.name] = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  }
  writeFileSync(join(outDir, 'layout-report.json'), JSON.stringify(reports, null, 2), 'utf8');

  const checks = [];
  const add = (label, ok, detail) => checks.push({ label, ok: !!ok, detail });
  const ratioTarget = 0.65;

  for (const [name, rep] of Object.entries(reports)) {
    const tag = name.padEnd(22);
    const expected = generated.find((v) => v.name === name)?.expectScroll;
    const spec = generated.find((v) => v.name === name);
    if (rep.ok !== true) { add(`${tag} 量测脚本正常`, false, rep.error); continue; }
    add(`${tag} 页面没有横向溢出`, rep.bodyScrollsHorizontally === false, `scrollWidth=${rep.docScrollWidth} vw=${rep.viewport.w}`);
    if (rep.card !== null) {
      add(`${tag} 卡片没有超出视口`, rep.cardOverflowsViewport === false, JSON.stringify(rep.card));
      if (rep.cardClass.includes('is-collapsed')) {
        add(`${tag} 折叠态 = 26px（一行字的高度）`, Math.abs(rep.card.h - 26) < 1, `h=${rep.card.h}`);
        add(`${tag} 卡片和「对话·轨迹」文字垂直对齐（偏移 < 1.5px）`, Math.abs(rep.tabAlignOffset ?? 999) < 1.5, `cardCenterY=${rep.cardCenterY} tabTextCenterY=${rep.tabTextCenterY} offset=${rep.tabAlignOffset}`);
      } else {
        add(`${tag} 卡片高度 = 152`, Math.abs(rep.card.h - 152) < 1, `h=${rep.card.h}`);
        add(`${tag} 展开态卡片顶边仍落在标签行里`, rep.card.y >= 40 && rep.card.y <= 50, `card.y=${rep.card.y}`);
      }
      // 展开态给标签行留高时，标签按钮不能被 flex 拉伸（拉伸会把文字推到行中间）。
      add(`${tag} 标签文字没被挤走（仍在标签行顶部）`, (rep.tabTextCenterY ?? 999) < 70, `tabTextCenterY=${rep.tabTextCenterY}`);
      // 这一轮改动的硬要求：无外框 / 水平居中 / 和「对话·轨迹」文字垂直对齐 / 不挤标题行。
      add(`${tag} 卡片没有外框（无边框·无底色·无圆角）`, rep.cardStyle.borderW === '0px' && rep.cardStyle.radius === '0px' && /rgba\(0, 0, 0, 0\)|transparent/.test(rep.cardStyle.bg), JSON.stringify(rep.cardStyle));
      add(`${tag} 卡片绝对定位（脱离右上角插槽）`, rep.cardStyle.position === 'absolute', String(rep.cardStyle.position));
      add(`${tag} 卡片在标题栏正中（偏移 < 1px）`, Math.abs(rep.centerOffset ?? 999) < 1, `cardCenter=${rep.cardCenterX} headerCenter=${rep.headerCenterX} offset=${rep.centerOffset}`);
      add(`${tag} 标题行没有被卡片撑开（仍然是 32px）`, Math.abs((rep.headerRow?.h ?? 0) - 32) < 1, `titleRow.h=${rep.headerRow?.h}`);
      add(`${tag} 卡片没压住标题行里的内容（标题/标准模式/后台任务）`, rep.hitsCrumbs !== true && rep.hitsActions !== true, JSON.stringify({ card: rep.card, actions: rep.headerActions, crumbs: rep.crumbs }));
      add(`${tag} 卡片没压住「对话·轨迹」标签`, (rep.tabsRight ?? 999) <= rep.card.x + 0.5, `card.x=${rep.card.x} tabsRight=${rep.tabsRight}`);
      if (rep.crumbs) add(`${tag} 面包屑没被卡片挤没`, rep.crumbs.w > 60, `crumbs.w=${rep.crumbs.w} cluster.w=${rep.titleCluster?.w}`);
    }
    if (rep.upper !== null && rep.upper !== undefined && rep.lower !== null && rep.lower !== undefined) {
      // 只有不滚动时才要求 SVG 宽度贴合容器；滚动时它本来就该更宽。
      if (expected !== true) {
        add(`${tag} 图表宽 = 容器宽（没有缩在左边）`, Math.abs(rep.upperSvgAttrW - rep.upperClientWidth) < 40, `svgW=${rep.upperSvgAttrW} clientW=${rep.upperClientWidth}`);
      }
      add(`${tag} 上层没被裁掉底部`, rep.upperClipped === false, `clientH=${rep.upperClientHeight} svgH=${rep.upperSvg?.h}`);
      add(`${tag} 下层余额条没被裁掉`, rep.lowerClipped === false, JSON.stringify(rep.lowerSvg));
      add(`${tag} 两层比例 = ${spec?.expectRatio ?? ratioTarget}`, Math.abs((rep.ratio ?? 0) - (spec?.expectRatio ?? ratioTarget)) < 0.02, `ratio=${rep.ratio} 期望=${spec?.expectRatio ?? ratioTarget}`);
      add(`${tag} 峰谷条 24 格且每格 ≥2px`, rep.peakCells?.count === 24 && rep.peakCells.minW >= 2, JSON.stringify(rep.peakCells));
      // 峰谷条不再有自己的胶囊外框 / 渐变底。
      add(`${tag} 峰谷条没有外框和渐变底`, rep.peakStripStyle !== undefined && rep.peakStripStyle.borderW === '0px' && rep.peakStripStyle.radius === '0px' && rep.peakStripStyle.bgImage === 'none' && /rgba\(0, 0, 0, 0\)|transparent/.test(rep.peakStripStyle.bgColor), JSON.stringify(rep.peakStripStyle));
      // 时间条左边那一个词就是当前时段，颜色跟着峰（橙）/ 谷（蓝）走；
      // 「峰谷」「高峰」这两个单独的字样已经删掉。
      if (rep.peakTagStyle !== null && rep.peakTagStyle !== undefined) {
        const tagText = rep.peakTagStyle.text;
        const expectText = rep.peakTagStyle.peak ? '高峰时段' : '峰谷时段';
        add(`${tag} 时段标签 = ${expectText}（不再是「峰谷」+「高峰」两个词）`, tagText === expectText, String(tagText));
        add(`${tag} 时段标签颜色跟着峰谷走（橙 #e2680d / 蓝 #2f4fd8）`, rep.peakTagStyle.peak ? rep.peakTagStyle.color === 'rgb(226, 104, 13)' : rep.peakTagStyle.color === 'rgb(47, 79, 216)', `${tag} ${tagText} color=${rep.peakTagStyle.color}`);
      }
      add(`${tag} 没有多余的「高峰」状态文字`, !(rep.peakStripText ?? '').includes('高峰') || (rep.peakStripText ?? '').includes('高峰时段'), String(rep.peakStripText));
      // 游标：细、灰，不是一根黑杠（深色主题下的「灰」是 #b9bec7，所以只判断「是不是灰」）。
      if (rep.peakCursor !== null && rep.peakCursor !== undefined) {
        const rgb = /rgb\((\d+), *(\d+), *(\d+)\)/.exec(rep.peakCursor.color ?? '');
        const [r, g, b] = rgb === null ? [0, 0, 0] : [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
        const grayish = Math.abs(r - g) <= 20 && Math.abs(g - b) <= 25 && Math.abs(r - b) <= 25;
        add(`${tag} 当前时刻游标 ≤2px 且是灰色文字色`, rep.peakCursor.w <= 2 && rep.peakCursor.w > 0 && grayish && r + g + b > 120, JSON.stringify(rep.peakCursor));
      }
      // 这一格写明「今日消耗 ¥x」。
      add(`${tag} 标题栏写明「今日消耗 ¥x」`, (rep.peakStripText ?? '').includes('今日消耗'), String(rep.peakStripText));
      add(`${tag} 柱子画在画布内且可见`, (rep.bars?.count ?? 0) >= 1 && (rep.bars.minY ?? -1) >= 0 && (rep.bars.minW ?? 0) >= 2, JSON.stringify(rep.bars));
      add(`${tag} 折线点数 = 柱子数 + 1`, rep.polyPoints === (rep.bars?.count ?? 0) + 1, `poly=${rep.polyPoints} bars=${rep.bars?.count}`);
      add(`${tag} 折线最右点落在画布内`, (rep.polyLastY ?? -1) >= 0 && rep.polyLastY <= (rep.upperSvg?.h ?? 0), `lastY=${rep.polyLastY} svgH=${rep.upperSvg?.h}`);
      add(`${tag} SVG 文字没有溢出画布`, (rep.clippedTexts ?? []).length === 0, JSON.stringify(rep.clippedTexts));
      if (expected !== undefined) {
        add(`${tag} 横向滚动状态符合预期（${expected ? '有' : '无'}滚动条）`, rep.scrollNeeded === expected, `scrollNeeded=${rep.scrollNeeded} scrollW=${rep.upperScrollWidth} clientW=${rep.upperClientWidth}`);
        // 这一条直接验证「给滚动条让位」的修复：让位的像素必须**正好等于真机滚动条高度**，
        // 不滚动时必须为 0（不能白占高度）。旧版写死 7px，而真机（scrollbar-width:thin
        // 会让 ::-webkit-scrollbar 失效）是 10px，差的 3px 正好把柱子底部裁掉。
        add(`${tag} 滚动条让位 = 实测滚动条高度（${expected ? '不裁柱子' : '0px'}）`,
          expected ? Math.abs((rep.upperReserve ?? -1) - (rep.upperBarH ?? -2)) < 0.6 : Math.abs(rep.upperReserve ?? 99) < 0.6,
          `reserve=${rep.upperReserve} barH=${rep.upperBarH}`);
      }
      // 两层要么装得下，要么被自己那一层裁掉——绝不允许画到图例 / 明细表上。
      if (rep.rowsFit !== undefined) {
        add(`${tag} 图表不会画到图例/明细表上（装得下或被裁掉）`, rep.rowsFit === true || rep.rowsOverflowY === 'hidden', `fit=${rep.rowsFit} overflowY=${rep.rowsOverflowY} rowsBottom=${rep.rowsBottom} lowerBottom=${rep.lower?.bottom}`);
      }
      // 余额条的填充比例直接反映「100% 基准」设置，验证它真的生效。
      if (spec?.expectFill !== undefined && rep.balance !== undefined) {
        add(`${tag} 余额条填充比例 = ${spec.expectFill}`, Math.abs((rep.balance.fillRatio ?? -1) - spec.expectFill) < 0.03, JSON.stringify(rep.balance));
      // 峰谷条和余额条必须是同一套几何（同高、同圆角、实色、不用渐变）。
      const bg = rep.balanceGeometry;
      if (bg !== undefined && bg !== null && bg.trackH !== null) {
        add(`${tag} 余额条与峰谷条同高（11px）`, bg.trackH === 11 && bg.fillH === 11, JSON.stringify(bg));
        add(`${tag} 余额条与峰谷条同圆角（4px）`, bg.trackR === 4 && bg.fillR === 4, JSON.stringify(bg));
        // 余额条的填充色必须就是峰谷条用的那两个色之一（同一个常量取色）。
        const norm = (c) => String(c ?? '').replace(/\s+/g, '');
        const fill = norm(bg.fillComputed);
        add(`${tag} 余额条颜色 = 峰谷条的颜色（蓝/橙同一支）`, (fill !== '' && (fill === norm(rep.peakColors?.off) || fill === norm(rep.peakColors?.peak))), `fill=${bg.fillComputed} off=${rep.peakColors?.off} peak=${rep.peakColors?.peak}`);
      }
      // 对齐三件事：两条轨道对齐；左列文字的左右边缘上下对齐；按钮和下面的金额共用右边缘。
      if (rep.balanceTrack !== null && rep.balanceTrack !== undefined && rep.peakTrack !== null && rep.peakTrack !== undefined) {
        const dx = Math.abs(rep.balanceTrack.x - rep.peakTrack.x);
        const dr = Math.abs(rep.balanceTrack.right - rep.peakTrack.right);
        const dw = Math.abs(rep.balanceTrack.w - rep.peakTrack.w);
        add(`${tag} 余额条与时段条左右对齐（两边差 < 1px）`, dx < 1 && dr < 1 && dw < 1, `bar.x=${rep.balanceTrack.x} track.x=${rep.peakTrack.x} bar.right=${rep.balanceTrack.right} track.right=${rep.peakTrack.right}`);
      }
      if (rep.balanceLabel !== null && rep.balanceLabel !== undefined && rep.peakTagStyle !== null && rep.peakTagStyle !== undefined) {
        const tagBox = rep.peakTagBox ?? {};
        const dl = Math.abs((rep.balanceLabel.x ?? 0) - (tagBox.x ?? 0));
        const dr2 = Math.abs((rep.balanceLabel.right ?? 0) - (tagBox.right ?? 0));
        add(`${tag} 左列文字左右边缘上下对齐（「高峰时段 / 账户余额」）`, dl < 1 && dr2 < 1, JSON.stringify({ label: { x: rep.balanceLabel.x, right: rep.balanceLabel.right }, tag: tagBox }));
      }
      if (rep.balanceValueRight !== null && rep.balanceValueRight !== undefined && rep.btnRight !== null && rep.btnRight !== undefined) {
        add(`${tag} 按钮与下面金额共用右边缘`, Math.abs(rep.balanceValueRight - rep.btnRight) < 1.5, `amount.right=${rep.balanceValueRight} btn.right=${rep.btnRight}`);
      }
      // 图表跟**文字边界**对齐：左边缘 = 左列文字左边，右边缘 = 右列（数值 / 按钮）右边。
      if (rep.upper !== null && rep.upper !== undefined && rep.peakTagBox !== null && rep.peakTagBox !== undefined) {
        const textLeft = rep.peakTagBox.x;
        const textRight = rep.btnRight ?? (rep.upper.right);
        const dx = Math.abs(rep.upper.x - textLeft);
        const dr = Math.abs(rep.upper.right - textRight);
        add(`${tag} 竖向柱状图与左右文字边界对齐`, dx < 1 && dr < 1, `chart=[${rep.upper.x},${rep.upper.right}] text=[${textLeft},${textRight}]`);
      }
      // 右边的数值要贴着轨道（用文字的真实墨迹盒量，不是外框盒），两行的文字左边缘要对齐。
      if (rep.valueInkGaps !== null && rep.valueInkGaps !== undefined) {
        const g = rep.valueInkGaps;
        add(`${tag} 右侧数值紧贴轨道（≤12px）`, typeof g.spend === 'number' && typeof g.balance === 'number' && g.spend >= 0 && g.spend <= 12 && g.balance >= 0 && g.balance <= 12, JSON.stringify(g));
      }
      if (rep.valueInkLefts !== null && rep.valueInkLefts !== undefined) {
        add(`${tag} 右侧两处数值左边缘对齐`, Math.abs(rep.valueInkLefts.spend - rep.valueInkLefts.balance) < 1.5, JSON.stringify(rep.valueInkLefts));
      }
      // 卡片里右上那组按钮要挨着数值文字；全屏的按钮在标题行，不适用。
      if (rep.btnGapFromText !== null && rep.btnGapFromText !== undefined && rep.card !== null) {
        add(`${tag} 三个按钮紧挨数值文字（≤ 40px）`, rep.btnGapFromText >= 0 && rep.btnGapFromText <= 40, `gap=${rep.btnGapFromText}`);
      }
      if (rep.peakValueGap !== null && rep.peakValueGap !== undefined) {
        add(`${tag} 数值紧贴按钮（间距 ≤ 8px）`, rep.peakValueGap <= 8, `gap=${rep.peakValueGap}`);
      }
      // 余额右边那串钱要和「今日消耗」一样的灰 + 同字号（不是加粗主色）。
      if (rep.balanceValueStyle !== null && rep.balanceValueStyle !== undefined) {
        const vs = rep.balanceValueStyle;
        const spendStyle = rep.peakSpendStyle ?? {};
        add(`${tag} 余额金额用和「今日消耗」一样的灰与字号`, vs.fill === (spendStyle.color ?? '') && vs.fontSize === spendStyle.fontSize && String(vs.fontWeight) === (spendStyle.fontWeight ?? '400'), JSON.stringify({ ...vs, spendColor: spendStyle.color, spendSize: spendStyle.fontSize }));
      }
      // 文字没有贴着轨道摆、也没有留大空白：标签 / 数值到轨道的间距都要小。
      const gaps = [rep.peakTagGap, rep.balanceLabelGap];
      if (gaps.every((g) => typeof g === 'number')) {
        add(`${tag} 左侧文字紧贴轨道（≤ 12px）`, gaps.every((g) => g >= 0 && g <= 12), JSON.stringify({ tag: rep.peakTagGap, label: rep.balanceLabelGap }));
      }
      if (rep.balanceLabel !== null && rep.balanceLabel !== undefined) {
        add(`${tag} 左列文字左对齐（两个词同宽）`, rep.balanceLabel.textAlign === 'left' && (rep.peakTagStyle?.textAlign ?? 'left') === 'left' && rep.balanceLabel.text === '账户余额', JSON.stringify({ labelAlign: rep.balanceLabel.textAlign, text: rep.balanceLabel.text }));
      }
      // 悬停提示：页面是静态快照（没有 React 运行时），所以悬停态是**渲染时**就点出来的，
      // 这里只量它的几何，验证提示面板不会被画布裁掉。
      if (rep.hoverTip !== undefined && rep.hoverTip !== null) {
        const rows = rep.hoverTip.rows ?? [];
        add(`${tag} 悬停弹出提示（时间 + 本轮 + 累计）`, rows.some((r) => /\d{2}:\d{2}/.test(r)) && rows.some((r) => r.includes('本轮')) && rows.some((r) => r.includes('累计')), JSON.stringify(rows));
        add(`${tag} 悬停提示不出画布`, rep.hoverTip.insideCanvas === true, JSON.stringify(rep.hoverTip));
        add(`${tag} 悬停时其他柱子变淡（那一列被强调）`, (rep.hoveredBars ?? 0) >= 1, `dimmed=${rep.hoveredBars} bars=${rep.bars?.count}`);
      }
      }
    }
    if (rep.settings !== null && rep.settings !== undefined) {
      add(`${tag} 设置面板完整可见`, rep.settingsFits === true, JSON.stringify(rep.settings));
      add(`${tag} 设置面板可滚动（内容高于 400px 上限）`, rep.settingsScrolls === true, `scrolls=${rep.settingsScrolls}`);
    }
    // 命中测试：滚动会话后，菜单区域里点到的最上层元素必须还在菜单里
    // （会话里的代码块表头是 sticky + z-index:6，卡片以前是 z-index:2，于是被它盖住）。
    if (rep.popupCover !== undefined && rep.popupCover !== null) {
      add(`${tag} 吸顶的代码块表头没盖住设置菜单（命中测试）`, rep.popupCover.allInside === true,
        JSON.stringify({ banner: rep.popupCover.banner, hits: rep.popupCover.hits }));
    }
    if (rep.fullscreenPanel !== null && rep.fullscreenPanel !== undefined) {
      add(`${tag} 全屏面板铺满且不出视口`, rep.fullscreenFits === true, JSON.stringify(rep.fullscreenPanel));
      add(`${tag} 全屏明细表有数据行`, (rep.detailRows ?? 0) > 0, `rows=${rep.detailRows}`);
    }
    // 明细表表头：不许吸顶（吸顶那一行占掉一行高度，还盖在滚上来的数据上面）。
    if (rep.detailHead !== undefined && rep.detailHead !== null) {
      add(`${tag} 明细表表头不吸顶（position ≠ sticky）`, rep.detailHead.position !== 'sticky', JSON.stringify({ position: rep.detailHead.position, top: rep.detailHead.top, bg: rep.detailHead.bg }));
      if (rep.detailHead.scrolledBy > 0) {
        // 真的滚一段：表头行和数据行的位移必须一样，才叫「跟着数据一起滚」。
        add(`${tag} 明细表滚动时表头与数据同步位移`,
          Math.abs(rep.detailHead.thMoved - rep.detailHead.rowMoved) < 0.6 && Math.abs(rep.detailHead.thMoved - rep.detailHead.scrolledBy) < 0.6,
          `scrolledBy=${rep.detailHead.scrolledBy} thMoved=${rep.detailHead.thMoved} rowMoved=${rep.detailHead.rowMoved}`);
      }
    }
  }

  let failed = 0;
  for (const c of checks) { if (!c.ok) failed += 1; console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.ok ? '' : `   -> ${c.detail}`}`); }
  console.log(`\n${checks.length - failed}/${checks.length} 项布局检查通过`);
  console.log(`详细数字: ${join(outDir, 'layout-report.json')}`);
  console.log(`可视化页面（可以直接用浏览器打开看）: ${outDir}/*.html`);
  // Chrome 的临时 profile 目录没有保留价值，清掉免得工作区发胖。
  rmSync(join(outDir, '.browser-profile'), { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}
