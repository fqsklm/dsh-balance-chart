/**
 * 客户端 bundle 的结构冒烟测试：不启动浏览器，用最小化的 React / DOM / fetch 替身
 * 把 lib/client.js 真正执行一遍，验证 module loader 契约、apply() 的插槽注册，
 * 以及整棵组件树的渲染路径没有运行时错误。
 *
 *   node test/client-smoke.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

/* ---------------------------------------------------------------- React 替身 */

const pendingEffects = [];

/**
 * 极简 hook 运行时：每个组件函数一个持久的状态槽数组，渲染时索引归零。
 *
 * 这里的 useState 必须是**真的**：如果 setter 是空操作，设置面板里改过的值
 * 永远回不到 draft 上，测试就会看到「提交的还是初始值」这种假失败
 * （或者反过来，假通过）。useRef 故意保持 `{current:null}`，
 * 让 useMeasure 走提前返回，从而稳定用 fallback 高度做几何断言。
 */
const hookStore = new Map();
let activeHooks = null;

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) };
  },
  useState(initial) {
    const slot = activeHooks;
    const index = slot.index++;
    if (!(index in slot.states)) slot.states[index] = typeof initial === 'function' ? initial() : initial;
    const set = (value) => {
      slot.states[index] = typeof value === 'function' ? value(slot.states[index]) : value;
    };
    return [slot.states[index], set];
  },
  useEffect(effect) {
    pendingEffects.push(effect);
    return undefined;
  },
  useRef(initial) {
    const slot = activeHooks;
    const index = slot.index++;
    if (!(index in slot.states)) slot.states[index] = { current: initial === undefined ? null : initial };
    return slot.states[index];
  },
  withHooks(component, callback) {
    let slot = hookStore.get(component);
    if (slot === undefined) {
      slot = { states: [] };
      hookStore.set(component, slot);
    }
    const previous = activeHooks;
    activeHooks = slot;
    slot.index = 0;
    try {
      return callback();
    } finally {
      activeHooks = previous;
    }
  },
};

function runEffects() {
  const queued = pendingEffects.splice(0, pendingEffects.length);
  const cleanups = [];
  for (const effect of queued) {
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }
  return cleanups;
}

/* ------------------------------------------------------------- DOM / window 替身 */

const openedUrls = [];
const styleTags = [];

function fakeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    children: [],
    attributes: {},
    textContent: '',
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    hasAttribute(name) {
      return Object.hasOwn(this.attributes, name);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append() {},
    remove() {},
    getBoundingClientRect() {
      return { width: 0, height: 0, top: 0, left: 0 };
    },
  };
}

const head = fakeElement('head');
const body = fakeElement('body');
const documentStub = {
  head,
  body,
  createElement: (tag) => fakeElement(tag),
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
};

const windowStub = {
  addEventListener() {},
  removeEventListener() {},
  open(url) {
    openedUrls.push(url);
  },
};

/* ------------------------------------------------------------------ 数据替身 */

/** 当前快照里渲染多少根柱子（测试会改这个值来同时覆盖「不需要滚动」和「需要滚动」两种布局）。 */
let pointsToRender = 4;

function snapshot() {
  const points = [];
  let cumulative = 0;
  const cycle = [0.0312, 0.0088, 0.125, 0.0042];
  const costs = [];
  for (let index = 0; index < pointsToRender; index += 1) costs.push(cycle[index % cycle.length]);
  for (let index = 0; index < costs.length; index += 1) {
    cumulative = Math.round((cumulative + costs[index]) * 10000) / 10000;
    points.push({
      id: 'p' + index,
      ts: Date.now() - (costs.length - index) * 60000,
      cost: costs[index],
      cum: cumulative,
      estimate: costs[index],
      delta: costs[index],
      peak: index % 2 === 0,
      synthetic: false,
      turn: index + 1,
      model: 'deepseek-v4-flash',
      tokens: { uncachedInput: 12000 + index * 500, output: 800, cacheRead: 40000, cacheWrite: 0, reasoning: 0 },
    });
  }
  return {
    ok: true,
    now: Date.now(),
    day: '2026-09-11',
    balance: { ok: true, currency: 'CNY', total: 42.5, granted: 0, toppedUp: 67.01, available: true, at: Date.now(), error: null },
    config: {
      maxBalance: 50,
      chartRatio: 0.62,
      pollMs: 15000,
      currency: 'CNY',
      accounting: 'delta',
      collapse: false,
      peakWindows: [[9, 12], [14, 18]],
      peakWeekdaysOnly: true,
      rates: { peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 }, offpeak: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 } },
      usageUrl: 'https://platform.deepseek.com/usage',
    },
    today: { spent: cumulative, pending: 0.42, trimmed: 0.25, count: points.length, points, lastTurnCost: costs[costs.length - 1], topUp: 0 },
    peak: { isPeak: true, windows: [[9, 12], [14, 18]], weekdaysOnly: true },
    status: { lastSampleAt: Date.now(), keyMissing: false, openTurn: 0 },
  };
}

