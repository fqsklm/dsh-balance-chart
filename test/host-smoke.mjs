/**
 * 宿主侧插件的本地冒烟测试：不启动 DSH，用假的 ctx / fetch / 会话事件跑一遍完整记账流程。
 *   node test/host-smoke.mjs
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import 插件之前设置，插件在模块加载时读取 DSH_HOME。
const sandboxHome = mkdtempSync(join(tmpdir(), 'dbc-smoke-'));
process.env.DSH_HOME = sandboxHome;

const plugin = await import('../lib/index.js');

let balanceTotal = 48.0;
const fetchCalls = [];

globalThis.fetch = async (url, init) => {
  fetchCalls.push(String(url));
  if (String(url).includes('/user/balance')) {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          is_available: true,
          balance_infos: [
            { currency: 'CNY', total_balance: balanceTotal.toFixed(2), granted_balance: '0.00', topped_up_balance: balanceTotal.toFixed(2) },
          ],
        };
      },
    };
  }
  throw new Error(`unexpected fetch ${url}`);
};

const routes = new Map();
const listeners = new Map();
const disposers = [];
const logs = [];

const ctx = {
  logger: {
    info: (m) => logs.push(['info', String(m)]),
    warn: (m) => logs.push(['warn', String(m)]),
  },
  effect(callback, label) {
    const dispose = callback();
    disposers.push({ label, dispose });
    return () => {};
  },
  on(event, handler) {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  },
  credentials: {
    async resolve(ref) {
      if (ref !== 'DEEPSEEK_API_KEY') return undefined;
      return { value: 'sk-test-not-a-real-key', source: 'test' };
    },
  },
};

plugin.apply(ctx, {});

/** 调用一个注册的 HTTP 路由并返回解析后的 JSON。 */
async function callRoute(path, method = 'GET', body = null) {
  const handler = routes.get(path);
  if (handler === undefined) throw new Error(`route ${path} not registered`);
  let payload = '';
  const res = {
    statusCode: 200,
    setHeader() {},
    end(text) {
      payload = text ?? '';
    },
  };
  const req = {
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== null) yield Buffer.from(JSON.stringify(body));
    },
  };
  await handler(req, res);
  return JSON.parse(payload);
}

const results = [];
function check(label, condition, detail) {
  results.push({ label, ok: !!condition, detail });
}

const emit = (session, event) => listeners.get('session/event')(session, event);
const flush = () => new Promise((resolve) => setTimeout(resolve, 120));

// ------------------------------------------------------------------ 1. 初始状态
await flush();
let state = await callRoute('/dsh-balance/state');
check('初始余额读取成功', state.balance.ok === true && state.balance.total === 48, JSON.stringify(state.balance));
check('初始当日消费为 0', state.today.spent === 0, String(state.today.spent));
check('峰谷字段存在', typeof state.peak.isPeak === 'boolean', JSON.stringify(state.peak));

// --------------------------------------------------- 2. 一轮对话 + 余额下降 0.05
const session = { id: 'session-smoke' };
emit(session, { type: 'turn/start', data: { turn: 1 } });
emit(session, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 12000, outputTokens: 800, cacheReadTokens: 40000, cacheWriteTokens: 0, totalTokens: 52800 } } } });
emit(session, { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 12000, outputTokens: 800, cacheReadTokens: 40000, cacheWriteTokens: 0, totalTokens: 52800 }, message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } } });
balanceTotal = 47.95;
emit(session, { type: 'turn/end', data: { turn: 1 } });

// turn/end 之后插件会安排 2.5s / 8s / 16s 的补采；测试里直接手动刷新一次。
await callRoute('/dsh-balance/refresh', 'POST');
state = await callRoute('/dsh-balance/state');
check('记录了一轮对话', state.today.count === 1, String(state.today.count));
const point = state.today.points[0];
check('余额差值被记账为 0.05', Math.abs(point.cost - 0.05) < 1e-9, `cost=${point.cost} delta=${point.delta} estimate=${point.estimate}`);
check('累计值等于本轮消耗', Math.abs(point.cum - 0.05) < 1e-9, String(point.cum));
check('token 桶被正确解析', point.tokens.uncachedInput === 12000 && point.tokens.cacheRead === 40000 && point.tokens.output === 800, JSON.stringify(point.tokens));
check('模型被记录', point.model === 'deepseek-v4-flash', String(point.model));
check('价卡换算值合理', point.estimate > 0.01 && point.estimate < 0.2, String(point.estimate));

