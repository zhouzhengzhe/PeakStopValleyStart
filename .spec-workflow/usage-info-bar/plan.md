# 实施方案（usage-info-bar）

> 阶段一产物，供 `to-spec` 细化。每一项都标注了**可验证的完成判据**。

## 硬约束（开工前必须记住）

1. **先并存、后卸载。** 必须在我们这条栏跑通并验收之后，才卸载 `dsh-bottom-info-bar`。中途卸载 = 同时失去对照物，故障定位退化成猜。
2. **时段权威只有一份。** 不新建第二套峰谷时刻表，一律走既有 `lib/time-window.js`。
3. **热路径只许增量。** `llm/stream` 是每次模型调用的必经之路；记账不得引入同步 IO，落盘异步合并写。
4. **记账永不吞错。** 上游异常只跳过记账，必须继续上抛。

---

## 阶段 0 · 先取证：弄清「刷新失败」

用户截图尾部就是 `刷新失败`，说明余额/用量取数**现在就在失败**。不先弄清它，我们的降级路径可能是在给一个不存在的问题写代码。

- 复现：在并存状态下观察 `dsh-bottom-info-bar` 的失败分支落到哪一支。
- 判定归属：余额接口 / 用量接口 / 凭据解析 / 网络。
- 产出：一句话结论 + 我们的降级行为清单。

**完成判据**：能写出"失败发生在哪一步"的确定结论，而不是猜测。

---

## 阶段 1 · 记账内核（纯函数，零 IO）

这一层承担全部正确性，也是测试的主战场。

| 模块 | 职责 |
|---|---|
| `lib/price-table.js` | DeepSeek 各模型四类 token 的峰/谷单价。**单一来源**，不在别处复制 |
| `lib/usage-ledger.js` | 一条账 =（发起时刻, 模型, 四类 token, 档位, 状态）；聚合出 `会话/今日/近一月/全部 × 峰/谷` |

要点：

- 定档只接受"一个 UTC 瞬间"，内部调用 `time-window.js`。不自己判工作日、不自己判时区。
- 未知模型 → "未定价"桶，**不猜单价**。
- 聚合函数必须满足不变量：`峰 + 谷 ≡ 总`。

**完成判据**：纯函数单测覆盖全部边界（见测试方案 T1–T3），无网络、无文件、无时钟依赖（时钟注入）。

---

## 阶段 2 · Host 侧采集

照搬对方已验证的 `llm/stream` 范式（`dsh-bottom-info-bar/lib/index.js:3470`），并保留它踩过的每一个坑：

```
ctx.on('llm/stream', async function* (options, next) {
  const stream = await next();          // 抛错 → 只跳过记账，异常继续上抛
  let latestUsage = null;               // usage 是快照，保留最后一个（累加=重复计费）
  let sawFinish = false, committed = false;
  for await (const chunk of stream) {
    if (chunk?.type === 'usage' && chunk.usage) latestUsage = { ...chunk.usage };
    if (chunk?.type === 'finish') sawFinish = true;
    yield chunk;                        // 无条件透传，否则截断模型输出
  }
  // finally: 提交一次，sawFinish ? 'completed' : 'interrupted'
});
```

- 发起时刻在进入钩子时取，**不用结束时刻**定档（BR-4）。
- `inject` 增加 `credentials`。
- 落盘复用 `lib/hold-ledger.js` 的写法，但**新建独立存储文件**，不与滞留消息台账混用。

**完成判据**：正常 / 中断 / 上游抛错 / 无 usage 四种结局下，账目与模型输出都正确（测试方案 T4）。

---

## 阶段 3 · 余额

- `ctx.credentials.resolve(...)` → `GET https://api.deepseek.com/user/balance`。
- TTL + 失败退避；失败时**保留上次成功值并标记**，不空白、不显示 0。
- 密钥不落盘、不进日志、不进前端。

**完成判据**：断网 / 无凭据 / 401 三种情形下，栏内文案明确且不误导（T5）。

---

## 阶段 4 · Client 侧挂载

- 注册进 `conversation.composer.dock`，**自有 id**，不占用 `stats`。
- `slots` 服务可能晚于 `apply` 就绪：轮询等待 + 超时告警（对方是 45s），不静默失败。
- host↔client 数据走既有 `lib/badge-api.js` 的轮询模式，不新建通道。
- 样式克制，与官方 `StatsPills` 并存；悬停"本会话花费"展开 今日/近一月/全部 及峰谷拆分。

**完成判据**：卸载第三方插件后，官方行仍在，我们的行同时出现且数据正确。

---

## 阶段 5 · 设置项

并入现有 `settings.section`（峰谷刹车设置页）：栏显隐、余额刷新间隔、回扫开关。

---

## 阶段 6 · 验收与卸载

按测试方案跑完 → 用户肉眼确认 → 才执行 `dsh plugin --profile web remove dsh-bottom-info-bar`。

---

## 涉及文件（预估）

| 文件 | 动作 |
|---|---|
| `lib/price-table.js` | 新增 |
| `lib/usage-ledger.js` | 新增 |
| `lib/usage-collect.js` | 新增（`llm/stream` 捕获 + 余额） |
| `lib/info-bar-view.js` | 新增（栏的数据模型，纯函数） |
| `lib/client.js` | 改（注册 dock 槽位） |
| `lib/index.js` | 改（`inject` 加 `credentials`；挂采集） |
| `lib/badge-api.js` | 改（增加用量快照端点） |
| `lib/badge-settings*.js` | 改（新增设置项） |
| `test/*.test.mjs` | 新增 4 个套件 |