const configPosts = [];
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.includes('/dsh-balance/config')) {
    configPosts.push(JSON.parse(init.body));
    return { ok: true, status: 200, async text() { return JSON.stringify(snapshot()); } };
  }
  if (target.includes('/dsh-balance/refresh')) {
    return { ok: true, status: 200, async text() { return JSON.stringify(snapshot()); } };
  }
  if (target.includes('/dsh-balance/state')) {
    return { ok: true, status: 200, async text() { return JSON.stringify(snapshot()); } };
  }
  throw new Error('unexpected fetch ' + target);
};

/* ----------------------------------------------------- 执行 bundle + 捕获注册 */

let entry = null;
globalThis.window = windowStub;
globalThis.document = documentStub;
windowStub.__ModuleLoader__ = { load: (value) => { entry = value; } };

const requireStub = (specifier) => {
  if (specifier === 'react') return React;
  throw new Error('client bundle required an unexpected module: ' + specifier);
};

const results = [];
function check(label, condition, detail) {
  results.push({ label, ok: !!condition, detail });
}

vm.runInThisContext(bundle, { filename: 'lib/client.js' });

check('bundle 调用了 __ModuleLoader__.load', entry !== null, String(entry));
check('bundle id 正确', entry.id === 'dsh-balance-chart', String(entry?.id));

const exportsValue = entry.factory(requireStub);

// CSS 注入发生在 factory 物化时（lazy），所以必须在 factory 之后断言。
check('head 中写入了插件样式', head.children.length === 1 && head.children[0].dataset.plugin === 'dsh-balance-chart', JSON.stringify(head.children.map((c) => c.dataset)));
// 明细表表头不许吸顶：吸顶那一行自己占掉一行，实心底色还会盖住滚上来的数据。
const pluginCss = String(head.children[0]?.textContent ?? '');
check('明细表表头不吸顶（没有 position:sticky）', !pluginCss.includes('position:sticky') && !/\.dbc-table th\{[^}]*background:/.test(pluginCss), pluginCss.match(/\.dbc-table th\{[^}]*\}/)?.[0] ?? '（没找到 .dbc-table th 规则）');
// 横向滚动条不再无条件写 scrollbar-width：设了它 Chrome 会忽略 ::-webkit-scrollbar，
// 退回系统原生粗条（Windows 10px），比预留的高度还高、把柱子底部裁掉。
// 只允许出现在 Firefox 兜底块（@supports not selector(::-webkit-scrollbar)）里。
const fbAt = pluginCss.indexOf('@supports not selector(::-webkit-scrollbar)');
const thinAt = pluginCss.indexOf('scrollbar-width:thin');
check('横向滚动条不无条件写 scrollbar-width:thin', fbAt >= 0 && thinAt > fbAt, `@supports@${fbAt} thin@${thinAt} ::${pluginCss.match(/\.dbc-upper\{[^}]*\}/)?.[0] ?? '?'}`);
// 卡片层级：必须高于宿主会话里那些吸顶元素，又必须低于 shell.overlay 那一层。
// 宿主的已知值（都写在 README 里）：代码块表头 6、输入区 / 聊天槽 7、宽度拖柄 8、overlay 层 20。
const cardRule = pluginCss.match(/\.dbc-card\{[^}]*\}/)?.[0] ?? '';
const cardZ = Number(/z-index:(\d+)/.exec(cardRule)?.[1] ?? NaN);
check('卡片层级高于宿主吸顶元素、低于 overlay 层（8 < z < 20）', cardZ > 8 && cardZ < 20, `z-index=${cardZ}（否则代码块表头会盖住设置菜单，或者卡片会戳穿全屏）`);
check('导出了 apply', typeof exportsValue.apply === 'function', typeof exportsValue.apply);
check('inject 只依赖 slots', Array.isArray(exportsValue.inject) && exportsValue.inject.length === 1 && exportsValue.inject[0] === 'slots', JSON.stringify(exportsValue.inject));

