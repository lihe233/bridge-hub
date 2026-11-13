# 桥 Bridge Hub v1.4.18

> 本版集中解决三件事：**回复不出去（空回复 / 只收到半段 / 根本不发）**、**重复收到同一条消息**、**重启后漏掉的收发不会补**。
> 版本号沿用 1.4.18，覆盖旧的 1.4.18 发布。

---

## 一、回复「思考完整、但正文为空」

**现象**：带角色卡/工作流的对话里，模型思考过程完整、内容也对得上，但 AI 消息正文为空，数据库里 0 字符、0 token；微信/QQ 收到空消息，对话里留一个空气泡。

**根因（日志实证）**：`ask()` 用 `Tools.Chat.agentStatus(chatId)` 判断「这一轮有没有跑完」，每 3 秒查一次，连续 3 次判「不忙」就 break，紧接着无条件 `Tools.Chat.cancel(chatId)`。

而平台实际返回的是：

```json
{"isIdle":false,"isProcessing":true,"state":"processing"}
```

旧代码查的 `executing` / `running` / `isExecuting` **三个字段根本不存在**，于是永远算出「不忙」——9 秒后就把还在生成的那一轮掐掉。思考是流式写入的已经在库里，正文要整轮结束才落库，于是「思考完整、正文空」。

**修复**：

- 新增统一的 `__isBusy()`，同时识别 `isProcessing` / `isIdle===false` / `state==="processing"` 以及旧字段
- `ask()` 的结束信号改为**以 `sendMessage` 的 Promise 为准**，`agentStatus` 只做诊断（`ASK_IDLE_OBSERVED`），不再据此终止
- `cancel` 只在硬超时（`aiTimeoutMs`，默认 600 秒）才执行，且前后打 `ASK_CANCEL_BEGIN` / `ASK_CANCEL_DONE`
- 取消后必须**等平台真正空闲**再放行，避免下一条注入抢占这一轮（`ASK_STILL_BUSY`）

**验证**：同一环境下 `ASK ... ms=51226 len=2020`，等了 51 秒不再被掐。

---

## 二、长回复只收到第一段

**现象**：QQ 只收到前半段，日志出现 `40054005 消息被去重，请检查请求msgseq`。

**根因**：超过 1500 字被切成多条，但每条都带同一个 `msg_id`、**没有递增的 `msg_seq`**，QQ 把第二条起当成重复消息拒掉。

**修复**：分段发送时带上递增 `msg_seq`（1、2、3…）。

**验证**：`QQ_SPLIT parts=2` 后两条均返回成功，不再出现 40054005。

---

## 三、整轮跑完却从没发出去

**现象**：日志里只有 `ASK_START`，之后一条都没有——既没有 `ASK` 也没有报错；对话里能看到回复，手机端收不到。

**根因**：`Tools.Chat.sendMessage` 的 Promise 有时**永远不 resolve**，而 `ask()` 只能等它，于是桥永远走不到「发出去」这一步。

**修复**：`ask()` 增加第二条通道——**同时盯数据库**。只要本轮之后出现 AI 正文、长度两次一致、且平台不忙，就直接从库里取正文返回（`ASK_DB_READY` / `ASK_FROM_DB`），不再死等 Promise。

**验证**：`ASK_FROM_DB chatId len=NNN` 正常出现，回复按时送达。

---

## 四、重启后漏掉的收发不会补

**现象**：消息刚发出去、或回复刚生成完，插件/App 就被重启，之后既不会补发回复，也不会重新处理那条用户消息。

**根因**：完全没有启动补偿机制；而且微信侧还有个顺序错误——**先写 `seen` 再判代次**，插件重启时这一轮作废，但 key 已经进了 `seen`，于是这条被当成「已处理」，补偿也不会再管它。

**修复**：新增启动检查（**只在插件加载时跑一次**）：

1. `__sweepCaptureBase()`：记下每个对话此刻的消息条数作为**基线**
2. **出站补偿**：最后一条是 AI、索引 ≥ 基线、内容指纹未记过 → 补发
3. **入站补偿**：最后一条是 user、`seen` 里没这条、索引 ≥ 基线、平台不忙 → 重新注入一次
4. 遇忙时**耐心等待**（最多约 2 分钟），不直接放弃
5. 微信侧把代次检查移到 `seen` 之前

配套：`last_peer.json` 持久化对端信息（`scene` / `from` / `group` / `ctx` / `msgId` / 原文）。

**验证**：`SWEEP_DONE` 后无 `SWEEP_SEND`，历史消息不会被重发。

---

## 五、同一条消息收到两次