// ------------------------------------------------------- 3. 充值不记为消费
balanceTotal = 100;
await callRoute('/dsh-balance/refresh', 'POST');
state = await callRoute('/dsh-balance/state');
check('充值不增加当日消费', Math.abs(state.today.spent - 0.05) < 1e-9, String(state.today.spent));
check('充值为负差值', state.today.topUp > 0, String(state.today.topUp));

// ------------------------------------------- 4. 无余额差值时回退到价卡换算
const session2 = { id: 'session-smoke-2' };
balanceTotal = 99.99;
await callRoute('/dsh-balance/refresh', 'POST'); // 基准 = 99.99
emit(session2, { type: 'turn/start', data: { turn: 1 } });
emit(session2, { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0 }, message: { source: { model: 'deepseek-v4-flash' } } } });
emit(session2, { type: 'turn/end', data: { turn: 1 } });
await callRoute('/dsh-balance/refresh', 'POST'); // 余额没变 -> delta 0 -> 用换算值
state = await callRoute('/dsh-balance/state');
const second = state.today.points[1];
check('第二轮已记录', state.today.count === 2, String(state.today.count));
check('差值缺失时回退到价卡换算', second.delta === 0 && second.cost === second.estimate && second.cost > 1, `delta=${second.delta} cost=${second.cost}`);
check('累计 = 两轮之和', Math.abs(second.cum - (state.today.points[0].cost + second.cost)) < 1e-6, String(second.cum));

// ------------------- 4b. 进行中的对话期间发生的扣费必须归到「这一轮」
const session3 = { id: 'session-mid-turn' };
emit(session3, { type: 'turn/start', data: { turn: 1 } });
balanceTotal = 99.69; // 相对上一轮基准 99.99 下降 0.30，且这次下降发生在对话进行中
await callRoute('/dsh-balance/refresh', 'POST');
let mid = await callRoute('/dsh-balance/state');
check('进行中的扣费进 pending，而不是立刻变成灰柱', Math.abs(mid.today.pending - 0.3) < 1e-9, `pending=${mid.today.pending}`);
check('进行中的扣费没有提前多出一根柱子', mid.today.count === 2, String(mid.today.count));
check('进行中的扣费没有生成「其他消耗」灰柱', mid.today.points.filter((p) => p.synthetic).length === 0, String(mid.today.points.filter((p) => p.synthetic).length));

emit(session3, { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 5000, outputTokens: 500, cacheReadTokens: 1000, cacheWriteTokens: 0 }, message: { source: { model: 'deepseek-v4-flash' } } } });
emit(session3, { type: 'turn/end', data: { turn: 1 } });
const settled = await callRoute('/dsh-balance/state');
const third = settled.today.points[2];
check('turn/end 后把进行中的扣费并进这一轮', third !== undefined && Math.abs(third.delta - 0.3) < 1e-9, JSON.stringify(third?.delta));
check('这一轮的 cost 用余额差值（而不是价卡换算）', third !== undefined && Math.abs(third.cost - 0.3) < 1e-9, JSON.stringify({ cost: third?.cost, estimate: third?.estimate }));
check('结算后 pending 归零', settled.today.pending === 0, String(settled.today.pending));
check('全程没有产生灰柱', settled.today.points.filter((p) => p.synthetic).length === 0, String(settled.today.points.filter((p) => p.synthetic).length));
check('当日消费 = 三轮之和', Math.abs(settled.today.spent - (settled.today.points[0].cost + settled.today.points[1].cost + third.cost)) < 1e-6, String(settled.today.spent));

