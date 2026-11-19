# 桥 v1.6.18

本次是审核驳回（1.5.18「存在安全风险」）的修复版，同时把两个新开关做进账号设置。

## 1. OpenAI 兼容网关默认对外监听 —— 已修

**现象**：审核意见「OpenAI 兼容网关监听所有 IPv4 接口。关闭公网访问后仍允许局域网连接」。

**根因**：
- `gw.py` 里写死 `ThreadingHTTPServer(("0.0.0.0", port))`，任何网卡都在听；
- 访问控制 `_lan()` 在 `allow_public=false` 时对 `10./192.168./172.16-31.` 等私网地址直接放行，等于「关了公网也照样给整栋楼的 Wi-Fi 用」。

**修复**：
- 新增 `expose` 三档：`local`（默认，只绑 `127.0.0.1`）、`lan`（绑 `0.0.0.0`，只放行私网段）、`public`（绑 `0.0.0.0`，不限来源）；
- `expose` 只认显式配置，旧配置里没有该字段时按 `allowPublic ? public : local` 迁移，**升级后默认回到仅本机**；
- 账号设置里原来那个「允许非局域网访问」的开关，换成「仅本机 / 局域网 / 公网」三选一，选局域网或公网前必须先有访问令牌。

**验证**：
- 单元级：18791~18794 四个端口分别跑 `local` / `lan` 无密钥 / `lan` 带密钥 / `public` 带密钥。`local` 下局域网 IP 连接被拒；`lan` 无密钥自动降级回环；`lan`+密钥时局域网可连、无密钥 401、带密钥 200；`public` 同上。
- 实机：升级后 8789 端口 `gw listening 127.0.0.1:8789 key=True expose=local`，本机 `/health` 200，`10.226.2.231:8789` Connection refused。

## 2. 密钥留空跳过鉴权 —— 已修

**现象**：审核意见「密钥留空时又会跳过鉴权」。

**根因**：`_auth()` 第一行就是 `if not st.key: return True`，没配密钥等于没有门。

**修复**：
- 改成 fail-closed：密钥为空时，除回环以外一律拒绝；
- `serve()` 再加一层硬保险：`expose` 不是 `local` 但没密钥时，直接降级为只监听 `127.0.0.1`，并在 `rt.log` 写 `GW_REFUSE_OPEN`；
- `/v1/models`、`/health` 也纳入鉴权（本机回环仍免密钥，探活不受影响）；
- `/log` 仍然只接受回环来源。

**验证**：带密钥实例上，局域网请求 `/health`、`/v1/models` 均 401；`127.0.0.1/health` 仍 200；无密钥 + `expose=lan` 时实际监听地址为 `127.0.0.1`。

## 3. 新增：Waifu 切条（账号设置）

**需求**：让桥的回复按 Waifu 模式插件的句子边界切成多条发送，而不是只在超过 1500 字时硬切。

**实现**：
- 「账号设置 → 回复与接收」新增开关「Waifu 切条（按插件分句发送）」，默认关闭；
- 开启后走 Waifu 的公开 API：`session.open` → `session.feed(final=true)` → `session.close`，只取 `kind=text` 的段，图片段先忽略（微信/QQ 上传链路另做）；
- 每段再按平台上限兜底切一次，段间仍是 300ms；
- 任何一步失败（没装、没启用、调用被拒）都静默回退到原来的 `__splitLong`，不会因为依赖缺失把消息卡住；
- manifest 声明 `requires: com.operit.waifu`（Waifu README 要求的依赖方式）。

**验证**：用一个临时测试包（同样声明依赖）调 `session.open/feed/close`，输入「你好。今天很热，出去走走吗？还没有决定。」返回 3 段：`你好。`、`今天很热，出去走走吗？`、`还没有决定。`，`charDelayMs=250`。测试包已删除。

## 4. 新增：群聊接收模式（QQ 账号设置）

**现象/疑问**：群里现在只有 @ 机器人才有反应，不清楚没 @ 的消息是不是被丢掉。

**根因**：代码同时监听 `GROUP_AT_MESSAGE_CREATE`（@ 我）和 `GROUP_MESSAGE_CREATE`（群全量消息），但 QQ 平台默认只推 @ 事件，所以看起来「仅 @ 生效」；一旦平台开了全量消息权限，插件会连没 @ 的消息也一条条回。

**实现**：
- QQ 账号设置新增「接收全部群消息（关闭＝仅 @ 我）」，默认关闭；
- 关闭时直接丢弃 `GROUP_MESSAGE_CREATE`，并写 `QQ_GROUP_AT_ONLY` 日志；
- 开启时两种事件都处理（仍需平台给全量消息权限）；
- 进对话前清掉 content 里的 `<@!openid>` 标签，模型不会再看到一串 ID。

**验证**：开关状态经 `bridge_status` 返回 `groupAll`；群事件分支按开关短路，代码路径已核对。

## 5. 已知行为变化

- 升级后默认只监听本机。原来靠局域网调 `/v1` 的场景，需要进账号设置把「监听范围」切到「局域网」（并确认已有访问令牌），否则会连不上。
- 切「局域网 / 公网」前必须先生成访问令牌，界面会拦一次。

## 6. 修复：所有「复制」按钮点了没反应

**现象**：账号页的「复制链接」「复制接口地址」「复制令牌」「复制接口密钥」，以及设置页的链接「复制」，点了以后剪贴板里什么都没有。

**根因**（两处叠加）：
- UI 侧 `opCopy` 第一分支探测 `ctx.copyToClipboard`，但平台 UI 上下文根本没有这个方法（整套类型定义里搜不到 `copyToClipboard`），判断永远为假；
- 兜底走的 `bridge_core:bridge_clip` 用终端执行 `cmd clipboard set-text`。Android 没有这个命令，`__termExec` 失败只返回 null，而代码不检查返回值就 `return {success:true}`，于是**假报成功**、剪贴板始终为空。

**修复**：
- `main.js` 的 `bridge_clip` 改用平台开放接口 `Tools.System.setClipboardText(text)`（`system.d.ts` 有正式声明，返回 `Promise<string>`），成功写 `CLIP_SET via=api` 日志；
- 终端方案降为兜底，且**如实回报失败**（检查输出里的 not found/permission denied），不再假成功；
- UI 侧 `opCopy` 改为三级：`ctx.copyToClipboard`（平台若将来提供）→ `Tools.System.setClipboardText` → RPC `bridge_clip`，失败才提示「自动复制失败，请长按选中复制」；
- 设置页「关于」里的复制按钮（原来另写一套，用 `p.success !== false` 判断）统一改成走 `opCopy`。