**现象**：用户发一句，收到两条一模一样的回复。

**根因（三个来源，逐条修掉）**：

1. **补偿与正常投递抢发**：两边都在「发完之后」才记账，都能通过检查
   → 新增统一出口 `__deliverOnce()`，**发送前先预占内容指纹**，后到者 `DEDUP_SKIP`
2. **两条轮询通道**：Python `wxpoll.py`（3 车道）与 JS `wxLoopOnce` 各用自己的游标拉同一批消息
   → **停用 Python 轮询**，只保留 JS（`WXPOLL_DISABLED js_poller_only`）
3. **同一条消息并发进入**：`seen` 是处理成功后才有记录
   → 新增「在途表」`__inflightTake()`，一开始处理就占位，5 分钟自动过期

去重指纹为 `正文 + 本轮用户消息 ID`：同一轮内两条路径指纹一致，不同轮即使回复内容相同也不会被误杀。

**验证**：同一轮只出现一次 `WX_REPLY` / `QQ_REPLY`。

---

## 六、对话忙时静默丢消息

**现象**：上一条还在生成时，新消息发过来没有任何回复。

**根因**：`process()` 最多等 15 秒，仍忙就 `return ""`，上层当成失败并把消息 `DROP` 掉。

**修复**：改为**最多等 5 分钟，等不到也照常排队注入**——宁可晚回，也不静默丢弃（`CHAT_BUSY_WAIT` / `CHAT_BUSY_PROCEED`）。

---

## 七、其它修复

| 问题 | 现象 / 根因 | 修复 |
|---|---|---|
| 配置项全部失效 | `state.cfg` 从未赋值，`aiTimeoutMs` 等永远走默认值 | `restore()` 补上赋值 |
| 手改配置不生效 | 优先用内存 `cfgOverride`，改文件要重启 App | 改为**文件优先**，`startWith` 例外 |
| QQ 失败不记账 | 失败后不写 `seen`，重投/重启会反复处理同一条 | 失败必落 `seen` |
| 失败重试重复注入 | 重试等于把同一条消息再注入一遍 | 改为 `__recoverReply` 从库里取回正文 |
| 长回复尾部被截掉 | `__splitLong` 只切一刀，第二段仍超长就 `slice` 丢弃 | 改循环切分 |
| 取不到正文 | `pickText` 只读 `item_list[0]` | 遍历全部 item |
| 日志写入 O(n²) | 每条日志都读整个 `rt.log` 再整体写回 | 缓冲 800ms 批量写 |
| 清日志清不干净 | 内存缓冲会在清空后被刷回 | 先清缓冲再清文件 |
| 去重记录丢一半 | 内存 1024 条、持久化只存 500 条 | 统一为 1024 |
| 队列内存泄漏 | `chatQueues` 永不回收 | 用完即删 |
| 命令注入 | 账号名/路径直接拼进 shell | 新增 `shq()` 单引号转义 |
| 重命名把账号搞失联 | `void __termExec` 不等结果就改配置 | 改 `await` + 校验目录 |
| 回收站留孤儿目录 | 删除失败仍从索引移除 | 删除成功才移除 |
| 状态显示残留 | `stop()` 不清 `run_state.json` | 新增 `markRunClear()` |
| 调试接口吞消息 | `bridge_pump` 拿 QQ runtime 走微信 getupdates | 跳过 QQ 通道 |
| 死代码 | `bridge_test` 里 `api2`/`api`/`vision` 三组各重复两遍；`__deliverText` 与 `__deliverOnce` 并存 | 全部删除 |

---

## 八、部署说明（重要）

**不要直接修改** `cache/toolpkg/com.operit.bridge_hub-*/dist/main.js`。

该目录带签名校验，插件加载时会用**未改动的 `.toolpkg`** 重新解包，改动会被静默覆盖——表现为「改完 md5 一致、但日志还是旧句式」。

正确路径：

1. 把新包放到 `extensions/device/packages/bridge_hub-v1.4.18.toolpkg`
2. 删掉（或改名）旧缓存目录
3. `package disable` → `package enable`

---

## 九、验证清单

- `node --check` 对 `main.js` / `ui` / `packages` 全部通过
- 启动日志：`START gen=1 accounts=3` → `QQ_READY` → `SWEEP_DONE`
- 空回复：`ASK_SETTLE done=true`，不再出现 `ASK_IDLE` 后紧跟 `len=0`
- 长回复：`QQ_SPLIT` 后全部段落发送成功
- 不复读：同一轮只有一次 `WX_REPLY` / `QQ_REPLY`
- 不重发历史：`SWEEP_DONE` 前无 `SWEEP_SEND`