// ------- 4c. 柱子超出上限被裁掉时，当日消费 / 折线最右端不能被裁小
const spentBeforeTrim = (await callRoute('/dsh-balance/state')).today.spent;
await callRoute('/dsh-balance/config', 'POST', { maxTurns: 10 });
for (let index = 0; index < 12; index += 1) {
  const sessionN = { id: `session-trim-${index}` };
  emit(sessionN, { type: 'turn/start', data: { turn: 1 } });
  balanceTotal = Math.round((balanceTotal - 0.1) * 100) / 100;
  await callRoute('/dsh-balance/refresh', 'POST');
  emit(sessionN, { type: 'turn/end', data: { turn: 1 } });
}
const trimmedState = await callRoute('/dsh-balance/state');
const visibleSum = trimmedState.today.points.reduce((sum, p) => sum + p.cost, 0);
check('柱子数被限制在 maxTurns', trimmedState.today.count === 10, String(trimmedState.today.count));
check('被裁掉的柱子金额进了 trimmed', trimmedState.today.trimmed > 0, String(trimmedState.today.trimmed));
check('12 轮 × 0.10 全部计入当日消费（没有被裁掉）', Math.abs((trimmedState.today.spent - spentBeforeTrim) - 1.2) < 1e-6, `Δ=${(trimmedState.today.spent - spentBeforeTrim).toFixed(4)}`);
check('当日消费 = 已滚出窗口的历史 + 可见柱子之和', Math.abs(trimmedState.today.spent - (trimmedState.today.trimmed + visibleSum)) < 1e-6, JSON.stringify({ spent: trimmedState.today.spent, trimmed: trimmedState.today.trimmed, visibleSum }));
const lastPoint = trimmedState.today.points[trimmedState.today.points.length - 1];
check('折线最右端等于当日消费', Math.abs(lastPoint.cum - trimmedState.today.spent) < 1e-6, JSON.stringify({ cum: lastPoint.cum, spent: trimmedState.today.spent }));

// 清空当日记录必须把「已滚出窗口的历史」一起清掉，否则当日消费会继续算旧账。
const clearedState = await callRoute('/dsh-balance/config', 'POST', { __clear: true });
check('清空当日记录后当日消费归零', clearedState.today.spent === 0 && clearedState.today.trimmed === 0 && clearedState.today.count === 0, JSON.stringify({ spent: clearedState.today.spent, trimmed: clearedState.today.trimmed, count: clearedState.today.count }));
await callRoute('/dsh-balance/config', 'POST', { maxTurns: 200 });

// ------------------------------------------------------------- 5. 配置读写
let configured = await callRoute('/dsh-balance/config', 'POST', { maxBalance: 25, chartRatio: 0.5, pollMs: 30000 });
check('配置写入生效', configured.config.maxBalance === 25, JSON.stringify({ maxBalance: configured.config.maxBalance, chartRatio: configured.config.chartRatio }));
// 上层图表占比已经锁死：不管传什么、旧文件里存着什么，都必须是 0.65。
check('比例被锁死在 0.65（传 0.5 也不生效）', configured.config.chartRatio === 0.65, String(configured.config.chartRatio));
configured = await callRoute('/dsh-balance/config', 'POST', { maxBalance: -5, chartRatio: 5 });
check('非法配置被夹紧', configured.config.maxBalance > 0 && configured.config.chartRatio === 0.65, JSON.stringify({ maxBalance: configured.config.maxBalance, chartRatio: configured.config.chartRatio }));
configured = await callRoute('/dsh-balance/config', 'POST', { __reset: true });
check('恢复默认', configured.config.maxBalance === 50 && configured.config.chartRatio === 0.65, JSON.stringify({ maxBalance: configured.config.maxBalance, chartRatio: configured.config.chartRatio }));
configured = await callRoute('/dsh-balance/config', 'POST', { __clear: true });
check('清空当日记录', configured.today.count === 0 && configured.today.spent === 0, JSON.stringify(configured.today.spent));

// ------------------------------------------------------------------ 6. 卸载
for (const item of disposers) {
  if (typeof item.dispose === 'function') item.dispose();
}
const routeCount = routes.size;
check('卸载后路由被移除', routeCount === 0, String(routeCount));