**验证**：
- 在插件主运行时插临时探针打印 `typeof Tools.System.setClipboardText` 并实调一次，日志为 `CLIP_PROBE hasSystem=true hasSet=true` / `CLIP_PROBE wrote=operit-probe-123`，确认接口存在且真实写入；探针已移除，成品包内无 `CLIP_PROBE` 字样；
- 界面点按复制的实际效果由用户验收（AI 无法代点）。

## 7. 监听范围控件的三处使用体验

- 三个档位按钮原来文字太长（「仅本机 / 局域网 / 公网」）会被折成两行，改短为「本机 / 局域网 / 公网」，并用底色（`containerColor`）标识当前档位，不再靠文字长度；
- 切到「局域网 / 公网」改为弹窗确认：写清「会监听 0.0.0.0、谁能连上来、必须带令牌」；还没令牌时确认按钮变成「生成令牌并开放」，确认后自动调 `bridge_token` 生成；
- 生成完再弹一次「已生成访问令牌」把令牌显示出来（原来只改配置不提示）；
- 切回「本机」不弹窗，直接生效；点当前已选中的档位不重复弹窗。
- 弹窗节点原来塞在 `LazyColumn` 的子节点列表里，改为与 `LazyColumn` 并列挂在最外层 `Box` 下，避免随列表滚动重建。

## 8. 监听范围改成一次点按生效；复制给出可见提示

**现象**：切监听范围要点两次才切过去；复制成功了但界面没任何提示。

**根因**：
- 切档位走「点按钮 → 弹确认 → 再点确认」三步，且界面刷新要等账号重启完才更新，第一下点完看不到任何变化；
- `TOAST()` 只是把文字写进 `msgState`，而这段文字渲染在列表最顶部——滚到账号卡片再点复制，提示在屏幕外，等于没有。

**修复**：
- 切「本机 / 局域网」一次点按直接生效，没令牌就顺手生成；切「公网」仍保留确认弹窗（风险最高）；
- 点下按钮立即本地更新档位高亮（乐观更新），不等重启完，失败再回滚；
- `TOAST()` 改用宿主 `ctx.showToast()`，提示浮在最上层，改名/删除/复制等所有提示一并变可见；
- 新增 `bridge_uilog` 工具，把界面上的切档动作写进 `rt.log`，以后排查点问题不用猜。

**验证**：界面操作由用户验收；`rt.log` 会同时输出 `UI tap expose ... want=/cur=` 和 `UI expose applied ... ok=`，一看就知道点了几下、传到后端没有。

## 9. 切到「公网」实际没生效：旧网关进程占着端口

**现象**：账号设置里切到「公网」，界面也显示已切，但 `/health` 返回的 `expose` 还是 `lan`。

**根因**（两层）：
- 旧 `gw.py` 进程还在占着 8789，新进程启动时 `ThreadingHTTPServer` 抛 `OSError: [Errno 98] Address in use` 直接退出，**旧进程继续按旧档位跑**；
- 重启网关前只会 `kill $(cat gw.pid)`，而 pid 文件每次重启都被覆盖，漏杀的旧进程永远不在 pid 文件里；进程名兜底那行写的是 `ps -ef | awk '{print $2}'`，但本机 `ps -ef` 输出是 `PID USER TIME COMMAND`，$2 拿到的是用户名 `root`，`kill -9 root` 等于什么都没干。

**修复**：
- 新增 `gwKillAll()`：pid 文件 + `pkill -f 'gw[.]py'` + `ps -ef | grep '[g]w[.]py' | awk '{print $1}'` 三路兜底（带方括号写法，避免 grep/pkill 匹配到执行命令自身）；
- 杀完轮询等端口释放（最多 2.4s），端口还占着就**不 spawn**，写 `GW_PORT_BUSY_SKIP_SPAWN` 而不是再起一个僵尸进程；
- 启动后校验 `/health` 的 `expose` 是否等于配置值，不一致写 `GW_EXPOSE_MISMATCH`，不再「200 就算活着」；
- 存活判定从「同名配置 + 有 200」改成「同名配置 + 无档位不一致 + 全部端口 200」。

**验证**：
- 修复前 `rt.log`：`GW_EXPOSE_STALE want=public` → `GW_HEALTH 200`（实际还是 lan），`ps` 里同时存在两个 `gw.py`，`gw.log` 里有 `Errno 98`；
- 修复后：`GW_KILL GW_KILLED` → `GW_SPAWN GW_SPAWNED 20733` → `GW_HEALTH 200 expose=public want=public`，`ps` 只剩一个网关进程。

## 10. 点「清除密钥」卡一下 —— 把网关重启从请求里挪出去

**现象**：点清除密钥/重新生成令牌时，按钮要转很久。

**根因**：密钥是网关的启动参数（`gw_ports.json` 里的 `key`），改它必须重启 `gw.py`。而重启是同步串在 RPC 里的：杀旧进程 → 等端口释放 → 写配置和源码 → 重新拉起 → 探活，全程界面只能等。里面还有两处浪费：源码没变也会做一次「find 插件目录 + cp」；固定 `sleep 1` + `sleep 2`。

**修复**：
- 清除/生成令牌、改端口、改监听范围只写文件就返回，网关重启交给后台定时器（400ms 合并窗口，连续改动只重启一次）；
- 界面先本地置空令牌区（乐观更新），不等 RPC 回来；
- 重启流程瘦身：`gw.py` 源码内容未变则跳过 find/cp；`sleep 1`→`0.6`、`sleep 2`→`1.2`；端口等待 8×300ms 改为 12×150ms 且端口一释放立即继续；
- 切 expose 不再重启账号（只影响网关监听），Waifu 切条/群聊接收仍需重启账号但改为后台执行、不阻塞界面；
- 启动时若配置与运行态一致，直接 `GW_ALIVE` 复用进程（之前每次启动都会白重启一次网关）。

**验证**：重载后日志为 `GW_CHECK same=true` → `GW_ALIVE 1`，不再多杀一次；清除密钥的交互耗时由用户验收。

## 11. 网关重启串行化 + 重启提示弹窗 + 进一步提速

**担心的问题**：后台重启会不会和启动恢复、连续改配置撞在一起。