---

# 历史版本

# 桥 v1.3.19 改动说明

> 本版只修一处：**桥把正在生成的回复掐掉，导致「模型思考完整、正文为空」。**

---

## 现象

用户反馈：桥注入消息后，模型**思考过程完整、内容也对得上**，但最终写进对话的 AI 消息正文为空，数据库里那条消息 0 字符、输入输出 token 均为 0。

同时：
- 同一个对话手动打字回复，一切正常
- 换成不思考的模型（flash），现象不变
- 桥日志里 `ASK` 返回 `len=0`，随后 `REQUEUE` 重发，重发时 QQ 官方接口报 `40054005 消息被去重`
- 影响面：QQ 和微信那边收到空消息，对话里留一个空气泡

## 根因

问题在 `dist/main.js` 的 `ask()` 等待逻辑，不在模型、额度、上下文长度。

原逻辑：

```js
while (!done) {
    await sleep(3000);
    var st = await Tools.Chat.agentStatus(chatId);
    var busy = !!(st && (st.executing || st.running || st.isExecuting));
    if (busy) { idleN = 0; }
    else {
        idleN++;
        if (idleN >= 3) { await rlog("ASK_IDLE ..."); break; }   // 3×3s = 9 秒
    }
}
if (!done) {
    try { await Tools.Chat.cancel(chatId); } catch (e) { }       // 无条件 cancel
    ...
}
```

两个错误：

1. **判定依据不可靠**：`agentStatus` 在带角色卡 / 工作流 / 长上下文的对话里不报 `executing / running / isExecuting`，桥于是把「查不到在跑」当成「答完了」。干净对话里生成快、9 秒内就结束，所以没暴露；带角色卡的对话生成慢、思考长，正好撞上这个判定。
2. **判定之后直接掐生成**：`break` 后无条件调用 `Tools.Chat.cancel(chatId)`。思考是流式写入的，已经在库里；正文要等整轮结束才落库，被 cancel 就丢了 —— 用户看到的就是「思考完整、正文空」。

补充：`cancel` 写在 `try/catch` 里且不打日志，所以从日志里只能看到 `ASK_IDLE`，看不到它引发的截断，这也是这个问题一直定位不到的原因。

**桥没有「截断模型输出」的代码，但这段 `cancel` 的效果等同于截断。**

## 修复

以 `sendMessage` 返回的 Promise 为准，`agentStatus` 降级为诊断信号：

1. **正常结束只认 Promise**：`done === true` 代表这一轮真的结束，直接取正文，不 cancel。
2. **空闲判定不再终止**：`agentStatus` 报空闲只在第 3 次时记一条 `ASK_IDLE_OBSERVED`（带 `st` 原始返回，便于日后验证），**不 break、不 cancel**。
3. **只有硬超时才 cancel**：`aiTimeoutMs`（默认 600000ms）到了才 break 并 cancel，且前后分别打 `ASK_CANCEL_BEGIN` / `ASK_CANCEL_DONE`，失败打 `ASK_CANCEL_ERR`。
4. **cancel 后给足收尾时间**：从 10 秒延长到 20 秒，拿到内容就照常返回。
5. **结束必留痕**：每次退出等待都打 `ASK_SETTLE done=0|1 hard=0|1 ms=...`。

## 验证

- `node --check` 语法校验通过（exit 0，无输出）
- 与原文件 `diff` 仅 `ask()` 函数内变动，共 50 行差异，其余 1827 行未动
- 部署后源文件与校验文件 md5 一致：`803f1ec1ef240bf230ba2ae855fb9c24`

## 复现验证步骤

1. 重启桥（包管理里停掉再启，或重启应用）
2. 在带角色卡的对话里，从 QQ/微信发一条会触发长思考的消息
3. 观察 `rt.log`：
   - **修复前**：`ASK_IDLE ... ms=9012` → `ASK ... len=0` → `REQUEUE`
   - **修复后**：可能出现 `ASK_IDLE_OBSERVED ...`（只是记录），但**不会再出现紧随其后的 `len=0`**，而是正常 `ASK ... len=NNN`
4. 如果仍出现 `len=0`，看是否有 `ASK_HARD_TIMEOUT` 和 `ASK_CANCEL_BEGIN` —— 那才说明是真超时（600 秒），另作处理

## 回滚

原始文件已备份：
- `/sdcard/Download/Operit/bridge_hub/main.js.orig`
- `/sdcard/Download/Operit/bridge_hub/main.js.bak.*`


---

