/**
 * dsh-balance-chart — 宿主侧插件
 *
 * 职责（零第三方依赖，只 import node: 内置模块）：
 *   1. 轮询 DeepSeek 余额接口 `/user/balance`（每轮对话结束后额外补采几次）；
 *   2. 监听 DSH 会话事件，按 turn 汇总精确 usage，并用峰谷价卡换算本轮消耗；
 *   3. 用「余额差值」做权威记账（余额下降 = 真实扣费），换算值作为差额不可用时的回退；
 *   4. 通过 ctx.webServer 暴露三个本地 HTTP 接口给浏览器侧图表读取/写配置。
 *
 * 数据只落在本机 `$DSH_HOME/.dsh-balance-chart.json`，不发送到任何第三方。
 *
 * @module dsh-balance-chart
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Cordis 插件名（Loader 行的 name 解析到这个包时使用）。 */
export const name = 'balance-chart';

/** 需要等待的服务：本地 HTTP 服务器 + 凭据服务。 */
export const inject = ['webServer', 'credentials'];

const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh');
const LEDGER_PATH = join(DSH_HOME, '.dsh-balance-chart.json');

const ROUTE_STATE = '/dsh-balance/state';
const ROUTE_CONFIG = '/dsh-balance/config';
const ROUTE_REFRESH = '/dsh-balance/refresh';

const BALANCE_URL = 'https://api.deepseek.com/user/balance';

/** 官方 2026-09-10 12:00 起执行的 Flash 系列价卡（元 / 百万 token）。 */
const DEFAULT_CONFIG = {
  /** 横向余额条 100% 对应的余额金额。 */
  maxBalance: 50,
  /** 上层（竖向柱 + 折线）占图表区高度的比例。锁死 65%，设置里不再暴露。 */
  chartRatio: 0.65,
  /** 余额轮询间隔（毫秒）。 */
  pollMs: 15000,
  /** 当日最多保留的柱子数量。 */
  maxTurns: 200,
  /** 币种偏好；余额接口返回多币种时按它挑选。 */
  currency: 'CNY',
  /** 记账方式：delta = 余额差值优先（默认），estimate = 仅按价卡估算。 */
  accounting: 'delta',
  /** 标题栏卡片是否折叠为 32px 摘要条。 */
  collapse: false,
  /** 峰谷时段（小时，左闭右开），默认工作日 9-12 与 14-18 为高峰。 */
  peakWindows: [[9, 12], [14, 18]],
  /** 周末是否全天按谷价。 */
  peakWeekdaysOnly: true,
  /** 峰谷价卡。 */
  rates: {
    peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 },
    offpeak: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
  },
  /** 峰谷条点击后打开的平台用量页。 */
  usageUrl: 'https://platform.deepseek.com/usage',
};

const round4 = (n) => Math.round(n * 10000) / 10000;

function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isPeakAt(date, config) {
  const weekday = date.getDay();
  if (config.peakWeekdaysOnly && (weekday === 0 || weekday === 6)) return false;
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  return config.peakWindows.some(([from, to]) => hour >= from && hour < to);
}

function mergeConfig(base, patch) {
  const next = { ...base, ...patch };
  next.rates = {
    peak: { ...base.rates.peak, ...(patch && patch.rates ? patch.rates.peak : undefined) },
    offpeak: { ...base.rates.offpeak, ...(patch && patch.rates ? patch.rates.offpeak : undefined) },
  };
  if (!Array.isArray(next.peakWindows) || next.peakWindows.length === 0) {
    next.peakWindows = DEFAULT_CONFIG.peakWindows;
  }
  next.maxBalance = Math.max(0.01, Number(next.maxBalance) || DEFAULT_CONFIG.maxBalance);
  // 上层图表占比锁死 65%：设置里已经没有这个选项，旧文件里读回别的值也不生效，
  // 免得界面上的承诺和实际渲染对不上。
  next.chartRatio = DEFAULT_CONFIG.chartRatio;
  next.pollMs = Math.min(600000, Math.max(5000, Math.round(Number(next.pollMs) || DEFAULT_CONFIG.pollMs)));
  next.maxTurns = Math.min(1000, Math.max(10, Math.round(Number(next.maxTurns) || DEFAULT_CONFIG.maxTurns)));
  next.collapse = next.collapse === true;
  next.peakWeekdaysOnly = next.peakWeekdaysOnly !== false;
  next.accounting = next.accounting === 'estimate' ? 'estimate' : 'delta';
  return next;
}