**处理**：
- 所有网关操作走一个 Promise 队列（`__gwChain`），启动恢复、后台应用、手动重载排队执行，不会出现两个 `gw.py` 抢同一个端口；
- 后台重启带 400ms 合并窗口，正在跑时再次触发只标记「再来一次」，跑完合并成一次；
- `__gwApplying` 无论成败都在 finally 清掉，避免弹窗挂死；该标记随 `bridge_status` 返回，界面据此显示进度。

**提示**：新增「正在应用设置 / 网关重启中…」弹窗，检测到真的在重启才弹，重启完自动关掉并 toast「网关已重启」。不需要重启的改动（本机下改密钥）不会弹。

**提速**：
- 所有端口都是「仅本机」时，改密钥不重启网关（回环免鉴权，密钥用不上），日志 `GW_KEY_LOCAL_SKIP`；实测进程 PID 不变；
- `gw.py` 源码未变就跳过「find 插件目录 + cp」；
- 杀进程 `sleep 1`→`0.6`，拉起 `sleep 2`→`1.2`，端口等待 8×300ms→12×150ms；
- 启动时配置与运行态一致直接 `GW_ALIVE`，不再每次启动白重启一次。

**公网通道无密钥的验证**（独立端口 18789 跑 `gw.py --expose public --key ''`）：
- 启动日志：`gw listening 127.0.0.1:18789 key=False expose=local`，并且 `GW_REFUSE_OPEN`；
- `127.0.0.1:18789/health` → 200；
- `192.168.110.175:18789/health`、`/v1/models` → Connection refused（根本没对外监听）。

结论：没有密钥时即使选了公网也不会真的对外开，不存在「无密钥放行」这条路径。测试实例已清理。

## 12. 空密钥切档时两个弹窗叠在一起

**现象**：从「本机」切到局域网/公网且没有密钥时，「正在重启网关」和「已生成访问令牌」两个弹窗同时出现，互相盖住。

**根因**：`doExposeNow` 里生成令牌后立刻 `exposeAskState.set({step:"key"})` 弹密钥框，而重启是后台任务、400ms 后才开始，`watchGw` 是 `void` 出去的——两边互不知情，于是同时渲染两个 `AlertDialog`。

**修复**：
- 有密钥要展示时改成 `await watchGw(..., quiet)`：先把重启弹窗走完，再弹密钥框，顺序固定为「重启 → 密钥」；
- `bridge_status` 新增 `gwPending`（已排上队、还没开跑），界面据此判断「要不要等」，不必盲等轮询；
- `watchGw` 首查一次：既没 `gwPending` 也没 `gwApplying` 就直接返回，不多发请求。

**验证**：代码路径已收紧（`await` 串行），实际交互由用户验收。

## 13. 顶部分段按钮选中态没有颜色区分、深底配黑字看不清

**现象**：概览 / 通道 / 设置、微信 / QQ / 公开 / 回收 这两行，点中之后外观没有任何变化，看不出当前在哪一页；蓝色主题下文字发黑，压在深色底上看不清。第二版改完更糟：未选中变成纯灰（没有主题色）、选中那个只剩一圈描边、没有填充。

**根因（两层）**：

1. 这两处原本只给了 `weight` 和 `onClick`，用的是 `ctx.UI.Button` 的默认样式，选中与未选中是同一个底色，所以「选中不明显」；
2. 关键一条：**`ctx.UI.Button` 的 `containerColor` / `contentColor` 在这台机器上填不出底色**。传了颜色之后按钮依旧是描边样式、文字退回默认深色。所以第一版和第二版的填色尝试都只改到了文字，没改到底色 —— 「深色字体只描边」就是这么来的。

**修复**：不再借 Button 上色，改成一个统一的分段控件 `SEG(isOn, label, onTap, style)`，用 `Row` 自身的绘制与点击能力：

- `background` 直接画底色，`backgroundShape: { cornerRadius: 18 }` 做圆角；
- `onClick` 承担点击，不依赖 Button 的交互层；
- 文字颜色**显式**给，不靠 `contentColor` 继承；
- 取色走 `ctx.MaterialTheme.colorScheme`：未选中 `primaryContainer`（主题色的浅色）+ `onPrimaryContainer`，选中 `primary`（主题色深底）+ `onPrimary`（反白）+ 加粗；
- 每次渲染现读色板，不缓存 —— 缓存的话切深色/换主题色，界面不会跟着变；
- 色板里取不到的键，退回 `primary` 加 14% 透明度（`copy({alpha})` 后单独赋 `over`，`copy()` 本身只接受 `alpha`），再取不到才退回同名 token 字符串；
- 极端情况下 Row 不可点击，退回普通按钮，保证点得动。

三处接入：一级导航（概览/通道/设置）、通道标签（微信/QQ/公开/回收）、账号设置里的监听范围（本机/局域网/公网）。

**验证**：`node --check` 两个文件都通过；打包 69742 字节并安装；运行缓存里确认已是新版（`CS_OF` / `TOK_TINT` / `backgroundShape` 齐全）；插件重载后 `rt.log` 正常，`gw.py` 1 个进程、`media_worker.py` 1 个进程，`/health` 返回 `{"ok":true,"auth":true,"expose":"local"}`。实际观感由用户验收。

## 14. 删除点了没反应、回收站里看不到东西

**现象**：点账号右侧的删除图标，提示「请点下方『确认删除』才会真正删除」，但下方确认条里只有「取消」，没有那个按钮，账号删不掉；回收站页面也不是空的而是几乎没东西（实际磁盘上躺着 5 个已删账号）。

**根因（两处独立问题）**：

1. **确认条缺按钮**。`accountCard` 里展开的确认条只 push 了「取消」一个 `BTN`，负责真正删除的按钮从来没有被写进去。而删除图标的 `opAskDelete` 又明确提示「请点下方『确认删除』」——用户按提示去找，找不到，删除就走不完。（图标连点两次确实能删，但没人会那么猜。）
2. **回收站只读索引、不看磁盘**。`trash_list` 直接返回 `.trash/index.json`。而 4 天前那批删除只把账号目录移进了 `accounts/.trash/`，索引里没有对应记录（当时还没有这套索引），于是那 4 个目录成了孤儿：列表里看不到、恢复不了、也删不掉。索引里现有 1 条，磁盘上有 5 个目录，对不上。

**修复**：

