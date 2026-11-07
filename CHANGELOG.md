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

