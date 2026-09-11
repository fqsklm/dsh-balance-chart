# 安装教程（dsh-balance-chart）

> **English quick start** is at the [bottom of this page](#english-quick-start).
> 本页是面向「没写过插件、也不熟命令行」的用户的分步教程。全部照做大约 5 分钟。

---

## 目录

- [第 0 步：确认前置条件](#第-0-步确认前置条件)
- [第 1 步：把仓库下载到本机](#第-1-步把仓库下载到本机)
- [第 2 步：把插件装进 web profile](#第-2-步把插件装进-web-profile)
- [第 3 步：把插件挂到配置树里](#第-3-步把插件挂到配置树里)
- [第 4 步：刷新浏览器](#第-4-步刷新浏览器)
- [第 5 步：确认真的装好了](#第-5-步确认真的装好了)
- [以后怎么更新](#以后怎么更新)
- [怎么卸载](#怎么卸载)
- [排错手册](#排错手册)
- [English quick start](#english-quick-start)

---

## 第 0 步：确认前置条件

装插件之前，先确认下面三件事。**任何一件没满足，插件都不会出现，而且报错会很难懂**，所以别跳过。

### ① Node.js ≥ 20

打开终端（Windows 用 PowerShell），执行：

```powershell
node --version
```

看到 `v20.x` / `v22.x` / `v24.x` 之类就对了。如果提示「不是内部或外部命令」，先去 <https://nodejs.org/> 装一个 LTS 版本。

### ② DSH 已经装好，而且 `dsh web` 能正常打开

```powershell
dsh --version
```

然后确认你现在能在浏览器里打开 DSH 的界面。本教程按默认地址 `http://127.0.0.1:3080` 讲解；
如果你改过端口，把下文所有 `3080` 换成你自己的端口即可。

> 如果你还没装 DSH：`npm i -g @deepseek-ai/dsh`，然后 `dsh web` 启动。

### ③ DSH 的凭据里有 `DEEPSEEK_API_KEY`

插件读余额用的就是这个凭据（和 `llm-deepseek` 用的是同一个，不需要你再填一次）。

**没有它也能装、也能用** —— 只是余额那一层会显示「余额不可用」，
而「每轮对话花了多少钱」（价卡换算那一路）照常工作。

### ④ 搞清楚你的 `DSH_HOME` 在哪

DSH 把 profile 和数据都放在 `DSH_HOME` 下，默认是用户目录里的 `.dsh`：

| 系统 | 默认 `DSH_HOME` | profile 的 patch 文件 |
|---|---|---|
| Windows | `C:\Users\<你的用户名>\.dsh` | `C:\Users\<你的用户名>\.dsh\profiles\web\cordis.patch.yml` |
| macOS / Linux | `~/.dsh` | `~/.dsh/profiles/web/cordis.patch.yml` |

在 PowerShell 里可以直接打印出来：

```powershell
if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
```

> 下文凡是出现 `$DSH_HOME` 的地方，都替换成上表或上面命令输出的那个真实路径。
> macOS / Linux 上 `~/.dsh` 一般就是你看到的样子，不用替换。

---

## 第 1 步：把仓库下载到本机

**⚠️ 关键：这个目录要长期留着。** 插件不是被复制进 DSH 的，而是 DSH 里放了一个**链接指向这个目录**。
你如果把目录删了、挪了，插件会立刻失效。

推荐放在用户目录下（不要放在 `Downloads`、临时文件夹、或会被清理工具扫到的地方）：

```powershell
# Windows（PowerShell）
cd $env:USERPROFILE
git clone https://github.com/fqsklm/dsh-balance-chart.git
```

```bash
# macOS / Linux
cd ~
git clone https://github.com/fqsklm/dsh-balance-chart.git
```

**没有装 git？** 也可以不用 git：在仓库页面点绿色的 `Code` → `Download ZIP`，
解压到 `C:\Users\<你的用户名>\dsh-balance-chart`（macOS/Linux 是 `~/dsh-balance-chart`）。
缺点是不能用 `git pull` 更新，以后要更新得重新下载解压。

记住这个目录的**绝对路径**，下一步要用：

```powershell
# 确认目录里有 package.json 和 lib 文件夹
Get-ChildItem "$env:USERPROFILE\dsh-balance-chart"
```

---

## 第 2 步：把插件装进 web profile

DSH 自带的 `dsh plugin` 命令会把这个包登记为 web profile 的依赖（`link:` 表示「链接到本机目录」，不是从 npm 下载）。

**在仓库目录里**执行（`$PWD` 就是当前目录）：

```powershell
# Windows（PowerShell）
cd $env:USERPROFILE\dsh-balance-chart
dsh plugin --profile web add link:$PWD
```

```bash
# macOS / Linux
cd ~/dsh-balance-chart
dsh plugin --profile web add link:"$PWD"
```

> **想直接写绝对路径也行**，效果完全一样：
> ```powershell
> dsh plugin --profile web add link:C:\Users\1kg\dsh-balance-chart      # Windows，注意别加引号
> dsh plugin --profile web add link:/Users/you/dsh-balance-chart        # macOS
> dsh plugin --profile web add link:/home/you/dsh-balance-chart         # Linux
> ```

**怎么知道成功了？** 命令会输出一段安装日志（`+ dsh-balance-chart 1.0.0`），并且
`$DSH_HOME/profiles/web/package.json` 里会出现这么一条：

```json
"dependencies": {
  "dsh-balance-chart": "link:C:/Users/you/dsh-balance-chart"
}
```

顺便还能看到一个关键字段——web profile 的 patch 是**热重载**的，这正是第 4 步不用重启的原因：

```json
"dsh": {
  "profile": {
    "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-balance-chart"],
    "patchReload": "live"
  }
}
```

> **这一步之后插件还没生效。** `add` 只是让它「可被加载」，真正把它挂进配置树的是下一步。

---

## 第 3 步：把插件挂到配置树里

打开 `$DSH_HOME/profiles/web/cordis.patch.yml`，在文件末尾加上这三行**结构完全一致**的内容
（YAML 对缩进敏感：`- insert:` 顶格，下一层缩进 4 个空格，再下一层缩进 6 个空格）：

```yaml
- insert:
    - id: balance-chart
      name: dsh-balance-chart
```

**用记事本 / VS Code 打开都行**：

```powershell
# Windows：用记事本打开（路径按你的实际 DSH_HOME 调整）
notepad "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"
```

```bash
# macOS
open -e ~/.dsh/profiles/web/cordis.patch.yml
# Linux
xdg-open ~/.dsh/profiles/web/cordis.patch.yml
# 或者在终端里直接追加
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'EOF'

- insert:
    - id: balance-chart
      name: dsh-balance-chart
EOF
```

### ⚠️ 这一格最容易踩的坑

**文件原本长这样**（新 profile 的默认内容，最后一行是一个空的数组字面量）：

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
# ...
[]

- insert:          ← ❌ 这样加是错的：`[]` 和 `- insert` 不能共存，整份文件会解析失败
    - id: balance-chart
      name: dsh-balance-chart
```

**正确做法：把那个 `[]` 删掉**，改成下面这样（注释留着无所谓）：

```yaml
# Your patch layer for this dsh profile...
- insert:
    - id: balance-chart
      name: dsh-balance-chart
```

三步自查：

1. 全文**只有一个** `insert:` 段落。（重复插入会产生两行同 id 的 loader 行，两个实例会抢同样的 HTTP 路由并报错。）
2. `id` 是 `balance-chart`，`name` 是 `dsh-balance-chart`（**前面没有 `./`、没有 `link:`、不能带 `/`**）。
3. 缩进是「4 空格 + 6 空格」，**不是 Tab**。

### 为什么激活行要放在这里，而不是包自带的 `cordis.patch.yml` 里？

这是**故意**的设计：web profile 的 `patchReload: live` 只监听 profile 自己的 patch 文件，
所以写在这里能做到**改完立刻生效、不用重启 `dsh web`**。
插件包自带的 `cordis.patch.yml` 因此是空的（`[]`）；如果两边都写 `insert`，就会出现上面说的「重复 loader 行」。

---

## 第 4 步：刷新浏览器

**回到 DSH 的页面，按 F5**（macOS 用 <kbd>⌘</kbd>+<kbd>R</kbd>）。

客户端那半（画图表的代码）是浏览器从 DSH 拉的 bundle，必须重新拉一次才会挂上插槽。
**「其实装好了但看不见」十有八九就是漏了这一步。**

刷新后，在**打开任意一个会话**的情况下，标题栏第二行（「对话 / 轨迹」那一行）的正中就会出现卡片。
如果只开了欢迎页 / 没有打开会话，标题栏不存在，自然也就没有卡片——先点进一个会话。

---

## 第 5 步：确认真的装好了

三个层次，从浅到深：

### ① 肉眼

会话标题栏正中出现图表卡片：上行是峰谷时段条 + 「今日消耗 ¥x」，中间是柱状图 + 折线，下面是余额条。
窗口太窄时卡片会跟着缩（`min(640px, 54vw)`）。

### ② 接口（不需要登录，仅本机）

```powershell
curl.exe -s http://127.0.0.1:3080/dsh-balance/state
```

应当返回一大段 JSON。想看得清楚点，只取几个关键字段：

```powershell
curl.exe -s http://127.0.0.1:3080/dsh-balance/state | ConvertFrom-Json |
  Select-Object day, @{n='ok';e={$_.balance.ok}}, @{n='total';e={$_.balance.total}},
                @{n='spent';e={$_.today.spent}}, @{n='points';e={$_.today.count}},
                @{n='isPeak';e={$_.peak.isPeak}}
```

| 字段 | 含义 | 正常值 |
|---|---|---|
| `balance.ok` | 余额接口是否拿到了数据 | `true`（`false` 时看 `balance.error`） |
| `balance.total` | 当前余额 | 你的真实余额 |
| `today.spent` | 今日消耗（已结算 + 进行中的合计口径见 README） | `0` 起步，随对话增长 |
| `today.count` | 今天已记录的轮次数 | 有对话就 > 0 |
| `status.keyMissing` | 是否找不到 `DEEPSEEK_API_KEY` | `false` |

### ③ 日志

`dsh web` 的输出里应当出现：

```
balance-chart: mounted (ledger: C:\Users\<你>\.dsh\.dsh-balance-chart.json)
```

所有本插件的日志都以 `balance-chart:` 开头。

### 手动触发一次刷新

```powershell
curl.exe -s -X POST http://127.0.0.1:3080/dsh-balance/refresh
```

也可以直接在界面里点 `⚙` → 「立即刷新余额」。

---

## 以后怎么更新

```powershell
cd $env:USERPROFILE\dsh-balance-chart
git pull
```

然后按改动的部分决定要不要重启（**这是实测结论**）：

| 改了哪半 | 生效方式 |
|---|---|
| `lib/client.js`（界面） | 按 F5 即可。DSH 每 500ms 检测客户端 bundle，变了会广播新版本号。 |
| `lib/index.js`（宿主） | **重启 `dsh web`**，再 F5。 |
| `package.json` 的 `dsh.client` 声明 | 重启 `dsh web`。 |

> 「宿主侧能不能不重启就热更新」这个问题已经试过五种方案，全部失败，原因写在 README 的常见问题里。
> 结论就一句：**改宿主代码 = 重启 `dsh web`**。

---

## 怎么卸载

```powershell
# 1) 打开 $DSH_HOME/profiles/web/cordis.patch.yml，删掉你加的那段 insert
#    （如果删完之后文件空了，写一个 [] 进去）
# 2) 移除依赖
dsh plugin --profile web remove dsh-balance-chart
# 3) 回浏览器按 F5
```

数据文件 `$DSH_HOME/.dsh-balance-chart.json`（余额缓存 + 当日记录 + 你的设置）不会被自动删除：
想彻底清干净就手动删掉它，想留着以后重装就留着。

---

## 排错手册

### 卡片完全不出现

按顺序排除，每步都有明确的判据：

1. **打开的是会话页吗？** 卡片挂在会话标题栏的插槽里，欢迎页没有这个插槽。
2. **F5 过了吗？** 99% 的「设置看着都对但没显示」都是这个原因。
3. **`cordis.patch.yml` 改对了吗？** 对照[第 3 步](#第-3-步把插件挂到配置树里)的三条自查。
4. **依赖真的装上了吗？** 看 `$DSH_HOME/profiles/web/package.json` 里有没有 `dsh-balance-chart`。
5. **看 `dsh web` 的日志**有没有 `balance-chart:` 开头的报错。若是「重复路由 / duplicate route」，说明 loader 行插了两遍。
6. **重启 `dsh web`** 再 F5。这一步能把「patch 应用失败」的所有情况排除掉。

### patch 应用失败会是什么表现？

**注意：这类失败经常是「静默」的** —— 接口照常返回 200、旧的数据还在，看起来一切正常，只是新代码没生效。
所以判断「插件是否真的换上去」不能只看接口通不通，要看**新版本独有的东西**
（比如 `/dsh-balance/state` 返回里有没有 `pending` / `trimmed` 字段）。

已知会导致整份 patch 回滚、旧树静默保留的写法：

- specifier 写成**相对路径**（`./`、`../`）—— 运行期解析不了。
- specifier 带**子路径**（`dsh-balance-chart/host`）—— 包名解析器不接受含 `/` 的 specifier，
  该行直接加载失败，**而且客户端半侧会从模块图里消失**。
- YAML 缩进错、Tab 缩进、`[]` 和 `- insert` 混写 —— 文件整体解析失败。

### 「余额不可用」

说明 `api.deepseek.com/user/balance` 那一路没拿到数据。依次检查：

- 凭据里有没有 `DEEPSEEK_API_KEY`（看 `/dsh-balance/state` 里 `status.keyMissing`）。
- `balance.error` 字段写着具体原因（`未配置 DEEPSEEK_API_KEY` / `余额接口 HTTP <码>` / 超时）。
- 网络能不能直连 `api.deepseek.com`；公司网络 / 某些地区需要代理，而 DSH 的 Node 进程未必继承了你的系统代理。
- 点「立即刷新余额」再看一次。

**余额不可用不等于插件坏了**：每轮消耗的换算值仍然照常工作，柱子照样画得出来。

### 数字和平台对不上

依次对照（这些都是**设计上的已知取舍**，不是 bug）：

- 正在进行的那一轮还没结算：标题栏「今日消耗」含进行中，但柱子/折线只画已结算的，所以最右那根柱子会小一点。
- 插件加载之前发生的消耗不会补记（余额差值法是向前观测的，没有基准可还原）。
- 跨天那一笔的日期只能按观测时刻近似（昨晚 23:00 后的消耗记到今天那一格）。
- 余额接口只给两位小数，单轮几分钱以下的消耗靠价卡换算补齐。
- DeepSeek 调价了：去 `⚙` 里改价卡。
- 记账方式选的是「仅按价卡换算」而不是「余额差值优先」：后者最接近真实扣费。

### 柱子底部被滚动条裁掉 / 突然出现一条很粗的原生滚动条

这是 Windows 上修过的一个真实 bug，触发条件很反直觉：**在 Chrome 里，只要给滚动条写了 `scrollbar-width`，
`::-webkit-scrollbar` 的自定义样式就会被整块忽略、退回系统原生滚动条**（Windows 上是 10px、还带两枚箭头按钮），
比容器预留的高度多 3px，正好把柱子底部裁掉。
现在的做法是只写 `::-webkit-scrollbar{height:var(--dsh-scrollbar-width,8px)}` 跟着宿主主题走，
绝不写 `scrollbar-width`。如果你自己改样式时踩到同样的坑，量一下真实滚动条高度再决定预留多少，别写死数字。

### 设置菜单被代码块挡住 / 全屏盖不住卡片

这是 `z-index` 的问题，而且**上限和下限都由宿主决定**：

- 下限：宿主的吸顶元素在 `z-index:6`（代码块表头，就是「复制」那一行）、`7`（输入区 / 聊天槽）、`8`（宽度拖柄）。
- 上限：宿主 `shell.overlay` 那一层是 `z-index:20`——卡片必须低于它，否则全屏盖不住卡片。

所以卡片层级要落在 **8 < z < 20**，当前是 10。改之前先确认宿主的这几层有没有变。

### 想彻底重来

```powershell
# 1) 删掉 cordis.patch.yml 里的 insert
# 2) dsh plugin --profile web remove dsh-balance-chart
# 3) 删掉数据文件（可选）
Remove-Item "$env:USERPROFILE\.dsh\.dsh-balance-chart.json" -ErrorAction SilentlyContinue
# 4) 重启 dsh web
# 5) 重新走第 2、3、4 步
```

---

## English quick start

`dsh-balance-chart` is a zero-dependency plugin for the DeepSeek Harness (DSH) web GUI that draws your DeepSeek
**account balance**, **today's per-turn spend**, and the current **peak / off-peak pricing window** on the conversation header.

Requirements: Node.js ≥ 20, a working DSH install (`dsh web` opens in your browser), and the `DEEPSEEK_API_KEY`
credential already configured in DSH (the balance layer degrades gracefully without it).

```bash
# 1) Clone somewhere permanent — DSH links to this directory, so don't delete or move it later.
cd ~ && git clone https://github.com/fqsklm/dsh-balance-chart.git

# 2) Register the package as a dependency of the web profile
cd dsh-balance-chart
dsh plugin --profile web add link:"$PWD"

# 3) Activate it: append this to $DSH_HOME/profiles/web/cordis.patch.yml
#    (default $DSH_HOME is ~/.dsh; if that file currently contains a bare `[]`, replace it)
#
#    - insert:
#        - id: balance-chart
#          name: dsh-balance-chart

# 4) Press F5 in the DSH browser tab, then open any conversation.
```

Verify: `curl http://127.0.0.1:3080/dsh-balance/state` should return JSON with `balance.ok: true`
and a growing `today.spent`.

Update: `git pull` → press F5 for `lib/client.js` changes; restart `dsh web` for `lib/index.js` changes.

Uninstall: remove the `insert` block from `cordis.patch.yml`, then `dsh plugin --profile web remove dsh-balance-chart`.

MIT licensed. See the [README](../README.md) for the full documentation (Chinese).