- UI：确认条补上「确认删除」按钮（`opDoDelete`），和「取消」并排；
- 后端：新增 `trashListDirs()` + `trashReconcile()`，以磁盘目录为准、索引为缓存做双向对账 ——
  - 目录有、索引没有：从目录名 `<名字>-<时间戳>` 还原出名字和删除时间，补一条记录（类型从目录里的 `account.json` 读），标记 `adopted:true`；
  - 索引有、目录已不存在：剔除该死条目；
  - 有变化才回写索引，并记 `TRASH_RECONCILE n=`；
- `trash_list` / `trash_restore` / `trash_purge` 三处入口全部改为先对账再操作，避免「列表里有、操作时目录已不在」这种半截状态。

**验证**：`node --check` 两个文件通过；打包 70480 字节并安装；运行缓存里 `trashReconcile` 出现 4 次（定义 1 + 调用 3）、UI 里「确认删除」4 次（注释 3 + 按钮 1）；插件重载后 `rt.log` 正常、`gw.py` 1 个进程。对账结果需在回收站页刷新后看 `TRASH_RECONCILE` 日志确认。

## 15. 删除确认改成弹窗（替掉卡片内联确认条）

**起因**：第 14 条只是把内联确认条的按钮补齐，形态仍然是「卡片里多出一行」。用户要求直接弹窗：点删除 → 弹出「确认删除 / 取消」。

**做法**：

- 删除图标点一下只做一件事：`delState.set(name)`，由最外层渲染的 `delDialog()` 弹出确认框；
- `delDialog()` 用 `ctx.UI.AlertDialog`，标题「删除账号」，正文写明「删除后会进回收站，可以恢复」，按钮「确认删除 / 取消」，`onDismiss` 与 `onDismissRequest` 都只清状态，不会误删；
- `opDoDelete(name)` 改为接名字而不是账号对象，并且顺手加了一条：如果当前正停在这个账号的详情页，删完一并退出详情，避免停在一个已经不存在的账号上；
- 卡片里的内联确认条整段删除，`delState` 只承担「哪个账号的弹窗开着」这一个职责。

**验证**：`node --check` 通过；打包 70521 字节并安装；运行缓存里 `function delDialog` 1 处、`delDialog(),` 挂载 1 处、内联确认条残留 0；插件重载后 `rt.log` 正常、`gw.py` 1 个进程、`/health` 返回 `{"ok":true,"auth":true,"expose":"local"}`。弹窗实际观感由用户验收。

## 16. 回收站「删除」是彻底删除，却没有二次确认

**现象**：在回收站里「全选 → 删除」，直接就把记录清掉了，没有任何确认框。上一轮加的确认框只加在账号卡片的删除图标上，管不到这里。

**根因**：回收站底部那排按钮里，「删除」的 onClick 直接就是 `RPC("bridge_core:trash_purge", ...)`，中间没有任何确认环节。而这个动作是**永久删除**——目录连同里面的凭证一起 `rm -rf`，比账号卡片的「删除（进回收站）」更危险，属于必须二次确认的操作。

**修复**：

- 新增状态 `purgeAskState` 保存「待永久删除的目录列表」；
- 「删除」按钮改成只做 `purgeAskState.set(chosen.slice())`，不再直接发 RPC；
- 新增 `purgeDialog()`：标题「永久删除」，正文写明确认数量与「删除后无法恢复」，按钮「永久删除 / 取消」，`onDismiss` 与 `onDismissRequest` 只清状态；
- 真正的清空动作抽成 `doPurge(dirs)`，成功后才 `tickState.set({})` + `loadTrash()`，失败把原因写进 `errState`；
- 弹窗挂在最外层，和 `exposeDialog()` / `delDialog()` / `gwDialog()` 并列。

顺带说明：「恢复」没有加确认——它是可逆方向的操作，加了只是多一步。

**验证**：`node --check` 通过；打包 70754 字节并安装；运行缓存里 `function purgeDialog` 1 处、`purgeDialog(),` 挂载 1 处；插件重载后 `rt.log` 正常、`gw.py` 1 个进程。实际交互由用户验收。

## 17. 永久删除执行了但记录还在；回收站要手动点刷新才显示

**现象**：回收站里全选 → 删除 → 确认弹窗点「永久删除」后，列表没有任何变化，重新打开还在；另外进回收站时列表是空的，得点一下「刷新」才出来。

**根因（两条，第一条是硬伤）**：

1. **`Tools.Files.exists()` 返回的是对象，不是布尔值**。类型定义写得很清楚：`exists(path: string): Promise<FileExistsData>`，而 `FileExistsData` 是 `{ path, exists: boolean, isDirectory: boolean, size: number }`。代码里 5 处全都直接把它当条件用，于是：
   - `trash_purge` 里 `_still = await Tools.Files.exists(full); _delOk = !_still;` —— `_still` 永远是真值对象，`_delOk` 恒为 false，**目录被 `rm -rf` 删掉了，记录却被判定「删除失败」重新塞回索引**，于是索引里躺着 5 条指向已消失目录的死记录，界面自然“没变化”；
   - `trashReconcile` 里 `if (ex)` 恒为真，死记录永远剔不掉；
   - `trash_restore` 里同理，会误判目标账号已存在，恢复时一路把名字改成 `名字 (99)`；
   - `rename` 完成后的目录校验也恒为真，等于没校验。
2. **回收站首次不自动取数**。`chanState` 是持久化状态，重开页面时它已经是 `trash`，不会再触发 `chanTab` 的点击回调，`trashState` 仍是 `null`，于是停在「点右上『刷新』加载回收站」。

**修复**：

- 新增 `fsExists(path)` 统一归一化：拿到对象就取 `.exists`，拿到布尔值就用布尔值，两者都不是则按“存在”处理；
- 5 处调用点（对账、恢复 ×2、永久删除、改名校验）全部改走 `fsExists`；
- 回收站页首次渲染时若 `trashLoaded` 还是 false，自动 `loadTrash()` 一次，不用再手点刷新。

**验证**：`node --check` 两个文件通过；`grep Tools.Files.exists` 在 main.js 里只剩 helper 自身那 1 处；打包 70997 字节并安装；运行缓存里 `function fsExists` 1 处、`trashLoaded` 2 处；插件重载后 `rt.log` 正常、`gw.py` 1 个进程。

