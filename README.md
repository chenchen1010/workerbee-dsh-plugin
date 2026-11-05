# 工蜂 · 小红书选品采集（DeepSeek Harness 插件）

把工蜂的采集能力接进 DeepSeek Harness。插件自己拉起采集核心，不需要工蜂桌面应用：

- 侧栏多一个「工蜂选品」入口：机会池、发起采集、看任务、看结果、看设备；
- Agent 多 9 个工具（6 采集 + 3 机会池）：直接说「用工蜂采集 XX 20 条」就能跑；
- 核心进程由插件托管：端口、数据库、discovery、日志、启停都在插件里。

**这个目录是可改的开放层。** 采集核心（真机脚本、解析、任务执行）仍然是工蜂的加固程序；
这里只有「怎么把它拉起来」和「怎么显示结果」，放心改。

---

## 1. 它怎么工作

```
DeepSeek Harness
├─ 面板（client.js） ──fetch──▶ /plugins/xhs-workbench/*  ┐
├─ 工具（index.js）  ─────────▶ 采集核心 HTTP API        │ 钥匙只在 Host 进程里
└─ 核心进程托管      ──spawn──▶ xhs-core serve           ┘
                                   │ 写 discovery（地址 + wf_live_* 钥匙）
                                   │ adb + uiautomator2
                              客户的安卓真机
```

两种运行方式：

| 模式 | 谁启动核心 | 什么时候用 |
|---|---|---|
| **插件托管（默认）** | 插件 spawn `xhs-core` | 客户不装桌面应用，只用 DSH |
| 连接现有核心 | 客户自己开（桌面应用 / `app.cli serve`） | 过渡期、开发机、已有采集机 |

插件托管时，核心退出/崩溃会在面板显示状态和日志路径；插件不会偷偷重启（避免两个执行器抢手机）。

---

## 2. 安装采集核心

核心是一个独立可执行目录（约 300MB，含 Python 运行时），**不放进 git**，二选一：

1. **放插件目录（推荐）**

```
runtime/core/
├─ xhs-core           # Windows 是 xhs-core.exe
├─ Python
└─ …（核心发布包里的全部文件）
```

2. **放别处，写 config.json**

```json
{
  "core": {
    "path": "/绝对路径/core",
    "dataDir": "/可选/数据目录",
    "port": 0
  }
}
```

`path` 可以是目录（自动拼 `xhs-core`），也可以直接是可执行文件。
也可以不写文件，用环境变量 `XHS_CORE_BIN`。

**不要改核心里的任何东西。** 它是加固过的采集执行程序，插件只负责调用。

> 授权：核心按工蜂的激活体系守门。插件不绕过、不破解；`core.enforceLicense` 打开时
> 会向核心传 `XHS_LICENSE_ENFORCE=1`。激活流程后续会搬进面板。

---

## 3. 安装插件

在 DSH 里安装本仓库（`package.json` 所在的根目录）：

```bash
git clone https://github.com/chenchen1010/workerbee-dsh-plugin.git
```

- 让 DSH 里的 AI 执行：
  > 安装 `workerbee-dsh-plugin` 这个仓库根目录的插件
- 如果当前 DSH 版本的「设置 → 插件」提供本地目录安装入口，也可以直接选这个目录。

安装是**链接**这个目录，不复制。改源码后不用打包：

| 改了哪个文件 | 生效方式 |
|---|---|
| `client.js` | 刷新 DSH 页面（Cmd/Ctrl+R） |
| `index.js` | 插件管理里关掉再打开（或重启 DSH） |
| `package.json` / `cordis.patch.yml` | 重新安装 bundle |
| `config.json` | 点面板「刷新」，或重载插件 |

---

## 4. 启动与连接

打开侧栏「工蜂选品」：

- 没装核心 → 面板显示安装指引；
- 装了没启动 → 点「启动核心」；
- 启动中 → 插件等 `/api/state` 就绪（最多 30 秒），然后自动读 discovery 拿钥匙；
- 已连接 → 顶部状态灯变绿，可以建任务。

