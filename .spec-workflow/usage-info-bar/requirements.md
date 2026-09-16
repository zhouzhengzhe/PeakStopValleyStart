# 输入框信息栏整合（usage-info-bar）— 需求研究结论

## Git 入口闸门

- 仓库路径：`D:/SoftDocument/DSHProject/PeakStopValleyStart`
- 起始分支：`main` · HEAD `eef6374`
- 分支决定：**继续在 main**（用户拍板）
- 工作区：干净，无未提交改动、无未跟踪文件
- 本闸门未创建任何提交

---

## 背景

用户提出：「在 DSH 对话输入框下面增加提示：当前模型、余额、高峰价/空闲价、距空闲时间、本会话花费，并分类统计高峰价多少、空闲价多少」，并要求给出需求方案、实施方案、测试方案。

**调查后发现请求的前提不成立**：这 6 项里 5 项已经在运行，只是用户不知道它来自哪个插件。

证据：

| 事实 | 出处 |
|---|---|
| 用户截图那条栏 = `dsh-bottom-info-bar@1.11.1` | `lib/locales.js:8` = "刷新失败"、`:108` = "高峰价"；`lib/client.js:2076/2088` 注释 |
| 该插件已安装在活动 profile | `profiles/web/package.json:10` |
| 6 项中 5 项已在运行 | `lib/constants.js:21-62` 字段注册表：`anchorGroup`(服务商+模型)、`balance`、`period`、`countdown`、`sessionCost` |
| 第 6 项（峰谷分类）不存在 | 注册表 26 个字段中无峰谷花费拆分；包描述仅"本会话·今日·近一月·全部" |
| 该插件体量 | `client.js` 2,395 行 + `index.js` 4,118 行 + `locales.js` 647 行 ≈ 7,300 行 / 460 KB |
| 该插件支撑 18 个供应商 × 3 种模式 | `lib/index.js` 中 18 个 endpoint；`constants.js` 的 `SUBSCRIPTION_PROVIDERS` / `BILLING_PROVIDERS` |

用户据此改变决定：**把该插件的功能整合进自己的 `dsh-peak-valley-brake`，整合后卸载它。**

---

## 目标

在自有插件 `dsh-peak-valley-brake` 内重建 `dsh-bottom-info-bar` 的用户实际在用链路（DeepSeek 单一供应商 · 余额制），并补上它没有的**峰谷花费分类统计**，使用户能够卸载第三方插件而**不损失任何自己实际使用的功能**。

成功判据（可观测）：

1. 卸载 `dsh-bottom-info-bar` 后，输入框下方仍有栏，且显示：服务商+模型、余额、高峰价/空闲价、距空闲倒计时、本会话花费。
2. 新增峰谷分类：能看到本会话花费中高峰档与空闲档各占多少。
3. 悬停"本会话花费"可看到 今日 / 近一月 / 全部。
4. 两行并存：官方 `StatsPills` 那一行仍在（我们没有顶掉它）。
5. 既有能力零回归：刹车、徽章、面板、设置页、命令全部照常。

---

## 非目标（本轮明确不做）

用户已明确接受以下损失（因为它们当前的使用面为零——`settings.yaml` 中只配置了 `llm-deepseek` 一个 provider）：

1. **其余 17 个供应商**的余额/额度接口：Moonshot、StepFun、小米 MiMo 三集群、Z.ai/智谱、OpenCode Zen、OpenRouter、Together、Fireworks、Amazon Bedrock、Cloudflare AI Gateway、OpenAI/Codex。
2. **订阅制模式**（额度窗口：5h / 周 / 月、重置倒计时）。
3. **账单制模式**（本月真实花费、预算百分比、免费额度）。
4. **信息栏设置页**：字段显隐开关、逐字段配色、预设色板、自定义颜色。
5. **主时间/世界时间**字段、**自定义文本**字段、**更新提示**、**远端定价目录拉取**。
6. **不接管 `conversation.composer.dock` 的 `stats` id**，不替换官方 `StatsPills`。
7. 不改动我方既有的刹车语义、介入时机、放行策略。

---