/** 把一次 provider 上报的 usage 归一化成记账用的 token 桶。 */
function usageBuckets(usage) {
  if (usage === null || typeof usage !== 'object') return null;
  return {
    uncachedInput: num(usage.inputTokens),
    output: num(usage.outputTokens),
    cacheRead: num(usage.cacheReadTokens),
    cacheWrite: num(usage.cacheWriteTokens),
    reasoning: num(usage.reasoningTokens),
  };
}

function addBuckets(into, add) {
  into.uncachedInput += add.uncachedInput;
  into.output += add.output;
  into.cacheRead += add.cacheRead;
  into.cacheWrite += add.cacheWrite;
  into.reasoning += add.reasoning;
  return into;
}

/** 按价卡把 token 桶换算成金额（元）。 */
function priceTokens(tokens, rates) {
  const perMillion = 1e-6;
  return round4(
    (tokens.uncachedInput + tokens.cacheWrite) * rates.cacheMiss * perMillion
    + tokens.cacheRead * rates.cacheHit * perMillion
    + tokens.output * rates.output * perMillion,
  );
}

/**
 * 宿主侧插件主体。
 * @param ctx - cordis 上下文，带 webServer 与 credentials 服务。
 * @param config - Loader 行配置（本插件不需要，保留签名兼容）。
 */