/* ---------------------------------------------------------------- 插槽替身 */

/**
 * 真实 shell 声明过的插槽表，抄自 ui-layout 与 ui-conversation 的 children 表
 * （`@deepseek-ai/dsh-client-ui-layout` 的 root 注册，以及
 * `@deepseek-ai/dsh-client-ui-conversation` 的 conversation /
 * conversation.session / conversation.session.header 注册）。
 *
 * 有了这张表，替身就能像真的 SlotCore.register 一样在「插槽没被声明」时抛错，
 * 于是插槽名拼错会当场测出来，而不是等到浏览器里什么都不显示。
 */
const DECLARED_SLOTS = {
  // ui-layout → root
  sidebar: { kind: 'single', scope: 'root' },
  conversation: { kind: 'single', scope: 'session-maybe' },
  details: { kind: 'single', scope: 'session' },
  'shell.overlay': { kind: 'list', scope: 'root' },
  // ui-conversation → conversation
  'conversation.session': { kind: 'single', scope: 'session' },
  'conversation.session.header': { kind: 'single', scope: 'session' },
  'conversation.composer': { kind: 'chain', scope: 'session' },
  'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
  'conversation.input.dock': { kind: 'list', scope: 'session' },
  'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
  'conversation.hero.workspace': { kind: 'single', scope: 'root' },
  'conversation.hero.agentPreset': { kind: 'single', scope: 'root' },
  // ui-conversation → conversation.session
  'conversation.view': { kind: 'list', scope: 'session' },
  // ui-conversation → conversation.session.header
  'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
  'conversation.session.header.actions': { kind: 'list', scope: 'session' },
  'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
};

const registrations = new Map();
const registeredKeys = new Set();
const pendingWaits = [];
const slotEvents = [];

/** 按 SlotCore 的真实规则实现 makeSlotService 的行为（见 SlotCore.register）。 */
function makeSlotService() {
  return {
    inject(key, callback) {
      const declared = DECLARED_SLOTS[key];
      if (declared === undefined) {
        // 真实实现：等父条目声明；这里记下来，让测试断言「不该等的都没等」。
        pendingWaits.push(key);
        return () => {};
      }
      slotEvents.push(['inject', key, declared.kind]);
      const dispose = callback();
      let done = false;
      return () => {
        // 真实实现返回的是幂等 disposer。
        if (done) return;
        done = true;
        if (typeof dispose === 'function') dispose();
      };
    },
    register(spec, component) {
      const declared = DECLARED_SLOTS[spec.name];
      if (declared === undefined) {
        throw new Error(`slot "${spec.name}" is not declared (a parent entry's children table must declare it)`);
      }
      if (declared.kind === 'list' && spec.id === undefined) {
        throw new Error(`list slot "${spec.name}" requires options.id`);
      }
      const key = `${spec.name}::${spec.id ?? ''}::${spec.priority ?? 0}`;
      if (registeredKeys.has(key)) {
        throw new Error(`list slot "${spec.name}" already has an entry with id "${spec.id}"`);
      }
      registeredKeys.add(key);
      registrations.set(spec.id, { spec, component, kind: declared.kind, scope: declared.scope });
      return () => {
        registrations.delete(spec.id);
        registeredKeys.delete(key);
      };
    },
  };
}

const slots = makeSlotService();
const ctx = {
  slots,
};

exportsValue.apply(ctx);