默认数据目录（数据库、discovery、日志）：

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/工蜂/` |
| Windows | `%APPDATA%\工蜂\` |
| Linux | `~/.config/工蜂/` |

和桌面应用共用同一套目录，所以换到插件后历史任务、设备记录都在。

**不要同时跑两个核心。** 一台手机只能有一个执行器。插件在启动前会探测已有核心并拒绝重复启动；
如果客户坚持要用现有核心，就不要点「启动核心」，直接用它。

---

## 5. 客户怎么改

三条边界：

1. **不动核心**：插件只依赖 HTTP 契约，不依赖核心源码。
2. **不在 `client.js` 写钥匙**：钥匙在 Host 进程，浏览器只调 `/plugins/xhs-workbench/*`。
3. **不新增未支持的 task_type**：模块表的 `type` 必须和核心已支持的 task_type 一致。

### 5.1 改文案 / 加模块

`client.js` 顶部 `MODULES`，一行一个模块：

```js
{ type: 'keyword', group: '商品', title: '关键词搜商品', desc: '…', input: 'keyword', placeholder: '…' }
```

- `input`：`keyword` / `link`，只影响输入框文案；
- `fixed: 1`：单链接模块，数量固定 1；
- `needsTarget`：矩阵号猎手的目标商家输入框；
- 分组名在 `MODULE_GROUPS`。

### 5.2 改样式

`client.js` 底部 `CSS`。只用 `--dsw-alias-*` 主题变量，否则深色模式会瞎。

### 5.3 改工具

`index.js` 的 `defineTools()`。每个工具要 `name` / `description` / `parameters`（JSON Schema）/
`output`（`{schema, render}`）/ `execute`。改完重载插件。

### 5.4 加自己的面板

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id, order, label }, Icon))
ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: id }, Page))
```

`id` 和 `key` 必须相同，点侧栏图标才会打开对应页。

---

## 6. 机会池（选品主界面）

插件默认打开的就是「机会池」，数据来自核心的 `/api/pools*`：

- 顶部：池内商品总数、今日新增、行业池数量；
- 池筛选：全部池 / 按池切换；
- 状态：全部 / 已确认 / 未复核 / 观察 / 已排除 / ★ 收藏；
- 搜索：商品名 / 店铺 / 关键词；
- 排序：日营业额（24h加购×价格）、累计营业额（销量×价格）、24h加购、已售、价格、入池时间；
- 列表：价格、已售、24h加购、日营业额、累计营业额、来源词、所属池、店铺、入池时间；
- 点行开右侧详情：主图、卖点标签、24h加购命中、店铺粉丝/销量、物流、原页链接、原始 JSON；
- 收藏：行首 ☆ 直接切换。

「AI 选品助手」不需要单独做页面：用 DSH 的会话即可。Agent 通过 `xhs_pools` / `xhs_pool_items` /
`xhs_pool_item` 读同一批池数据，直接在对话里做筛选和分析。

---

## 7. 常用操作

| 想做什么 | 面板 | 对话里 |
|---|---|---|
| 启动/停止核心 | 面板顶部指引 | — |
| 看核心在不在 | 状态灯 | `xhs_status` |
| 看手机 | 设备 tab | `xhs_devices` |
| 建采集任务 | 发起采集 | `xhs_create_task` |
| 看进度 | 任务 tab | `xhs_task` |
| 取结果 | 任务 → 看结果 | `xhs_result` |
| 取消 | 任务行 → 取消 | `xhs_cancel_task` |
| 列行业池 | 机会池 tab | `xhs_pools` |
| 筛池内商品 | 机会池 tab | `xhs_pool_items` |
| 看商品详情 | 点行 → 右侧详情 | `xhs_pool_item` |

采集是异步的：建单只返回 `task_id`。20 条的关键词任务通常几十秒到几分钟，
让 Agent 间隔 5–10 秒轮询 `xhs_task`，完成后 `xhs_result`。

---

## 8. 常见问题

**「采集核心还没安装」**
核心没放到 `runtime/core/`，`config.json` 的 `core.path` 也不对。看面板里显示的查找路径。

**「采集核心启动后立刻退出」**
看 `logs/core.log`（面板里有路径）。最常见：核心参数不匹配、核心文件损坏、权限不够。

**「检测到已经在运行的采集核心」**
已经有一个核心在跑（桌面应用或另一份 serve）。先停掉它，再启动托管核心。
两个执行器同时跑会抢同一台手机。

**「核心已启动，但接口没连上」**
核心的 `/api/state` 通了但 `/api/v1` 不通：多半是钥匙桥/版本问题。
面板会显示具体错误；日志里有核心侧原因。

**设备列表是空的，但任务能跑**
老版本核心没有 `/devices` 端点。插件会降级为空列表，建单时由执行器自动选机。

**任务一直「排队中」**
核心的 supervisor 没启动（`--no-worker`）或手机不可用。插件默认不带 `--no-worker`，
会启动内嵌调度器；如果核心被别的方式启动过，检查 `/api/state` 的 `supervisor.enabled`。

**图片不显示**
小红书图床认 Referer 且链接会过期。图片走核心的 `/media` 缓存，核心没跑或图过期就空图。

---

## 9. 升级与发布

- 本仓库是客户可改的公开层。内部源码在私有仓库维护，发布时同步到这里
  （和 `workerbee-skills`、`workerbee-workspace` 是同一套做法）。
- 同步时不要带上 `config.json`（本机连接/核心路径），也不要带 `runtime/`（核心二进制）。
- 核心单独发版：插件通过 `runtime/core/` 或 `core.path` 找它，两边解耦。
- 客户升级：`git pull` → 重载插件；核心升级：替换 `runtime/core/` 后重启核心。
- 发布前检查：`config.json` 没进仓库、钥匙没进 `client.js`、README 是客户视角。

---

## 10. 目录

```
workerbee-dsh-plugin/
├─ package.json         # bundle 声明：Host 入口 + dsh.client
├─ cordis.patch.yml     # 插件行
├─ index.js             # Host：核心托管、连接、路由、9 个工具
├─ client.js            # Client：侧栏图标 + 机会池/采集/任务/设备
├─ config.example.json  # 配置样例（核心路径/数据目录/env）
├─ locale/{zh,en}.json  # 插件标题/描述
├─ icon.svg             # 插件图标
└─ runtime/             # 核心运行时（gitignore，单独分发）
```