export function apply(ctx, config) {
  const state = {
    config: mergeConfig(DEFAULT_CONFIG, config ?? {}),
    day: dayKey(),
    turns: [],
    topUps: [],
    balance: {
      ok: false,
      currency: DEFAULT_CONFIG.currency,
      total: null,
      granted: null,
      toppedUp: null,
      at: null,
      error: null,
    },
    prevTotal: null,
    /** 上面那个 prevTotal 是什么时候观测到的（用来识别跨天的差值）。 */
    prevTotalAt: null,
    lastSampleAt: null,
    keyMissing: false,
    /** 已经滚出可视化窗口的那些柱子的消费合计（当日消费不能因为它变小）。 */
    trimmedSpent: 0,
  };

  const openTurns = new Map();
  const timers = new Set();
  let persistTimer = null;
  let sampling = false;
  let disposed = false;

  /* ------------------------------------------------------------------ 持久化 */

  function loadLedger() {
    try {
      if (!existsSync(LEDGER_PATH)) return;
      const raw = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
      if (raw === null || typeof raw !== 'object') return;
      state.config = mergeConfig(DEFAULT_CONFIG, raw.config ?? {});
      state.day = typeof raw.day === 'string' ? raw.day : dayKey();
      state.turns = Array.isArray(raw.turns) ? raw.turns : [];
      state.topUps = Array.isArray(raw.topUps) ? raw.topUps : [];
      state.prevTotal = typeof raw.prevTotal === 'number' ? raw.prevTotal : null;
      state.prevTotalAt = typeof raw.prevTotalAt === 'number' ? raw.prevTotalAt : null;
      state.trimmedSpent = num(raw.trimmedSpent);
      if (raw.balance && typeof raw.balance === 'object') {
        state.balance = { ...state.balance, ...raw.balance };
      }
      state.turns = normalizeTurns(state.turns);
    } catch (error) {
      log('warn', 'ledger load failed', error);
    }
  }

  function normalizeTurns(turns) {
    const out = [];
    for (const turn of turns) {
      if (turn === null || typeof turn !== 'object') continue;
      const tokens = {
        uncachedInput: num(turn.tokens?.uncachedInput),
        output: num(turn.tokens?.output),
        cacheRead: num(turn.tokens?.cacheRead),
        cacheWrite: num(turn.tokens?.cacheWrite),
        reasoning: num(turn.tokens?.reasoning),
      };
      const estimate = round4(num(turn.estimate));
      const delta = round4(num(turn.delta));
      out.push({
        id: typeof turn.id === 'string' ? turn.id : `restored-${out.length}`,
        ts: num(turn.ts) || Date.now(),
        sessionId: typeof turn.sessionId === 'string' ? turn.sessionId : '',
        turn: num(turn.turn),
        model: typeof turn.model === 'string' ? turn.model : '',
        peak: turn.peak === true,
        synthetic: turn.synthetic === true,
        offline: turn.offline === true,
        tokens,
        estimate,
        delta,
        cost: round4(num(turn.cost)),
      });
    }
    return out;
  }

  function schedulePersist() {
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, 800);
    timers.add(persistTimer);
  }

  function persistNow() {
    try {
      const payload = {
        version: 1,
        day: state.day,
        config: state.config,
        turns: state.turns,
        topUps: state.topUps.slice(-50),
        prevTotal: state.prevTotal,
        prevTotalAt: state.prevTotalAt,
        trimmedSpent: state.trimmedSpent,
        balance: { ...state.balance, ok: undefined, error: undefined },
      };
      writeFileSync(LEDGER_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (error) {
      log('warn', 'ledger write failed', error);
    }
  }

  /* --------------------------------------------------------------- 记账核心 */

  function ensureDay() {
    const today = dayKey();
    if (today === state.day) return;
    log('info', `day rollover ${state.day} -> ${today}`);
    state.day = today;
    state.turns = [];
    state.topUps = [];
    state.trimmedSpent = 0;
    schedulePersist();
  }

  function recomputeCost(turn) {
    const useDelta = state.config.accounting === 'delta' && turn.delta > 0;
    turn.cost = round4(useDelta ? turn.delta : turn.estimate);
    return turn;
  }

  function lastTurn() {
    return state.turns.length > 0 ? state.turns[state.turns.length - 1] : null;
  }

  /** 正在进行中的那一轮（多个会话并发时取最近开始的）。 */
  function newestOpenTurn() {
    let best = null;
    for (const open of openTurns.values()) {
      if (best === null || open.startedAt > best.startedAt) best = open;
    }
    return best;
  }

  /** 进行中那几轮已经观测到的扣费合计（还没结算成柱子）。 */
  function pendingSpend() {
    let total = 0;
    for (const open of openTurns.values()) total = round4(total + num(open.delta));
    return total;
  }

  /**
   * 把一次观测到的余额下降归属到某一轮对话。
   *
   * 归属顺序：
   *   1. 有正在进行的对话 -> 记到它头上。长对话可能横跨好几次轮询，
   *      如果不这么做，这些扣费会落到「上一轮」或者变成「其他消耗」，
   *      于是本轮柱子偏小、图上多出莫名其妙的灰柱。
   *   2. 没有进行中的对话，但最近 10 分钟内刚结束过一轮 -> 记到它头上
   *      （扣费入账有延迟，turn/end 之后的补采就属于这种情况）。
   *   3. 都不满足 -> 建一个「其他消耗」桶（换了别的客户端，或插件加载前的旧账）。
   *
   * @param amount - 观测到的余额下降额（正数，元）。
   * @param options.offline - 这笔钱发生在「上一次观测」和「现在」之间、且跨了自然日
   *   （典型场景：昨天关掉 dsh web，今天再打开，中间在用量平台或别的客户端消耗掉的钱）。
   *   这种情况**仍然记进今天的账**——用户要的是「今天总共花了多少」，
   *   而不是「这个网页开着的时候花了多少」；但具体时刻不可知，所以单独标出来，
   *   并且绝不并进正在进行的这一轮（那会把昨天的账算到今天的对话头上）。
   */
  function attributeSpend(amount, options) {
    const offline = options?.offline === true;
    const open = offline ? null : newestOpenTurn();
    if (open !== null) {
      open.delta = round4(open.delta + amount);
      schedulePersist();
      return;
    }
    const recent = lastTurn();
    // 离线期间那一笔代表「昨天收尾时段的旧账」，不该被今天的新消耗并进去
    // （并进去以后时间线上就分不清哪部分是离线期间的了）。
    const fresh = !offline && recent !== null && recent.offline !== true && Date.now() - recent.ts < 10 * 60 * 1000;
    if (fresh) {
      recent.delta = round4(recent.delta + amount);
      recomputeCost(recent);
    } else {
      const orphan = {
        id: `orphan-${Date.now()}`,
        ts: Date.now(),
        sessionId: '',
        turn: 0,
        model: '',
        peak: isPeakAt(new Date(), state.config),
        synthetic: true,
        offline,
        tokens: { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        estimate: 0,
        delta: round4(amount),
        cost: round4(amount),
      };
      state.turns.push(orphan);
      trimTurns();
    }
    schedulePersist();
  }

  function trimTurns() {
    const limit = state.config.maxTurns;
    if (state.turns.length <= limit) return;
    const evicted = state.turns.slice(0, state.turns.length - limit);
    state.turns = state.turns.slice(state.turns.length - limit);
    // 被裁掉的柱子不能就这么把钱忘了：当日消费必须仍然是真实总额。
    // 折线的累计也从这笔「已滚出屏幕的历史」起算，所以最右边那点永远等于当日消费。
    for (const turn of evicted) state.trimmedSpent = round4(state.trimmedSpent + num(turn.cost));
  }

  function finalizeTurn(sessionId, open) {
    ensureDay();
    const tokens = { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    let steps = 0;
    for (const buckets of open.attempts.values()) {
      addBuckets(tokens, buckets);
      steps += 1;
    }
    const peak = isPeakAt(new Date(open.startedAt), state.config);
    const rates = peak ? state.config.rates.peak : state.config.rates.offpeak;
    const record = {
      id: `${sessionId}#${open.turn}@${open.startedAt}`,
      ts: open.startedAt,
      sessionId,
      turn: open.turn,
      model: open.model ?? '',
      peak,
      synthetic: false,
      steps,
      tokens,
      estimate: priceTokens(tokens, rates),
      // 这一轮进行期间就已经观测到的扣费，直接带进来，别让它变成「其他消耗」。
      delta: round4(num(open.delta)),
    };
    recomputeCost(record);
    state.turns.push(record);
    trimTurns();
    schedulePersist();
    // 扣费入账通常有几秒延迟，跟着补采几次把差值抓回来。
    for (const delay of [2500, 8000, 16000]) {
      scheduleSample(delay);
    }
  }

  /* --------------------------------------------------------------- 余额采样 */

  function scheduleSample(delay) {
    if (disposed) return;
    const handle = setTimeout(() => {
      timers.delete(handle);
      void sampleBalance('turn');
    }, delay);
    timers.add(handle);
  }

  async function resolveKey() {
    try {
      const resolved = await ctx.credentials.resolve('DEEPSEEK_API_KEY');
      const value = resolved === undefined || resolved === null ? null : resolved.value;
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch (error) {
      log('warn', 'credential resolve failed', error);
      return null;
    }
  }

  async function fetchBalance() {
    const key = await resolveKey();
    if (key === null) {
      state.keyMissing = true;
      state.balance = { ...state.balance, ok: false, error: '未配置 DEEPSEEK_API_KEY' };
      return null;
    }
    state.keyMissing = false;
    const response = await fetch(BALANCE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error(`余额接口 HTTP ${response.status}`);
    }
    const payload = await response.json();
    const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
    if (infos.length === 0) {
      throw new Error('余额接口未返回 balance_infos');
    }
    const preferred = infos.find((info) => info?.currency === state.config.currency) ?? infos[0];
    return {
      currency: String(preferred?.currency ?? state.config.currency),
      total: num(Number(preferred?.total_balance)),
      granted: num(Number(preferred?.granted_balance)),
      toppedUp: num(Number(preferred?.topped_up_balance)),
      available: payload?.is_available !== false,
    };
  }

  async function sampleBalance(reason) {
    if (sampling || disposed) return;
    sampling = true;
    try {
      ensureDay();
      const fresh = await fetchBalance();
      if (fresh === null) {
        schedulePersist();
        return;
      }
      const previous = state.prevTotal;
      state.balance = {
        ok: true,
        currency: fresh.currency,
        total: fresh.total,
        granted: fresh.granted,
        toppedUp: fresh.toppedUp,
        available: fresh.available,
        at: Date.now(),
        error: null,
      };
      state.lastSampleAt = Date.now();
      if (typeof previous === 'number' && Number.isFinite(previous)) {
        const delta = round4(previous - fresh.total);
        // 上一次观测到现在的这段差值如果跨了自然日，具体花在哪一天不可知
        // （典型场景：昨天关掉 dsh web，今天打开，中间的消耗）。
        // 仍然记进今天：用户要的是「今天总共花了多少」，丢掉这笔反而少算了。
        // 只是把它标成 offline，既不并进正在进行的这一轮，提示里也说明时刻不精确。
        const crossedDay = typeof state.prevTotalAt === 'number' && dayKey(new Date(state.prevTotalAt)) !== dayKey();
        if (delta > 0.0001) {
          if (crossedDay) log('info', `attributing cross-day balance drop ${delta} to today as offline spend`);
          attributeSpend(delta, { offline: crossedDay });
        } else if (delta < -0.0001) {
          state.topUps.push({ ts: Date.now(), amount: round4(-delta) });
          state.topUps = state.topUps.slice(-50);
        }
      }
      state.prevTotal = fresh.total;
      state.prevTotalAt = Date.now();
      schedulePersist();
    } catch (error) {
      state.balance = { ...state.balance, ok: false, error: String(error?.message ?? error), at: Date.now() };
      log('warn', `balance sample (${reason}) failed: ${String(error?.message ?? error)}`);
    } finally {
      sampling = false;
    }
  }

  /* ----------------------------------------------------------- 会话事件监听 */

  function handleSessionEvent(session, event) {
    try {
      const type = event?.type;
      if (typeof type !== 'string') return;
      const sessionId = String(session?.id ?? '');
      if (type === 'turn/start') {
        openTurns.set(sessionId, {
          turn: num(event.data?.turn),
          startedAt: Date.now(),
          attempts: new Map(),
          model: undefined,
          delta: 0,
        });
        return;
      }
      if (type === 'turn/end') {
        const open = openTurns.get(sessionId);
        if (open === undefined) return;
        openTurns.delete(sessionId);
        finalizeTurn(sessionId, open);
        return;
      }
      const open = openTurns.get(sessionId);
      if (open === undefined) return;
      if (type === 'assistant/chunk') {
        const chunk = event.data?.chunk;
        if (chunk?.type !== 'usage') return;
        const buckets = usageBuckets(chunk.usage);
        if (buckets === null) return;
        open.attempts.set(num(event.data?.step), buckets);
        return;
      }
      if (type === 'assistant/message') {
        const step = num(event.data?.step);
        const buckets = usageBuckets(event.data?.usage) ?? open.attempts.get(step);
        if (buckets !== undefined && buckets !== null) open.attempts.set(step, buckets);
        const source = event.data?.message?.source;
        if (source && typeof source.model === 'string' && source.model.length > 0) {
          open.model = source.model;
        }
      }
    } catch (error) {
      log('warn', 'session event handling failed', error);
    }
  }

  /* ------------------------------------------------------------- HTTP 接口 */

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', Buffer.byteLength(text));
    res.end(text);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 262144) throw new Error('body too large');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    return text.length === 0 ? {} : JSON.parse(text);
  }

  function snapshot() {
    const config = state.config;
    const points = [];
    // 从「已滚出窗口的历史」起算：窗口内的柱子被裁掉时，钱已经累进 trimmedSpent，
    // 所以折线最右端永远等于当日消费，而不是只剩窗口内的那部分。
    let cumulative = state.trimmedSpent;
    for (const turn of state.turns) {
      cumulative = round4(cumulative + turn.cost);
      points.push({
        id: turn.id,
        ts: turn.ts,
        cost: turn.cost,
        cum: cumulative,
        estimate: turn.estimate,
        delta: turn.delta,
        peak: turn.peak === true,
        synthetic: turn.synthetic === true,
        offline: turn.offline === true,
        turn: turn.turn,
        model: turn.model,
        tokens: turn.tokens,
      });
    }
    const latest = state.turns.length > 0 ? state.turns[state.turns.length - 1] : null;
    return {
      ok: true,
      now: Date.now(),
      day: state.day,
      balance: state.balance,
      config: {
        maxBalance: config.maxBalance,
        chartRatio: config.chartRatio,
        pollMs: config.pollMs,
        currency: config.currency,
        accounting: config.accounting,
        collapse: config.collapse,
        peakWindows: config.peakWindows,
        peakWeekdaysOnly: config.peakWeekdaysOnly,
        rates: config.rates,
        usageUrl: config.usageUrl,
      },
      today: {
        spent: round4(cumulative),
        count: points.length,
        points,
        lastTurnCost: latest === null ? null : latest.cost,
        /** 今天这笔账是从哪一刻开始记的（第一条记录的 ts）——用来把口径写清楚。 */
        from: points.length > 0 ? points[0].ts : null,
        /** 正在进行中的那几轮已经扣掉、但还没结算成柱子的钱。 */
        pending: pendingSpend(),
        /** 已经滚出可视化窗口、但已计入当日消费的历史金额（>0 说明柱子只显示了最近的若干轮）。 */
        trimmed: state.trimmedSpent,
        topUp: state.topUps.reduce((sum, item) => sum + num(item.amount), 0),
      },
      peak: {
        isPeak: isPeakAt(new Date(), config),
        windows: config.peakWindows,
        weekdaysOnly: config.peakWeekdaysOnly,
      },
      status: {
        lastSampleAt: state.lastSampleAt,
        keyMissing: state.keyMissing,
        openTurn: openTurns.size,
      },
    };
  }

  async function handleState(req, res) {
    ensureDay();
    sendJson(res, 200, snapshot());
  }

  async function handleRefresh(req, res) {
    await sampleBalance('manual');
    sendJson(res, 200, snapshot());
  }

  async function handleConfig(req, res) {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, config: snapshot().config });
      return;
    }
    if (req.method !== 'POST' && req.method !== 'PUT') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    try {
      const patch = (await readBody(req)) ?? {};
      if (patch.__clear === true) {
        state.turns = [];
        state.topUps = [];
        state.trimmedSpent = 0;
        state.prevTotal = typeof state.balance.total === 'number' ? state.balance.total : state.prevTotal;
        state.prevTotalAt = Date.now();
        persistNow();
        sendJson(res, 200, snapshot());
        return;
      }
      if (patch.__reset === true) {
        state.config = mergeConfig(DEFAULT_CONFIG, {});
      } else {
        state.config = mergeConfig(state.config, patch);
      }
      for (const turn of state.turns) recomputeCost(turn);
      persistNow();
      sendJson(res, 200, snapshot());
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  }

  function log(level, message, error) {
    try {
      const logger = ctx.logger;
      if (logger === undefined) return;
      const line = `balance-chart: ${message}`;
      if (level === 'warn') {
        logger.warn(line);
        if (error !== undefined) logger.warn(error);
      } else {
        logger.info(line);
      }
    } catch {
      /* logging must never break the plugin */
    }
  }

  /* -------------------------------------------------------------- 生命周期 */

  ctx.effect(() => {
    loadLedger();
    ensureDay();

    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: ROUTE_STATE, handler: handleState }),
      ctx.webServer.register({ kind: 'exact', path: ROUTE_CONFIG, handler: handleConfig }),
      ctx.webServer.register({ kind: 'exact', path: ROUTE_REFRESH, handler: handleRefresh }),
    ];

    const offEvent = ctx.on('session/event', handleSessionEvent);
    disposers.push(offEvent);

    void sampleBalance('startup');
    const interval = setInterval(() => {
      void sampleBalance('interval');
    }, state.config.pollMs);
    timers.add(interval);

    log('info', `mounted (ledger: ${LEDGER_PATH})`);

    return () => {
      disposed = true;
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      timers.clear();
      if (persistTimer !== null) clearTimeout(persistTimer);
      persistNow();
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      openTurns.clear();
      log('info', 'unmounted');
    };
  }, 'balance-chart: balance polling, turn accounting, and local routes');
}
