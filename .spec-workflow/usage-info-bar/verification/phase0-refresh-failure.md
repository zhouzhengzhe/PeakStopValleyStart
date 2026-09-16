# 阶段 0 取证：`刷新失败` 到底失败在哪一步

**结论（一句话）**：不是网络、不是凭据、不是余额、不是用量——是第三方插件**每次都无条件探测六个端点**，其中
`getBillingMode` / `getSubscriptionSnapshot` / `getBillingStatus` 三个对「DeepSeek 余额制账号」本就没有意义，
它们 reject 就把 `刷新失败` 永久点亮。**这是插件自己造出来的假警报，而不是故障。**

取证日期：2026-09-16 · 被测插件 `dsh-bottom-info-bar@1.11.1`

---

## 一、先排除：四个候选全部健康

用户截图那条栏显示 `余额 ¥515.75`、`本会话 ¥30.790`，说明主要数据是有的。逐一验证四个可能失败点：

| 候选失败点 | 判定 | 证据 |
|---|---|---|
| **余额接口** | ✅ 正常 | `harness/dsh-usage/provider-snapshots.json`：`deepseek-official.balance.totalBalance = "515.00"`，`updatedAt` 为当日最新；该文件正在被实时重写 |
| **用量记账** | ✅ 正常 | `harness/dsh-usage/usage-ledger.json`：09-14/15/16 三天、按模型分桶的 `cost` 齐全，今日 `5.965372`，文件在持续增长 |
| **凭据解析** | ✅ 正常 | 同一文件 `credential: "env"` 且余额已成功取到——凭据能解析才可能有余额 |
| **远端定价目录** | ✅ 正常 | `logs/harness.log` 反复出现 `远程价目已合并（启动）：25 条有效条目`（20+ 次）；手工 HEAD 该 URL 得 HTTP 200 |

> 顺带否掉一个诱人的误判：`dsh-usage/pricing-cache.json` **不存在**，看起来像"定价目录从没拉到过"。
> 但日志里 25 条有效条目反复合并成功，且该 URL 从本机可达 —— 文件缺失只是这个版本不落该缓存，不是失败信号。
> **只看文件缺失会得出相反结论，必须以日志为准。**

## 二、`刷新失败` 是什么：一个通用陈旧标记

`lib/client.js:2370-2382`：

```js
// 全局降级提示：任一端点失败 → 旧数据照常渲染 + 角落提示（title 列出失败项），仅失败项降级
const failedLabels = [];
if (errors.balance)     failedLabels.push(t('ui.balance.pushBalanceGroups'));
if (errors.pricing)     failedLabels.push(t('ui.pricing'));
if (errors.usage)       failedLabels.push(t('ui.spend'));
if (errors.billingMode) failedLabels.push(t('ui.mode'));
if (errors.sub)         failedLabels.push(t('ui.subscriptionQuota'));
if (errors.billing)     failedLabels.push(t('ui.billing'));
```

即：**这一格本身不说明原因**，原因在它的 `title` 悬浮提示里；而栏里显示的数值是**上次成功值**（¥515.75 是旧值，现为 ¥515.00）。

**副作用（也是一个缺陷）**：`locales.js:101` 的键名是 `ui.balance.pushBalanceGroups` —— 明显是批量改写事故留下的坏键。
所以余额失败时，提示里会出现**原始键名**而不是「余额」。这一格的可读性本来就不可靠。

## 三、根因：六个端点无条件全打

`lib/client.js:1680-1686`（每次 load 都执行，与供应商实际计费模式无关）：

```js
Promise.allSettled([
  rpc('getBalanceSnapshot', ...),
  rpc('getPricing', ...),
  rpc('getUsageSummary', ...),
  rpc('getBillingMode', '...'),
  rpc('getSubscriptionSnapshot', ...),   // ← 余额制账号没有订阅
  rpc('getBillingStatus', ...),          // ← 余额制账号没有账单
]);
```

`mergeLoadResults`（`:142-164`）对**任一** reject 记 `errors[key]`，于是：

```
balance ✓  pricing ✓  usage ✓        →  数据全部正常显示
billingMode / sub / billing 之一 ✗   →  刷新失败 永久点亮
```

### 为什么这是"确定结论"而不是猜测

这是**排除法证明**，不是推断：

1. 用户**看见了** `刷新失败` ⇒ 六个端点里至少有一个 reject（`failedLabels.length > 0` 才会渲染这一格）。
2. 前三个端点已用运行时数据证明成功（第一节）——reject 的端点不可能同时成功。
3. ⇒ **必然**是后三个之一。

结论不依赖我猜哪一个具体的 reject，也不依赖任何日志（事实上该插件**根本不记录余额失败日志**，
全域检索无此类行——所以指望日志定位这条路本身是死的）。

## 四、对我们的意义：这条路径**不移植**

按需求文档「非目标」，我们只搬 DeepSeek 余额制这一条链路，**不搬订阅制与账单制**。因此：

**我们不会继承这个 bug** —— 前提是我们不照抄"六个端点全打"这个形状。

→ 由此得到一条**实施约束**（已并入测试方案）：

> **只探测与当前计费模式相关的端点。** 余额制不请求订阅/账单端点；不存在的模式不是错误，不产生任何失败标记。

这条值得写成断言，因为"顺手把六个都打上"正是这个 bug 的成因，而它看起来完全无害。

## 五、我方降级行为清单（本阶段要求的产出）

基于"四个数据源全部健康"，我们**不需要**为定价目录或用量采集写降级代码。真正需要的降级只有三条：

| 场景 | 行为 | 不做什么 |
|---|---|---|
| 余额接口失败 / 超时 / 401 | 保留上次成功值 + 明确标记"余额暂不可用，显示上次数据" | **不空白、不显示 0、不显示 ¥0.00** |
| 无凭据 | 明确提示"未配置凭据" | 不静默留空 |
| 未知模型 | 归入"未定价"桶且可见 | **不猜单价**（猜出来的金额比没有金额更糟） |

并且：**不引入"六端点全打"的形状**，从根上避免复刻 `刷新失败` 这类假警报。

## 六、本阶段未做的事（诚实记录）

- **没有**把 reject 精确到 `sub` / `billing` / `billingMode` 中的哪一个。排除法已足够支撑我们的三个实施决定
  （不移植、不照抄形状、降级只需三条），进一步精确对结论没有增量价值，故停止。
- **没有**在真实窗口里读那一格 `title` 的悬浮文本。新开的第二个客户端里该插件**完全不渲染**
  （`class*="bi-"` 命中数为 0，dock 里只有官方 `StatsPills`），无法在旁路复现；而如上所述，该提示本身
  因坏键 `ui.balance.pushBalanceGroups` 也不可靠。
- **没有**修改第三方插件的任何文件。它是参照物，不是被测物。