## 关键调查结论（实施前提，均已验证）

### 1. 插槽是官方公开插槽，不是 hack

`dsh-bottom-info-bar` 的真实机制（`lib/client.js:1458-1461`）：

```js
slots.register(
  { name: 'conversation.composer.dock', id: 'stats', priority: -1000, locale },
  (slotProps) => React.createElement(BottomInfoBar, ...))
```

官方插槽目录（`@deepseek-ai/dsh-cordis-client-runner/lib/client.js:2515-2565`）原文：

- `key: "conversation.composer.dock"`，`kind: "list"`，`scope: "session"`
- summary：`"Ambient entries below the composer card."`（输入框卡片下方的常驻条目）
- `occupants: ["client-ui-chat StatsPills id 'stats'"]`
- **`replaceRisk: "none"`**
- `id` 说明原文：**"用自己的 id 会加在官方条目旁边；复用官方 id 则占据那个格子并把它替换掉。"**

即：官方占用者是 `dsh-client-ui-chat` 注册的 `StatsPills`，`id: "stats"`，`order: 0`（`:8358-8363`）。第三方插件用**同名 id** 把它顶掉了——这才是"替换原生统计栏"的真实机制。

**结论：我们用新 id 注册即可并存，且这是官方声明 `replaceRisk: none` 的用法。**

### 2. 我方已注入承载用量的服务

`lib/index.js:83`：

```js
export const inject = {
  commands: null,
  llm: { required: true },   // ← 已经注入
  connection: null,
  agents: null,
  settings: null,
};
```

用量事件正来自 `llm` 服务的 `llm/stream`。**无需新增注入即可拿到记账原料。**

### 3. 用量的正确读法（快照语义，非增量）

`dsh-bottom-info-bar/lib/index.js:3470-3510` 是可直接照搬的范式：

```js
ctx.on('llm/stream', async function* (options, next) {
  const stream = await next();
  let latestUsage = null, sawFinish = false, committed = false;
  for await (const chunk of stream) {
    if (chunk?.type === 'usage' && chunk.usage) latestUsage = { ...chunk.usage }; // 快照，保留最后一个
    if (chunk?.type === 'finish') sawFinish = true;
    yield chunk;                                                                  // 必须透传
  }
  // finally 中提交一次：sawFinish ? 'completed' : 'interrupted'
});
```

要点（全部是踩过的坑，必须保留）：

- usage chunk 是**快照**而非增量；累加会把一次调用重复计费。
- 一次调用**只提交一次**（`committed` 幂等闩）。
- `next()` 抛错时**只跳过记账、不消化错误**，异常必须继续向上传播。
- 流被中断时也要提交（`interrupted`），否则这次调用的钱凭空消失。
- `yield chunk` 必须无条件透传，否则会截断模型输出。

token 字段：`uncachedInputTokens` / `inputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `outputTokens`。

### 4. 余额与凭据

对方用 `ctx.credentials.resolve(provider.credential)` 取密钥（`lib/index.js:1721`），再打 `https://api.deepseek.com/user/balance`。我方需把 `credentials` 加进 `inject`。

### 5. 定价规则（官方原文核对）