**现场自愈**：用户上一次「永久删除」实际已经把 5 个目录删掉了，只是索引没同步。装上这版后打开回收站，对账会发现这 5 条记录对应的目录都不存在，自动清空索引——所以列表会显示为空，这是正确结果，不是又丢了数据。

## 18. 删掉「接收全部群消息」开关（腾讯侧不提供该权限）

**背景**：为了接收群里没 @ 机器人的普通消息，之前加了一个 `groupAll` 开关，对应 QQ 的 `GROUP_MESSAGE_CREATE` 事件。实测腾讯并没有给公域机器人开放「全量群消息」权限，这个事件根本不会下发，开关开着也没有任何效果，只会误导使用者。

**删除范围（全链路，grep `groupAll` 已归零）**：

- UI：账号设置里 QQ 专用的那一整块开关与说明文字；
- 事件分发：只保留 `C2C_MESSAGE_CREATE`（单聊）和 `GROUP_AT_MESSAGE_CREATE`（群内 @ 机器人），去掉 `GROUP_MESSAGE_CREATE` 分支与它依赖的 `groupAll` 判断；
- `statusSnapshot` 不再下发 `groupAll` 字段；
- `bridge_config` 不再接收/透传 `groupAll`，账号重启条件里也去掉它（只剩 `waifuSplit` 需要重启）。

**保留的东西**：`QQ_EVT <账号> t=<事件>` 这条诊断日志留着——它记录每一个 op=0 事件的类型，以后要判断「平台到底推没推」直接看日志即可。

**遗留数据**：`rt_config.json` 和 `accounts/qq-1/account.json` 里还留着 `"groupAll": true` 这个键。代码已经不再读它，属于无害残留，没有去动用户的配置文件。

**验证**：`node --check` 两个文件通过；`grep groupAll` 在两个源文件与运行缓存里均为 0；打包 70911 字节并安装；重载后 QQ 只有一条连接（`QQ_START` → `QQ_IDENTIFY intents=33554432` → `QQ_EVT t=READY` → `QQ_READY`），网关 1 个进程。
## 19. 全量代码审计：三处真 Bug（文件接口返回值误判、无效方法名、QQ 重连漏清理）

**做法**：先跑静态扫描（`node --check` 两个文件、检查重复函数定义、扫未定义调用），再人工复核最近改动过的关键路径。静态全过，人工复核查出三处。

### 19.1 `Tools.Files.delete()` 这个方法根本不存在

**现象**：多处「删不掉就换一种方式删」的兜底代码从来没起过作用，也不会报错。

**根因**：`files.d.ts` 里只有 `deleteFile(path, recursive?)`，没有 `delete`。main.js 里有 6 处 `Tools.Files.delete(...)` 当兜底调用，一执行就抛异常，抛出的异常被外层 `catch` 吞掉，所以表现为「静默无效」。

**修复**：6 处全部改为 `deleteFile`；回收站里删目录那一处补上 `recursive=true`（不补只会删空目录失败）。

**验证**：`grep -c 'Tools.Files.delete(' src/main.js` 与运行缓存均为 0。

### 19.2 文件操作「没抛异常」被当成了「成功」

**现象**：写配置偶尔会静默丢内容，账号可能变成空壳目录，回收站记录被抹掉但目录还在（或反过来）。

**根因**：平台这几个接口的返回值是对象，不是布尔也不是空：

- `write / move / copy / deleteFile` → `FileOperationData { operation, path, successful, details }`
- 失败时**可能既不抛异常也不 `successful`**。

而原来的代码有三处只凭「没抛异常」就下结论：

1. `writeFile` 直接 `return true` —— 写入失败照样当成功，`account.json` / 索引可能写空。
2. `softDelete` 只要没抛异常就认为目录已经移进回收站，接着就把索引记录 splice 掉 —— 目录其实没移走，记录却没了，等于数据永久丢失。
3. `trash_restore` 移目录失败也继续往下改 `account.json` 和索引 —— 恢复出来一个指向不存在目录的死记录。

**修复**：
- 新增 `__opOk(r)`，**同时兼容两种返回结构**：顶层有 `.successful` 就用它（`FileOperationData`），否则看 `.operation.successful`（`FileApplyResultData`）；拿不到明确 `false` 时按成功处理（避免平台版本差异误伤）。
- `writeFile` 两轮写入都判 `__opOk`，失败时把 `details` 记进 `state.ioErr` 便于排查。
- `softDelete` 改为 `moved = !(mv1 && mv1.successful === false)`，移动失败再走终端 `mv` 兜底，最后用 `fsExists` 做一次磁盘复核，只有目录真的不在了才摘掉索引记录。
- `trash_restore` 移动目录失败就 `rlog("TRASH_RESTORE_MOVE_FAIL ...")` 后 `continue`，不再往下改 `account.json` 和索引。

**踩到的坑（记下来免得再犯）**：第一版 `__opOk` 只写了 `r.operation.successful`，这个写法**对 `write` 有效、对其他调用全部失效** —— 因为两套返回结构里 `operation` 的含义相反：

| 方法 | 返回类型 | 成败字段 |
|---|---|---|
| `write` / `create` | `FileApplyResultData` | `.operation.successful`（嵌套） |
| `move` / `copy` / `deleteFile` / `mkdir` | `FileOperationData` | `.successful`（顶层），而 `.operation` 是**字符串** |

`FileOperationData.operation` 是字符串，`"move".successful` 得到的 `undefined` 不是 boolean，于是函数一路 fall through 到 `return true` —— **恒定判成功，等于没修**。发现方式是把 `results.d.ts` 里两个类型逐字读出来对照，不能靠 `grep -c '__opOk'` 那种计数（计数只证明「改过」，不证明「改对」）。

**验证**：`grep -c '__opOk'` 源码与运行缓存均为 3；逐条打印 `__opOk` 最终形态确认先判顶层、再判嵌套；md5 源码与运行缓存一致（`042b12ad...`）。

### 19.3 QQ 重连出来的连接不受 `stop()` 管理

**现象**：上一轮修好了「停用插件时 WebSocket 不关闭」，但重连路径漏了 —— 断线重连后旧连接仍然可能残留，表现为同账号出现两条连接、事件推到没人读的那条。

**根因**：重连时调用的是 `startQQ({cfg: a.cfg}, gen)`，传的是一个临时 acc 对象，新建的 runtime **没有进入 `state.accounts`**；而 `stop()` 是遍历 `state.accounts` 逐个 `qqStop` 的，扫不到这个临时对象，于是它永远不会被关。

