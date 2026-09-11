/**
 * 线上集成验证：直接问正在运行的 `dsh web` 要客户端模块图，
 * 再把我的 bundle 从服务器上抓下来，和本地文件逐字节比对。
 *
 * 这一步能证明三件光靠单元测试证明不了的事：
 *   1. dsh-client-modules 真的把我的包装进了客户端模块图（组合成功）；
 *   2. 服务器发出去的 bundle 字节 == 我现在磁盘上的最新代码（HMR 已经重新哈希过）；
 *   3. 浏览器 F5 时拿到的就是这个版本。
 *
 * 需要 `dsh web` 正在运行。
 *   node test/live-verify.mjs [baseUrl]
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';

const base = process.argv[2] ?? 'http://127.0.0.1:3080';
const bundleId = 'dsh-balance-chart';
const localPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js');
const local = readFileSync(localPath, 'utf8');

const results = [];
const check = (label, ok, detail) => results.push({ label, ok: !!ok, detail });

/**
 * 服务器发出去的 combo 字节并不是磁盘文件的原样拷贝：combo 路由会剥掉原有的
 * sourceMappingURL 尾巴、给每个文件补一个 `;` 分隔符和换行、再盖上自己的
 * sourceMappingURL。比对前把两边都归一化，剩下的差异才算真差异。
 */
function normalize(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\/\/# sourceMappingURL=[^\n]*/g, '')
    .replace(/[\s;]+$/, '');
}

/**
 * 用 node:http 直接读 SSE 并主动 destroy socket，读第一帧模块图。
 * （不用 fetch：在 Windows 上销毁进行中的 undici 流会在退出时触发 libuv 断言。）
 * @param timeoutMs - 超时（毫秒）。
 * @returns 解析后的 graph 帧。
 */
function readGraph(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL('/plugins/events', base);
    const request = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', agent: false, headers: { Accept: 'text/event-stream' } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error('SSE HTTP ' + response.statusCode));
          return;
        }
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          buffer += chunk;
          const line = buffer.split('\n').find((row) => row.startsWith('data: ') && row.includes('"type":"graph"'));
          if (line !== undefined) {
            request.destroy();
            try {
              resolve(JSON.parse(line.slice('data: '.length)));
            } catch (error) {
              reject(error);
            }
          }
        });
        response.on('end', () => reject(new Error('SSE 结束时仍未送出 graph 帧')));
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      reject(new Error('SSE 超时'));
    });
    request.on('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    request.end();
  });
}

const frame = await readGraph();
check('SSE 送回 graph 帧', frame !== null && frame.type === 'graph', JSON.stringify(frame)?.slice(0, 120));

const entries = frame?.graph?.entries ?? [];
check('模块图非空', entries.length > 10, String(entries.length));

const entry = entries.find((row) => row.id === bundleId);
check('客户端模块图里包含 ' + bundleId, entry !== undefined, JSON.stringify(entries.map((r) => r.id).filter((id) => !id.startsWith('@deepseek-ai')).slice(0, 5)));
check('我没有声明任何客户端插件依赖（inject 缺省或为空）', entry !== undefined && (entry.inject === undefined || entry.inject.length === 0), JSON.stringify(entry?.inject));

if (entry !== undefined) {
  console.log('graph entry:', JSON.stringify(entry));

  const servedResponse = await fetch(base + entry.url);
  check('服务器能提供我的 bundle（HTTP 200）', servedResponse.ok, 'HTTP ' + servedResponse.status);
  const served = await servedResponse.text();

  const a = normalize(served);
  const b = normalize(local);
  check('线上字节与本地最新代码一致（忽略服务器的 sourceMappingURL 封装）', a === b, a === b ? 'identical' : `served=${a.length} local=${b.length}`);

  // 抽查几处只有最新版才有的标记，双保险。
  const markers = [
    ['滚动条让位常量（对齐宿主 --dsh-scrollbar-width）', 'const SCROLLBAR = 8'],
    ['横向滚动条不再写 scrollbar-width:thin', '.dbc-upper{flex:none;overflow-x:auto;overflow-y:hidden}'],
    ['滚动条高度取宿主变量', '.dbc-upper::-webkit-scrollbar{height:var(--dsh-scrollbar-width,8px)}'],
    ['图表不会画到图例/明细表上', ".dbc-fs-plot{flex:1;min-height:0;display:flex;flex-direction:column;gap:' + PLOT_GAP + 'px;overflow:hidden}"],
    ['全屏也自动贴到最新一根', 'ref: scrollRef'],
    ['明细表表头不吸顶（跟着数据一起滚）', '.dbc-table th{padding:4px 8px;text-align:left;font-weight:600'],
    ['卡片层级高于宿主吸顶的代码块表头（6）', 'margin-top:17.5px;z-index:10;display:flex'],
    ['卡片新高度', 'height:152px'],
    ['卡片居中（无外框的两段式外壳）', 'left:50%;transform:translateX(-50%)'],
    ['撑高度的占位块', '.dbc-slot{position:static'],
    ['卡片落到「对话 / 轨迹」那一行', 'margin-top:17.5px'],
    ['展开态给标签行留高且不拉伸按钮', 'min-height:152px;align-items:flex-start'],
    ['DeepSeek 特征蓝', 'DS_BLUE = "#4d6bfe"'],
    ['配套的高饱和橙', 'DS_ORANGE = "#ff7a2a"'],
    ['上层占比锁死 65%', 'const CHART_RATIO = 0.65'],
    ['悬停提示面板', 'className: "dbc-tip"'],
    ['悬停按列取索引', 'function indexAt(event)'],
    ['齿轮图标（cog，不是小太阳）', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82'],
    ['今日消耗的口径', '今日消耗 '],
    ['两行共用一组列宽常量', 'const ROW_LABEL_W = 52'],
    ['余额条改成和时段条同一套 flex 行', '.dbc-balrow{display:flex'],
    ['余额条颜色与峰谷条共用常量', 'const FILL_OFF ='],
    ['账户余额标签（4 个字，和「高峰时段」对齐）', '账户余额'],
    ['自适应顶部留白', 'Math.round(height * 0.24)'],
    ['全屏容器', 'dbc-fs-plot'],
    ['会话标题栏插槽', 'conversation.session.header.utilities'],
    ['全屏用 shell.overlay 插槽', 'shell.overlay'],
  ];
  for (const [label, marker] of markers) {
    check('线上字节含「' + label + '」', served.includes(marker), marker);
  }

  // 用量页地址来自宿主配置，不属于客户端 bundle，这里只确认客户端确实读了它。
  check('客户端使用宿主下发的 usageUrl', served.includes('config.usageUrl'), 'config.usageUrl');
  check('bundle 注册了 module loader', served.includes('__ModuleLoader__.load'), '');
}

// 宿主侧接口顺带再确认一次。
const stateResponse = await fetch(base + '/dsh-balance/state');
check('宿主接口 /dsh-balance/state 可用', stateResponse.ok, 'HTTP ' + stateResponse.status);
if (stateResponse.ok) {
  const state = await stateResponse.json();
  check('余额可用', state.balance?.ok === true, JSON.stringify(state.balance));
  check('返回了峰谷与配置', typeof state.peak?.isPeak === 'boolean' && state.config?.maxBalance !== undefined, '');
}

let failed = 0;
for (const item of results) {
  if (!item.ok) failed += 1;
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok ? '' : `   -> ${item.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed > 0 ? 1 : 0;
// 给 undici 的连接池一点时间收尾，避免 Windows 上退出时的 libuv 断言。
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 150);
