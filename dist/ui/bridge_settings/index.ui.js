"use strict";
exports.default = Screen;

var CHANNEL = "bridge_hub.service";
var __qrWatch = false;
var __qrLoading = false;

function useS(ctx, key, init) {
    const pair = ctx.useState(key, init);
    return { value: pair[0], set: pair[1] };
}

function Screen(ctx) {
    const chanState = useS(ctx, "chan", "wechat");
    const statusState = useS(ctx, "status", null);
    const busyState = useS(ctx, "busy", false);
    const msgState = useS(ctx, "msg", "");
    const errState = useS(ctx, "err", "");
    const editState = useS(ctx, "edit", {});
    const selState = useS(ctx, "sel", "");
    const pageState = useS(ctx, "page", "");
    const navState = useS(ctx, "nav", "home");
    const testState = useS(ctx, "test", {});
    const qrState = useS(ctx, "qr", null);
    const logState = useS(ctx, "logs", "");
    const delState = useS(ctx, "del", "");
    const renameState = useS(ctx, "rename", "");   // 专管重命名编辑，与展开状态分离
    const regState = useS(ctx, "reg", "");
    const chatsState = useS(ctx, "chats", null);
    const qrBusyState = useS(ctx, "qrBusy", false);   // 防扫码连点
    const qrWatchState = useS(ctx, "qrWatch", false);
    const revealState = useS(ctx, "reveal", null); // [FIX] 自动轮询开关（原来未声明，导致扫码后自动登录整段失效）
    // 监听范围切换的确认弹窗：{ name, mode, needKey } 或 { step:"key", name, token }
    const exposeAskState = useS(ctx, "exposeAsk", null);
    const gwBusyState = useS(ctx, "gwBusy", null);   // 正在重启网关时的弹窗文案

    function tryParse(t) {
        if (typeof t !== "string") return null;
        var c = t.replace(/^\s*[0-9]+\|\s?/gm, "").trim();
        if (!c) return null;
        try { return JSON.parse(c); } catch (e) { return null; }
    }

    function parse(r) {
        if (r == null) return null;
        if (typeof r === "object") {
            if (r.success !== undefined) return r;
            if (typeof r.content === "string") { var a = tryParse(r.content); if (a) return a; }
            if (typeof r.text === "string") { var b = tryParse(r.text); if (b) return b; }
            if (typeof r.output === "string") { var c = tryParse(r.output); if (c) return c; }
            return r;
        }
        if (typeof r === "string") return tryParse(r);
        return null;
    }

    async function call(name, params, okText) {
        busyState.set(true);
        errState.set("");
        msgState.set("");
        try {
            const r = await RPC(name, params || {});
            const p = parse(r);
            if (p && p.success === false) {
                errState.set(String(p.error || p.message || "失败"));
                return null;
            }
            if (p && Array.isArray(p.accounts)) { statusState.set(p); }
            if (okText) msgState.set(okText);
            return p;
        } catch (e) {
            errState.set(String(e && e.message ? e.message : e));
            return null;
        } finally {
            busyState.set(false);
        }
    }

    // [新增] 纯 JS 延时：优先 setTimeout，其次 ctx.sleep，最后立即返回
    function delay(ms) {
        return new Promise(function (res) {
            try {
                if (typeof setTimeout === "function") { setTimeout(res, ms); return; }
            } catch (e0) {}
            try {
                if (ctx && typeof ctx.sleep === "function") { SLEEP(ms); res(); return; }
            } catch (e1) {}
            res();
        });
    }

    function ed(n) { return (editState.value || {})[n] || {}; }
    function setEd(n, patch) {
        const m = Object.assign({}, editState.value || {});
        m[n] = Object.assign({}, m[n] || {}, patch);
        editState.set(m);
    }
    function tst(n) { return (testState.value || {})[n] || null; }
    function setTst(n, v) {
        const m = Object.assign({}, testState.value || {});
        m[n] = v;
        testState.set(m);
    }

    async function refresh() {
        const p = await call("bridge_core:bridge_status", {}, null);
        if (p) statusState.set(p);
        return p;
    }

    try {
        if (!globalThis.__bridgeUiReported) {
            globalThis.__bridgeUiReported = true;
            var __probe = []; var __names = ["Text","Button","Row","Column","Card","LazyColumn","TextField","Switch","Image","AsyncImage","WebView","Icon","IconButton","OutlinedButton","TextButton","Checkbox","CheckBox","RadioButton","AlertDialog","Dialog","Chip","ListItem","Box","Spacer","Divider","ProgressIndicator"];
            for (var __i = 0; __i < __names.length; __i++) { try { if (typeof ctx.UI[__names[__i]] === "function") __probe.push(__names[__i]); } catch (e) {} }
            var __cs = "";
            try {
                var __cso = (ctx && ctx.MaterialTheme && ctx.MaterialTheme.colorScheme) || null;
                if (__cso) { var __ks = []; for (var __k in __cso) __ks.push(__k); __cs = __ks.join(","); }
            } catch (eCS) { __cs = "ERR:" + String(eCS && eCS.message || eCS); }
            RPC("bridge_core:bridge_ui", { keys: __probe.join(",") + "|tm=" + (typeof setTimeout) + "|cp=" + (typeof (ctx && ctx.copyToClipboard)) + "|cs=" + __cs });
        }
    } catch (eRep) {}
    var __labels = [];
    var __RawText = ctx.UI.Text;
    var __RawButton = ctx.UI.Button;
    function TXT(p) { __labels.push((p && p.text) || ""); return __RawText(p); }
    function __pop(n) { var out = []; for (var i = 0; i < n; i++) out.unshift(__labels.pop() || ""); return out.join(" "); }
    function BTN(props, kids) {
        var t = (kids && kids.length) ? __pop(kids.length) : "";
        var o = {};
        if (props) { for (var k in props) o[k] = props[k]; }
        o.text = t || o.text || "确定";
        return __RawButton(o);
    }

    // ── 主题取色 ──
    // 每次都现读当前 Material3 调色板，不在模块加载时缓存：
    // 缓存的话用户切深色/换主题色时，这里拿到的还是旧色板，界面不会跟着变。
    function CS_OF() {
        try { return (ctx.MaterialTheme && ctx.MaterialTheme.colorScheme) || null; } catch (eCs0) { return null; }
    }
    function TOK(name) {
        try { var c = CS_OF(); if (c && c[name]) return c[name]; } catch (eCs1) { }
        return name;
    }
    // 主题色 + 透明度 = 主题色的浅色。
    // 注意 copy() 只接受 alpha，over 是 token 自己的属性，得单独赋值，
    // 让宿主按底色合成出稳定的浅色（否则只是半透明，压在不同底色上深浅不一）。
    function TOK_TINT(name, alpha) {
        try {
            var c = CS_OF(), t = c && c[name];
            if (t && typeof t.copy === "function") {
                var d = t.copy({ alpha: alpha });
                try { if (d) d.over = TOK("surface"); } catch (eOv) { }
                return d;
            }
        } catch (eCs2) { }
        return TOK(name);
    }

    // 分段按钮：未选中 = 主题色的浅色底 + 深字；选中 = 主题色深底 + 反白字。
    // 注意不要用 Button 的 containerColor/contentColor：实测那条路填不出底色，只剩描边。
    // 改成 Row 自带 background + backgroundShape + onClick，文字颜色显式给，不靠继承。
    function SEG(isOn, label, onTap, styleName) {
        var cs = CS_OF() || {};
        var bgOff = cs.primaryContainer || TOK_TINT("primary", 0.14);
        var fgOff = cs.onPrimaryContainer || TOK("primary");
        var txt = {
            text: label,
            style: styleName || "labelLarge",
            textAlign: "center",
            fillMaxWidth: true,
            maxLines: 1,
            color: isOn ? TOK("onPrimary") : fgOff
        };
        if (isOn) txt.fontWeight = "bold";
        try {
            if (typeof ctx.UI.Row === "function") {
                return ctx.UI.Row({
                    weight: 1,
                    background: isOn ? TOK("primary") : bgOff,
                    backgroundShape: { cornerRadius: 18 },
                    paddingVertical: 9,
                    paddingHorizontal: 4,
                    onClick: onTap,
                    content: [__RawText(txt)]
                });
            }
        } catch (eSeg1) { }
        // 兜底：Row 不支持点击时退回普通按钮，宁可没底色也不能没反应
        try { return __RawButton({ weight: 1, onClick: onTap, text: label }); } catch (eSeg2) { }
        return __RawText(txt);
    }
    var __ICON_LABEL = { check: "确认", edit: "编辑", delete: "删除", close: "移除", refresh: "刷新", add: "添加", qr: "二维码", save: "保存", stop: "停止", play: "启动" };
    function IBTN(props) {
        var k = (props && props.icon) ? String(props.icon) : "";
        if (typeof ctx.UI.IconButton === "function") {
            try {
                var ib = { icon: k, onClick: props && props.onClick };
                if (props && props.tint) ib.tint = props.tint;
                if (props && props.enabled === false) ib.enabled = false;
                return ctx.UI.IconButton(ib);
            } catch (eIB) { }
        }
        var lb = (props && props.label) ? String(props.label) : (__ICON_LABEL[k] || "操作");
        var o = { text: lb, enabled: !(props && props.enabled === false), onClick: props && props.onClick };
        if (props && props.tint) o.tint = props.tint;
        return __RawButton(o);
    }
    function ICON() { return __RawText({ text: "" }); }
    function WEBVIEW(p) {
        var u = String((p && (p.url || p.html || p.data)) || "");
        if (typeof ctx.UI.WebView === "function") {
            try { return ctx.UI.WebView({ url: u, height: (p && p.height) || 420, fillMaxWidth: true, javaScriptEnabled: true, domStorageEnabled: true }); } catch (e) {}
        }
        if (typeof ctx.UI.Image === "function" && u.indexOf("data:image") === 0) {
            try { return ctx.UI.Image({ src: u, contentDescription: "二维码", fillMaxWidth: true }); } catch (e) {}
        }
        return __RawText({ text: "链接：" + u });
    }
    function lockField(a, e, group, key, label, shown, placeholder) {
        if (e["__ed_" + group]) {
            return ctx.UI.TextField({ value: (e[key] !== undefined ? e[key] : (shown || "")), label: label, placeholder: placeholder || "", onValueChange: function (v) { var o = {}; o[key] = v; setEd(a.name, o); }, singleLine: true, fillMaxWidth: true });
        }
        return TXT({ text: label + "：" + (shown ? String(shown) : "未设置"), style: "labelSmall" });
    }


    function act_wrap(name) { return RPC("bridge_core:" + name, {}); }

    async function RPC(tool, params, tries) {
        try {
            return await ToolPkg.ipc.call(CHANNEL, { action: "tool", tool: tool, params: params || {} }, { targetRuntime: "main" });
        } catch (e) {
            const m = String((e && e.message) || e);
            const n = tries || 0;
            if (n < 3 && m.indexOf("not registered") >= 0) {
                await new Promise(function (r) { setTimeout(r, 1500); });
                return RPC(tool, params, n + 1);
            }
            throw e;
        }
    }
    function TOAST(t) {
        const s = String(t || "");
        // 宿主 toast 浮在最上层，滚动到页面中段也看得见；msgState 只作兜底
        try { if (ctx && typeof ctx.showToast === "function") { ctx.showToast(s); return; } } catch (eS) { }
        try { msgState.set(s); } catch (e) {}
    }
    function SLEEP(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    const accounts = (statusState.value && statusState.value.accounts) ? statusState.value.accounts : [];
    const cur = accounts.filter(function (a) { return a.type === chanState.value; });
    const pageAcc = (function () {
        const pg = String(pageState.value || "");
        if (!pg) return null;
        for (var pi = 0; pi < accounts.length; pi++) if (accounts[pi].name === pg) return accounts[pi];
        return null;
    })();

    function opToggle(a, v) {
        return call("bridge_core:bridge_accounts", { action: v ? "enable" : "disable", account: a.name }, "").then(refresh);
    }
    function opStart(a) {
        return call("bridge_core:bridge_process", { action: "start", account: a.name }, a.name + " 已启动").then(refresh);
    }
    function opStop(a) {
        return call("bridge_core:bridge_process", { action: "stop", account: a.name }, a.name + " 已停止").then(refresh);
    }
    async function opAdd() {
        const type = chanState.value;
        const prefix = type === "wechat" ? "wx" : (type === "qq" ? "qq" : "pub");
        const used = {};
        ((statusState.value && statusState.value.indexList) || []).forEach(function (n) { used[n] = 1; });
        let n = 1;
        while (used[prefix + "-" + n]) n++;
        const name = prefix + "-" + n;
        const p = await call("bridge_core:bridge_accounts", { action: "add", account: name, type: type }, "已新增 " + name);
        if (p) {
            testState.set({});
            qrState.set(null);
            delState.set("");
            regState.set("");
            chatsState.set(null);
            editState.set({});
            msgState.set("");
            errState.set("");
            selState.set(name);
            setEd(name, { newName: name });
            statusState.set(p);
            try { TOAST("已创建 " + name + "，可点击名称直接改"); } catch (_e) {}
        }
    }
    // 删除确认：点图标弹窗「确认删除 / 取消」，确定后才真正删。
    // 不用卡片内联确认条（之前那条只写了「取消」、没有确认按钮，等于删不掉）。
    // 也不用「同一按钮点两次」：上膛状态寄托在跨重渲染的 delState 上，切页面/刷新后
    // 快照与真实状态不同步，会出现「图标看着复位了、一点却直接删」。
    function opAskDelete(a) {
        delState.set(a.name);
    }
    function opCancelDelete() {
        delState.set("");
    }
    function opDoDelete(name) {
        var n = String(name || "");
        delState.set("");
        if (!n) return;
        // 正在看这个账号的详情页就退出去，否则删完还停在一个已经不存在的账号上
        if (pageState.value === n) pageState.set("");
        return call("bridge_core:bridge_accounts", { action: "remove", account: n }, n + " 已删除").then(function () {
            if (selState.value === n) selState.set("");
            return refresh();
        });
    }

    function opRegenConfirm(a) {
        if (regState.value !== a.name) {
            regState.set(a.name);
            try { TOAST("再点一次确认重新生成令牌"); } catch (_e) {}
            return;
        }
        regState.set("");
        return opRegenToken(a);
    }

    function opTokenClear(a) {
        const wasOpen = String(a.expose || "local") !== "local";
        // 先本地清掉，令牌区/按钮立刻给反馈；没密钥就不能对外，档位同步显示回本机
        try { setAccLocal(a.name, { tokenReady: false, hasToken: false, tokenFull: "", accessTokenPreview: "", tokenLen: 0, token: "", expose: "local", allowPublic: false }); } catch (eL) { }
        return call("bridge_core:bridge_token", { account: a.name, clear: true }, "令牌已清除，可自定义").then(function (p) {
            if (wasOpen) TOAST("密钥已清除，已自动切回仅本机");
            void watchGw("密钥已清除，网关正在重启…");
            return p;
        });
    }
    function opRename(a) {
        const nn = String(ed(a.name).newName || "").trim();
        if (!nn) { try { TOAST("请先输入新名称"); } catch (_e) {} errState.set("请填写新名称"); return; }
        if (nn === a.name) { renameState.set(""); return; }
        return call("bridge_core:bridge_accounts", { action: "rename", account: a.name, new_name: nn }, "已改名为 " + nn).then(function (p) {
            setEd(a.name, { newName: "" });
            if (p) { try { TOAST("已改名为 " + nn); } catch (_e) {} }
            selState.set("");
            return refresh();
        });
    }
    function opTest(a) {
        setTst(a.name, { busy: true, text: "测试中…" });
        msgState.set("正在测试 " + a.name + " …");
        return RPC("bridge_core:bridge_test", { account: a.name }).then(function (r) {
            const p = parse(r);
            if (p && p.success !== false) {
                setTst(a.name, { busy: false, ok: !!p.ok, text: String(p.detail || ""), steps: p.steps || [] });
                msgState.set(a.name + " → " + String(p.detail || "测试完成"));
            } else {
                setTst(a.name, { busy: false, ok: false, text: (p && (p.error || p.message)) || "测试失败" });
            }
            return refresh();
        }).catch(function (e) {
            setTst(a.name, { busy: false, ok: false, text: String(e && e.message ? e.message : e) });
            errState.set("测试异常：" + String(e && e.message ? e.message : e));
        });
    }
    // 切档位：本机/局域网一次点按直接生效（没密钥就顺手生成一个），公网风险最高仍弹确认。
    function setExposeLocal(name, mode) { setAccLocal(name, { expose: mode, allowPublic: (mode === "public") }); }
    function setAccLocal(name, patch) {
        const st = statusState.value;
        if (!st || !Array.isArray(st.accounts)) return;
        const nx = Object.assign({}, st);
        nx.accounts = st.accounts.map(function (x) {
            return (x.name === name) ? Object.assign({}, x, patch) : x;
        });
        statusState.set(nx);
    }
    function accByName(name) {
        const list = (statusState.value && statusState.value.accounts) || [];
        for (let i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
        return null;
    }
    function uilog(msg) { try { RPC("bridge_core:bridge_uilog", { msg: String(msg) }).catch(function () { }); } catch (e) { } }
    function opAskExpose(a, mode) {
        const m = String(mode || "local");
        uilog("tap expose " + a.name + " want=" + m + " cur=" + String(a.expose || "local"));
        if (m === String(a.expose || "local")) return Promise.resolve(null);
        // 公网：把「谁能连上来」说清楚再确认
        if (m === "public") { exposeAskState.set({ name: a.name, mode: m, needKey: !a.tokenReady }); return Promise.resolve(null); }
        return doExposeNow(a.name, m);
    }
    // 网关重启是后台做的：先看后端有没有排上任务（gwPending）或正在跑（gwApplying），
    // 有就等它跑完再收弹窗；都没有就直接返回，不多做轮询。
    async function watchGw(label, quiet) {
        let p0 = null;
        try { p0 = parse(await RPC("bridge_core:bridge_status", {})); } catch (e0) { p0 = null; }
        if (!p0 || (!p0.gwApplying && !p0.gwPending)) { if (p0 && p0.accounts) statusState.set(p0); return; }
        let started = !!p0.gwApplying;
        for (let i = 0; i < 10 && !started; i++) {
            await delay(200);
            let p = null;
            try { p = parse(await RPC("bridge_core:bridge_status", {})); } catch (e1) { p = null; }
            if (!p) continue;
            if (p.accounts) statusState.set(p);
            if (p.gwApplying) started = true;
            if (!p.gwApplying && !p.gwPending) break;   // 任务已经跑完了
        }
        if (!started) return;
        gwBusyState.set(String(label || "正在重启网关，稍等一下…"));
        let finished = false;
        for (let i = 0; i < 24; i++) {
            await delay(300);
            let p = null;
            try { p = parse(await RPC("bridge_core:bridge_status", {})); } catch (e1) { p = null; }
            if (!p) continue;
            if (p.accounts) statusState.set(p);
            if (!p.gwApplying) { finished = true; break; }
        }
        gwBusyState.set(null);
        if (!quiet) TOAST(finished ? "网关已重启" : "重启比平时慢，稍后到状态里确认一下");
    }
    // 真正下发配置。本机/局域网直接走这里，公网由弹窗确认后也走这里。
    async function doExposeNow(name, mode, tokenIn) {
        let token = String(tokenIn || "");
        if (!token) {
            const acc = accByName(name);
            if (acc && !acc.tokenReady) {
                const p = await call("bridge_core:bridge_token", { account: name }, null);
                token = String((p && p.token) || "");
                if (!token) { errState.set("生成访问令牌失败，请重试"); return; }
            }
        }
        setExposeLocal(name, mode);   // 先让界面立刻跟着动，不用等重启完
        const txt = mode === "lan" ? "已切到局域网" : (mode === "public" ? "已切到公网" : "已切到仅本机");
        const r = await call("bridge_core:bridge_config", { account: name, config: JSON.stringify({ expose: mode }) }, txt);
        uilog("expose applied " + name + " " + mode + " ok=" + !!r);
        if (!r) { await refresh(); return; }
        await refresh();
        if (token) {
            // 先等网关重启走完，再弹「已生成访问令牌」；两个弹窗同时出来会互相盖住
            await watchGw("正在切换监听范围，网关重启中…", true);
            exposeAskState.set({ step: "key", name: name, token: token, mode: mode });
        } else {
            void watchGw("正在切换监听范围，网关重启中…");
            TOAST(txt);
        }
    }
    async function doExpose() {
        const s = exposeAskState.value;
        if (!s) return;
        exposeAskState.set(null);
        await doExposeNow(s.name, s.mode, "");
    }
    function exposeDialog() {
        const s = exposeAskState.value;
        if (!s) return null;
        if (s.step === "key") {
            return ctx.UI.AlertDialog({
                title: "已生成访问令牌",
                text: "开放成功。调用方必须带上这个令牌：\n\n" + s.token + "\n\n离开弹窗后，可以在账号页的「令牌」区再次复制。",
                confirmText: "知道了",
                onConfirm: function () { exposeAskState.set(null); },
                onDismiss: function () { exposeAskState.set(null); },
                onDismissRequest: function () { exposeAskState.set(null); }
            });
        }
        const tail = s.needKey
            ? "当前还没有访问令牌，确认后会自动生成一个；没有令牌的请求一律拒绝。"
            : "调用方必须带上访问令牌；没有令牌的请求一律拒绝。";
        return ctx.UI.AlertDialog({
            title: "开放公网访问？",
            text: "网关会对任何能连上来的 IP 开放，通常还要配合路由器端口映射。\n\n" + tail,
            confirmText: s.needKey ? "生成令牌并开放" : "确认开放",
            dismissText: "取消",
            onConfirm: function () { return doExpose(); },
            onDismiss: function () { exposeAskState.set(null); },
            onDismissRequest: function () { exposeAskState.set(null); }
        });
    }
    function gwDialog() {
        const t = gwBusyState.value;
        if (!t) return null;
        return ctx.UI.AlertDialog({
            title: "正在应用设置",
            text: String(t),
            confirmText: "好",
            onConfirm: function () { gwBusyState.set(null); },
            onDismiss: function () { gwBusyState.set(null); },
            onDismissRequest: function () { gwBusyState.set(null); }
        });
    }
    async function doPurge(dirs) {
        purgeAskState.set(null);
        const list = (dirs || []).filter(Boolean);
        if (!list.length) return;
        try {
            const r = await RPC("bridge_core:trash_purge", { dirs: list.join(",") });
            const p = parse(r);
            if (p && p.success === false) { errState.set(String(p.error || "删除失败")); return; }
            tickState.set({});
            await loadTrash();
        } catch (eP) {
            errState.set("删除失败：" + String((eP && eP.message) || eP));
        }
    }
    function purgeDialog() {
        const dirs = purgeAskState.value;
        if (!dirs || !dirs.length) return null;
        return ctx.UI.AlertDialog({
            title: "永久删除",
            text: "确认把这 " + dirs.length + " 个账号从回收站彻底删除？\n\n删除后无法恢复。",
            confirmText: "永久删除",
            dismissText: "取消",
            onConfirm: function () { return doPurge(dirs); },
            onDismiss: function () { purgeAskState.set(null); },
            onDismissRequest: function () { purgeAskState.set(null); }
        });
    }
    function delDialog() {
        const nm = delState.value;
        if (!nm) return null;
        return ctx.UI.AlertDialog({
            title: "删除账号",
            text: "确认删除「" + nm + "」？\n\n删除后会进回收站，可以恢复。",
            confirmText: "确认删除",
            dismissText: "取消",
            onConfirm: function () { return opDoDelete(nm); },
            onDismiss: function () { opCancelDelete(); },
            onDismissRequest: function () { opCancelDelete(); }
        });
    }
    function opSetOption(a, patch) {
        return call("bridge_core:bridge_config", { account: a.name, config: JSON.stringify(patch) }, "已保存").then(refresh);
    }
    function opRegenToken(a) {
        return call("bridge_core:bridge_token", { account: a.name }, "已生成新令牌").then(function (p) {
            setEd(a.name, {});
            if (p && p.token) revealState.set({ name: a.name, token: String(p.token) });
            void watchGw("新密钥已生成，网关正在重启…");
            return refresh();
        });
    }
    async function opLoadChats() {
        const p = await call("bridge_core:bridge_list_chats", {}, null);
        if (p && p.chats) { chatsState.set(p.chats); msgState.set("已加载 " + p.chats.length + " 个对话"); }
        else { errState.set("加载对话列表失败"); }
    }

    function opPickChat(a, c) {
        setEd(a.name, { chatId: c.id });
        return call("bridge_core:bridge_bind", { account: a.name, chat_id: c.id, chat_title: c.title }, a.name + " 已绑定「" + c.title + "」").then(refresh);
    }

    function opBind(a) {
        const v = String(ed(a.name).chatId || "").trim();
        if (!v) { errState.set("请填对话 ID"); return; }
        return call("bridge_core:bridge_bind", { account: a.name, chat_id: v, chat_title: v.slice(0, 24) }, a.name + " 已绑定").then(refresh);
    }
    function opUnbind(a) {
        return call("bridge_core:bridge_unbind", { account: a.name }, "已解绑").then(refresh);
    }
    function opClearLog() {
        return call("bridge_core:bridge_log", { action: "clear" }, "日志已清理").then(refresh);
    }
    async function opLogs(a) {
        const p = await call("bridge_core:bridge_poll", { account: a.name }, null);
        if (p) {
            const acc = (p.accounts || [])[0];
            const lines = (acc && acc.messages) ? acc.messages.map(function (m) {
                return "[" + String(m.msg_id).slice(0, 8) + "] " + m.from + ": " + m.text;
            }) : [];
            logState.set(lines.length ? lines.join("\n") : "（队列为空）");
        }
    }

    // 扫码登录：防重入 + 明确的加载态（不清空提示）
    async function opGetQr(a) {
        qrBusyState.set(true);
        __qrWatch = false;
        errState.set("");
        // 立刻切到 loading 视图，并给出可见提示（不让 call() 清空）
        qrState.set({ account: a.name, url: "", id: "", step: "loading", img: "" });
        msgState.set("正在向微信申请二维码…");
        __qrLoading = true;
        (async function () {
            for (let s3 = 1; s3 <= 60; s3++) {
                await delay(1000);
                if (!__qrLoading) return;
                msgState.set("正在向微信申请二维码… 已等待 " + s3 + " 秒");
            }
        })();
        try {
            let p = null;
            try {
                p = await RPC("wechat_claude_bridge:setup_bridge", { show_qrcode: true, account: a.name });
                p = parse(p);
            } catch (e1) {
                p = null;
                errState.set("获取二维码失败：" + String(e1 && e1.message ? e1.message : e1));
            }
            if (p && p.success === false) {
                qrState.set(null);
                msgState.set("");
                errState.set(String(p.error || p.message || "获取二维码失败"));
                return;
            }
            if (!p || !p.qrcode_url) {
                qrState.set(null);
                msgState.set("");
                errState.set("获取二维码失败，请重试");
                return;
            }
            qrState.set({ account: a.name, url: p.qrcode_url, id: p.qrcode_id, step: "waiting", img: "" });
            msgState.set("请用微信扫码");
            // 二维码就绪：自动开始轮询，扫完自动登录
            opAutoWatch(a, p.qrcode_id);
        } finally {
            __qrLoading = false;
            qrBusyState.set(false);
        }
    }
    // 复制走三级：UI 上下文自带方法 → 平台开放的 System.setClipboardText → 主运行时 bridge_clip。
    // 之前只探测 ctx.copyToClipboard（平台没有这个方法），失败后静默落到终端方案，所以点了没反应。
    async function opCopy(t) {
        const x = String(t || "");
        if (!x) { TOAST("没有可复制的内容"); return; }
        try { if (ctx && typeof ctx.copyToClipboard === "function") { await ctx.copyToClipboard(x); TOAST("已复制到剪贴板"); return; } } catch (e0) { }
        try {
            if (typeof Tools !== "undefined" && Tools && Tools.System && typeof Tools.System.setClipboardText === "function") {
                await Tools.System.setClipboardText(x);
                TOAST("已复制到剪贴板");
                return;
            }
        } catch (e1) { }
        try {
            const p = parse(await RPC("bridge_core:bridge_clip", { text: x }));
            if (p && p.success) { TOAST("已复制到剪贴板"); return; }
            if (p && p.error) { TOAST("复制失败：" + p.error); return; }
        } catch (e2) { }
        TOAST("自动复制失败，请长按选中复制");
    }
    async function opAutoWatch(a, qid) {
        if (__qrWatch) return;
        __qrWatch = true;
        try {
            for (let round = 0; round < 60; round++) {
                await delay(2500);
                let p2 = null;
                try {
                    const r2 = await RPC("bridge_core:bridge_status", {});
                    p2 = parse(r2);
                } catch (e1) { p2 = null; }
                const accs2 = (p2 && p2.accounts) ? p2.accounts : [];
                let hit = null;
                for (let i2 = 0; i2 < accs2.length; i2++) if (accs2[i2].name === a.name) hit = accs2[i2];
                if (hit && hit.tokenReady) {
                    __qrWatch = false;
                    qrState.set(null);
                    await refresh();
                    clearEd(a.name);
                    msgState.set("微信登录成功，Token 已保存");
                    return;
                }
            }
        } finally {
            __qrWatch = false;
        }
    }

    async function opCheckQr(a, qq) {
        const q = qq || qrState.value;
        if (!q || !q.id) { msgState.set("二维码已关闭，正在刷新状态…"); await refresh(); return; }
        let p = null;
        try {
            const rr = await RPC("wechat_claude_bridge:setup_bridge", { qrcode_id: q.id, poll_once: true, wait_ms: 3000, account: q.account || "" });
            p = parse(rr);
        } catch (e1) { p = null; }
        const stp = (p && (p.step || (p.logged_in ? "confirmed" : ""))) || "无响应";
        if (stp === "confirmed" || stp === "logged_in") {
            msgState.set("微信登录成功，Token 已保存（" + stp + "）");
        } else if (stp === "expired") {
            errState.set("二维码已过期，请重新获取");
        } else {
            msgState.set("已查询（" + stp + "），Token 由后台保存");
        }
        await refresh();
        clearEd(a.name);
    }

    function clearEd(n) {
        const m = Object.assign({}, editState.value || {});
        m[n] = {};
        editState.set(m);
    }

    function typeLabel(a) {
        return a.type === "qq" ? "QQ" : (a.type === "wechat" ? "微信" : "公开接口");
    }

    function opSaveCred(a) {
        const e = ed(a.name);
        let cfg = {};
        const emptyKeys = [];
        if (a.type === "qq") {
            if (e.appId !== undefined) cfg.appId = String(e.appId).trim();
            if (e.appSecret !== undefined) cfg.appSecret = String(e.appSecret).trim();
            if (!Object.keys(cfg).length) { TOAST("输入框没有改动（开关和档位点一下就已保存）"); return; }
            if (!cfg.appId) { errState.set("AppID 不能为空"); return; }
            // AppSecret 在界面上只显示「已保存（不可见）」，用户改别的字段时拿不到原值，不能要求他重填
            if (!cfg.appSecret && !a.appSecretSet) { errState.set("首次配置要把 AppID 和 AppSecret 都填上"); return; }
            if (cfg.appSecret === "") delete cfg.appSecret;
        } else if (a.type === "wechat") {
            if (e.token !== undefined) {
                const tk = String(e.token).trim();
                if (tk && tk.length < 10) { errState.set("Token 太短（至少 10 字符），请重新扫码或粘贴完整 Token"); return; }
                if (tk) cfg.token = tk;
            }
            if (e.baseUrl !== undefined) { const v = String(e.baseUrl).trim(); if (v) cfg.baseUrl = v; else emptyKeys.push("BaseUrl"); }
            if (e.wechatAccountId !== undefined) { const v = String(e.wechatAccountId).trim(); if (v) cfg.wechatAccountId = v; else emptyKeys.push("Bot ID"); }
            if (e.wechatUserId !== undefined) { const v = String(e.wechatUserId).trim(); if (v) cfg.wechatUserId = v; else emptyKeys.push("User ID"); }
            if (!Object.keys(cfg).length) {
                if (emptyKeys.length) errState.set(emptyKeys.join("、") + " 不能为空，未保存");
                else TOAST("输入框没有改动（开关和档位点一下就已保存）");
                return;
            }
            if (emptyKeys.length) errState.set(emptyKeys.join("、") + " 为空，这几项没有保存");
        } else {
            if (e.port !== undefined && String(e.port).trim()) {
                const pn = Number(String(e.port).trim());
                if (!pn || pn < 1024 || pn > 65535) { errState.set("端口需在 1024-65535 之间"); return; }
                cfg.port = pn;
            }
            if (e.token !== undefined && String(e.token).trim()) {
                const tk = String(e.token).trim();
                if (!/^sk-/.test(tk) || tk.length < 20) { errState.set("令牌需以 sk- 开头且至少 20 字符"); return; }
                cfg.token = tk;
            }
            if (!Object.keys(cfg).length) { TOAST("输入框没有改动（开关和档位点一下就已保存）"); return; }
        }
        return call("bridge_core:bridge_config", { account: a.name, config: JSON.stringify(cfg) }, a.name + " 已保存").then(function (p) {
            clearEd(a.name);
            return refresh().then(function () { return p; });
        });
    }

    function accountCard(a, asPage) {
        const e = ed(a.name);
        const t = tst(a.name);
        const renaming = renameState.value === a.name;
        const rows = [];

        if (asPage) {
            rows.push(ctx.UI.Row({ verticalAlignment: "center", spacing: 8 }, [
                BTN({ onClick: function () { pageState.set(""); } }, [TXT({ text: "← 返回" })]),
                TXT({ text: a.name, style: "titleMedium", fontWeight: "bold", weight: 1 }),
                TXT({ text: typeLabel(a), style: "labelSmall", color: "onSurfaceVariant" })
            ]));
        } else {
            rows.push(ctx.UI.Row({ verticalAlignment: "center", spacing: 6 }, [
                renaming
                    ? ctx.UI.TextField({ value: e.newName || "", placeholder: a.name, onValueChange: function (v) { setEd(a.name, { newName: v }); }, singleLine: true, weight: 1 })
                    : TXT({ text: a.name, style: "bodyLarge", fontWeight: "bold", weight: 1 }),
                renaming
                    ? IBTN({ icon: "check", onClick: function () { return opRename(a); } })
                    : IBTN({ icon: "edit", onClick: function () { setEd(a.name, { newName: a.name }); renameState.set(a.name); delState.set(""); } }),
                IBTN({
                    icon: "delete",
                    tint: delState.value === a.name ? "error" : "onSurfaceVariant",
                    onClick: function () { return opAskDelete(a); }
                }),
                ctx.UI.Switch({ checked: a.enabled !== false, onCheckedChange: function (v) { return opToggle(a, v); } })
            ]));

            const left = [];
            const right = [];
            if (a.type === "qq") {
                left.push(TXT({ text: "AppID: " + (a.appId || "（未填）"), style: "labelSmall", color: "onSurfaceVariant" }));
                left.push(TXT({ text: "AppSecret: " + (a.appSecretSet ? "已配置" : "未配置"), style: "labelSmall", color: a.appSecretSet ? "primary" : "error" }));
            } else if (a.type === "wechat") {
                left.push(TXT({ text: "Token: " + (a.tokenReady ? ("已配置（" + (a.wechatTokenPreview || "") + "）") : "未配置"), style: "labelSmall", color: a.tokenReady ? "primary" : "error" }));
                left.push(TXT({ text: "Bot ID: " + (a.wechatAccountId || "（未获取）"), style: "labelSmall", color: "onSurfaceVariant" }));
                left.push(TXT({ text: "User ID: " + (a.wechatUserId || "（未获取）"), style: "labelSmall", color: "onSurfaceVariant" }));
                left.push(TXT({ text: "BaseUrl: " + (a.baseUrl || "（默认）"), style: "labelSmall", color: "onSurfaceVariant" }));
            } else {
                left.push(TXT({ text: "端口: " + (a.port || "8789"), style: "labelSmall", color: "onSurfaceVariant" }));
                left.push(TXT({ text: "密钥: " + (a.tokenReady ? "已配置" : "未配置"), style: "labelSmall", color: a.tokenReady ? "primary" : "error" }));
            }
            left.push(TXT({ text: a.chatId ? ("对话: " + (a.chatTitle || String(a.chatId).slice(0, 10))) : "对话: 未绑定", style: "labelSmall", color: a.chatId ? "onSurfaceVariant" : "error" }));
            left.push(TXT({ text: "状态: " + (a.running ? "运行中" : (a.enabled !== false ? "已启用未运行" : "已停用")), style: "labelSmall", color: a.running ? "primary" : "onSurfaceVariant" }));

            right.push(BTN({ fillMaxWidth: true, onClick: function () { pageState.set(a.name); } }, [TXT({ text: "账号设置" })]));
            right.push(BTN({ fillMaxWidth: true, enabled: !(t && t.busy), onClick: function () { return opTest(a); } }, [TXT({ text: (t && t.busy) ? "测试中…" : "链接测试" })]));
            if (t && t.steps && t.steps.length) {
                t.steps.forEach(function (st) {
                    right.push(TXT({ text: (st.ok ? "✓ " : "✗ ") + st.name + "：" + st.detail, style: "labelSmall", color: st.ok ? "primary" : "error" }));
                });
            } else if (t && t.text) {
                right.push(TXT({ text: t.text, style: "labelSmall", color: t.ok ? "primary" : "error" }));
            }

            rows.push(ctx.UI.Row({ spacing: 10, fillMaxWidth: true }, [
                ctx.UI.Column({ spacing: 3, weight: 16 }, left),
                ctx.UI.Column({ spacing: 6, weight: 11 }, right)
            ]));
        }

        if (asPage) {
            const d = [];
            if (a.type === "qq") {
                d.push(BTN({ onClick: function () { setEd(a.name, { __ed_qq: !e.__ed_qq }); } }, [TXT({ text: e.__ed_qq ? "收起" : "修改 QQ 凭证" })]));
                d.push(lockField(a, e, "qq", "appId", "AppID", a.appId, "1905874015"));
                d.push(lockField(a, e, "qq", "appSecret", "AppSecret", a.appSecretSet ? "已保存（不可见）" : "", "机器人密钥"));
                d.push(TXT({ text: "QQ 不支持扫码：先在 q.qq.com 创建机器人，再填 AppID / AppSecret", style: "labelSmall", color: "onSurfaceVariant" }));
            } else if (a.type === "wechat") {
                const q = qrState.value;
                if (q && q.account === a.name && q.step === "loading") {
                    d.push(ctx.UI.Card({ fillMaxWidth: true }, [
                        ctx.UI.Column({ padding: 20, spacing: 8, horizontalAlignment: "center" }, [
                            TXT({ text: "正在向微信申请二维码…", style: "bodyMedium", fontWeight: "bold" }),
                            TXT({ text: msgState.value || "通常 3-10 秒，请稍候", style: "labelSmall", color: "primary" }),
                            BTN({ fillMaxWidth: true, onClick: function () { qrBusyState.set(false); qrState.set(null); msgState.set(""); } }, [TXT({ text: "取消" })])
                        ])
                    ]));
                } else if (q && q.account === a.name) {
                    d.push(ctx.UI.Card({ fillMaxWidth: true }, [
                        ctx.UI.Column({ padding: 10, spacing: 8, horizontalAlignment: "center" }, [
                            TXT({ text: "请用微信扫码登录", style: "bodySmall", fontWeight: "bold" }),
                            TXT({ text: "扫完自动保存，本页没变化就返回列表再看", style: "labelSmall", color: "onSurfaceVariant" }),
                            q.url
                                ? WEBVIEW({
                                    url: q.url,
                                    height: 420,
                                    fillMaxWidth: true,
                                    javaScriptEnabled: true,
                                    domStorageEnabled: true,
                                    supportZoom: true
                                })
                                : ctx.UI.Column({ height: 240, fillMaxWidth: true, contentAlignment: "center" }, [TXT({ text: "二维码生成中…", style: "labelSmall" }) ]),
                            ctx.UI.TextField({ value: q.url, label: "扫码链接（只读，可长按选中复制）", onValueChange: function () {}, readOnly: true, singleLine: false, maxLines: 3, fillMaxWidth: true }),
                            ctx.UI.Row({ spacing: 8 }, [
                                BTN({ weight: 1, onClick: function () { return opCopy(q.url); } }, [TXT({ text: "复制链接" })]),
                            ]),
                            BTN({ fillMaxWidth: true, onClick: function () { qrState.set(null); } }, [TXT({ text: "取消" })])
                        ])
                    ]));
                } else {
                    const qbusy = qrBusyState.value;
                    d.push(BTN({ fillMaxWidth: true, enabled: !qbusy, onClick: function () { return opGetQr(a); } }, [TXT({ text: qbusy ? "正在获取二维码，请稍候…" : "扫码登录微信" })]));
                    if (qbusy) {
                        d.push(TXT({ text: "正在向微信申请二维码，通常需 3-10 秒，请勿重复点击。", style: "labelSmall", color: "onSurfaceVariant" }));
                    }
                }
                d.push(BTN({ onClick: function () { setEd(a.name, { __ed_wechat: !e.__ed_wechat }); } }, [TXT({ text: e.__ed_wechat ? "收起" : "修改微信凭证" })]));
                d.push(lockField(a, e, "wechat", "token", "Token", a.tokenReady ? (a.token || "已配置") : "", "扫码后自动填入，或手动粘贴"));
                d.push(lockField(a, e, "wechat", "wechatAccountId", "Bot ID", a.wechatAccountId, "如 abc123@im.bot"));
                d.push(lockField(a, e, "wechat", "wechatUserId", "User ID", a.wechatUserId, "如 o9cq80xxx@im.wechat"));
                d.push(lockField(a, e, "wechat", "baseUrl", "BaseUrl", a.baseUrl || "https://ilinkai.weixin.qq.com", "https://ilinkai.weixin.qq.com"));
            } else {
                d.push(ctx.UI.TextField({
                    value: e.port || String(a.port || ""),
                    label: "监听端口（仅数字）",
                    placeholder: "8789",
                    onValueChange: function (v) { setEd(a.name, { port: String(v).replace(/[^0-9]/g, "") }); },
                    singleLine: true,
                    keyboardType: "number"
                }));
                d.push(TXT({ text: "监听范围", style: "bodyMedium", fontWeight: "bold" }));
                const _exp = a.expose || "local";
                // 用底色区分当前档位，文字保持 2~3 字，窄屏不会挤成两行
                const _expBtn = function (key, label) {
                    return SEG(_exp === key, label, function () { return opAskExpose(a, key); }, "labelLarge");
                };
                d.push(ctx.UI.Row({ spacing: 6, fillMaxWidth: true }, [
                    _expBtn("local", "本机"),
                    _expBtn("lan", "局域网"),
                    _expBtn("public", "公网")
                ]));
                d.push(TXT({
                    text: _exp === "local"
                        ? "只监听 127.0.0.1，手机以外的设备连不进来（推荐）"
                        : (_exp === "lan" ? "监听 0.0.0.0，同一局域网内可访问，必须带密钥" : "监听 0.0.0.0，任何能连上来的 IP 都可访问，必须带密钥"),
                    style: "labelSmall", color: _exp === "public" ? "error" : "onSurfaceVariant"
                }));
                if (_exp !== "local" && !a.tokenReady) {
                    d.push(TXT({ text: "⚠ 还没配密钥：这种状态下网关会退回只监听本机，先生成访问令牌再开放", style: "labelSmall", color: "error" }));
                }
                var _apiUrl = "http://127.0.0.1:" + (e.port || a.port || 8789) + "/v1";
                d.push(TXT({ text: "接口地址：" + _apiUrl + (_exp === "local" ? "（仅本机可调用）" : "（把 127.0.0.1 换成手机局域网 IP）"), style: "labelSmall", color: "onSurfaceVariant" }));
                d.push(BTN({ onClick: function () { return opCopy(_apiUrl); } }, [TXT({ text: "复制接口地址" })]));
                if (a.tokenReady) {
                    var _rv = revealState.value;
                    if (_rv && _rv.name === a.name && _rv.token) {
                        d.push(ctx.UI.TextField({ value: _rv.token, label: "完整令牌（只读，可长按选中复制）", onValueChange: function () {}, readOnly: true, singleLine: false, maxLines: 2, fillMaxWidth: true }));
                        d.push(ctx.UI.Row({ spacing: 8 }, [
                            BTN({ weight: 1, onClick: function () { return opCopy(_rv.token); } }, [TXT({ text: "复制令牌" })]),
                            BTN({ weight: 1, onClick: function () { revealState.set(null); } }, [TXT({ text: "收起" })]),
                        ]));
                    } else {
                        d.push(ctx.UI.TextField({ value: a.tokenFull || a.accessTokenPreview || "", label: "访问令牌（只读，可长按选中复制）", onValueChange: function () {}, readOnly: true, singleLine: false, maxLines: 2, fillMaxWidth: true }));
                        if (a.tokenFull) { d.push(BTN({ onClick: function () { return opCopy(a.tokenFull); } }, [TXT({ text: "复制接口密钥" })])); }
                    }
                    d.push(ctx.UI.Row({ spacing: 8 }, [
                        BTN({ weight: 1, onClick: function () { return opRegenConfirm(a); } }, [TXT({ text: regState.value === a.name ? "确认刷新？" : "令牌刷新" })]),
                        BTN({ weight: 1, onClick: function () { return opTokenClear(a); } }, [TXT({ text: "清除令牌" })])
                    ]));
                    d.push(TXT({ text: "清除后可手动自定义令牌", style: "labelSmall", color: "onSurfaceVariant" }));
                } else {
                    d.push(BTN({ onClick: function () { setEd(a.name, { __ed_pub: !e.__ed_pub }); } }, [TXT({ text: e.__ed_pub ? "收起" : "手动填写令牌" })]));
                                        d.push(lockField(a, e, "pub", "token", "自定义访问令牌", a.token || "", "手动输入或点随机生成"));
                    d.push(ctx.UI.Row({ spacing: 8 }, [
                        BTN({ weight: 1, onClick: function () { return opRegenConfirm(a); } }, [TXT({ text: regState.value === a.name ? "确认生成？" : "随机生成" })]),
                        BTN({ weight: 1, onClick: function () { setEd(a.name, { token: "" }); } }, [TXT({ text: "清除" })])
                    ]));
                }
            }

            d.push(TXT({ text: "── 回复与接收 ──", style: "labelMedium", color: "primary" }));
            d.push(ctx.UI.Row({ verticalAlignment: "center", spacing: 8 }, [
                TXT({ text: "Waifu 切条（按插件分句发送）", style: "bodyMedium", weight: 1 }),
                ctx.UI.Switch({ checked: a.waifuSplit === true, onCheckedChange: function (v) { return opSetOption(a, { waifuSplit: !!v }); } })
            ]));
            d.push(TXT({
                text: a.waifuSplit ? "已开启：回复交给 Waifu 模式插件切句，逐条气泡发送；没装或调用失败时自动回退" : "已关闭：只有超过 1500 字时才按标点机械切分",
                style: "labelSmall", color: "onSurfaceVariant"
            }));

            d.push(TXT({ text: "── 对话绑定 ──", style: "labelMedium", color: "primary" }));
            if (a.chatId) {
                d.push(ctx.UI.Column({ spacing: 2 }, [
                    TXT({ text: a.chatTitle || "（无标题）", style: "bodySmall", fontWeight: "bold" }),
                    TXT({ text: "ID: " + a.chatId, style: "labelSmall", color: "onSurfaceVariant" }),
                    BTN({ onClick: function () { return opUnbind(a); } }, [TXT({ text: "解除绑定" })])
                ]));
            }
            d.push(ctx.UI.Row({ spacing: 8, verticalAlignment: "center" }, [
                ctx.UI.TextField({ value: e.chatId || "", label: "对话 ID（手工输入）", placeholder: "粘贴 chatId", onValueChange: function (v) { setEd(a.name, { chatId: v }); }, singleLine: true, weight: 1 }),
                BTN({ onClick: function () { return opBind(a); } }, [TXT({ text: "绑定" })])
            ]));
            d.push(BTN({ fillMaxWidth: true, onClick: function () { return opLoadChats(); } }, [TXT({ text: "选择已有对话" })]));
            if (chatsState.value && chatsState.value.length) {
                chatsState.value.forEach(function (c) {
                    d.push(ctx.UI.Row({ verticalAlignment: "center", spacing: 6, padding: 4, background: "surfaceVariant" }, [
                        TXT({ text: (c.title || "(no title)") + "  |  " + c.id, style: "labelSmall", weight: 1 }),
                        BTN({ onClick: function () { return opPickChat(a, c); } }, [TXT({ text: "绑定" })])
                    ]));
                });
            } else {
                d.push(TXT({ text: "（点上方按钮加载对话列表）", style: "labelSmall", color: "onSurfaceVariant" }));
            }
            d.push(BTN({ fillMaxWidth: true, onClick: function () { return opSaveCred(a); } }, [TXT({ text: "保存" })]));
            rows.push(ctx.UI.Column({ spacing: 8 }, d));
        }

        return ctx.UI.Card({ fillMaxWidth: true }, [ctx.UI.Column({ padding: 14, spacing: 8 }, rows)]);
    }

    function chanHeader() {
        const map = {
            wechat: { nm: "微信", ic: "chat" },
            qq: { nm: "QQ", ic: "forum" },
            public: { nm: "公开接口", ic: "cloud" }
        };
        const info = map[chanState.value] || map.wechat;
        const on = cur.filter(function (a) { return a.enabled !== false; }).length;
        const run = cur.filter(function (a) { return !!a.running; }).length;
        const bound = cur.filter(function (a) { return !!a.chatId; }).length;
        const ready = cur.filter(function (a) { return a.tokenReady; }).length;
        return ctx.UI.Card({ fillMaxWidth: true }, [
            ctx.UI.Column({ padding: 14, spacing: 6 }, [
                ctx.UI.Row({ verticalAlignment: "center", spacing: 8 }, [
                    ICON({ name: info.ic, tint: "primary", size: 22 }),
                    TXT({ text: info.nm, style: "titleMedium", fontWeight: "bold" })
                ]),
                TXT({ text: "共 " + cur.length + " 个账号", style: "bodyLarge", fontWeight: "bold", color: "primary" }),
                TXT({ text: "启用 " + on + " · 运行 " + run + " · 已绑定 " + bound + " · 凭证就绪 " + ready, style: "labelSmall", color: "onSurfaceVariant" })
            ])
        ]);
    }

    function tabOverview() {
        return ctx.UI.Column({ spacing: 12 }, [
            chanHeader(),
            ctx.UI.Row({ spacing: 8 }, [
                BTN({ weight: 1, enabled: !busyState.value, onClick: function () { return opAdd(); } }, [TXT({ text: "＋ 新增账号" })]),
                BTN({ weight: 1, onClick: function () { return refresh(); } }, [TXT({ text: "刷新" })])
            ]),
            cur.length
                ? ctx.UI.Column({ spacing: 10 }, cur.map(function (a) { return accountCard(a, false); }))
                : ctx.UI.Card({ fillMaxWidth: true }, [
                    ctx.UI.Column({ padding: 16, spacing: 4 }, [
                        TXT({ text: "还没有账号", style: "bodyMedium", color: "onSurfaceVariant" }),
                        TXT({ text: "点上方「新增账号」创建，可创建多个", style: "labelSmall", color: "onSurfaceVariant" })
                    ])
                ])
        ]);
    }

    function tabMsgs() {
        if (!cur.length) return TXT({ text: "暂无账号", style: "labelSmall", color: "onSurfaceVariant" });
        const list = cur.map(function (a) {
            return ctx.UI.Row({ verticalAlignment: "center", spacing: 8 }, [
                TXT({ text: a.name, style: "bodySmall", weight: 1 }),
                BTN({ onClick: function () { return opLogs(a); } }, [TXT({ text: "最近消息" })])
            ]);
        });
        list.push(TXT({ text: "── 最近收到 ──", style: "labelMedium", color: "primary" }));
        list.push(TXT({ text: logState.value || "（点上方按钮加载）", style: "labelSmall", color: "onSurfaceVariant" }));
        return ctx.UI.Card({ fillMaxWidth: true }, [ctx.UI.Column({ padding: 14, spacing: 8 }, list)]);
    }

    function tabMaintain() {
        return ctx.UI.Column({ spacing: 12 }, [
            // ══ 自动转发（事件驱动）══
            ctx.UI.Card({ fillMaxWidth: true }, [
                ctx.UI.Column({ padding: 14, spacing: 8 }, [
                    ctx.UI.Row({ verticalAlignment: "center", spacing: 8 }, [
                        TXT({ text: "自动转发", style: "titleSmall", fontWeight: "bold", weight: 1 }),
                        TXT({ text: "事件驱动", style: "labelSmall", color: "primary" })
                    ]),
                    TXT({ text: "不使用定时器。每当对话进入空闲状态时，自动检查各账号队列并送入对话。", style: "labelSmall", color: "onSurfaceVariant" }),
                    TXT({ text: "· 对话空闲 → 检查队列 → 有新消息才注入", style: "labelSmall", color: "onSurfaceVariant" }),
                    TXT({ text: "· 微信/QQ 接收器与公开接口在需要时自动拉起", style: "labelSmall", color: "onSurfaceVariant" }),
                    TXT({ text: "· 回复越快，检查越频繁；不占用后台资源", style: "labelSmall", color: "onSurfaceVariant" })
                ])
            ]),
            ctx.UI.Card({ fillMaxWidth: true }, [
                ctx.UI.Column({ padding: 14, spacing: 8 }, [
                    TXT({ text: "全局操作", style: "titleSmall", fontWeight: "bold" }),
                    BTN({ fillMaxWidth: true, onClick: function () { return refresh(); } }, [TXT({ text: "刷新全部状态" })]),
                    BTN({ fillMaxWidth: true, onClick: function () { return opClearLog(); } }, [TXT({ text: "清理日志" })])
                ])
            ]),
            ctx.UI.Card({ fillMaxWidth: true }, [
                ctx.UI.Column({ padding: 14, spacing: 8 }, [
                    TXT({ text: "批量测试", style: "titleSmall", fontWeight: "bold" }),
                    cur.length
                        ? BTN({ fillMaxWidth: true, onClick: async function () { const list = cur.slice(); for (let i = 0; i < list.length; i++) { await opTest(list[i]); } } }, [TXT({ text: "测试本渠道全部账号" })])
                        : TXT({ text: "本渠道暂无账号", style: "labelSmall", color: "onSurfaceVariant" })
                ])
            ]),
            ctx.UI.Card({ fillMaxWidth: true }, [
                ctx.UI.Column({ padding: 14, spacing: 4 }, [
                    TXT({ text: "运行环境", style: "titleSmall", fontWeight: "bold" }),
                    TXT({ text: "数据目录：" + ((statusState.value && statusState.value.hubDir) || "-"), style: "labelSmall", color: "onSurfaceVariant" }),
                    TXT({ text: "账号索引：" + (((statusState.value && statusState.value.indexList) || []).join(", ") || "-"), style: "labelSmall", color: "onSurfaceVariant" }),
                    TXT({ text: "路由条目：" + ((statusState.value && statusState.value.routeCount) || 0), style: "labelSmall", color: "onSurfaceVariant" }),
                    TXT({ text: "核心版本：" + ((statusState.value && statusState.value.ver) || "-"), style: "labelSmall", color: "onSurfaceVariant" })
                ])
            ])
        ]);
    }

    function tabPaths() {
        const pub = (statusState.value && statusState.value.publicCfg) || {};
        return ctx.UI.Column({ spacing: 12 }, [
            ctx.UI.Card({ fillMaxWidth: true }, [
                ctx.UI.Column({ padding: 14, spacing: 4 }, [
                    TXT({ text: "全局设置", style: "titleSmall", fontWeight: "bold" }),
                    TXT({ text: "以下配置对所有渠道统一生效", style: "labelSmall", color: "onSurfaceVariant" })
                ])
            ]),
            ctx.UI.Card({ fillMaxWidth: true }, [
                ctx.UI.Column({ padding: 14, spacing: 4 }, [
                    TXT({ text: "说明", style: "bodyMedium", fontWeight: "bold" }),
                    TXT({ text: "· 账号凭证 / 端口 / 对话绑定在「概览」点账号的「账号设置」配", style: "labelSmall", color: "onSurfaceVariant" }),
                    TXT({ text: "· 微信扫码登录；QQ 填 AppID+AppSecret；公开接口用随机令牌", style: "labelSmall", color: "onSurfaceVariant" }),
                    TXT({ text: "· 这里只放跨账号通用配置", style: "labelSmall", color: "onSurfaceVariant" })
                ])
            ])
        ]);
    }

    // [重构] 旧的四标签已取消：通用设置置顶，渠道各自独立

    const trashState = useS(ctx, "trashItems", null);
    const tickState = useS(ctx, "ticks", {});
    const purgeAskState = useS(ctx, "purgeAsk", null);
    const trashLoaded = useS(ctx, "trashLoaded", false);

    async function loadTrash() {
        try {
            const r = await RPC("bridge_core:trash_list", {});
            const p = parse(r);
            if (p && Array.isArray(p.items)) trashState.set(p.items);
            else if (p && p.success === false) errState.set(String(p.error || "回收站读取失败"));
        } catch (e) { errState.set("读取回收站失败：" + String(e && e.message ? e.message : e)); }
    }

    function CHK(on, onTap) {
        if (typeof ctx.UI.Checkbox === "function") {
            try { return ctx.UI.Checkbox({ checked: !!on, onCheckedChange: function () { return onTap(); } }); } catch (eC) { }
        }
        return IBTN({ icon: on ? "check_box" : "check_box_outline_blank", tint: on ? "primary" : "onSurfaceVariant", onClick: onTap });
    }

    function chanTab(key, label) {
        return SEG(chanState.value === key, label, function () {
            chanState.set(key); selState.set(""); qrState.set(null); delState.set("");
            if (key === "trash") void loadTrash();
        }, "labelSmall");
    }

    function aboutLink(label, url) {
        const copyIt = function () { return opCopy(url); };
        return ctx.UI.Row({ verticalAlignment: "center", spacing: 8, fillMaxWidth: true }, [
            TXT({ text: label, style: "bodyMedium", color: "onSurfaceVariant" }),
            TXT({ text: url, style: "labelSmall", color: "onSurfaceVariant", weight: 1 }),
            BTN({ onClick: copyIt }, [TXT({ text: "复制" })])
        ]);
    }

    function tabHome() {
        const all = accounts;
        const cnt = function (t) { return all.filter(function (x) { return x.type === t; }).length; };
        const run = function (t) { return all.filter(function (x) { return x.type === t && x.running; }).length; };
        const st = statusState.value || {};
        const lines = (st.logs || []).slice(-3);
        const stat = function (label, n, r) {
            return ctx.UI.Row({ verticalAlignment: "center", spacing: 8, fillMaxWidth: true }, [
                TXT({ text: label, style: "bodyMedium", weight: 1 }),
                TXT({ text: n + " 个号", style: "bodyMedium", color: "primary", fontWeight: "bold" }),
                TXT({ text: "运行 " + r, style: "labelSmall", color: r > 0 ? "primary" : "onSurfaceVariant" })
            ]);
        };
        return ctx.UI.Column({ spacing: 12 }, [
            ctx.UI.Card({ fillMaxWidth: true }, [
                ctx.UI.Column({ padding: 16, spacing: 10 }, [
                    ctx.UI.Row({ verticalAlignment: "center", spacing: 8 }, [
                        TXT({ text: st.running ? "●" : "○", style: "bodyLarge", color: st.running ? "primary" : "onSurfaceVariant" }),
                        TXT({ text: st.running ? "引擎运行中" : "引擎已停止", style: "titleMedium", fontWeight: "bold", weight: 1 })
                    ]),
                    ctx.UI.Row({ spacing: 16 }, [
                        TXT({ text: "收到 " + (st.received || 0), style: "bodyMedium", color: "onSurfaceVariant" }),
                        TXT({ text: "回复 " + (st.replied || 0), style: "bodyMedium", color: "onSurfaceVariant" })
                    ])
                ])
            ]),
            ctx.UI.Card({ fillMaxWidth: true }, [
                ctx.UI.Column({ padding: 16, spacing: 12 }, [
                    TXT({ text: "通道", style: "titleSmall", fontWeight: "bold" }),
                    stat("微信", cnt("wechat"), run("wechat")),
                    stat("QQ", cnt("qq"), run("qq")),
                    stat("公开接口", cnt("public"), run("public"))
                ])
            ]),
            ctx.UI.Card({ fillMaxWidth: true }, [
                ctx.UI.Column({ padding: 16, spacing: 8 }, [
                    TXT({ text: "最近日志", style: "titleSmall", fontWeight: "bold" }),
                    TXT({ text: lines.length ? lines.join(String.fromCharCode(10)) : "（暂无）", style: "labelSmall", color: "onSurfaceVariant" })
                ])
            ]),
            ctx.UI.Card({ fillMaxWidth: true }, [
                ctx.UI.Column({ padding: 16, spacing: 10 }, [
                    TXT({ text: "关于", style: "titleSmall", fontWeight: "bold" }),
                    TXT({ text: "桥 · 多通道聚合", style: "bodyMedium", fontWeight: "bold" }),
                    TXT({ text: "作者 lihe233", style: "labelSmall", color: "onSurfaceVariant" }),
                    TXT({ text: "版 本 " + ((st && st.ver) || "-"), style: "labelSmall", color: "onSurfaceVariant" }),
                    TXT({ text: "把微信 / QQ / 本机 API 三类通道接入 Operit 对话，统一收发与回复回传，并对外提供 OpenAI 兼容网关。", style: "labelSmall", color: "onSurfaceVariant" }),
                    aboutLink("项目", "https://github.com/lihe233/bridge-hub"),
                    aboutLink("主页", "https://github.com/lihe233"),
                    aboutLink("B 站", "https://b23.tv/vqqqZLO")
                ])
            ])
        ]);
    }

    function tabTrash() {
        // 首次进回收站就自动取数，不用先点一次「刷新」
        if (!trashLoaded.value) { trashLoaded.set(true); void loadTrash(); }
        const items = trashState.value || [];
        const ticks = tickState.value || {};
        const chosen = items.filter(function (x) { return ticks[x.dir]; }).map(function (x) { return x.dir; });
        const typeLabel = function (t) { return t === "wechat" ? "微信" : (t === "qq" ? "QQ" : "公开接口"); };
        const rows = [];
        rows.push(ctx.UI.Row({ verticalAlignment: "center", spacing: 8 }, [
            TXT({ text: "回收站（" + items.length + "）", style: "titleSmall", weight: 1 }),
            BTN({ onClick: function () { return loadTrash(); } }, [TXT({ text: "刷新" })])
        ]));
        if (!items.length) {
            rows.push(TXT({ text: trashState.value === null ? "点右上「刷新」加载回收站" : "（空）", style: "labelSmall", color: "onSurfaceVariant" }));
        }
        items.forEach(function (it) {
            const on = !!ticks[it.dir];
            const d = new Date(it.deletedAt || 0);
            const ts = (d.getMonth() + 1) + "-" + d.getDate() + " " + d.getHours() + ":" + ("0" + d.getMinutes()).slice(-2);
            rows.push(ctx.UI.Row({ verticalAlignment: "center", spacing: 8 }, [
                CHK(on, function () { const m = Object.assign({}, ticks); if (on) delete m[it.dir]; else m[it.dir] = true; tickState.set(m); }),
                TXT({ text: "[" + typeLabel(it.type) + "] " + it.name + "　" + ts, style: "labelSmall", weight: 1 })
            ]));
        });
        rows.push(ctx.UI.Row({ spacing: 8 }, [
            BTN({ weight: 1, enabled: chosen.length > 0, onClick: async function () {
                const r = await RPC("bridge_core:trash_restore", { dirs: chosen.join(",") });
                const p = parse(r); if (p && p.success === false) { errState.set(String(p.error || "恢复失败")); return; }
                tickState.set({}); await loadTrash(); await refresh();
            } }, [TXT({ text: "恢复" })]),
            BTN({ weight: 1, onClick: function () { const m = {}; items.forEach(function (x) { m[x.dir] = true; }); tickState.set(m); } }, [TXT({ text: "全选" })]),
            BTN({ weight: 1, onClick: function () { tickState.set({}); } }, [TXT({ text: "取消" })]),
            BTN({ weight: 1, enabled: chosen.length > 0, onClick: function () { purgeAskState.set(chosen.slice()); } }, [TXT({ text: "删除" })])
        ]));
        return ctx.UI.Column({ spacing: 8 }, rows);
    }

    return ctx.UI.Box({ fillMaxSize: true }, [
        ctx.UI.LazyColumn({
        onLoad: async function () {
            try {
                pageState.set(""); selState.set(""); delState.set(""); renameState.set(""); regState.set(""); qrState.set(null);
                await refresh();
            } catch (_e) {}
        },
        fillMaxSize: true,
        padding: 16,
        spacing: 12
    }, [
        pageAcc ? null : ctx.UI.Row({ verticalAlignment: "center", spacing: 8 }, [
            ICON({ name: "hub", tint: "primary", size: 24 }),
            TXT({ text: "桥", style: "titleLarge", fontWeight: "bold", weight: 1 }),
            IBTN({ icon: "refresh", onClick: function () { return refresh(); } })
        ]),
        msgState.value ? TXT({ text: msgState.value, color: "primary", style: "labelSmall" }) : null,
        errState.value ? TXT({ text: errState.value, color: "error", style: "labelSmall" }) : null,

        // ═══ 一级导航：概览 / 通道 / 设置 ═══
        pageAcc ? null : ctx.UI.Row({ spacing: 6, fillMaxWidth: true }, [
            { key: "home", label: "概览" },
            { key: "channels", label: "通道" },
            { key: "settings", label: "设置" }
        ].map(function (c) {
            return SEG(navState.value === c.key, c.label, function () {
                navState.set(c.key); selState.set(""); qrState.set(null); delState.set("");
                if (c.key === "trash") void loadTrash();
            }, "bodyMedium");
        })),

        // ═══ 通道：微信 / QQ / 公开 / 回收 ═══
        (pageAcc || navState.value !== "channels") ? null : ctx.UI.Row({ spacing: 4, fillMaxWidth: true }, [
            ["wechat", "微信"],
            ["qq", "QQ"],
            ["public", "公开"],
            ["trash", "回收"]
        ].map(function (t) {
            return chanTab(t[0], t[1]);
        })),

        // ═══ 内容 ═══
        pageAcc
            ? ctx.UI.Column({ spacing: 12 }, [accountCard(pageAcc, true)])
            : navState.value === "home"
                ? ctx.UI.Column({ spacing: 12 }, [tabHome()])
                : navState.value === "settings"
                    ? ctx.UI.Column({ spacing: 12 }, [tabPaths(), tabMaintain()])
                    : (chanState.value === "trash"
                        ? ctx.UI.Column({ spacing: 12 }, [tabTrash()])
                        : ctx.UI.Column({ spacing: 12 }, [tabOverview(), tabMsgs()]))
    ].filter(Boolean)),
        exposeDialog(),
        delDialog(),
        purgeDialog(),
        gwDialog()
    ].filter(Boolean));
}