**修复**：新增登记表 `var __qqLive = []`（上限 16 条，超出时只保留仍有 `ws` 的）；`startQQ` 里 `__qqLive.push(a)`，`qqStop` 里 `splice` 移除；`stop()` 在清空 `state.accounts` **之前**先按登记表把存活的连接全部 `qqStop` 一遍。

**验证**：`grep -c '__qqLive'` 源码与运行缓存均为 7；插件重载后日志为干净的四行 `QQ_START` → `QQ_IDENTIFY intents=33554432` → `QQ_EVT t=READY` → `QQ_READY`，没有重复 `QQ_START`。

### 本轮部署结果

打包 71875 字节，导入 → 停用 → 启用，重载后 `rt.log` 正常（72 行，无新增报错），网关 `/health` 返回 `{"ok":true,...,"expose":"local","auth":true}`，`gw.py` 1 个进程、`media_worker.py` 1 个进程。仍存在的 `SWEEP_ERR Chat does not exist: ...` 是已知无害告警（这两个账号绑定的对话已被删除）。

### 刻意没动的

- QQ 通道事件范围不变：仍只处理单聊 `C2C_MESSAGE_CREATE` 与群内 @ `GROUP_AT_MESSAGE_CREATE`。
- 用户配置文件里残留的 `"groupAll": true` 没改：代码已不读它，属无害残留，不擅自改用户配置。
- `QQ_EVT` 诊断日志保留，用于区分「平台没推」和「我们丢了」。

## 20. 点完开关再点「保存」提示「没有改动」；顺手修掉三个凭证编辑问题

**现象**：账号设置页里，开关（启用、Waifu 切条）、档位（监听范围）点一下就直接保存了；这时候再点「保存」按钮，界面提示「没有改动，无需保存」，看着像保存按钮坏了。

**根因**：页面上其实有两条独立的通道，但界面没说清分工。

| 操作 | 走哪条 | 是否进编辑缓冲 |
|---|---|---|
| 开关 / 分段档位 | 点一下立刻 `bridge_accounts` 或 `bridge_config` 写盘 | 否 |
| 输入框（AppID、Token、端口…） | 先攒在 `editState`，点「保存」才提交 | 是 |

`opSaveCred` 判断「有没有改动」的标准是 `editState[账号名]` 里有没有字段。开关点完不进 `editState`，所以编辑区必定是空的 → 必然落到「没有改动」这条分支。逻辑本身没错，但提示语只说了「没有改动」，没解释「开关那类早就存了」，用户自然会以为按钮失灵。

### 20.1 公开接口的「自定义访问令牌」根本没法手动填（真 bug）

**根因**：`lockField()` 只有在 `e["__ed_" + group]` 为真时才渲染成输入框，否则只显示一行文字。`qq` 组有「修改 QQ 凭证」按钮切换 `__ed_qq`，`wechat` 组有「修改微信凭证」切换 `__ed_wechat`，**`pub` 组从来没有切换 `__ed_pub` 的入口**（`grep -c __ed_pub` 为 0）。所以新建的公开接口账号，令牌那一栏永远是「自定义访问令牌：未设置」这行死文字，占位提示写着「手动输入或点随机生成」，但根本点不出输入框。

**修复**：补一个「手动填写令牌 / 收起」按钮切换 `__ed_pub`，位置在令牌那一行上方。

### 20.2 QQ 只改 AppID 会被拦下要求重填 AppSecret（真 bug）

**根因**：原判断是 `if (!cfg.appId || !cfg.appSecret)`。而 AppSecret 在界面上只显示「已保存（不可见）」，用户展开凭证区改 AppID 时，`e.appSecret` 是 `undefined`（没碰过输入框），`cfg.appSecret` 自然为空 —— 于是被要求「AppID 和 AppSecret 都要填」。可用户手里根本没有原密钥，等于改不了 AppID。

**修复**：改成已存过密钥就不再强制重填：

```js
if (!cfg.appId) { errState.set("AppID 不能为空"); return; }
if (!cfg.appSecret && !a.appSecretSet) { errState.set("首次配置要把 AppID 和 AppSecret 都填上"); return; }
if (cfg.appSecret === "") delete cfg.appSecret;
```

### 20.3 微信清空 BaseUrl / Bot ID / User ID 会静默跳过（真 bug）

**根因**：原写法 `if (e.baseUrl !== undefined && String(e.baseUrl).trim()) cfg.baseUrl = ...`，用户把字段清空时，`trim()` 为假，整条分支跳过，不报错也不提示。用户以为清掉了，实际磁盘上还是旧值。

**修复**：清空时记进 `emptyKeys`；如果别的字段有改动就照常保存并提示「×× 为空，这几项没有保存」；如果一个有效改动都没有就明确说「×× 不能为空，未保存」，不再假装什么都没有发生。

### 20.4 部署环节的坑：UI 文件放错位置，包里的界面还是旧的

**现象**：改完 UI 打包，字节数跟上一版一模一样，装上后界面毫无变化。

**根因**：`build_pkg.py` 第 19 行取的是 `/sdcard/bh_work/ui/bridge_settings/index.ui.js`，而本轮第一次复制成了 `/sdcard/bh_work/index.ui.js`（少了 `ui/bridge_settings/` 两级）。打包脚本没报错，安静地把 `bh_work` 里那份旧文件打进包了。

**怎么发现的**：解开成品 `unzip` 比对标记 —— 包里 `__ed_pub` 命中 0、旧提示命中 3，而源码是 1 和 0；再看两份文件，`/sdcard/bh_work/index.ui.js` 是 70194 字节（新），`/sdcard/bh_work/ui/bridge_settings/index.ui.js` 是 69234 字节（旧）。

**教训**：只看「打包成功 + 字节数」不够，必须解开包核对新代码标记；`main.js` 和 `index.ui.js` 是两条独立的部署路径，两边都要验。

**修复**：复制到正确路径，删掉错位置那份，重新打包 72249 字节，解包校验 `__ed_pub=1`、旧提示 `=0`、`purgeDialog=2`（第 16 条的功能没丢）。

**验证**：`node --check` 通过；包内与运行缓存 `index.ui.js` md5 一致（`c6b4b44f...`），70194 字节；`main.js` 184046 字节，`__opOk` / `__qqLive` 仍在；重载后 `QQ_IDENTIFY` → `QQ_EVT t=READY` → `QQ_READY` 正常，`gw.py` 1 个进程。