check('两个插槽目标都被真实 shell 声明过（没有在等待未声明的插槽）', pendingWaits.length === 0, JSON.stringify(pendingWaits));
check('注册了两个插槽组件', registrations.size === 2, JSON.stringify([...registrations.keys()]));
check('卡片挂在会话标题栏插槽', registrations.get('dsh-balance-chart')?.spec.name === 'conversation.session.header.utilities', registrations.get('dsh-balance-chart')?.spec.name);
check('卡片插槽是 session 作用域的 list', registrations.get('dsh-balance-chart')?.kind === 'list' && registrations.get('dsh-balance-chart')?.scope === 'session', JSON.stringify({ kind: registrations.get('dsh-balance-chart')?.kind, scope: registrations.get('dsh-balance-chart')?.scope }));
check('全屏挂在 shell.overlay 插槽', registrations.get('dsh-balance-chart-fullscreen')?.spec.name === 'shell.overlay', registrations.get('dsh-balance-chart-fullscreen')?.spec.name);
check('全屏插槽是 root 作用域的 list', registrations.get('dsh-balance-chart-fullscreen')?.kind === 'list' && registrations.get('dsh-balance-chart-fullscreen')?.scope === 'root', JSON.stringify({ kind: registrations.get('dsh-balance-chart-fullscreen')?.kind, scope: registrations.get('dsh-balance-chart-fullscreen')?.scope }));
check('两个注册用了不同的 id（不会撞 SlotCore 的重复检查）', registeredKeys.size === 2, JSON.stringify([...registeredKeys]));

// 重复物化必须被框架拒绝——这正是「同一 id 注册两次」的护栏。
let duplicateRejected = false;
try {
  slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-balance-chart', inject: () => ({}) }, ChartCardPlaceholder);
} catch {
  duplicateRejected = true;
}
check('同一 (插槽, id) 重复注册会被拒绝', duplicateRejected, '');

// 插槽名拼错必须被框架拒绝——证明前面那条「已被声明」的断言真的在起作用。
let typoRejected = false;
try {
  slots.register({ name: 'conversation.session.header.utility', id: 'x', inject: () => ({}) }, ChartCardPlaceholder);
} catch {
  typoRejected = true;
}
check('拼错插槽名会被拒绝', typoRejected, '');

function ChartCardPlaceholder() {
  return null;
}

/* -------------------------------------------------------------- 渲染整棵树 */

/** 把元素树里的函数组件递归展开成纯宿主节点树（等价于 React 的一次渲染）。 */
function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(expand).filter((child) => child !== null);
  const type = node.type;
  const props = node.props ?? {};
  const own = Array.isArray(node.children) && node.children.length > 0
    ? node.children
    : props.children !== undefined ? [props.children] : [];
  if (typeof type === 'function') {
    return expand(React.withHooks(type, () => type({ ...props, children: own.length === 1 ? own[0] : own })));
  }
  if (typeof type !== 'string') return null;
  return { type, props, children: own.map(expand).filter((child) => child !== null) };
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return (node.children ?? []).map(textOf).join(' ');
}

function countBy(node, predicate) {
  if (node === null || node === undefined || typeof node === 'string') return 0;
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + countBy(child, predicate), 0);
  let total = predicate(node) ? 1 : 0;
  for (const child of node.children ?? []) total += countBy(child, predicate);
  return total;
}

function render(component, props) {
  // 必须走 expand，hook 作用域才建立得起来（直接调 component() 会让 activeHooks 为 null）。
  return expand({ type: component, props: props ?? {}, children: [] });
}

const ChartCard = registrations.get('dsh-balance-chart').component;
const Fullscreen = registrations.get('dsh-balance-chart-fullscreen').component;

// 第一遍渲染：数据还没拉回来（展示加载态），同时 component 内部的 useEffect 会触发 pull()。
let cleanups = [];
let tree = render(ChartCard);
check('未取到数据时渲染加载态', textOf(tree).includes('加载中'), textOf(tree).slice(0, 60));

cleanups = cleanups.concat(runEffects());
await new Promise((resolve) => setTimeout(resolve, 60));