据 [央广财经 2026-08-14](https://finance.eastmoney.com/a/202608143841684074.html)：峰谷定价 **2026-08-17 00:00（北京时间）生效**；**高峰为北京时间 9:00–12:00、14:00–18:00**，其余为空闲；**空闲价为高峰价的 50%**。另有 **2026-08-23 起周末全天按谷价**。

**我方 `lib/time-window.js` 现有规则（UTC 01:00–04:00 与 06:00–10:00、仅工作日）与之逐条吻合，本轮不改。**

---

## 用户流程

**主流程（常态）**：用户打开任意会话 → 输入框下方两行：上行官方统计（轮次/耗时/缓存命中/Token），下行本插件信息栏 → 信息栏随会话实时更新（模型、余额、当前档位、距切换倒计时、本会话花费）→ 鼠标悬停"本会话花费"→ 弹出今日 / 近一月 / 全部。

**峰谷分类流程（本轮新增）**：用户想知道"这个月烧的钱里，有多少是按高峰价付的" → 悬停或展开 → 看到 `高峰 ¥X · 空闲 ¥Y`，并可按今日 / 近一月 / 全部三个时间窗查看。

**降级流程**：余额接口取数失败 → 栏内显示上次成功的值 + 明确的失败标记（不静默、不留空白）。

---

## 功能范围

### F1 栏的挂载
以自有 id（如 `peak-valley-info`）注册进 `conversation.composer.dock`，`order` 取一个不与官方 `stats` 冲突的值。**不占用 `stats` id。**

### F2 服务商 + 模型
显示当前会话实际路由到的服务商与具体模型（DeepSeek 官方 / `deepseek-flash` 等）。

### F3 余额
经 `ctx.credentials.resolve(...)` 取 DeepSeek 密钥，请求 `/user/balance`，显示可用余额。带缓存与退避，失败时保留上次成功的值并标记。

### F4 档位与倒计时
显示当前是高峰价还是空闲价，以及距下一次切换的倒计时。**复用现有 `lib/time-window.js`，不新建第二套时刻表**（这是本次整合最大的收益点：时段权威只有一份）。

### F5 花费记账
经 `llm/stream` 捕获每次调用的 token 用量与所用模型，按价格表折算金额。

### F6 峰谷分类（本轮唯一真正的新增能力）
每笔记账按**发起时刻**所属档位归档，分别累计高峰花费与空闲花费。

### F7 多时间窗汇总
本会话 / 今日 / 近一月 / 全部 四个窗口的花费，及其各自的峰谷拆分。

### F8 设置项
并入现有 `settings.section`（峰谷刹车设置页）：栏的显隐、余额刷新间隔、是否显示原生行之外的字段等。**不重建对方的整套字段显隐/配色 UI。**

---

## 业务规则

| 编号 | 规则 | 来源 |
|---|---|---|
| BR-1 | 高峰 = 北京时间工作日 9:00–12:00、14:00–18:00；其余为空闲 | 官方 |
| BR-2 | 空闲价 = 高峰价 × 50% | 官方 |
| BR-3 | 周末全天按空闲价 | 官方（2026-08-23 起） |
| BR-4 | **一笔花费按"调用发起时刻"定档**；跨界的调用整笔归入发起档，不拆分 | 用户拍板 |
| BR-5 | 金额按"未缓存输入 / 缓存命中输入 / 缓存写入 / 输出"四类 token 各自单价折算 | provider 上报口径 |
| BR-6 | 一次调用只计一次；usage 快照取最后一个 | 对方范式（防重复计费） |
| BR-7 | 被中断的调用同样计入（标 `interrupted`） | 对方的 `finally` 语义 |
| BR-8 | 价格表随模型变化；未知模型不得猜测单价，归入"未定价"桶并在栏内可见 | 防静默错账 |
| BR-9 | 记账失败绝不影响模型输出——只跳过记账，异常继续上抛 | 热路径安全 |

---

## 数据语义

- **归属**：一笔账 =（发起时刻, 模型, 四类 token, 档位, 状态）。
- **档位判定的时间基准**：发起时刻的 UTC 瞬间，用既有 `time-window.js` 判定，避免时区二次实现。
- **幂等**：以 `llm/stream` 的调用身份为键，一次调用一条账。
- **新鲜度**：余额有 TTL 与失败退避；花费为本地累计、实时。
- **一致性**：栏内"本会话花费"与峰谷拆分之和必须相等（不变量，须有断言）。
- **持久化**：今日/近一月/全部 需要落盘。复用我方既有 ledger 落盘模式（`lib/hold-ledger.js` 的写法），新增独立存储，**不复用滞留消息的台账文件**。
- **历史回扫**：可选服务 `sessionController` 提供冷会话摘要，用于补齐挂载前的历史。**若该服务不可用，安全退回"只统计挂载后"，绝不猜测。**

---

## 权限、安全与审计

- 余额请求使用 DSH **凭据服务**解析密钥，密钥不落我方任何文件、不进日志、不进前端。
- 前端只接收**已折算的金额与 token 数**，不接收任何凭据或原始账户信息。
- 余额接口调用频率受 TTL 与退避约束，避免把用户账号打到限流。
- 记账数据纯本地，不外发。

---

## 异常与边界

| 场景 | 期望行为 |
|---|---|
| 余额接口失败/超时 | 保留上次成功值 + 明确失败标记；不空白、不显示 0 |
| 无凭据 | 显示明确的"未配置凭据"提示，而非静默无余额 |
| 未知模型 | 归入"未定价"桶，可见；不猜单价 |
| `llm/stream` 上游抛错 | 本次不记账；错误继续上抛，模型输出不受影响 |
| 流被中断 | 按 `interrupted` 提交，钱不丢 |
| `slots` 服务晚就绪 | 轮询等待 + 超时后告警（对方是 45s 超时），不静默失败 |
| `sessionController` 不可用 | 只统计挂载后，明确标注回扫不可用 |
| 跨日/跨月边界 | 今日/近一月按本地时区切分，与"距空闲"用同一时区基准 |
| 宿主重启 | 已落盘的账继续有效；未提交的本次调用丢失（可接受，须记录） |

---

## 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| **上游仍在演进** | 对方已到 1.11.1，我们搬的是快照 | 只搬我们真正用的链路，减少表面积 |
| **热路径性能** | `llm/stream` 是每次模型调用的必经之路 | 记账只做增量累加，落盘异步且合并写（`scheduleSave`） |
| **与官方 `StatsPills` 视觉打架** | 两行可能显得拥挤 | 用户已选择并存；样式上克制，必要时后续再合并 |
| **`sessionController` 接口随版本变动** | 对方代码里已明确"严禁裸写，读取未 provide 的属性会抛" | 按能力读取 + try/catch + 不可用即降级 |
| **当前就存在的「刷新失败」** | 用户截图尾部即此状态，说明余额/用量取数**现在就在失败** | 实施时先复现并定位；这属于要修的既有缺陷 |
| **价格表漂移** | 官方调价后金额会错 | 价格表单点定义 + 一条断言钉住当前官方价；不在多处复制 |

---

## 已关闭的问题

| 问题 | 决定 | 谁定的 |
|---|---|---|
| 这一轮方案覆盖什么 | 把该插件功能整合进自有插件，然后卸载它 | 用户 |
| 搬多少 | 只搬 DeepSeek 余额制这一条链路（含今日/近一月/全部） | 用户 |
| 栏的形态 | 用新 id 并存两行，保留官方 `StatsPills` | 用户 |
| 跨界调用的归属 | 按发起时刻定档 | 用户 |
| 工作流分支 | 继续在 `main` | 用户 |
| 截图那条栏是什么 | `dsh-bottom-info-bar@1.11.1` | 环境调查 |
| 插槽是否公开 | 是，`conversation.composer.dock`，`replaceRisk: none` | 环境调查 |
| 用量从哪拿 | `ctx.on('llm/stream')`，我方 `inject` 已有 `llm` | 环境调查 |
| 峰谷规则 | 官方口径，与我方 `time-window.js` 一致，不改 | 官方文档 |

---

## 显式推迟 / 超出范围

1. 其余 17 个供应商、订阅制、账单制（用户已接受损失）。
2. 字段显隐与配色设置页（可后续增量补，我方已有设置页模式）。
3. 主时间/世界时间、自定义文本、更新提示。
4. 合并成单行的可能性（先并存两行跑稳，再评估）。
5. **`dsh-usage-statistics-panel` 的去留本轮不处理**——它与本条栏功能不重叠，继续保留。
6. 卸载 `dsh-bottom-info-bar` 的动作放在**验收通过之后**，不在实施中途卸载（否则失去对照物）。

---

## 建议的下一步

需求已可进入 `to-spec`。三个方案（需求 / 实施 / 测试）见同目录 `spec.md`、`plan.md`、`test-plan.md`（由后续阶段产出）。

实施顺序上有一条硬约束需要在此处记录：**必须先在并存状态下跑通并验收，再卸载第三方插件**——否则一旦出问题，对照物同时消失，故障定位会退化成猜。