**另外观察到（未改动）**：`gw_ports.json` 里 key 为空、监听范围 `local`，所以 `/health` 报 `auth:false`。只在 127.0.0.1 监听时不设密钥是安全的，这是之前「清除令牌」留下的状态；`accounts/pub-1/account.json` 里 `expose` 还是 `public`，与 `gw_ports.json` 的 `local` 不一致，属配置漂移，没有擅自动它。

## 21. 微信通道彻底收不到消息：轮询被停了，但没人启动替代的 JS 轮询

**现象**：微信发消息过去，一点反应都没有。界面上「测试通道」能通（会生成一条自检消息进对话），但真实微信消息永远进不来。

**关键证据**：

- `rt.log` 里 `WX_START wx-1` 有记录，之后**没有任何一条 `WX_POLL`**（这是拉到消息才会打的日志）；
- 3 条 `WX_POLL_ERR` 全是 `pub-1` 的（网关没起来时连不上自己 8789），跟微信无关；
- `accounts/wx-1/sync_buf.txt` 的修改时间停在 **Nov 13 14:53**，整整 6 天没被写过 —— 说明 6 天来没有任何东西调用过 `getupdates`。

**根因**：某轮为了消掉「Python 轮询和 JS 轮询同时拉同一批消息、同一条被各送一次」，把 Python 的 `wxpoll.py` 停掉了，改成「只保留 JS 轮询」。但只写了**停的那一半**：

```js
await markRun(cfg.name, true);
void ensureWxPoll();      // 只负责杀掉 wxpoll.py 并打 WXPOLL_DISABLED
}                          // ← 到这里就结束了
```

而真正拉消息的 JS 循环 `__wxTick`，**只在公开接口的 `startHttp` 里被调用过**（`startHttp` 末尾那行 `void __wxTick(a, gen)`）。微信通道的 `startWechat` 从头到尾没调它。

结果就是「两头都断」：Python 轮询被杀掉了，JS 轮询没起来。微信通道变成只挂了一个 `WX_START` 的空壳。

顺带解释了一个容易误判的现象：`bridge_test`（测试通道）走的是主动往对话注入一条自检消息，**不经过轮询**，所以它一直是通的 —— 这也是为什么之前「测试能过」却「真消息不来」。

**修复**：`startWechat` 末尾补上启动 JS 轮询。

```js
void ensureWxPoll();
void __wxTick(a, gen);
```

**为什么安全**（先确认过再动手）：

- `__wxTick` 每轮开头检查 `state.running && a.running && gen === state.gen`，任一不满足就直接返回、不再自我调度；
- `stop()` 会 `state.running = false; state.gen++` 并逐个把 runtime 的 `running` 置 false；
- `stopOne()` 会把该 runtime 的 `running` 置 false 并移除账号；
- 所以停用账号 / 重载插件时旧循环会自己退出，不会留一个野生轮询在那儿空转；
- `wxHandle` 里有 `state.seen`（`账号|消息id`）去重，重放不会导致重复回复。

**验证（装完立刻发生，不是推理）**：

```
04:57:54 WX_POLL wx-1 ms=753 n=1
04:57:54 RECV [wechat] wx-1 o9cq808Tim...@im.wechat: 输出几句话，测试一下微信通道插件切条
04:58:01 ASK wx-1 msg=v1:... ms=6021 len=103
04:58:01 WX_SPLIT wx-1 parts=6 len=103
04:58:02~06 WX_REPLY wx-1 × 6（六条 message_id 均返回成功）
```

游标从 6 天前的旧位置开始拉，只返回了 1 条（用户最后发的那条），没有出现旧消息批量重放。`sync_buf.txt` 的修改时间已更新到 04:57。打包 72467 字节。

**遗留说明**：这 6 天里微信发来的更早消息拿不回来了 —— 服务端只返回了游标之后的一条，保留窗口有限。从这条之后开始一切正常。

**未改动**：Python 的 `wxpoll.py` 仍然保持停用状态（避免双通道重复）；`ensureWxPoll` 里那套清理逻辑没动，只是把它缺的另一半补上了。

## 22. 全量轮次审计（第 2 批）：11 处真 Bug，集中在「失败路径的顺序」和「静默失败」

**审计方法**：四轮循环 —— 静态扫描 → 人工逐域复核 → 修复 → 重扫，直到静态检查无新增、人工无新发现。

**静态四项（每轮全过）**

| 检查 | 结果 |
|---|---|
| `node --check` 两文件 | 通过 |
| 未定义调用扫描 | 只剩 `TextEncoder`、`URL`（JS 内置全局，且都在 try 内） |
| 平台接口方法名 vs `types/*.d.ts` 逐个比对 | 只有 `Tools.Files.append`（平台无此方法，但调用处有 `typeof === "function"` 守卫，不会报错） |
| 重复函数定义 | 无 |

### 22.1 补偿基线记晚了，重启前那条回复永远补不回来

**现象**：关机/重启时如果正好卡在「正文已生成、还没送出去」，这条回复永久丢失，补偿也救不回来。

**根因**：`restore()` 里是先 `for` 循环把微信 tick、QQ 长连接全部拉起来，**之后**才调 `__sweepCaptureBase()` 记录基线。启动的那几秒里进来的消息会被算进基线，于是「重启前那条 AI 回复」的索引小于基线，`__sweepOne` 里 `if (aiIdx < Number(_base)) return;` 直接跳过。

**修复**：基线改到 `for` **之前**记录；通道起来后再补记一次（`onlyMissing=true`，只补前面没拿到 `chatId` 的账号，那时 `runtime.chatId` 可能是 rebind 出来的新 ID，更准）。两阶段都不覆盖已记录的值。

### 22.2 回收站对账把「列不出目录」当成「目录是空的」，会把索引清空

**现象**：终端偶发不可用时打开回收站，记录会全部消失。

**根因**：`trashListDirs()` 里 `__termExec` 返回 null（终端没连上/命令失败）时，`String(null && ... || "")` 得到空串，函数返回 `[]`。`trashReconcile()` 第二步会拿 `fsExists` 逐个核对索引里的记录，而这一步在目录列表为空时仍然会跑 —— 只要 `fsExists` 也因同样原因返回假，所有记录都会被当成「目录已不存在」剔掉。