// 第二遍渲染：模块级快照已就绪。
tree = render(ChartCard);
cleanups = cleanups.concat(runEffects());
let text = textOf(tree);
// 时间条左边只剩一个词，就是当前时段（高峰时段 / 峰谷时段）；「峰谷」「高峰」两个旧标签已删。
{
  const tagNode = findFirst(tree, (n) => typeof n.props.className === 'string' && n.props.className.startsWith('dbc-peak-tag'));
  check('时段标签 = 「高峰时段」或「峰谷时段」', tagNode !== null && ['高峰时段', '峰谷时段'].includes(textOf(tagNode)), String(tagNode && textOf(tagNode)));
  check('旧的「峰谷 / 高峰」两个标签已经删掉', countBy(tree, (n) => typeof n.props.className === 'string' && n.props.className.startsWith('dbc-peak-state')) === 0, '');
  check('时段标签带峰/谷配色类', tagNode !== null && /is-(peak|off)/.test(String(tagNode.props.className)), String(tagNode && tagNode.props.className));
}
check('渲染出今日消耗（已结算 + 进行中）', text.includes('今日消耗 ¥0.59'), text.slice(0, 240));
check('渲染出账户余额 / 100% 基准 · 百分比', text.includes('42.50 / 50.00 · 85.0%'), text.slice(0, 480));
check('柱峰/线峰标注存在', text.includes('柱峰') && text.includes('线峰'), text.slice(0, 480));
check('峰谷条渲染了 24 个小时格', countBy(tree, (n) => typeof n.props.className === 'string' && n.props.className.includes('dbc-peak-cell')) === 24, String(countBy(tree, (n) => typeof n.props.className === 'string' && n.props.className.includes('dbc-peak-cell'))));
check('柱状图渲染了 4 根柱子', countBy(tree, (n) => n.type === 'rect' && n.props.rx !== undefined) >= 4, String(countBy(tree, (n) => n.type === 'rect' && n.props.rx !== undefined)));
check('折线图渲染了 polyline', countBy(tree, (n) => n.type === 'polyline') === 1, String(countBy(tree, (n) => n.type === 'polyline')));

/* ------------------------------------------- 悬停反馈（柱子和折线共用一列 x） */

{
  const chartSvg = findFirst(tree, (n) => typeof n.props.onMouseMove === 'function' && typeof n.props.onMouseLeave === 'function');
  check('图表挂了悬停事件', chartSvg !== null, '');
  if (chartSvg !== null) {
    // 假 DOM 没有布局，所以把「元素盒」按 svg 自己的 width 报回去，
    // 这样 clientX 就是 SVG 用户坐标，落点可算。
    const at = (clientX) => ({ clientX, currentTarget: { getBoundingClientRect: () => ({ left: 0, width: Number(chartSvg.props.width) }) } });
    chartSvg.props.onMouseMove(at(7)); // centers[0] = 1 + step/2 = 7
    tree = render(ChartCard);
    cleanups = cleanups.concat(runEffects());
    const hoverText = textOf(tree);
    check('悬停弹出提示：时间 + 本轮 + 累计', /\d{2}:\d{2}/.test(hoverText) && hoverText.includes('本轮') && hoverText.includes('累计'), hoverText.slice(0, 300));
    check('悬停高亮了那一列（列底 + 导引线）', countBy(tree, (n) => n.type === 'rect' && n.props.fill === 'currentColor' && n.props.fillOpacity === 0.08) === 1 && countBy(tree, (n) => n.type === 'line' && n.props.strokeDasharray !== undefined) === 1, '');
    const hoveredSvg = findFirst(tree, (n) => typeof n.props.onMouseLeave === 'function');
    hoveredSvg.props.onMouseLeave();
    tree = render(ChartCard);
    cleanups = cleanups.concat(runEffects());
    check('移开鼠标后提示消失', !textOf(tree).includes('本轮'), textOf(tree).slice(0, 240));
  }
}

// 点峰谷条应打开用量页
const peakStrip = findFirst(tree, (node) => node.props && node.props.role === 'button' && typeof node.props.onClick === 'function');
check('峰谷条是可点击控件', peakStrip !== null, String(peakStrip));
if (peakStrip !== null) {
  peakStrip.props.onClick();
  check('点击峰谷条打开 platform.deepseek.com/usage', openedUrls.some((u) => u.includes('platform.deepseek.com/usage')), JSON.stringify(openedUrls));
}