// ------------------------------------------- 7. 跨天基准（昨天关、今天开）
// 场景：昨晚关掉 dsh web，今早打开，中间余额少了 10 元（别的客户端或夜间任务）。
// 这 10 元不属于「今天」，只能挪基准、不能记账。
const ledgerPath = join(process.env.DSH_HOME, '.dsh-balance-chart.json');
const nowDate = new Date();
const todayKey = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-${String(nowDate.getDate()).padStart(2, '0')}`;
writeFileSync(ledgerPath, JSON.stringify({
  version: 1,
  day: todayKey,
  config: {},
  turns: [],
  topUps: [],
  trimmedSpent: 0,
  prevTotal: 100,
  prevTotalAt: Date.now() - 26 * 60 * 60 * 1000, // 昨天这个时候
}), 'utf8');

const routes2 = new Map();
const listeners2 = new Map();
const disposers2 = [];
const ctx2 = {
  logger: { info: (m) => logs.push(['info', String(m)]), warn: (m) => logs.push(['warn', String(m)]) },
  effect(callback) { const dispose = callback(); disposers2.push(dispose); return () => {}; },
  on(event, handler) { listeners2.set(event, handler); return () => listeners2.delete(event); },
  webServer: { register(route) { routes2.set(route.path, route.handler); return () => routes2.delete(route.path); } },
  credentials: { async resolve(ref) { return ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-test', source: 'test' } : undefined; } },
};
async function callRoute2(path, method = 'GET', body = null) {
  const handler = routes2.get(path);
  if (handler === undefined) throw new Error(`route2 ${path} not registered`);
  let payload = '';
  const res = { statusCode: 200, setHeader() {}, end(text) { payload = text ?? ''; } };
  const req = { method, async *[Symbol.asyncIterator]() { if (body !== null) yield Buffer.from(JSON.stringify(body)); } };
  await handler(req, res);
  return JSON.parse(payload);
}

balanceTotal = 90; // 相对昨天的 100 少了 10
plugin.apply(ctx2, {});
await flush();
await callRoute2('/dsh-balance/refresh', 'POST');
const crossed = await callRoute2('/dsh-balance/state');
// 这里要的是「今天总共花了多少」，所以离线期间（上一次观测和现在之间）的下降照样算进今天，
// 只是单独标成 offline：不并进正在进行的对话，提示里说明时刻不精确。
check('跨天的余额差值记进今日消费（离线期间）', Math.abs(crossed.today.spent - 10) < 1e-9 && crossed.today.count === 1, JSON.stringify({ spent: crossed.today.spent, count: crossed.today.count }));
check('离线期间的那一笔被标成 offline', crossed.today.points?.[0]?.offline === true && crossed.today.points?.[0]?.synthetic === true, JSON.stringify(crossed.today.points?.[0]));
check('跨天后基准挪到新余额', crossed.balance.total === 90, String(crossed.balance.total));

balanceTotal = 89.5; // 这一次是今天内的真实消耗
await callRoute2('/dsh-balance/refresh', 'POST');
const sameDay = await callRoute2('/dsh-balance/state');
check('同一天内的下降继续累加（10 + 0.50）', Math.abs(sameDay.today.spent - 10.5) < 1e-9, String(sameDay.today.spent));
check('离线期间那一笔保持独立（没被今天的消耗并进去）', sameDay.today.points?.length === 2 && sameDay.today.points[0].offline === true && Math.abs(sameDay.today.points[0].cost - 10) < 1e-9, JSON.stringify(sameDay.today.points));

// ---------------------------------------------------------------------- 汇总
let failed = 0;
for (const item of results) {
  if (!item.ok) failed += 1;
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok ? '' : `   -> ${item.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed   (fetch calls: ${fetchCalls.length}, log lines: ${logs.length})`);
console.log(`ledger dir: ${sandboxHome}`);
// 第二阶段的插件实例还挂着轮询定时器，收尾时一并拆掉，否则进程不会退出。
for (const dispose of disposers2) {
  if (typeof dispose === 'function') {
    try {
      dispose();
    } catch {
      /* ignore */
    }
  }
}
process.exit(failed > 0 ? 1 : 0);
