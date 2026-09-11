window.__ModuleLoader__.load({
	id: "dsh-balance-chart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const h = react.createElement;

		/* ------------------------------------------------------------------ 配色 */

		/**
		 * 配色：DeepSeek 特征蓝 #4D6BFE + 与之配套的高饱和橙，
		 * 正好对应平台的峰谷计价（空闲=蓝、高峰=橙）。
		 * 折线（当日累计）是另一个量纲，用同一支蓝再深/浅一档区分，
		 * 避免和「空闲价柱子」撞色；灰色只留给「非对话消耗」。
		 *
		 * FILL_OFF / FILL_PEAK 是**峰谷条和余额条共用的填充色**：
		 * 两处都从这两个常量取值，改一处就一起变，不会再出现「余额的蓝和峰谷的蓝不一样」。
		 */
		const DS_BLUE = "#4d6bfe";
		const DS_ORANGE = "#ff7a2a";
		const OFF_COLOR = DS_BLUE;
		const PEAK_COLOR = DS_ORANGE;
		const OTHER_COLOR = "#94a3b8";
		const LINE_COLOR_LIGHT = "#1226b8";
		const LINE_COLOR_DARK = "#9db0ff";
		const FILL_OFF = "rgba(77,107,254,.78)";
		const FILL_PEAK = "rgba(255,122,42,.92)";
		/** 深色主题下深蓝折线会糊在背景里，所以折线颜色随主题走。 */
		const lineColor = () => (isDark() ? LINE_COLOR_DARK : LINE_COLOR_LIGHT);
		/** 上层图表占比锁死在 65%（设置里不再暴露这个选项）。 */
		const CHART_RATIO = 0.65;
		/**
		 * 上下两行（时段条 / 账户余额条）和图表共用这一组列宽：
		 *
		 *   [标签 52][gap 8][轨道 flex:1][gap 8][数值 96][gap 6][按钮 84]
		 *   [标签 52][gap 8][轨道 flex:1][gap 8][数值 96][gap 6][（按钮那一列空着）]
		 *
		 * - 左列取「4 个字」的宽度：上行「高峰时段」、下行「账户余额」，一样宽，左右边缘都对齐。
		 * - 数值左对齐、紧贴轨道（8px）：右边不留大空白；数值格按「今日消耗 ¥0.00」这点长度留余量，
		 *   所以三个按钮也紧挨着文字。
		 * - **图表**不跟轨道对齐，而是跟文字边界对齐：左右各缩进 2px，
		 *   左边缘 = 左列文字的左边、右边缘 = 右列（数值 / 按钮）的右边。
		 * - 全屏那一行里右边没有按钮，但金额那一串更长（含 100% 基准），
		 *   所以全屏用更宽的数值列 `ROW_VALUE_W_FULL`，时段条那一格也一起加宽，两条轨道才对齐。
		 */
		const ROW_EDGE_INSET = 2;
		const ROW_LABEL_W = 52;
		const ROW_VALUE_W = 96;
		const ROW_VALUE_W_FULL = 150;
		const ROW_BTNS_W = 84;
		const ROW_GAP = 8;
		const ROW_BTNS_GAP = 6;
		/**
		 * 柱子超宽时横向滚动条占掉的高度：上层图表要先让出这么多，比例才不会被吃掉。
		 *
		 * 8px 不是猜的——宿主的 DSH 主题给**所有**滚动条统一上了 8px 皮肤
		 * （`body{--dsh-scrollbar-width:8px}` + 全局 `::-webkit-scrollbar{width:8px;height:8px}`），
		 * 插件只做「和宿主同宽」的那一条（见 `.dbc-upper` 的 `::-webkit-scrollbar`），
		 * 所以这个值是确定的。原来写 7px 配 `scrollbar-width:thin`：Chrome 里只要设了
		 * `scrollbar-width`，`::-webkit-scrollbar` 的样式就被整块忽略，退回**系统原生**滚动条
		 * （Windows 实测 10px、还带箭头按钮），于是白留少 3px，柱子底部被裁掉，
		 * 0.65 的比例承诺也跟着破了。
		 */
		const SCROLLBAR = 8;
		/** 上下两层之间的缝：必须和 .dbc-plot / .dbc-fs-plot 的 gap 一致。 */
		const PLOT_GAP = 6;
		/** 柱子的横向步长：卡片里密一点（12px），全屏里松一点（一条柱子一根柱位）。 */
		const CARD_STEP = 12;
		const FULL_STEP = 22;

		/* ------------------------------------------------------------------ CSS */

		const css = [
			// 卡片不占标题行：占位块宽高都归零，标题行恢复自己的自然高度（min-height:32px），
			// 面包屑和右侧的「标准模式 / 后台任务」按钮都不再被挤。
			// 卡片本身绝对定位，落到下一行——和「对话 / 轨迹」标签同一排、水平居中。
			// 垂直位置：占位块高度 0，被标题行的 align-items:center 居中，
			// 所以 static 位置 = 标题行垂直中心（真实 GUI 里 = 顶栏 padding 12px + 标题行 32px 的一半 = 28px）。
			// 标签行文字的中心 = 12 + 32 + margin-top 4px + 那一行字形盒的一半 ≈ 58.5px（实测），
			// 折叠卡片 26px 高 -> 顶部要在 58.5 - 13 = 45.5px，即相对 static 位置再下移 17.5px。
			// 用相对 static 位置的 margin 而不是写死 top:45.5px：顶栏 padding 变了也会跟着走。
			'.dbc-slot{position:static;width:0;height:0}',
			// z-index:10 是算出来的，不是拍的：卡片和设置菜单要盖住**宿主自己的吸顶元素**，
			// 不然滚动会话时它们会被画在菜单上面。已知的这几层（全部来自宿主 CSS）：
			//   代码块表头 `._bannerWrap_5swpp_23{position:sticky;top:0;z-index:6}`
			//   （就是「复制」那一行，实测会盖住设置窗口）、输入区 `.wSkVaW_composerSeat{z-index:7}`、
			//   聊天槽 `.eGxaPq_slot{z-index:7}` / `.EvIC1a_toBottomSlot{z-index:8}`、
			//   宽度拖柄 `.wSkVaW_widthHandle{z-index:8}`。
			// 上限是 20：`shell.overlay` 那一层是 `.pI_x6G_overlayLayer{z-index:20}`，
			// 卡片必须低于它，全屏才能照样盖住卡片。
			// （以前的 2 比代码块表头的 6 小，所以菜单被那一条横条压住。）
			'.dbc-card{box-sizing:border-box;position:absolute;left:50%;transform:translateX(-50%);margin-top:17.5px;z-index:10;display:flex;flex-direction:column;gap:4px;height:152px;width:min(640px,54vw);min-width:300px;padding:0;font-family:var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary,#16181d)}',
			'.dbc-card.is-collapsed{height:26px;gap:0}',
			// 展开态：让标签行（标题行的下一个兄弟）留出卡片高度。选择器只依赖插槽锚点
			// 和结构位置；只有一个视图、没有标签行时匹配不上，卡片会压住对话区顶部。
			// align-items:flex-start 是必须的：标签行是 flex，默认 stretch 会把
			// <button> 拉满 152px，而按钮内部会把文字居中——「对话 / 轨迹」就被推到中间去了。
			'[data-slot="conversation.session.header"]:has(.dbc-card:not(.is-collapsed)) > * > *:nth-child(2){min-height:152px;align-items:flex-start}',
			// 右边留 inset（按钮不贴卡片边缘），左边不留：这样时段标签和下行「账户余额」从同一个 x 开始。
			'.dbc-top{display:flex;align-items:center;gap:' + ROW_BTNS_GAP + 'px;height:26px;flex:none;padding:0 ' + ROW_EDGE_INSET + 'px 0 0}',
			// 峰谷条不再有自己的「胶囊」外框和渐变底：去掉边框 / 圆角底 / 渐变，只剩内容本身。
			// 仍然可点（打开平台用量页），所以保留 cursor 和 hover 时的一点底色反馈。
			'.dbc-peak{flex:1;min-width:0;display:flex;align-items:center;gap:' + ROW_GAP + 'px;height:100%;padding:0 ' + ROW_EDGE_INSET + 'px;cursor:pointer;transition:background .12s ease}',
			'.dbc-peak:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10))}',
			// 时间条左边那一个词就是当前时段，颜色跟着峰 / 谷走（不再另写「峰谷 / 高峰」两个标签）。
			// 宽度按「4 个字」定死、左对齐：和下面「账户余额」一样宽，左右边缘都对齐。
			'.dbc-peak-tag{flex:none;width:' + ROW_LABEL_W + 'px;text-align:left;font-size:12px;font-weight:700;letter-spacing:.2px}',
			'.dbc-peak-tag.is-peak{color:#e2680d}',
			'.dbc-peak-tag.is-off{color:#2f4fd8}',
			'.dbc-peak-track{position:relative;flex:1;min-width:34px;height:11px;display:flex;border-radius:4px;overflow:hidden}',
			'.dbc-peak-cell{flex:1;background:' + FILL_OFF + '}',
			'.dbc-peak-cell.is-peak{background:' + FILL_PEAK + '}',
			// 当前时刻游标：细一点、用文字的灰，不要一根黑杠。
			'.dbc-peak-cursor{position:absolute;top:-2px;bottom:-2px;width:1.5px;border-radius:1px;background:var(--dsw-alias-label-secondary,#5b6270);pointer-events:none}',
			// 数值格左对齐：文字紧贴自己那根轨道（只隔一个行间距），右边不留大空白。
			'.dbc-peak-spend{flex:none;width:' + ROW_VALUE_W + 'px;text-align:left;font-size:12px;color:var(--dsw-alias-label-secondary,#5b6270);font-variant-numeric:tabular-nums}',
			'.dbc-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary,#8b93a1);cursor:pointer}',
			'.dbc-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,#16181d)}',
			'.dbc-plot{flex:1;min-height:0;display:flex;flex-direction:column;gap:' + PLOT_GAP + 'px;overflow:hidden}',
			// 横向滚动条：**不要写 scrollbar-width:thin**。Chrome 里只要设了 scrollbar-width，
			// ::-webkit-scrollbar 的自定义样式就被整块忽略、退回系统原生滚动条，于是这一条会比其他
			// 滚动条粗一大截（还带箭头按钮），也超过 SCROLLBAR 预留的高度、把柱子底部裁掉 3px。
			// 只留 ::-webkit-scrollbar，宽度直接取宿主那支变量，和全站滚动条同一个观感。
			'.dbc-upper{flex:none;overflow-x:auto;overflow-y:hidden}',
			'.dbc-upper::-webkit-scrollbar{height:var(--dsh-scrollbar-width,8px)}',
			'.dbc-upper::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.4));border-radius:4px}',
			// Firefox 没有 ::-webkit-scrollbar（上面的规则不生效），按宿主主题同样的写法兜底，
			// 否则原生滚动条会比预留的高度更宽、又把柱子裁掉。
			'@supports not selector(::-webkit-scrollbar){.dbc-upper{scrollbar-width:thin}}',
			'.dbc-lower{flex:none;overflow:hidden}',
			// 余额条那一行：列宽 / 内缩 / gap 和 `.dbc-peak` 完全一致，两条轨道必然对齐。
			'.dbc-balrow{display:flex;align-items:center;gap:' + ROW_GAP + 'px;height:100%;padding:0 ' + ROW_EDGE_INSET + 'px;color:var(--dsw-alias-label-primary,#16181d)}',
			'.dbc-balrow-label{flex:none;width:' + ROW_LABEL_W + 'px;text-align:left;font-size:12px;color:var(--dsw-alias-label-secondary,#5b6270)}',
			'.dbc-bartrack{position:relative;flex:1;min-width:34px;height:11px;border-radius:4px;overflow:hidden;background:rgba(127,127,127,.16)}',
			'.dbc-barfill{position:absolute;left:0;top:0;bottom:0;border-radius:4px;background:' + FILL_OFF + '}',
			'.dbc-barfill.is-high{background:' + FILL_PEAK + '}',
			'.dbc-cap{fill:var(--dsw-alias-label-caption,#98a0ae);font-size:11px;font-family:var(--dsw-font-family,inherit)}',
			'.dbc-val{fill:var(--dsw-alias-label-secondary,#5b6270);font-size:12px;font-family:var(--dsw-font-family,inherit);font-variant-numeric:tabular-nums}',
			// 悬停提示里的数值行：主色 + 等宽数字，和标题栏其它读数一套观感。
			'.dbc-tip-val{fill:var(--dsw-alias-label-primary,#16181d);font-weight:600;font-family:var(--dsw-font-family,inherit);font-variant-numeric:tabular-nums}',
			'.dbc-pop{position:absolute;right:6px;top:calc(100% + 6px);width:340px;max-height:400px;overflow:auto;z-index:40;box-sizing:border-box;display:flex;flex-direction:column;gap:7px;padding:12px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.32));border-radius:12px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 10px 32px rgba(0,0,0,.22)}',
			'.dbc-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#5b6270)}',
			'.dbc-row>label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dbc-input{width:100px;box-sizing:border-box;padding:4px 6px;font-size:12px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.36));background:transparent;color:var(--dsw-alias-label-primary,#16181d)}',
			'.dbc-input.wide{width:160px}',
			'.dbc-num{width:62px}',
			'.dbc-sec{margin-top:3px;font-size:11px;font-weight:700;letter-spacing:.3px;color:var(--dsw-alias-label-caption,#98a0ae)}',
			'.dbc-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}',
			'.dbc-abtn{padding:5px 12px;font-size:12px;border-radius:7px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.36));background:transparent;color:var(--dsw-alias-label-primary,#16181d)}',
			'.dbc-abtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
			'.dbc-abtn.primary{border-color:transparent;background:#4d6bfe;color:#fff}',
			'.dbc-abtn.primary:hover{background:#3f5bea}',
			'.dbc-note{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-caption,#98a0ae)}',
			'.dbc-warn{font-size:11px;line-height:1.55;color:#e2680d}',
			'.dbc-fs{position:absolute;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(15,18,26,.44)}',
			'.dbc-fs-panel{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;width:100%;height:100%;padding:12px 14px;border-radius:14px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 20px 64px rgba(0,0,0,.4);color:var(--dsw-alias-label-primary,#16181d)}',
			// 右内缩和下面两行一致，全屏里「关闭按钮」的右边缘才能和余额金额的右边缘对齐。
			'.dbc-fs-head{flex:none;display:flex;align-items:center;gap:10px;padding-right:' + ROW_EDGE_INSET + 'px}',
			'.dbc-fs-title{font-size:15px;font-weight:700}',
			'.dbc-fs-metrics{margin-left:auto;display:flex;gap:16px;font-size:13px;color:var(--dsw-alias-label-secondary,#5b6270);font-variant-numeric:tabular-nums}',
			'.dbc-fs-metrics b{font-weight:700;color:var(--dsw-alias-label-primary,#16181d)}',
			// overflow:hidden：图表算出来的两层高度只允许待在容器里。原来容器不裁剪，
			// 一旦量到的高度偏大（首帧兜底值、窗口变矮），多出来的部分就横在下面的图例和
			// 明细表头上，看着就像「一条不滚动的长条挡住视线」。
			'.dbc-fs-plot{flex:1;min-height:0;display:flex;flex-direction:column;gap:' + PLOT_GAP + 'px;overflow:hidden}',
			'.dbc-fs-detail{flex:none;max-height:158px;overflow:auto;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25))}',
			'.dbc-table{width:100%;border-collapse:collapse;font-size:12px}',
			// 表头**不吸顶**（原来写的是 position:sticky;top:0）：明细区只有 158px 高、约 6 行，
			// 钉住的那一行自己就吃掉一行，而且它的实心底色会把滚上来的数据盖住——
			// 「时间/轮次/本轮消耗…」那一行不跟着数据滚、还挡在数据上面。
			// 现在它和普通行一样跟着滚；背景也不必再涂不透明色（那本来就是为盖住数据而加的）。
			'.dbc-table th{padding:4px 8px;text-align:left;font-weight:600;color:var(--dsw-alias-label-caption,#98a0ae)}',
			'.dbc-table td{padding:4px 8px;color:var(--dsw-alias-label-secondary,#5b6270);font-variant-numeric:tabular-nums;border-top:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}',
			'.dbc-table td.strong{color:var(--dsw-alias-label-primary,#16181d);font-weight:600}',
			'.dbc-empty{padding:10px 2px;font-size:12px;color:var(--dsw-alias-label-caption,#98a0ae)}',
			'.dbc-legend{display:flex;gap:12px;font-size:11px;color:var(--dsw-alias-label-caption,#98a0ae)}',
			'.dbc-legend i{display:inline-block;width:9px;height:9px;margin-right:4px;border-radius:2px;vertical-align:-1px}',
		].join("");

		const tagId = "dsh-balance-chart/chart.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-balance-chart";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/* -------------------------------------------------------------- 数据层 */

		const STATE_URL = "/dsh-balance/state";
		const CONFIG_URL = "/dsh-balance/config";
		const REFRESH_URL = "/dsh-balance/refresh";
		const POLL_MS = 4000;

		const subscribers = new Set();
		let snapshotData = null;
		let lastError = null;
		let inflight = null;
		let interval = null;
		let fullscreenOpen = false;
		let settingsOpen = false;

		function emit() {
			for (const listener of [...subscribers]) {
				try {
					listener();
				} catch (error) {
					/* 单个订阅者异常不影响其它订阅者 */
				}
			}
		}

		async function requestJson(url, init) {
			const response = await fetch(url, {
				credentials: "same-origin",
				headers: { Accept: "application/json" },
				...init,
			});
			const text = await response.text();
			if (!response.ok) throw new Error("HTTP " + response.status + (text.length > 0 ? " " + text.slice(0, 160) : ""));
			return text.length > 0 ? JSON.parse(text) : null;
		}

		function pull() {
			if (inflight !== null) return inflight;
			inflight = (async () => {
				try {
					snapshotData = await requestJson(STATE_URL, { method: "GET" });
					lastError = null;
				} catch (error) {
					lastError = String((error && error.message) || error);
				} finally {
					inflight = null;
					emit();
				}
			})();
			return inflight;
		}

		async function postConfig(patch) {
			try {
				snapshotData = await requestJson(CONFIG_URL, {
					method: "POST",
					headers: { Accept: "application/json", "Content-Type": "application/json" },
					body: JSON.stringify(patch),
				});
				lastError = null;
			} catch (error) {
				lastError = String((error && error.message) || error);
			}
			emit();
		}

		async function refreshBalance() {
			try {
				snapshotData = await requestJson(REFRESH_URL, { method: "POST" });
				lastError = null;
			} catch (error) {
				lastError = String((error && error.message) || error);
			}
			emit();
		}

		function useData() {
			const [, bump] = react.useState(0);
			react.useEffect(() => {
				const listener = () => bump((n) => n + 1);
				subscribers.add(listener);
				if (snapshotData === null) void pull();
				if (interval === null) interval = setInterval(() => void pull(), POLL_MS);
				return () => {
					subscribers.delete(listener);
					if (subscribers.size === 0 && interval !== null) {
						clearInterval(interval);
						interval = null;
					}
				};
			}, []);
			return {
				data: snapshotData,
				error: lastError,
				fullscreen: fullscreenOpen,
				settings: settingsOpen,
			};
		}

		function useMeasure(ref) {
			const [size, setSize] = react.useState({ w: 0, h: 0 });
			react.useEffect(() => {
				const el = ref.current;
				if (el === null || typeof ResizeObserver === "undefined") return undefined;
				const apply = () => {
					const rect = el.getBoundingClientRect();
					setSize((prev) => (Math.abs(prev.w - rect.width) < 0.5 && Math.abs(prev.h - rect.height) < 0.5 ? prev : { w: rect.width, h: rect.height }));
				};
				const observer = new ResizeObserver(apply);
				observer.observe(el);
				apply();
				return () => observer.disconnect();
			}, [ref]);
			return size;
		}

		/* -------------------------------------------------------------- 工具函数 */

		/** 深色主题下深蓝折线会糊在背景里，所以折线颜色随主题走。 */

		function yuan(value, digits) {
			if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--";
			const d = digits === undefined ? 2 : digits;
			return "\u00a5" + Number(value).toFixed(d);
		}

		function plain(value, digits) {
			if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--";
			const d = digits === undefined ? 2 : digits;
			return Number(value).toFixed(d);
		}

		function shortNumber(value) {
			const n = Number(value) || 0;
			if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
			if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
			return String(Math.round(n));
		}

		function clock(ts) {
			const d = new Date(ts);
			return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
		}

		function isDark() {
			if (typeof document === "undefined") return false;
			return document.body !== null && document.body.hasAttribute("data-ds-dark-theme");
		}

		function tokenTotal(tokens) {
			if (tokens === null || tokens === undefined) return 0;
			return (Number(tokens.uncachedInput) || 0) + (Number(tokens.cacheRead) || 0) + (Number(tokens.cacheWrite) || 0) + (Number(tokens.output) || 0);
		}

		/* ------------------------------------------------------------------ 图标 */

		function icon(name) {
			if (name === "settings") {
				// 齿轮：feather 风格的 cog（带齿的外圈 + 中间轴孔），不是「小太阳」那种放射线。
				// viewBox 24 换到 16px 显示，stroke 2 -> 实显约 1.33px，和另外两个图标同粗。
				return h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", "aria-hidden": "true" }, [
					h("circle", { key: "c", cx: 12, cy: 12, r: 3.2, fill: "none", stroke: "currentColor", strokeWidth: 2 }),
					h("path", {
						key: "p",
						d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 2,
						strokeLinecap: "round",
						strokeLinejoin: "round",
					}),
				]);
			}
			if (name === "expand") {
				return h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": "true" }, [
					h("path", { key: "p", d: "M2.2 6V2.2H6M13.8 6V2.2H10M2.2 10v3.8H6M13.8 10v3.8H10", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }),
				]);
			}
			if (name === "close") {
				return h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": "true" }, [
					h("path", { key: "p", d: "M4 4l8 8M12 4l-8 8", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }),
				]);
			}
			return null;
		}

		/* ------------------------------------------------------------ 峰谷实时条 */

		function PeakStrip(props) {
			const data = props.data;
			const config = data.config;
			const now = new Date(data.now);
			const weekend = now.getDay() === 0 || now.getDay() === 6;
			const windows = config.peakWindows || [];
			const cells = [];
			for (let hour = 0; hour < 24; hour += 1) {
				const peak = config.peakWeekdaysOnly && !weekend && windows.some((pair) => hour >= pair[0] && hour < pair[1]);
				cells.push(h("div", {
					key: hour,
					className: peak ? "dbc-peak-cell is-peak" : "dbc-peak-cell",
					title: String(hour).padStart(2, "0") + ":00 " + (peak ? "高峰" : "空闲"),
				}));
			}
			const cursorPct = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;
			cells.push(h("div", { key: "cursor", className: "dbc-peak-cursor", style: { left: cursorPct + "%" } }));

			const rate = data.peak.isPeak ? config.rates.peak : config.rates.offpeak;
			const pending = Number(data.today.pending) || 0;
			const spent = Number(data.today.spent) || 0;
			// 口径就是「今天总共花掉多少」：已结算 + 进行中，一次给一个数，
			// 而不是让人自己去加「今日 ¥x +¥y」。
			const todayTotal = Math.round((spent + pending) * 10000) / 10000;
			const title = [
				"峰谷时段：工作日 " + windows.map((pair) => pair[0] + ":00-" + pair[1] + ":00").join(" 与 ") + " 为高峰，其余时间（含周末）为空闲",
				"当前" + (data.peak.isPeak ? "高峰" : "空闲") + "：缓存命中 " + rate.cacheHit + " 元/M，未命中 " + rate.cacheMiss + " 元/M，输出 " + rate.output + " 元/M",
				"点击打开 DeepSeek 平台用量页",
			].join("\n");
			// 时间条左边那一个词就是当前时段：高峰时段（橙）/ 峰谷时段（蓝）。
			const stateClass = data.peak.isPeak ? "is-peak" : "is-off";
			const stateText = data.peak.isPeak ? "高峰时段" : "峰谷时段";

			return h("div", {
				className: "dbc-peak",
				role: "button",
				tabIndex: 0,
				title: title,
				onClick: () => {
					window.open(config.usageUrl, "_blank", "noopener,noreferrer");
				},
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						window.open(config.usageUrl, "_blank", "noopener,noreferrer");
					}
				},
			}, [
				h("span", { key: "tag", className: "dbc-peak-tag " + stateClass }, stateText),
				h("div", { key: "track", className: "dbc-peak-track" }, cells),
				h("span", {
					key: "spend",
					className: "dbc-peak-spend",
					// 全屏里这一格要放宽，和下面「余额 / 基准」那一串等宽，两条轨道才对得齐。
					style: { width: (Number(props.valueWidth) || ROW_VALUE_W) + "px" },
					title: [
						"今日消耗 " + yuan(todayTotal) + " = 已结算 " + yuan(spent) + (pending > 0 ? " + 进行中 " + yuan(pending) : ""),
						"口径：当天观测到的**全部**余额下降——本机对话、别的客户端、dsh web 关着的那段时间都算在内。",
						typeof data.today.from === "number" ? "这份记录从 " + clock(data.today.from) + " 起；比这更早的消耗插件当时没在跑，只能到平台用量页核对。" : "",
					].filter((line) => line.length > 0).join("\n"),
				}, "今日消耗 " + yuan(todayTotal)),
			]);
		}

		/* ------------------------------------------------- 上层：竖向柱状图 + 折线 */

		/**
		 * 悬停提示要自己排版（SVG 没有自动换行/自适应宽度），所以粗略量一下文字宽度：
		 * 中日韩字符按 1 个字宽算，其余按 0.56 个字宽算。够用就好，不需要精确。
		 */
		function textWidth(text, size) {
			let wide = 0;
			let narrow = 0;
			for (const ch of String(text)) {
				if (ch.codePointAt(0) > 0x2e80) wide += 1;
				else narrow += 1;
			}
			return wide * size + narrow * size * 0.56;
		}

		/** 悬停时那一列的文字（第一行是时间 + 这一笔是什么）。 */
		function hoverRows(point, full) {
			const kind = point.offline
				? "离线期间"
				: point.synthetic
					? "其他消耗"
					: "第 " + point.turn + " 轮 · " + (point.peak ? "高峰价" : "空闲价");
			const rows = [
				clock(point.ts) + " · " + kind,
				"本轮 " + yuan(point.cost, 4),
				"累计 " + yuan(point.cum, 4),
			];
			if (full) {
				rows.push("余额差值 " + yuan(point.delta, 4) + " / 换算 " + yuan(point.estimate, 4));
				rows.push("tokens " + shortNumber(tokenTotal(point.tokens)) + "（未命中 " + shortNumber(point.tokens.uncachedInput) + " / 命中 " + shortNumber(point.tokens.cacheRead) + " / 输出 " + shortNumber(point.tokens.output) + "）");
				if (point.model) rows.push("模型 " + point.model);
			}
			return rows;
		}

		function TurnBars(props) {
			const data = props.data;
			const width = props.width;
			const height = props.height;
			const step = props.step;
			const full = props.detail === "full";
			const points = data.today.points || [];
			const leftPad = 1;
			const contentWidth = Math.max(width, points.length * step + step + leftPad * 2);
			/* 上层高度很小时按比例缩小顶部留白，否则 12px 的标注会把柱子压扁。 */
			const topPad = Math.max(11, Math.min(17, Math.round(height * 0.24)));
			const baseY = height - 1;
			const plotHeight = Math.max(6, baseY - topPad);

			// 悬停：鼠标落在哪一列，就高亮那一列 + 弹一个小面板（时间 / 本轮 / 累计），
			// 柱子和折线用的是同一组 x 坐标，所以一次悬停同时给出两个读数。
			const [hover, setHover] = react.useState(null);
			const lastIndex = points.length - 1;
			const hovered = hover !== null && hover >= 0 && hover <= lastIndex ? hover : null;

			let maxCost = 0;
			let maxCum = 0;
			for (const point of points) {
				if (point.cost > maxCost) maxCost = point.cost;
				if (point.cum > maxCum) maxCum = point.cum;
			}
			if (maxCost <= 0) maxCost = 0.0001;
			if (maxCum <= 0) maxCum = 0.0001;

			const barWidth = Math.max(3, Math.min(step - 4, 16));
			const children = [];

			children.push(h("rect", { key: "bg", x: 0, y: 0, width: contentWidth, height: height, fill: "transparent" }));
			for (let line = 1; line <= 2; line += 1) {
				const y = topPad + (plotHeight / 3) * line;
				children.push(h("line", { key: "grid" + line, x1: 0, y1: y, x2: contentWidth, y2: y, stroke: "currentColor", strokeOpacity: 0.10, strokeWidth: 0.5 }));
			}
			children.push(h("line", { key: "base", x1: 0, y1: baseY, x2: contentWidth, y2: baseY, stroke: "currentColor", strokeOpacity: 0.28, strokeWidth: 0.8 }));

			const centers = [];
			for (let index = 0; index < points.length; index += 1) {
				const point = points[index];
				const cx = leftPad + step * index + step / 2;
				centers.push(cx);
				const barHeight = point.cost > 0 ? Math.max(1, (point.cost / maxCost) * plotHeight) : 0;
				if (barHeight > 0) {
					const isHovered = hovered === index;
					children.push(h("rect", {
						key: "bar" + index,
						x: cx - barWidth / 2,
						y: baseY - barHeight,
						width: barWidth,
						height: barHeight,
						rx: Math.min(1.5, barWidth / 3),
						fill: point.synthetic ? OTHER_COLOR : point.peak ? PEAK_COLOR : OFF_COLOR,
						fillOpacity: isHovered ? 1 : hovered === null ? 1 : 0.55,
					}));
				}
			}

			if (points.length > 0) {
				const linePoints = [leftPad + " " + baseY];
				for (let index = 0; index < points.length; index += 1) {
					const y = baseY - (points[index].cum / maxCum) * plotHeight;
					linePoints.push(centers[index] + " " + y.toFixed(2));
				}
				const areaPath = "M " + leftPad + " " + baseY + " L " + linePoints.slice(1).join(" L ") + " L " + centers[centers.length - 1] + " " + baseY + " Z";
				children.push(h("path", { key: "area", d: areaPath, fill: lineColor(), fillOpacity: 0.14, stroke: "none" }));
				children.push(h("polyline", { key: "line", points: linePoints.join(" "), fill: "none", stroke: lineColor(), strokeWidth: 1.8, strokeLinejoin: "round", strokeLinecap: "round" }));
				for (let index = 0; index < points.length; index += 1) {
					const y = baseY - (points[index].cum / maxCum) * plotHeight;
					children.push(h("circle", { key: "dot" + index, cx: centers[index], cy: y, r: points.length > 60 ? 1.2 : 2, fill: lineColor() }));
				}
			}

			if (hovered !== null && points.length > 0) {
				const point = points[hovered];
				const cx = centers[hovered];
				const dotY = baseY - (point.cum / maxCum) * plotHeight;
				children.push(h("rect", {
					key: "hover-col",
					x: Math.max(0, cx - step / 2 + 1),
					y: 0,
					width: Math.max(2, step - 2),
					height: height,
					rx: 2,
					fill: "currentColor",
					fillOpacity: 0.08,
					pointerEvents: "none",
				}));
				children.push(h("line", {
					key: "hover-guide",
					x1: cx, y1: Math.max(0, topPad - 6), x2: cx, y2: baseY,
					stroke: "currentColor", strokeOpacity: 0.32, strokeWidth: 1,
					strokeDasharray: "2 2", pointerEvents: "none",
				}));
				// 折线上被选中的那个点：外面套一圈底色，保证在任何背景上都看得清。
				children.push(h("circle", { key: "hover-dot-ring", cx: cx, cy: dotY, r: 4.2, fill: "var(--dsw-alias-bg-base,#fff)", pointerEvents: "none" }));
				children.push(h("circle", { key: "hover-dot", cx: cx, cy: dotY, r: 2.6, fill: lineColor(), pointerEvents: "none" }));

				const rows = hoverRows(point, full);
				const fontSize = full ? 12 : 11;
				const lineHeight = fontSize + 3;
				const padX = 8;
				const padY = 6;
				const boxW = Math.min(contentWidth, Math.max(...rows.map((row) => textWidth(row, fontSize))) + padX * 2);
				const boxH = rows.length * lineHeight + padY * 2 - 3;
				// 默认贴在柱子右侧，右边放不下就翻到左侧，两边都放不下就直接夹回画布内。
				let boxX = cx + 12;
				if (boxX + boxW > contentWidth) boxX = cx - 12 - boxW;
				boxX = Math.max(0, Math.min(contentWidth - boxW, boxX));
				const boxY = Math.max(0, Math.min(height - boxH, topPad - 8));
				children.push(h("g", { key: "hover-tip", className: "dbc-tip", pointerEvents: "none" }, [
					h("rect", {
						key: "box",
						x: boxX, y: boxY, width: boxW, height: boxH, rx: 6,
						fill: "var(--dsw-alias-bg-base,#fff)",
						stroke: "var(--dsw-alias-border-l2,rgba(127,127,127,.32))",
						strokeWidth: 0.6,
						fillOpacity: 0.97,
					}),
					...rows.map((row, index) => h("text", {
						key: "row" + index,
						className: index === 0 ? "dbc-cap" : "dbc-tip-val",
						x: boxX + padX,
						y: boxY + padY + fontSize + index * lineHeight - 2,
						style: { fontSize: fontSize + "px" },
					}, row)),
				]));
			}

			children.push(h("text", { key: "maxbar", className: "dbc-cap", x: 2, y: 12 }, "柱峰 " + yuan(maxCost, 4)));
			children.push(h("text", { key: "maxcum", className: "dbc-cap", x: contentWidth - 2, y: 12, textAnchor: "end" }, "线峰 " + yuan(maxCum, 4)));

			if (points.length === 0) {
				children.push(h("text", { key: "empty", className: "dbc-cap", x: contentWidth / 2, y: height / 2 + 4, textAnchor: "middle" }, "今日暂无消耗记录"));
			}

			/** 鼠标 x -> 最近的一列（用 rect 换算，SVG 被 CSS 缩放过也不会算歪）。 */
			function indexAt(event) {
				const rect = event.currentTarget.getBoundingClientRect();
				if (rect.width <= 0) return null;
				const x = (event.clientX - rect.left) * (contentWidth / rect.width);
				const raw = Math.round((x - leftPad - step / 2) / step);
				return Math.max(0, Math.min(lastIndex, raw));
			}

			return h("svg", {
				width: contentWidth,
				height: height,
				viewBox: "0 0 " + contentWidth + " " + height,
				style: { display: "block", color: "var(--dsw-alias-label-primary,#16181d)" },
				onMouseMove: (event) => {
					if (points.length === 0) return;
					const index = indexAt(event);
					if (index !== null && index !== hovered) setHover(index);
				},
				onMouseLeave: () => setHover(null),
			}, children);
		}

		/* -------------------------------------------------- 下层：总余额横向柱状图 */

		/**
		 * 余额条故意不用 SVG，而是**和时段条一样的 flex 行**：
		 * `[72px 标签] [轨道 flex:1] [右列]`，两行的 padding / gap 完全一致，
		 * 所以两条轨道的左右边缘必然对齐——不需要在 SVG 里维护一份「列宽镜像」，
		 * 也不会出现改了一处另一处对不齐的情况。
		 *
		 * 右列宽度按所在布局给：卡片里时段条右边还有三个按钮（24*3 + 6*2），
		 * 所以余额这一格也要留出同样的宽度；全屏里时段条独占一行，只留 150 的数值格。
		 */
		function BalanceBar(props) {
			const data = props.data;
			const config = data.config;
			const total = data.balance.ok ? data.balance.total : null;
			const max = Number(config.maxBalance) || 1;
			const ratio = total === null ? 0 : Math.max(0, Math.min(1, total / max));
			// 右列总宽 = 数值 + 按钮间距 + 按钮 + inset：多出来的 inset 是补上时段条自己那 2px 内缩，
			// 这样两行的轨道右边缘完全重合，而且金额的右边缘正好落在按钮的右边缘上。
			const valueWidth = props.reserveButtons === true
				? ROW_VALUE_W + ROW_BTNS_GAP + ROW_BTNS_W + ROW_EDGE_INSET
				: ROW_VALUE_W_FULL;
			const title = total === null
				? "余额不可用" + (data.balance.error ? "：" + data.balance.error : "")
				: ["总余额 " + yuan(total, 2), "赠送 " + yuan(data.balance.granted, 2) + " / 充值 " + yuan(data.balance.toppedUp, 2), "100% 基准 " + plain(max) + "（设置里可改）"].join("\n");

			const fillClass = ratio > 0.6 ? "dbc-barfill is-high" : "dbc-barfill";
			// 金额 = 余额 / 100% 基准 · 百分比。基准取自设置（maxBalance），不是写死的数。
			const amountText = total === null
				? "-- / " + plain(max)
				: yuan(total) + " / " + plain(max) + " · " + (ratio * 100).toFixed(1) + "%";
			return h("div", { className: "dbc-balrow", title: title }, [
				h("span", { key: "label", className: "dbc-balrow-label" }, "账户余额"),
				h("div", { key: "track", className: "dbc-bartrack" }, ratio > 0
					? h("div", { key: "fill", className: fillClass, style: { width: (ratio * 100).toFixed(2) + "%" } })
					: null),
				// 复用时段条那个数值格类：颜色 / 字号 / 字重必然是同一个（灰色 12px）。
				h("span", {
					key: "value",
					className: "dbc-peak-spend",
					style: { width: valueWidth + "px" },
				}, amountText),
			]);
		}

		/* -------------------------------------------------------------- 图表装配 */

		/**
		 * 上下两层的高度。
		 *
		 * 规则：先把横向滚动条让出来，再按锁死的 CHART_RATIO 切「两层可视图表」。
		 * 最后一层是**兜底钳制**：Math.max 的下限（minUpper / minLower）在容器很矮时会让
		 * 两层加起来超过容器高度，多出来的那几像素就会画到容器外面去（全屏里正好压在图例
		 * 和明细表头上）。宁可两层都小一点，也不许越界。
		 */
		function layerHeights(height, scrollbar, minUsable, minUpper, minLower) {
			const usable = Math.max(minUsable, height - PLOT_GAP - scrollbar);
			let upper = Math.max(minUpper, Math.round(usable * CHART_RATIO));
			let lower = Math.max(minLower, usable - upper);
			let over = upper + scrollbar + PLOT_GAP + lower - height;
			if (over > 0) lower = Math.max(0, lower - over);
			over = upper + scrollbar + PLOT_GAP + lower - height;
			if (over > 0) upper = Math.max(0, upper - over);
			return { upper: upper, lower: lower };
		}

		function Plot(props) {
			const data = props.data;
			const wrapRef = react.useRef(null);
			const size = useMeasure(wrapRef);
			const scrollRef = react.useRef(null);
			const step = props.step;
			const pointCount = (data.today.points || []).length;

			react.useEffect(() => {
				const el = scrollRef.current;
				if (el !== null) el.scrollLeft = el.scrollWidth;
			}, [pointCount, size.w, step]);

			const height = Math.max(24, Math.round(size.h || props.fallbackHeight || 96));
			// 图表本身也要和上下两条轨道对齐：左右各缩进一列（左 = 标签列，右 = 数值/按钮列）。
			// 宽度按缩进后的可用宽度算，所以不会凭空造出一条横向滚动条。
			const outer = Math.max(160, Math.round(size.w || 360));
			// 图表跟**文字边界**对齐（左列文字左边 ↔ 右列文字/按钮右边），所以只缩进 2px 内边；
			// 下限给得很低：窄窗口里图表本身就窄，这里不该替它「撑宽」而凭空多出横向滚动条。
			const width = Math.max(40, outer - ROW_EDGE_INSET * 2);
			// 先把滚动条让出来，再按 ratio 切分「两层可视图表高度」，
			// 这样比例恒定的承诺不会被滚动条临时打破。
			const needsScroll = pointCount * step + step + 2 > width;
			const scrollbar = needsScroll ? SCROLLBAR : 0;
			const sizing = layerHeights(height, scrollbar, 20, 14, 12);
			const upperHeight = sizing.upper;
			const lowerHeight = sizing.lower;

			return h("div", { className: "dbc-plot", ref: wrapRef }, [
				h("div", {
					key: "upper",
					className: "dbc-upper",
					ref: scrollRef,
					style: {
						height: upperHeight + scrollbar + "px",
						marginLeft: ROW_EDGE_INSET + "px",
						marginRight: ROW_EDGE_INSET + "px",
					},
				}, h(TurnBars, { data: data, width: width, height: upperHeight, step: step })),
				h("div", { key: "lower", className: "dbc-lower", style: { height: lowerHeight + "px" } },
					h(BalanceBar, { data: data, reserveButtons: true })),
			]);
		}

		/* ---------------------------------------------------------------- 设置面板 */

		function NumberRow(props) {
			return h("div", { className: "dbc-row" }, [
				h("label", { key: "l", title: props.title }, props.label),
				h("input", {
					key: "i",
					className: "dbc-input " + (props.small ? "dbc-num" : ""),
					type: "number",
					step: props.step,
					min: props.min,
					max: props.max,
					value: props.value,
					onChange: (event) => props.onChange(event.target.value),
				}),
			]);
		}

		function SettingsPanel(props) {
			const config = props.data.config;
			const [draft, setDraft] = react.useState(() => ({
				maxBalance: String(config.maxBalance),
				pollSec: String(Math.round(config.pollMs / 1000)),
				accounting: config.accounting,
				peakText: (config.peakWindows || []).map((pair) => pair[0] + "-" + pair[1]).join(","),
				weekdaysOnly: config.peakWeekdaysOnly,
				peak: { ...config.rates.peak },
				offpeak: { ...config.rates.offpeak },
			}));
			const [busy, setBusy] = react.useState(false);

			const setField = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));
			const setRate = (band, key, value) => setDraft((prev) => ({ ...prev, [band]: { ...prev[band], [key]: value } }));

			const save = async () => {
				const windows = [];
				for (const chunk of String(draft.peakText).split(",")) {
					const match = chunk.trim().match(/^(\d{1,2})\s*[-~到]\s*(\d{1,2})$/);
					if (match === null) continue;
					const from = Math.max(0, Math.min(23, Number(match[1])));
					const to = Math.max(1, Math.min(24, Number(match[2])));
					if (to > from) windows.push([from, to]);
				}
				setBusy(true);
				await postConfig({
					maxBalance: Number(draft.maxBalance),
					// 上层图表占比已经锁死，不再跟着设置走（也不再提交）。
					chartRatio: CHART_RATIO,
					pollMs: Math.round(Number(draft.pollSec) * 1000),
					accounting: draft.accounting,
					peakWeekdaysOnly: draft.weekdaysOnly,
					...(windows.length > 0 ? { peakWindows: windows } : {}),
					rates: {
						peak: {
							cacheHit: Number(draft.peak.cacheHit),
							cacheMiss: Number(draft.peak.cacheMiss),
							cacheWrite: Number(draft.peak.cacheMiss),
							output: Number(draft.peak.output),
						},
						offpeak: {
							cacheHit: Number(draft.offpeak.cacheHit),
							cacheMiss: Number(draft.offpeak.cacheMiss),
							cacheWrite: Number(draft.offpeak.cacheMiss),
							output: Number(draft.offpeak.output),
						},
					},
				});
				setBusy(false);
			};

			const ratePair = (band, label) => [
				h("div", { key: band + "-h", className: "dbc-sec" }, label + "（元 / 百万 token）"),
				h(NumberRow, { key: band + "-1", label: "输入·缓存命中", small: true, step: 0.01, min: 0, value: draft[band].cacheHit, onChange: (v) => setRate(band, "cacheHit", v) }),
				h(NumberRow, { key: band + "-2", label: "输入·缓存未命中", small: true, step: 0.1, min: 0, value: draft[band].cacheMiss, onChange: (v) => setRate(band, "cacheMiss", v) }),
				h(NumberRow, { key: band + "-3", label: "输出", small: true, step: 0.1, min: 0, value: draft[band].output, onChange: (v) => setRate(band, "output", v) }),
			];

			return h("div", { className: "dbc-pop", onClick: (event) => event.stopPropagation() }, [
				h("div", { key: "h", className: "dbc-sec" }, "显示"),
				h(NumberRow, { key: "max", label: "余额 100% 基准（" + config.currency + "）", step: 1, min: 0.01, value: draft.maxBalance, onChange: (v) => setField("maxBalance", v) }),
				h(NumberRow, { key: "poll", label: "余额轮询间隔（秒）", step: 1, min: 5, max: 600, value: draft.pollSec, onChange: (v) => setField("pollSec", v) }),
				h("div", { key: "acc", className: "dbc-row" }, [
					h("label", { key: "l" }, "记账方式"),
					h("select", {
						key: "s",
						className: "dbc-input wide",
						value: draft.accounting,
						onChange: (event) => setField("accounting", event.target.value),
					}, [
						h("option", { key: "d", value: "delta" }, "余额差值优先（推荐）"),
						h("option", { key: "e", value: "estimate" }, "仅按价卡换算"),
					]),
				]),
				h("div", { key: "peakcfg", className: "dbc-sec" }, "峰谷"),
				h("div", { key: "pw", className: "dbc-row" }, [
					h("label", { key: "l", title: "例如 9-12,14-18" }, "高峰时段（小时，逗号分隔）"),
					h("input", { key: "i", className: "dbc-input wide", value: draft.peakText, onChange: (event) => setField("peakText", event.target.value) }),
				]),
				h("div", { key: "wd", className: "dbc-row" }, [
					h("label", { key: "l" }, "周末全天按空闲价"),
					h("input", { key: "i", type: "checkbox", checked: draft.weekdaysOnly, onChange: (event) => setField("weekdaysOnly", event.target.checked) }),
				]),
				...ratePair("peak", "高峰价卡"),
				...ratePair("offpeak", "空闲价卡"),
				h("div", { key: "actions", className: "dbc-actions" }, [
					h("button", { key: "save", type: "button", className: "dbc-abtn primary", disabled: busy, onClick: save }, busy ? "保存中…" : "保存"),
					h("button", { key: "refresh", type: "button", className: "dbc-abtn", onClick: () => void refreshBalance() }, "立即刷新余额"),
					h("button", { key: "clear", type: "button", className: "dbc-abtn", onClick: () => void postConfig({ __clear: true }) }, "清空当日记录"),
					h("button", { key: "reset", type: "button", className: "dbc-abtn", onClick: () => void postConfig({ __reset: true }) }, "恢复默认"),
				]),
				h("div", { key: "note", className: "dbc-note" }, "「余额差值优先」用相邻两次余额观测的下降额记账，最贴近真实扣费；差值不可用时回退到 token × 价卡换算。"),
				props.error ? h("div", { key: "err", className: "dbc-warn" }, "后端错误：" + props.error) : null,
			]);
		}

		/* ------------------------------------------------------------ 标题栏卡片 */

		/**
		 * 卡片外壳：一个留在文档流里的占位块 + 绝对定位的居中卡片。
		 *
		 * 占位块的尺寸和卡片一致，所以标题栏高度、面包屑的可用宽度都和以前一样；
		 * 卡片本身 out of flow，用 left:50% + translateX(-50%) 在标题栏正中，
		 * 不受「utilities 插槽靠右」的影响。
		 */
		function cardFrame(collapsed, children) {
			return h("div", { className: collapsed ? "dbc-slot is-collapsed" : "dbc-slot" }, children);
		}

		function ChartCard() {
			const view = useData();
			const data = view.data;
			const collapsed = data !== null && data.config.collapse === true;

			if (data === null) {
				return cardFrame(false, h("div", { className: "dbc-card", title: view.error || "正在读取余额数据" }, [
					h("div", { key: "top", className: "dbc-top" }, [
						h("span", { key: "t", className: "dbc-peak-tag" }, view.error ? "余额图表：未连接" : "余额图表：加载中…"),
					]),
				]));
			}

			const errorBadge = data.balance.ok ? null : h("span", {
				key: "badge",
				className: "dbc-peak-spend",
				style: { color: "#e2680d" },
				title: data.balance.error || view.error || "",
			}, "余额不可用");

			const buttons = [
				errorBadge,
				h("button", {
					key: "settings",
					type: "button",
					className: "dbc-btn",
					title: "图表设置",
					onClick: () => {
						settingsOpen = !settingsOpen;
						emit();
					},
				}, icon("settings")),
				h("button", {
					key: "collapse",
					type: "button",
					className: "dbc-btn",
					title: collapsed ? "展开图表" : "收起图表",
					onClick: () => void postConfig({ collapse: !collapsed }),
				}, h("span", { style: { fontSize: 13, lineHeight: 1 } }, collapsed ? "\u25be" : "\u25b4")),
				h("button", {
					key: "full",
					type: "button",
					className: "dbc-btn",
					title: "全屏查看",
					onClick: () => {
						fullscreenOpen = true;
						emit();
					},
				}, icon("expand")),
			];

			return cardFrame(collapsed, h("div", { className: collapsed ? "dbc-card is-collapsed" : "dbc-card" }, [
				h("div", { key: "top", className: "dbc-top" }, [
					h(PeakStrip, { key: "peak", data: data }),
					...buttons,
				]),
				collapsed ? null : h(Plot, { key: "plot", data: data, step: CARD_STEP, fallbackHeight: 96 }),
				view.settings ? h(SettingsPanel, { key: "settings-panel", data: data, error: view.error }) : null,
			]));
		}

		/* ---------------------------------------------------------------- 全屏视图 */

		function FullscreenView() {
			const view = useData();
			const data = view.data;
			const wrapRef = react.useRef(null);
			const size = useMeasure(wrapRef);

			react.useEffect(() => {
				if (!view.fullscreen) return undefined;
				const onKey = (event) => {
					if (event.key === "Escape") {
						fullscreenOpen = false;
						emit();
					}
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [view.fullscreen]);

			if (!view.fullscreen || data === null) return null;

			const points = data.today.points || [];
			const rows = [...points].reverse().slice(0, 200);

			// 量到之前也要先画出来（ResizeObserver 缺失或首帧尺寸为 0 时用视口兜底）。
			const viewportWidth = typeof window !== "undefined" && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280;
			const viewportHeight = typeof window !== "undefined" && Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
			const plotWidth = size.w > 0 ? size.w : Math.max(320, viewportWidth - 96);
			const plotHeight = size.h > 0 ? size.h : Math.max(160, viewportHeight - 330);

			return h("div", {
				className: "dbc-fs",
				onClick: () => {
					fullscreenOpen = false;
					emit();
				},
			}, h("div", {
				className: "dbc-fs-panel",
				onClick: (event) => event.stopPropagation(),
			}, [
				h("div", { key: "head", className: "dbc-fs-head" }, [
					h("span", { key: "t", className: "dbc-fs-title" }, "DeepSeek 余额与消费"),
					h("span", { key: "day", className: "dbc-cap", style: { fontSize: 11 } }, data.day),
					h("div", { key: "m", className: "dbc-fs-metrics" }, [
						h("span", { key: "1" }, ["总余额 ", h("b", { key: "b" }, data.balance.ok ? yuan(data.balance.total) : "--")]),
						h("span", { key: "2" }, ["今日消耗 ", h("b", { key: "b" }, yuan(Number(data.today.spent) + (Number(data.today.pending) || 0)))]),
						Number(data.today.pending) > 0
							? h("span", { key: "2b" }, ["进行中 ", h("b", { key: "b", style: { color: DS_BLUE } }, "+" + yuan(data.today.pending))])
							: null,
						h("span", { key: "3" }, ["对话轮次 ", h("b", { key: "b" }, String(data.today.count))]),
						h("span", { key: "4" }, ["当前 ", h("b", { key: "b", style: { color: data.peak.isPeak ? "#e2680d" : "#2f4fd8" } }, data.peak.isPeak ? "高峰价" : "空闲价")]),
					]),
					h("button", {
						key: "close",
						type: "button",
						className: "dbc-btn",
						title: "关闭（Esc）",
						onClick: () => {
							fullscreenOpen = false;
							emit();
						},
					}, icon("close")),
				]),
				h("div", { key: "strip", style: { flex: "none" } }, h(PeakStrip, { data: data, valueWidth: ROW_VALUE_W_FULL })),
				h("div", { key: "plot", ref: wrapRef, className: "dbc-fs-plot" },
					h(PlotFull, { data: data, width: plotWidth, height: plotHeight })),
				h("div", { key: "legend", className: "dbc-legend" }, [
					h("span", { key: "1" }, [h("i", { key: "i", style: { background: OFF_COLOR } }), "空闲价轮次消耗"]),
					h("span", { key: "2" }, [h("i", { key: "i", style: { background: PEAK_COLOR } }), "高峰价轮次消耗"]),
					h("span", { key: "3" }, [h("i", { key: "i", style: { background: OTHER_COLOR } }), "非对话消耗 / 离线期间"]),
					h("span", { key: "4" }, [h("i", { key: "i", style: { background: lineColor() } }), "当日累计（从 0 起）"]),
					Number(data.today.trimmed) > 0
						? h("span", { key: "5", title: "柱子数量有上限；更早的柱子滚出了窗口，但那部分金额仍计入当日消费与折线" }, "更早的柱子已滚出窗口（" + yuan(data.today.trimmed) + " 仍在累计里）")
						: null,
				]),
				h("div", { key: "detail", className: "dbc-fs-detail" }, rows.length === 0
					? h("div", { className: "dbc-empty" }, "今天还没有消耗记录。跑一轮对话后，柱子会随余额扣费自动出现。")
					: h("table", { className: "dbc-table" }, [
						h("thead", { key: "th" }, h("tr", { key: "r" }, [
							h("th", { key: "1" }, "时间"),
							h("th", { key: "2" }, "轮次"),
							h("th", { key: "3" }, "本轮消耗"),
							h("th", { key: "4" }, "累计"),
							h("th", { key: "5" }, "计价"),
							h("th", { key: "6" }, "未命中输入"),
							h("th", { key: "7" }, "命中输入"),
							h("th", { key: "8" }, "输出"),
							h("th", { key: "9" }, "模型"),
						])),
						h("tbody", { key: "tb" }, rows.map((point, index) => h("tr", { key: point.id || index }, [
							h("td", { key: "1" }, clock(point.ts)),
							h("td", { key: "2" }, point.synthetic ? "其他" : "#" + point.turn),
							h("td", { key: "3", className: "strong" }, yuan(point.cost, 4)),
							h("td", { key: "4" }, yuan(point.cum, 4)),
							h("td", { key: "5" }, point.peak ? "高峰" : "空闲"),
							h("td", { key: "6" }, shortNumber(point.tokens.uncachedInput)),
							h("td", { key: "7" }, shortNumber(point.tokens.cacheRead)),
							h("td", { key: "8" }, shortNumber(point.tokens.output)),
							h("td", { key: "9" }, point.model || "-"),
						]))),
					])),
			]));
		}

		function PlotFull(props) {
			const scrollRef = react.useRef(null);
			const outer = Math.max(200, Math.round(props.width));
			const width = Math.max(140, outer - ROW_EDGE_INSET * 2);
			const height = Math.max(80, Math.round(props.height));
			const step = FULL_STEP;
			const pointCount = (props.data.today.points || []).length;

			// 和卡片里的 Plot 同一套行为：柱子放不下时自动贴到最新一根。
			// 原来只有卡片有这段——全屏里滚动条一直停在最左边，看到的永远是今天最早那几根柱子，
			// 观感上就是「这条横向长条不滚动」。
			react.useEffect(() => {
				const el = scrollRef.current;
				if (el !== null) el.scrollLeft = el.scrollWidth;
			}, [pointCount, width, step]);

			const needsScroll = pointCount * step + step + 2 > width;
			const scrollbar = needsScroll ? SCROLLBAR : 0;
			const sizing = layerHeights(height, scrollbar, 40, 20, 14);
			const upperHeight = sizing.upper;
			const lowerHeight = sizing.lower;
			return h("div", { className: "dbc-fs-plot" }, [
				h("div", {
					key: "u",
					className: "dbc-upper",
					ref: scrollRef,
					style: {
						height: upperHeight + scrollbar + "px",
						marginLeft: ROW_EDGE_INSET + "px",
						marginRight: ROW_EDGE_INSET + "px",
					},
				}, h(TurnBars, { data: props.data, width: width, height: upperHeight, step: step, detail: "full" })),
				h("div", { key: "l", className: "dbc-lower", style: { height: lowerHeight + "px" } },
					h(BalanceBar, { data: props.data, reserveButtons: false })),
			]);
		}

		/* ------------------------------------------------------------- 插件入口 */

		const inject = ["slots"];

		/**
		 * 挂载两个插槽组件。
		 *
		 * `slots.inject(key, cb)` 的两个契约来自 SlotRegistry 的实现：
		 *   - 目标插槽已被父条目声明时立即执行 cb，否则在声明提交后执行（等待）；
		 *   - 返回的 disposer 是幂等的，并且控制器属于**本插件的 fiber**，
		 *     所以插件卸载/热替换时 cordis 会自己取消等待并撤销已生效的贡献。
		 * 因此这里和所有内置插件一样直接调用，不再自己包一层 ctx.effect。
		 *
		 * `register` 只在两种情况下抛错，两种都值得让它在控制台里响：
		 *   - 插槽没被声明（拼错插槽名）；
		 *   - list 插槽缺少 id，或同一 (id, priority) 重复注册（重复物化）。
		 *
		 * @param ctx - 客户端插件上下文。
		 */
		function apply(ctx) {
			const slots = ctx.slots;
			if (slots === undefined) return;
			slots.inject("conversation.session.header.utilities", () => slots.register({
				name: "conversation.session.header.utilities",
				id: "dsh-balance-chart",
				inject: () => ({}),
			}, ChartCard));
			slots.inject("shell.overlay", () => slots.register({
				name: "shell.overlay",
				id: "dsh-balance-chart-fullscreen",
				inject: () => ({}),
			}, FullscreenView));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