// 设置面板：切换后应渲染出表单
const settingsButton = findFirst(tree, (node) => node.props && node.props.title === '图表设置' && typeof node.props.onClick === 'function');
check('存在设置按钮', settingsButton !== null, String(settingsButton));
if (settingsButton !== null) {
  settingsButton.props.onClick();
  tree = render(ChartCard);
  cleanups = cleanups.concat(runEffects());
  text = textOf(tree);
  check('设置面板可打开', text.includes('余额 100% 基准') && text.includes('记账方式'), text.slice(0, 240));
  check('设置面板含峰谷价卡', text.includes('高峰价卡') && text.includes('空闲价卡'), '');

  // 先真的改一下输入框，验证控件接线（而不是把初始草稿原样提交回去）
  const inputs = findAll(tree, (node) => node.type === 'input');
  const rangeInput = inputs.find((node) => node.props.type === 'range');
  const numberInputs = inputs.filter((node) => node.props.type === 'number');
  const maxBalanceInput = numberInputs[0];
  check('设置面板里已经没有比例滑块（锁死 65%）', rangeInput === undefined, `inputs=${inputs.length}`);
  check('设置面板里有余额基准数字框', maxBalanceInput !== undefined, `numberInputs=${numberInputs.length}`);
  if (maxBalanceInput !== undefined) maxBalanceInput.props.onChange({ target: { value: '20' } });

  // 改完要重新渲染：真实 React 里 setState 会重新渲染，用户点的是**新**那棵树上的
  // 保存按钮（带着更新后的 draft 闭包）。老树上的 onClick 还闭包着旧值。
  tree = render(ChartCard);
  cleanups = cleanups.concat(runEffects());
  const freshSave = findFirst(tree, (node) => node.props && node.props.className && String(node.props.className).includes('dbc-abtn primary') && typeof node.props.onClick === 'function');

  // 找到「保存」并点击，验证会 POST 配置
  const saveButton = freshSave ?? findFirst(tree, (node) => node.props && node.props.className && String(node.props.className).includes('dbc-abtn primary') && typeof node.props.onClick === 'function');
  check('存在保存按钮', saveButton !== null, String(saveButton));
  if (saveButton !== null) {
    await saveButton.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    check('保存会 POST 到 /dsh-balance/config', configPosts.length === 1, JSON.stringify(configPosts));
    const body = configPosts[0] ?? {};
    check('保存的内容包含四项关键配置', body.maxBalance !== undefined && body.chartRatio !== undefined && body.peakWindows !== undefined && body.rates !== undefined, JSON.stringify(body));
    check('峰谷时段被解析为区间数组', Array.isArray(body.peakWindows) && body.peakWindows.length === 2 && body.peakWindows[0][0] === 9 && body.peakWindows[1][1] === 18, JSON.stringify(body.peakWindows));
    check('比例被锁死在 0.65（不跟设置走）', body.chartRatio === 0.65, String(body.chartRatio));
    check('余额基准改动进入了提交内容（20）', body.maxBalance === 20, String(body.maxBalance));
  }

  /* ------------------------------------------- 双层比例不变性（含滚动条让位） */

  const refreshButton = findFirst(tree, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('dbc-abtn') && textOf(node).includes('立即刷新余额'));
  check('存在立即刷新余额按钮', refreshButton !== null, '');

  if (refreshButton !== null) {
    const measure = () => {
      const upper = findFirst(tree, (node) => node.type === 'div' && node.props.className === 'dbc-upper');
      const lower = findFirst(tree, (node) => node.type === 'div' && node.props.className === 'dbc-lower');
      const svg = upper === null ? null : findFirst(upper, (node) => node.type === 'svg');
      return {
        box: upper === null ? null : Number.parseFloat(upper.props.style.height),
        chart: svg === null ? null : Number(svg.props.height),
        lower: lower === null ? null : Number.parseFloat(lower.props.style.height),
      };
    };
    const grab = async (count) => {
      pointsToRender = count;
      await refreshButton.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 40));
      tree = render(ChartCard);
      cleanups = cleanups.concat(runEffects());
      return measure();
    };

    // 未量到尺寸时 Plot 用 fallbackHeight = 96；step = 12、宽度下限 160、层间距 6。
    const few = await grab(4); // 4*12+14 = 62 < 160 -> 不滚动
    const many = await grab(40); // 40*12+14 = 494 > 160 -> 出现横向滚动条

    check('不滚动时上层容器高度等于图表高度', few.box === few.chart, JSON.stringify(few));
    check('不滚动时 上层 + 间距 + 下层 = 图表区总高', few.chart + 6 + few.lower === 96, JSON.stringify(few));
    check('不滚动时两层比例 = 65%', Math.abs(few.chart / (few.chart + few.lower) - 0.65) < 0.02, String(few.chart / (few.chart + few.lower)));

    // 让位像素必须和 .dbc-upper 的 ::-webkit-scrollbar 高度一致（宿主 --dsh-scrollbar-width = 8px）。
    check('滚动时容器为滚动条额外让出 8px', many.box === many.chart + 8, JSON.stringify(many));
    check('滚动时 容器 + 间距 + 下层 = 图表区总高（柱子不会被裁掉）', many.box + 6 + many.lower === 96, JSON.stringify(many));
    check('滚动时两层比例仍是 65%', Math.abs(many.chart / (many.chart + many.lower) - 0.65) < 0.02, String(many.chart / (many.chart + many.lower)));
    check('滚动时柱子数变多', countBy(tree, (node) => node.type === 'rect' && node.props.rx !== undefined) >= 40, String(countBy(tree, (node) => node.type === 'rect' && node.props.rx !== undefined)));
  }
}