**修复**：`trashListDirs()` 拿不到终端结果时返回 `null`，与「目录确实为空」区分开；`trashReconcile()` 见到 `null` 就记 `TRASH_LS_FAIL keep=N` 并原样返回索引，什么都不删。

### 22.3 QQ 连续失败三次后永久不再重连

**现象**：网络抖动或凭证临时失效让 QQ 连接失败三次之后，通道彻底静默，日志里再也没有 `QQ_START`，只有重载插件才恢复。

**根因**：`state.qqRetry` 只在失败时 `+1`，**任何地方都没有归零**。`if (state.qqRetry <= 3)` 一旦被突破就永远进不去重试分支。

**修复**：收到 `READY`（真正连上）时把 `state.qqRetry = 0`。

### 22.4 删账号：先摘索引删配置，最后才移目录

**现象**：删除操作如果移目录失败（权限、目录被占用），账号从列表里消失，但目录还留在 `accounts/` 下，变成谁也管不到的孤儿；回收站记录里也丢了 `chatId` 和 `port`。

**根因**：原顺序是 `setIndex`（摘索引）→ `rmCfg`（删配置）→ `stopOne` → `softDelete`（移目录）。而且 `cfgOf(nm)` 是在 `rmCfg(nm)` **之后**调用的，读到的已经是空配置。

**修复**：改成先读 `account.json` 和 cfg → `softDelete` 移目录 → 成功才 `stopOne` + 摘索引 + 删配置；`softDelete` 失败直接返回错误，账号保持原样。

### 22.5 重命名：先改索引再 mv，mv 失败账号当场失联

**现象**：重命名遇到目标目录已存在等失败情形，账号从列表消失且无法恢复。

**根因**：代码先 `setIndex` 把索引里的旧名换成新名，然后才 `mv`，失败就 `return`。索引指向新名字、目录还在旧名字，两边对不上。

**修复**：改成先 `mv` → `fsExists` 核对 → 成功后才改索引和配置。

### 22.6 重连出来的 QQ runtime 没挂回 state.accounts

**现象**：断线重连后，`state.accounts[i].runtime` 仍指向那个已经 `qqStop` 掉的旧对象，外部读到的 `ws` 恒为 null，状态判断和补偿扫描会误判。

**根因**：`qqTick` 的 catch 里用 `startQQ({cfg: a.cfg}, gen)` 传的是临时对象，新 runtime 只挂在临时对象上。上一轮的 `__qqLive` 解决了「关不掉」，但没解决「外部拿不到新的」。

**修复**：`startQQ` 里新建 runtime 后，按名字回填 `state.accounts` 中对应项的 `runtime`。

### 22.7 令牌清空后 rt_config 还留着旧密钥

**现象**：通过配置接口把令牌清成空串，界面显示已清空，网关实际还在用旧密钥。

**根因**：`bridge_config` 里写的是 `if (cur.token) patch.token = cur.token;` —— 空串是假值，这条分支直接跳过，`patch` 里根本没有 `token` 字段，`rt_config.json` 保留旧值。

**修复**：改成 `if (cur.token !== undefined) patch.token = String(cur.token || "")`，字段存在就同步，空串也同步。

### 22.8 写盘失败被当成成功（4 处）

**根因**：`putCfg`/`rmCfg` 调 `writeJson` 忽略返回值；`bridge_config` 写 `account.json`、`bridge_token` 写新密钥同样忽略。磁盘满或路径不可写时，界面显示「已保存」，重启后配置回到旧值。

**修复**：全部检查返回值。`putCfg`/`rmCfg` 失败记 `CFG_WRITE_FAIL`；`bridge_config` 和 `bridge_token` 直接返回 `{success:false, error:"写入失败"}`，不假装成功。

### 22.9 未知通道会占住指纹却不发送

**根因**：`__deliverOnce` 里只处理 `qq` 和 `wechat` 两个分支，其他通道走完函数 `ok` 仍是 false，但指纹已经预占且不会撤销 —— 这条回复以后永远被判「发过了」。

**修复**：加 `else { throw new Error("unknown channel: " + channel); }`，让已有的 catch 把预占撤掉。

### 22.10 端口没做后端校验

**根因**：前端有 1024-65535 校验，但 `bridge_config` 直接 `Number(cur.port)`。传进来非法值会得到 `NaN`，序列化进 `gw_ports.json` 会把网关配置搞坏。

**修复**：后端再挡一次，非法时记 `PORT_INVALID` 并跳过该字段。

### 22.11 每次启动都报「Chat does not exist」

**现象**：日志里每次启动都有两条 `SWEEP_ERR Chat does not exist`，看着像故障。

**根因**：账号绑定的对话被删掉后，补偿扫描仍拿这个死 `chatId` 去读消息。真实消息到达时 `process()` 会自动重绑，所以这只是噪声。

**修复**：`__sweepOne`/`__sweepInbound` 的 catch 里识别这个错误，改记 `SWEEP_CHAT_GONE`（带解释），不再污染错误日志。

### 本轮部署与验证

打包 74589 字节，导入 → 停用 → 启用。重载后日志：

```
WX_START wx-1 chat=405abc9a... tokenLen=58
WXPOLL_DISABLED js_poller_only
QQ_START qq-1 → QQ_IDENTIFY intents=33554432 → QQ_EVT t=READY → QQ_READY
SWEEP_CHAT_GONE qq-1（绑定对话已删除，等新消息到达时自动重绑）
SWEEP_DONE
```

网关 `/health` 正常、`gw.py` 1 个进程。前面几轮的功能全部保留（`__opOk` 3 处、`__qqLive` 7 处、`__ed_pub` 1 处、`purgeDialog` 2 处）。

**没有改动的已知项（记录在案，非 Bug）**

- `wxInboxTick` 整体不可达（Python 轮询停用后函数开头就 `return`），每 800ms 空转一次，开销可忽略；保留是为了将来若要恢复收件箱通道直接用。
- `qqMessage` 里 `else if (_qskip.length)` 是死分支（`_qskip` 已并入 `_qnotes`），不影响行为。
- 公开接口密钥用 `Math.random()` 生成（48 位 hex）。平台没有暴露密码学随机源，V8 的 `Math.random` 对本地令牌强度足够，但若将来把 `expose` 长期开成 `public`，建议换成更可靠的随机源。
- `accounts/qq-1/account.json` 与 `rt_config.json` 里残留的 `"groupAll": true` 不读不删。