// 全屏视图：默认关闭
check('全屏默认关闭', render(Fullscreen) === null, String(render(Fullscreen)));

const fullscreenButton = findFirst(tree, (node) => node.props && node.props.title === '全屏查看' && typeof node.props.onClick === 'function');
check('存在全屏按钮', fullscreenButton !== null, String(fullscreenButton));
if (fullscreenButton !== null) {
  fullscreenButton.props.onClick();
  const fsTree = render(Fullscreen);
  cleanups = cleanups.concat(runEffects());
  check('全屏视图可打开', fsTree !== null, String(fsTree));
  if (fsTree !== null) {
    const fsText = textOf(fsTree);
    check('全屏显示今日消耗与轮次', fsText.includes('今日消耗') && fsText.includes('对话轮次'), fsText.slice(0, 240));
    check('全屏含明细表', fsText.includes('本轮消耗') && fsText.includes('未命中输入'), fsText.slice(0, 320));
    check('全屏含图例', fsText.includes('空闲价轮次消耗') && fsText.includes('当日累计'), fsText.slice(0, 320));
    check('全屏提示滚出窗口的历史金额', fsText.includes('滚出窗口') && fsText.includes('¥0.25'), fsText.slice(0, 480));
    check('全屏渲染了更大的柱子', countBy(fsTree, (n) => n.type === 'rect' && n.props.rx !== undefined) >= 4, String(countBy(fsTree, (n) => n.type === 'rect' && n.props.rx !== undefined)));
  }
  // 关闭全屏，确认回到 null
  const closeButton = findFirst(fsTree ?? [], (node) => node.props && node.props.title === '关闭（Esc）' && typeof node.props.onClick === 'function');
  if (closeButton !== null) {
    closeButton.props.onClick();
    check('全屏可关闭', render(Fullscreen) === null, String(render(Fullscreen)));
  }
}

/* ------------------------------------------------------------------ 工具函数 */

function findFirst(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findFirst(child, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const hit = findFirst(child, predicate);
    if (hit !== null) return hit;
  }
  return null;
}

/** 按渲染顺序收集所有满足条件的节点（设置面板里要按顺序认输入框）。 */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, out);
  return out;
}

for (const cleanup of cleanups) {
  try {
    cleanup();
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------------------- 汇总 */

let failed = 0;
for (const item of results) {
  if (!item.ok) failed += 1;
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok ? '' : `   -> ${item.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed > 0 ? 1 : 0);
