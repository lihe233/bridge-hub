"use strict";

var HUB = "/mnt/android/sdcard/Download/Operit/bridge_hub/";
var CFG_PATH = HUB + "rt_config.json";
var DEFAULT_CFG = { accounts: [ { name: "wx-1", channel: "wechat", enabled: true, chatId: "" }, { name: "pub-1", channel: "public", enabled: true, port: 8789, token: "", chatId: "" } ] };

var state = { running: false, gen: 0, seen: [], logLines: [], accounts: [], received: 0, replied: 0, seeds: {}, cfgOverride: null, retry: [], wxExpired: {}, msgs: {} };
var chatQueues = {};
var CHANNEL = "bridge_hub.service";
var __ipcReady = false;
function ensureIpc() {
    if (__ipcReady) return true;
    try { ToolPkg.ipc.on(CHANNEL, handleRequest); __ipcReady = true; return true; } catch (eIp) { return false; }
}
var __UI = null, __UI_ERR = "";
try { __UI = require("./ui/bridge_settings/index.ui.js"); }
catch (eU) { __UI_ERR = String(eU && eU.message ? eU.message : eU); try { console.log("[bridge] ui require failed: " + __UI_ERR); } catch (e2) {} }
var __UI_KIND = (__UI === null) ? "null" : (typeof __UI);
var __UI_KEYS = (__UI && typeof __UI === "object") ? Object.keys(__UI).join(",") : "";
var __UI_HAS_DEFAULT = !!(__UI && __UI.default);
function __pickScreen() {
    if (!__UI) return null;
    if (__UI.default) return __UI.default;
    if (__UI.Screen) return __UI.Screen;
    if (typeof __UI === "function") return __UI;
    return null;
}
try { ToolPkg.ipc.on(CHANNEL, handleRequest); } catch (e) { try { console.log("[bridge] ipc " + errText(e)); } catch (e2) {} }

function errText(e) { return String(e && e.message ? e.message : e); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function writeFile(p, c) {
    var txt = String(c);
    try { await Tools.Files.write(p, txt); state.io = "Files.write"; return true; } catch (e) { state.ioErr = errText(e); }
    try { await Tools.Files.write(p, txt, false, "android"); state.io = "Files.write(env)"; return true; } catch (e) { state.ioErr = errText(e); }
    return false;
}
async function readFile(p) {
    try { var r = await Tools.Files.read(p); if (r && typeof r.content === "string") { state.io = "Files.read"; return r.content; } if (typeof r === "string") return r; } catch (e) { state.ioErr = errText(e); }
    try { var r2 = await Tools.Files.read({ path: p, environment: "android" }); if (r2 && typeof r2.content === "string") { state.io = "Files.read(env)"; return r2.content; } } catch (e) { state.ioErr = errText(e); }
    return "";
}
var SEEN_PATH = HUB + "rt_seen.json";
async function saveSeen() {
    try { var arr = state.seen.slice(-500); await writeFile(SEEN_PATH, JSON.stringify(arr)); } catch (e) {}
}
async function loadSeen() {
    try {
        var txt = await readFile(SEEN_PATH);
        if (!txt) return;
        var arr = JSON.parse(txt);
        if (Array.isArray(arr)) { state.seen = arr.slice(-500); await rlog("SEEN_LOAD " + state.seen.length); }
    } catch (e) {}
}
var __logChain = Promise.resolve();
function rlog(msg) {
    var line = new Date().toISOString().slice(11, 19) + " " + msg;
    try { state.logLines.push(line); if (state.logLines.length > 400) state.logLines.shift(); } catch (e) { }
    __logChain = __logChain.then(async function () {
        try {
            var old = await readFile(HUB + "rt.log");
            if (old.length > 300000) old = old.slice(-150000);
            await writeFile(HUB + "rt.log", old + line + String.fromCharCode(10));
        } catch (eL) { }
    });
    return __logChain;
}
var PLOG = HUB + "rt_plugin.log";
async function loadJson(p, def) { try { var t = await readFile(p); if (!t) return def; return JSON.parse(t); } catch (e) { return def; } }

function normalize(cfg) {
    if (cfg && Array.isArray(cfg.accounts)) return cfg;
    var out = { accounts: [] };
    if (cfg && cfg.wechat && cfg.wechat.enabled !== false) out.accounts.push({ name: (cfg.wechat.account || "wx-1"), channel: "wechat", enabled: true, chatId: "" });
    if (cfg && cfg.public && cfg.public.enabled) out.accounts.push({ name: "pub-1", channel: "public", enabled: true, port: cfg.public.port || 8789, token: cfg.public.token || "", chatId: cfg.public.chatId || "" });
    if (!out.accounts.length) out = JSON.parse(JSON.stringify(DEFAULT_CFG));
    return out;
}

function extract(out, acc) {
    if (!out) return acc;
    if (typeof out === "string") return acc + out;
    var keys = ["text", "delta", "content", "snapshot"];
    for (var i = 0; i < keys.length; i++) { var v = out[keys[i]]; if (typeof v === "string" && v.length) return acc + v; }
    if (out.type === "segment" && out.segment && out.segment.kind === "text") return acc + (out.segment.text || "");
    if (out.message && typeof out.message.content === "string") return acc + out.message.content;
    return acc;
}

async function ask(chatId, text) {
    var hard = Number((state.cfg && state.cfg.aiTimeoutMs) || 600000);
    var req = { kind: "submit", chatId: chatId, runtime: "main",
        input: { text: text, attachments: [], replyToMessageTimestamp: null },
        turn: { kind: "execute" }, notifyReply: false };
    var t0 = Date.now();
    var done = false;
    var result = null;
    Tools.Chat.sendMessage(req).then(function (r) { done = true; result = r; })
        .catch(function (e) { done = true; result = { __err: errText(e) }; });
    var idleN = 0;
    while (!done) {
        await sleep(3000);
        if (done) break;
        var el = Date.now() - t0;
        var busy = true;
        try {
            var st = await Tools.Chat.agentStatus(chatId);
            busy = !!(st && (st.executing || st.running || st.isExecuting));
        } catch (e) { busy = true; }
        if (busy) { idleN = 0; }
        else {
            idleN++;
            if (idleN >= 3) { await rlog("ASK_IDLE " + chatId + " ms=" + el); break; }
        }
        if (el > hard) { await rlog("ASK_HARD_TIMEOUT " + chatId + " ms=" + el); break; }
    }
    if (!done) {
        try { await Tools.Chat.cancel(chatId); } catch (e) { }
        var waitN = 0;
        while (!done && waitN < 10) { await sleep(1000); waitN++; }
    }
    if (result && result.__err) throw new Error(result.__err);
    if (result === null || result === undefined) return "";
    return __pickText(result);
}


var MEDIA_DIR = HUB + "media/";
var MEDIA_KEEP_N = 100;
var MEDIA_KEEP_MS = 7 * 86400000;
var __mediaCleanAt = 0;

async function __mediaClean() {
    try {
        var lr = await Tools.Files.list(MEDIA_DIR);
        var arr = (lr && (lr.entries || lr.items || lr.list)) || (Array.isArray(lr) ? lr : []);
        if (!arr.length) return;
        var files = [];
        var staleMark = 0;
        var now0 = Date.now();
        for (var i = 0; i < arr.length; i++) {
            var e = arr[i] || {};
            var nm = String(e.name || e.fileName || "");
            if (!nm || nm === "." || nm === "..") continue;
            var mt = Number(e.lastModified || e.mtime || e.modifiedTime || 0);
            if (mt && mt < 1e11) mt = mt * 1000;
            // 中间标记文件：job_ / done_ 且超 10 分钟的直接删掉
            if (/^(job_|done_)/.test(nm) && nm.slice(-5) === ".json") {
                if (!mt || (now0 - mt > 600000)) {
                    try { await Tools.Files.delete(MEDIA_DIR + nm); staleMark++; } catch (eM) { }
                }
                continue;
            }
            files.push({ name: nm, mtime: mt || 0 });
        }
        if (staleMark) await rlog("MEDIA_MARK_CLEAN " + staleMark);
        files.sort(function (a, b) { return b.mtime - a.mtime; });
        var now = Date.now();
        var killed = 0;
        for (var k = 0; k < files.length; k++) {
            var f = files[k];
            var tooOld = f.mtime && (now - f.mtime > MEDIA_KEEP_MS);
            var tooMany = k >= MEDIA_KEEP_N;
            if (!tooOld && !tooMany) continue;
            try { await Tools.Files.delete(MEDIA_DIR + f.name); killed++; } catch (eD) { }
        }
        if (killed) await rlog("MEDIA_CLEAN " + killed + " left=" + (files.length - killed));
    } catch (e) { }
}

function __maybeCleanMedia() {
    if (__mediaCleanAt && Date.now() - __mediaCleanAt < 1800000) return;
    __mediaCleanAt = Date.now();
    try { void __mediaClean(); } catch (e) { }
}
function __splitLong(t, limit) {
    if (!t) return [];
    if (t.length <= limit) return [t];
    var half = Math.ceil(t.length / 2);
    var cut = -1;
    var seps = ["\n\n", "\n", "。", "！", "？", "，", ".", "!", "?", ";"];
    for (var si = 0; si < seps.length; si++) {
        var sp = seps[si];
        var best = -1;
        var idx = t.indexOf(sp);
        while (idx >= 0) {
            var pos = idx + sp.length;
            if (Math.abs(pos - half) < Math.abs(best - half) || best < 0) best = pos;
            if (pos > half + 200) break;
            idx = t.indexOf(sp, idx + 1);
        }
        if (best > 0 && best > limit * 0.3) { cut = best; break; }
    }
    if (cut <= 0) cut = Math.min(half, limit);
    var a = t.slice(0, cut).replace(/\s+$/, "");
    var b = t.slice(cut).replace(/^\s+/, "");
    if (!b) return [a];
    if (b.length > limit) b = b.slice(0, limit);
    return [a, b];
}

function __cleanText(t) {
    if (typeof t !== "string") return "";
    var x = t;
    x = x.replace(/\u0000/g, "");
    x = x.replace(/[ \t]+$/gm, "");
    x = x.replace(/^[ \t]+/gm, "");
    x = x.replace(/\n{3,}/g, String.fromCharCode(10) + String.fromCharCode(10));
    x = x.replace(/^\s+/, "");
    x = x.replace(/\s+$/, "");
    return x;
}
function __pickText(r) {
    if (r === null || r === undefined) return "";
    if (typeof r === "string") return __cleanText(r);
    if (typeof r.aiResponse === "string" && r.aiResponse.length) return __cleanText(r.aiResponse);
    var keys = ["response", "reply", "text", "content", "output"];
    for (var i = 0; i < keys.length; i++) {
        if (typeof r[keys[i]] === "string" && r[keys[i]].length) return __cleanText(r[keys[i]]);
    }
    if (r.data) return __pickText(r.data);
    if (r.result) return __pickText(r.result);
    return "";
}

function enqueue(chatId, task) {
    var prev = chatQueues[chatId] || Promise.resolve();
    var next = prev.then(function () { return task(); }, function () { return task(); });
    chatQueues[chatId] = next.then(function () {}, function () {});
    return next;
}

async function rebindChat(name, channel, from) {
    try {
        var cr = await Tools.Chat.createNew({ setAsCurrentChat: false });
        var nid = (cr && cr.chatId) || "";
        if (!nid) { await rlog("REBIND_NO_ID " + name); return ""; }
        var title = channel + " " + name + (from ? " " + String(from).slice(0, 12) : "");
        try { await Tools.Chat.updateTitle(nid, title); } catch (e0) { }
        await writeFile(HUB + "accounts/" + name + "/binding.json", JSON.stringify({ chatId: nid, chatTitle: title, enabled: true }, null, 2));
        try { await putCfg(name, { chatId: nid }); } catch (e1) { }
        state.chatFix = state.chatFix || {};
        state.chatFix[name] = nid;
        await rlog("CHAT_REBIND " + name + " " + nid);
        return nid;
    } catch (e) { await rlog("REBIND_ERR " + name + " " + errText(e)); return ""; }
}

function chLabel(channel) {
    return (channel === "wechat") ? "微信" : ((channel === "qq") ? "QQ" : "公开接口");
}
async function ensureChatValid(chatId) {
    if (!chatId) return false;
    var now = Date.now();
    state.chatCheck = state.chatCheck || {};
    var c = state.chatCheck[chatId];
    if (c && (now - c.at) < 30000) return c.ok;
    var ok = true;
    try {
        var lr = await Tools.Chat.listChats();
        var arr = (lr && (lr.chats || lr.items || lr.list)) || (Array.isArray(lr) ? lr : []);
        if (arr && arr.length >= 0) {
            ok = false;
            for (var i = 0; i < arr.length; i++) {
                var cid = String(arr[i].chatId || arr[i].id || "");
                if (cid === String(chatId)) { ok = true; break; }
            }
        }
    } catch (e) { ok = true; }
    state.chatCheck[chatId] = { at: now, ok: ok };
    return ok;
}

async function process(name, channel, from, id, text, chatId) {
    if (chatId) {
        var _okChat = await ensureChatValid(chatId);
        if (!_okChat) {
            await rlog("CHAT_GONE " + name + " " + chatId);
            chatId = (await rebindChat(name, chLabel(channel), from)) || "";
        }
    }
    if (chatId) {
        var _stillBusy = false;
        try {
            for (var _bw = 0; _bw < 120; _bw++) {
                var stb = await Tools.Chat.agentStatus(chatId);
                var _b = !!(stb && (stb.executing || stb.running || stb.isExecuting));
                _stillBusy = _b;
                if (!_b) break;
                await sleep(2500);
            }
        } catch (e) { }
        if (_stillBusy) { await rlog("CHAT_BUSY " + name + " " + chatId); return ""; }
    }
    if (!chatId) {
        try {
            var cr = await Tools.Chat.createNew({ setAsCurrentChat: false });
            chatId = (cr && cr.chatId) || "";
            if (chatId) {
                try { await Tools.Chat.updateTitle(chatId, channel + " " + name + " " + (from || "")); } catch (e0) { }
                await writeFile(HUB + "accounts/" + name + "/binding.json", JSON.stringify({ chatId: chatId, chatTitle: channel + " " + name, enabled: true }, null, 2));
                try { await putCfg(name, { channel: channel, chatId: chatId }); } catch (e1) { }
                await rlog("CHAT_CREATED " + name + " " + chatId);
            }
        } catch (e) {
            await rlog("CREATE_CHAT_SKIP " + name + " " + errText(e));
        }
    }
    if (!chatId) { await rlog("NO_BINDING " + name + " 未绑定对话，消息丢弃"); return ""; }
    return enqueue(chatId, async function () {
        var t0 = Date.now();
        await rlog("ASK_START " + name + " q=" + t0);
        var _ch = (channel === "wechat") ? "微信" : ((channel === "qq") ? "QQ" : "公开接口");
        var _body = __cleanText(text);
        if (!_body) { await rlog("ASK_EMPTY " + name + " " + id); return "__EMPTY__"; }
        var payload = _body + String.fromCharCode(10) + String.fromCharCode(10) + "[" + _ch + " " + name + "]";
        try {
            var acc = await ask(chatId, payload);
            await rlog("ASK " + name + " msg=" + id + " ms=" + (Date.now() - t0) + " len=" + acc.length);
            if (acc) state.replied++;
            return acc || null;
        } catch (e) {
            var em = errText(e);
            await rlog("ASK_ERR " + name + " " + em);
            if (em.indexOf("does not exist") >= 0) {
                var nid = await rebindChat(name, _ch, from);
                if (nid) {
                    try {
                        var acc2 = await ask(nid, payload);
                        await rlog("ASK_REBIND_OK " + name + " len=" + acc2.length);
                        if (acc2) state.replied++;
                        return acc2 || null;
                    } catch (e2) { await rlog("ASK_REBIND_ERR " + name + " " + errText(e2)); }
                }
            }
            return "";
        }
    });
}

// ============ 微信账号 ============
function wxHeaders(a) {
    var h = { "Content-Type": "application/json", "User-Agent": "operit-bridge-rt/1.7" };
    if (a.token) { h["Authorization"] = "Bearer " + a.token; h["AuthorizationType"] = "ilink_bot_token"; }
    return h;
}
async function wxPost(a, path, body, rt) {
    var r = await Tools.Net.http({ url: a.baseUrl + path, method: "POST", headers: wxHeaders(a),
        body: JSON.stringify(body), connect_timeout: 20, read_timeout: rt || 40, responseType: "text", follow_redirects: false });
    if (!r || r.statusCode < 200 || r.statusCode >= 300) throw new Error("HTTP " + (r && r.statusCode) + ": " + String(r && r.content).slice(0, 160));
    return JSON.parse(r.content);
}
function pickText(m) { try { var it = (m.item_list || [])[0]; if (it && it.text_item && it.text_item.text) return it.text_item.text; } catch (e) {} return m.text || m.content || ""; }
function pickId(m) { if (m.msg_id) return m.msg_id; try { var it = (m.item_list || [])[0]; if (it && it.msg_id) return it.msg_id; } catch (e) {} return String(m.message_id || ""); }

var __typingCache = {};
var __typingLive = {};
var __typingStart = {};
var TYPING_CACHE_PATH = HUB + "typing_cache.json";
var TYPING_MS = 1500;
var WX_TEXT_LIMIT = 1500;
var QQ_TEXT_LIMIT = 1500;
var TYPING_MIN_MS = 3000;
async function __typingTicket(a, userId, ctxToken) {
    var key = a.name + "|" + userId;
    if (__typingCache[key]) return __typingCache[key];
    try {
        var disk = await readJsonSafe(TYPING_CACHE_PATH, {});
        var ent = disk && disk[key];
        if (ent && ent.ticket && ent.at && (Date.now() - Number(ent.at) < 72000000)) {
            __typingCache[key] = ent.ticket;
            return ent.ticket;
        }
    } catch (e0) { }
    try {
        var r0 = await wxPost(a, "/ilink/bot/getconfig", {
            ilink_user_id: userId,
            context_token: ctxToken || "",
            base_info: { channel_version: "2.0.0" }
        }, 10);
        var tk = (r0 && r0.typing_ticket) || "";
        if (tk) {
            __typingCache[key] = tk;
            try { var d2 = await readJsonSafe(TYPING_CACHE_PATH, {}); d2[key] = { ticket: tk, at: Date.now() }; await writeJson(TYPING_CACHE_PATH, d2); } catch (e1) { }
        }
        return tk;
    } catch (e) {
        await rlog("WX_TYPING_ERR ticket " + a.name + " " + errText(e));
        return "";
    }
}
async function wxTypingKeep(a, userId, ctxToken) {
    if (!a || !userId) return;
    var key = a.name + "|" + userId;
    if (__typingLive[key]) return;
    __typingLive[key] = true;
    __typingStart[key] = Date.now();
    try {
        await writeFile(HUB + "typing/" + a.name + ".json", JSON.stringify({ at: Date.now(), user: userId }));
    } catch (e) { await rlog("TYPING_MARK_ERR " + a.name + " " + errText(e)); }
}
async function wxTypingStop(a, userId) {
    if (!a || !userId) return;
    var key = a.name + "|" + userId;
    var _st = __typingStart[key] || 0;
    var _left = TYPING_MIN_MS - (Date.now() - _st);
    if (_st && _left > 0) { await sleep(_left); }
    delete __typingStart[key];
    __typingLive[key] = false;
    try { await Tools.Files.delete(HUB + "typing/" + a.name + ".json"); } catch (e) { }
    await rlog("WX_TYPING_KEEP " + a.name + " done");
}

async function wxReply(a, to, ctx, text) {
    text = __cleanText(text);
    if (!text) { await rlog("REPLY_EMPTY " + a.name); return; }
    if (a.cfg && a.cfg.channel === "http") {
        var r0 = await wxPost(a, "/sendmessage", { to: to, text: text, reply_to: String(ctx || "") }, 30);
        await rlog("HTTP_REPLY " + a.name + " " + JSON.stringify(r0 || {}).slice(0, 100));
        return;
    }
    var parts = __splitLong(text, WX_TEXT_LIMIT);
    if (parts.length > 1) { await rlog("WX_SPLIT " + a.name + " parts=" + parts.length + " len=" + text.length); }
    for (var pi = 0; pi < parts.length; pi++) {
        if (pi > 0) { await sleep(300); }
        var msg = { to_user_id: to, client_id: "rt-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
            message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text: parts[pi] } }] };
        if (ctx) msg.context_token = ctx;
        var r = await wxPost(a, "/ilink/bot/sendmessage", { msg: msg, base_info: { channel_version: "2.0.0" } }, 30);
        await rlog("WX_REPLY " + a.name + " " + (r && r.errcode === 0 ? "ok" : JSON.stringify(r).slice(0, 100)));
    }
}

async function __wxMedia(a, m, msgId) {
    try {
        var items = m.item_list || [];
        var jobs = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i] || {};
            var t = it.type;
            var node = null, kind = "", fname = "";
            if (t === 2 && it.image_item) { node = it.image_item; kind = "img"; }
            else if (t === 3 && it.voice_item) { node = it.voice_item; kind = "voice"; }
            else if (t === 4 && it.file_item) { node = it.file_item; kind = "file"; fname = String(node.file_name || ""); }
            else if (t === 5 && it.video_item) { node = it.video_item; kind = "video"; }
            if (!node) continue;
            var media = node.media || {};
            var url = media.full_url || "";
            if (!url) continue;
            var key = String(node.aeskey || node.aes_key || "").trim();
            jobs.push({ url: url, key: key, kind: kind, name: fname });
        }
        if (!jobs.length) return "";
        var tag = String(msgId).replace(/[^a-zA-Z0-9]/g, "").slice(-20) + "_" + Date.now();
        var outs = [];
        for (var k = 0; k < jobs.length; k++) {
            var job = jobs[k];
            var jobTag = tag + "_" + k;
            var outPath = MEDIA_DIR + job.kind + "_wx_" + jobTag;
            var payload = { url: job.url, key: job.key, out: outPath, kind: job.kind, name: job.name };
            try { await Tools.Files.mkdir(MEDIA_DIR); } catch (e0) { }
            await writeFile(MEDIA_DIR + "job_" + jobTag + ".json", JSON.stringify(payload));
            var got = "";
            for (var w = 0; w < 240; w++) {
                await sleep(250);
                try {
                    var rj = await readFile(MEDIA_DIR + "done_" + jobTag + ".json");
                    if (rj) {
                        var jd = JSON.parse(rj);
                        try { await Tools.Files.delete(MEDIA_DIR + "done_" + jobTag + ".json"); } catch (eD) { }
                        if (jd && jd.ok) got = jd.path;
                        else await rlog("WX_MEDIA_FAIL " + a.name + " " + job.kind + " " + String(jd && jd.err));
                        break;
                    }
                } catch (eR) { }
            }
            if (got) outs.push({ kind: job.kind, path: got, name: job.name });
        }
        if (!outs.length) return "";
        await rlog("WX_MEDIA " + a.name + " n=" + outs.length);
        return outs;
    } catch (e) {
        await rlog("WX_MEDIA_ERR " + errText(e));
        return "";
    }
}

async function wxHandle(a, gen, m) {
    var _isHttp = !!(a.cfg && a.cfg.channel === "http");
    var id = _isHttp ? (m.id || m.msg_id || "") : pickId(m);
    var text = _isHttp ? (m.text || "") : pickText(m);
    var from = _isHttp ? (m.from || m.from_user_id || "") : (m.from_user_id || m.from || "");
    var _hasImg = false;
    if (!_isHttp) { var _il = m.item_list || []; for (var _ii = 0; _ii < _il.length; _ii++) { var _t2 = _il[_ii] && _il[_ii].type; if (_t2 === 2 || _t2 === 3 || _t2 === 4 || _t2 === 5) { _hasImg = true; break; } } }
    if (!id || (!text && !_hasImg)) return;
    if (_hasImg) {
        var _mds = await __wxMedia(a, m, id);
        if (_mds && _mds.length) {
            var _lines = [];
            for (var _mi = 0; _mi < _mds.length; _mi++) {
                var _mk = _mds[_mi].kind;
                var _ml = (_mk === "img") ? "[图片] " : ((_mk === "voice") ? "[语音] " : ((_mk === "video") ? "[视频] " : ((_mk === "file") ? "[文件] " : "[附件] ")));
                _lines.push(_ml + _mds[_mi].path);
            }
            var _blk = _lines.join(String.fromCharCode(10));
            text = text ? (text + String.fromCharCode(10) + _blk) : _blk;
        } else {
            text = text ? (text + String.fromCharCode(10) + "[附件下载失败]") : "[附件下载失败]";
        }
    }
    var key = a.name + "|" + id;
    if (state.seen.indexOf(key) >= 0) return;
    state.received++;
    await rlog("RECV [" + (a.cfg && a.cfg.channel) + "] " + a.name + " " + from + ": " + String(text).slice(0, 500));
    try { pushEvent(a.name, id, from, text); } catch (e0) {}
    if (!_isHttp) { void wxTypingKeep(a, from, m.context_token || ""); }
    var acc = await process(a.name, _isHttp ? "http" : "wechat", from, id, text, (state.chatFix && state.chatFix[a.name]) || a.chatId);
    if (acc === "__EMPTY__") { state.seen.push(key); if (state.seen.length > 1024) state.seen.shift(); void saveSeen(); if (!_isHttp) { void wxTypingStop(a, from); } return; }
    if (!acc) {
        if (!_isHttp) { void wxTypingStop(a, from); }
        state.retryN = state.retryN || {};
        var rn = (state.retryN[key] || 0) + 1;
        state.retryN[key] = rn;
        if (rn <= 2 && state.retry.length < 50) {
            state.retry.push({ acc: a, gen: gen, m: m, at: Date.now() });
            await rlog("REQUEUE " + a.name + " " + id + " try=" + rn);
            return;
        }
        state.seen.push(key); if (state.seen.length > 1024) state.seen.shift(); void saveSeen();
        await rlog("DROP " + a.name + " " + id + " try=" + rn);
        return;
    }
    state.seen.push(key); if (state.seen.length > 1024) state.seen.shift(); void saveSeen();
    if (state.retryN && state.retryN[key]) delete state.retryN[key];
    if (gen !== state.gen) { if (!_isHttp) { void wxTypingStop(a, from); } return; }
    if (!_isHttp) { await wxTypingStop(a, from); }
    try { await wxReply(a, from, _isHttp ? id : (m.context_token || ""), acc); }
    catch (e) { await rlog("SEND_ERR " + a.name + " " + errText(e)); }
}

async function startWechat(acc, gen) {
    var cfg = acc.cfg, a = { name: cfg.name, cfg: cfg, token: "", baseUrl: "https://ilinkai.weixin.qq.com", chatId: cfg.chatId || "", syncBuf: "", running: false };
    var seed = state.seeds[cfg.name] || {};
    if (!seed.account) { try { seed.account = await readFile(HUB + "accounts/" + cfg.name + "/account.json"); } catch (e) {} }
    if (!seed.binding) { try { seed.binding = await readFile(HUB + "accounts/" + cfg.name + "/binding.json"); } catch (e) {} }
    if (!seed.sync) { try { seed.sync = await readFile(HUB + "accounts/" + cfg.name + "/sync_buf.txt"); } catch (e) {} }
    var info = {}; try { info = JSON.parse(seed.account || "{}"); } catch (e) {}
    var bind = {}; try { bind = JSON.parse(seed.binding || "{}"); } catch (e) {}
    a.token = info.wechatToken || info.token || info.accessToken || "";
    a.baseUrl = info.baseUrl || a.baseUrl;
    if (!a.chatId) a.chatId = bind.chatId || "";
    a.syncBuf = String(seed.sync || "").trim();
    if (!a.token) { await rlog("WX_SKIP_NO_TOKEN " + cfg.name); return; }
    a.running = true;
    acc.runtime = a;
    state.wxRuntime = state.wxRuntime || {};
    state.wxRuntime[cfg.name] = a;
    await rlog("WX_START " + cfg.name + " chat=" + (a.chatId || "-") + " tokenLen=" + a.token.length);
    await markRun(cfg.name, true);
    void ensureWxPoll();
}

// ============ 通用接口账号 ============
function pubAuth(cfg, req, url) {
    var t = cfg.token || "";
    if (!t) return true;
    var h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
    if (h.indexOf("Bearer ") === 0) h = h.slice(7);
    var q = "";
    try { q = new URL("http://x" + url).searchParams.get("token") || ""; } catch (e) {}
    return (h || q) === t;
}
function readBody(req) {
    return new Promise(function (resolve) {
        var chunks = [];
        req.on("data", function (c) { chunks.push(c); });
        req.on("end", function () { try { resolve(Buffer.concat(chunks).toString("utf8")); } catch (e) { resolve(""); } });
        req.on("error", function () { resolve(""); });
    });
}

// [v1.7] HTTP 渠道：外部程序充当“腾讍”，字段完全兼容 iLink
// ============ QQ 通道（官方 Bot API + Gateway WS） ============
async function qqHttp(method, url, token, bodyObj, timeout) {
    var headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = "QQBot " + token;
    var opt = { url: url, method: method, headers: headers, connect_timeout: 10, read_timeout: timeout || 15, responseType: "text" };
    if (bodyObj !== null && bodyObj !== undefined) opt.body = JSON.stringify(bodyObj);
    var r = await Tools.Net.http(opt);
    var code = r && r.statusCode;
    var txt = String((r && r.content) || "");
    if (!(code >= 200 && code < 300)) throw new Error("HTTP " + code + " " + txt.slice(0, 120));
    if (!txt.trim()) return {};
    return JSON.parse(txt);
}
async function qqTokenOf(a) {
    var now = Date.now();
    if (a.qqToken && a.qqTokenExp && now < a.qqTokenExp - 60000) return a.qqToken;
    var j = await qqHttp("POST", "https://bots.qq.com/app/getAppAccessToken", "", { appId: a.appId, clientSecret: a.appSecret });
    if (!j || !j.access_token) throw new Error("取 token 失败: " + JSON.stringify(j).slice(0, 120));
    a.qqToken = j.access_token;
    a.qqTokenExp = now + (Number(j.expires_in || 7200) * 1000);
    return a.qqToken;
}
async function startQQ(acc, gen) {
    var cfg = acc.cfg;
    var aj = await readJsonSafe(HUB + "accounts/" + cfg.name + "/account.json", {});
    var a = {
        name: cfg.name, cfg: cfg, chatId: cfg.chatId || aj.chatId || "",
        appId: String(cfg.appId || aj.appId || ""), appSecret: String(cfg.appSecret || aj.appSecret || ""),
        running: true, ws: null, seq: null, hb: 0, nextHb: 0, awaitingAck: true, sessionId: "", qqToken: "", qqTokenExp: 0
    };
    acc.runtime = a;
    if (!a.appId || !a.appSecret) { a.running = false; await rlog("QQ_SKIP_NO_CRED " + cfg.name); return; }
    try {
        var tok = await qqTokenOf(a);
        var gw = await qqHttp("GET", "https://api.sgroup.qq.com/gateway/bot", tok, null);
        if (!gw || !gw.url) throw new Error("gateway 为空: " + JSON.stringify(gw).slice(0, 100));
        var sep = String(gw.url).indexOf("?") < 0 ? "?" : "&";
        var r = await Promise.race([
            Tools.Net.webSocket({ op: "open", url: gw.url + sep + "v=1&encoding=json", connect_timeout_seconds: 20 }),
            new Promise(function (res, rej) { setTimeout(function () { rej(new Error("WS_OPEN_TIMEOUT")); }, 15000); })
        ]);
        if (!r || r.op !== "open") throw new Error("ws 打开失败");
        a.ws = r.handle;
        await rlog("QQ_START " + cfg.name + " chat=" + (a.chatId || "-"));
        await markRun(cfg.name, true);
        void qqTick(a, gen);
    } catch (e) {
        a.running = false;
        await rlog("QQ_START_ERR " + cfg.name + " " + errText(e));
        if (state.running && gen === state.gen) {
            state.qqRetry = (state.qqRetry || 0) + 1;
            if (state.qqRetry <= 3) {
                await sleep(8000);
                if (state.running && gen === state.gen) {
                    try { await startQQ(acc, gen); } catch (eQ2) { }
                }
            }
        }
    }
}
async function qqSend(a, obj) {
    if (!a.ws) throw new Error("no ws");
    await Tools.Net.webSocket({ op: "send", handle: a.ws, text: JSON.stringify(obj) });
}
async function qqStop(a) {
    a.running = false;
    if (a.ws) { try { await Tools.Net.webSocket({ op: "close", handle: a.ws }); } catch (e) {} a.ws = null; }
}
async function qqTick(a, gen) {
    if (!(state.running && a.running && gen === state.gen && a.ws)) return;
    try {
        var r = await Tools.Net.webSocket({ op: "read", handle: a.ws });
        var evs = (r && r.events) || [];
        for (var i = 0; i < evs.length; i++) {
            var ev = evs[i];
            if (ev.type === "message") { var f = null; try { f = JSON.parse(ev.text); } catch (e) { continue; } await qqFrame(a, gen, f); }
            else if (ev.type === "closed") throw new Error("连接被关闭");
            else if (ev.type === "error") throw new Error(ev.message || "ws error");
        }
        var now = Date.now();
        if (a.hb > 0 && now >= a.nextHb) {
            if (!a.awaitingAck) throw new Error("心跳无 ACK");
            await qqSend(a, { op: 1, d: a.seq });
            a.awaitingAck = false; a.nextHb = now + a.hb;
        }
    } catch (e) {
        await rlog("QQ_TICK_ERR " + a.name + " " + errText(e));
        await qqStop(a);
        if (state.running && gen === state.gen) {
            await sleep(5000);
            if (state.running && gen === state.gen) {
                await rlog("QQ_RECONNECT " + a.name);
                try { await startQQ({ cfg: a.cfg }, gen); } catch (eRc) { await rlog("QQ_RECONNECT_ERR " + a.name + " " + errText(eRc)); }
            }
        }
        return;
    }
    setTimeout(function () { void qqTick(a, gen); }, 120);
}
async function qqFrame(a, gen, f) {
    if (!f) return;
    if (f.s !== undefined && f.s !== null) a.seq = f.s;
    var op = Number(f.op);
    if (op === 10) {
        var d = f.d || {};
        a.hb = Number(d.heartbeat_interval || 0);
        a.nextHb = Date.now() + a.hb;
        var tk = await qqTokenOf(a);
        if (a.sessionId) await qqSend(a, { op: 6, d: { token: "QQBot " + tk, session_id: a.sessionId, seq: a.seq } });
        else await qqSend(a, { op: 2, d: { token: "QQBot " + tk, intents: (1 << 25), shard: [0, 1], properties: { os: "operit", browser: "operit", device: "operit" } } });
        return;
    }
    if (op === 11) { a.awaitingAck = true; return; }
    if (op === 7) { throw new Error("QQ_OP7_RECONNECT"); }
    if (op === 9) { if (f.d === false) { a.sessionId = ""; a.seq = null; } throw new Error("QQ_OP9_INVALID_SESSION"); }
    if (op === 0) {
        var t = String(f.t || "");
        if (t === "READY") { a.sessionId = String((f.d || {}).session_id || ""); await rlog("QQ_READY " + a.name); return; }
        if (t === "RESUMED") return;
        if (t === "C2C_MESSAGE_CREATE" || t === "GROUP_AT_MESSAGE_CREATE" || t === "GROUP_MESSAGE_CREATE") {
            await qqMessage(a, gen, t, f.d || {});
        }
    }
}
async function __qqMedia(a, atts, msgId) {
    try {
        var jobs = [];
        for (var i = 0; i < atts.length; i++) {
            var at = atts[i] || {};
            var u = at.url || "";
            if (!u) continue;
            var ct = String(at.content_type || "");
            var kind = "file";
            if (ct.indexOf("image/") === 0) kind = "img";
            else if (ct.indexOf("video/") === 0) kind = "video";
            else if (ct.indexOf("audio/") === 0) kind = "voice";
            jobs.push({ url: u, kind: kind, ct: ct, name: String(at.filename || "") });
        }
        if (!jobs.length) return "";
        var tag = String(msgId).replace(/[^a-zA-Z0-9]/g, "").slice(-20) + "_" + Date.now();
        var outs = [];
        for (var k = 0; k < jobs.length; k++) {
            var job = jobs[k];
            var jobTag = tag + "_" + k;
            var outPath = MEDIA_DIR + job.kind + "_qq_" + jobTag;
            var payload = { url: job.url, key: "", out: outPath, kind: job.kind, name: job.name, ct: job.ct };
            try { await Tools.Files.mkdir(MEDIA_DIR); } catch (e0) { }
            await writeFile(MEDIA_DIR + "job_" + jobTag + ".json", JSON.stringify(payload));
            var got = "";
            for (var w = 0; w < 240; w++) {
                await sleep(250);
                try {
                    var rj = await readFile(MEDIA_DIR + "done_" + jobTag + ".json");
                    if (rj) {
                        var jd = JSON.parse(rj);
                        try { await Tools.Files.delete(MEDIA_DIR + "done_" + jobTag + ".json"); } catch (eD) { }
                        if (jd && jd.ok) got = jd.path;
                        else await rlog("QQ_MEDIA_FAIL " + a.name + " " + job.kind + " " + String(jd && jd.err));
                        break;
                    }
                } catch (eR) { }
            }
            if (got) outs.push({ kind: job.kind, path: got, name: job.name });
        }
        if (!outs.length) return "";
        await rlog("QQ_MEDIA " + a.name + " n=" + outs.length);
        return outs;
    } catch (e) {
        await rlog("QQ_MEDIA_ERR " + errText(e));
        return "";
    }
}
async function qqMessage(a, gen, type, body) {
    var scene = type === "C2C_MESSAGE_CREATE" ? "c2c" : "group";
    var author = body.author || {};
    var from = String(scene === "c2c" ? (author.user_openid || "") : (author.member_openid || ""));
    var groupOpenid = String(body.group_openid || "");
    var id = String(body.id || "");
    var text = String(body.content || "").trim();
    var _atts = body.attachments || [];
    if (_atts.length) {
        try { await writeFile(HUB + "qq_last.json", JSON.stringify(body, null, 1)); } catch (eW) { }
        var _ts = [];
        for (var _ai = 0; _ai < _atts.length; _ai++) { _ts.push(String(_atts[_ai].content_type || "?")); }
        await rlog("QQ_RAW " + a.name + " atts=" + _atts.length + " types=" + _ts.join(","));
    }
    if (!id || (!text && !_atts.length)) return;
    if (_atts.length) {
        var _qmds = await __qqMedia(a, _atts, id);
        if (_qmds && _qmds.length) {
            var _qlines = [];
            for (var _qi = 0; _qi < _qmds.length; _qi++) {
                var _qk = _qmds[_qi].kind;
                var _ql = (_qk === "img") ? "[图片] " : ((_qk === "voice") ? "[语音] " : ((_qk === "video") ? "[视频] " : "[文件] "));
                _qlines.push(_ql + _qmds[_qi].path);
            }
            var _qblk = _qlines.join(String.fromCharCode(10));
            text = text ? (text + String.fromCharCode(10) + _qblk) : _qblk;
        } else {
            text = text ? (text + String.fromCharCode(10) + "[附件下载失败]") : "[附件下载失败]";
        }
    }
    var key = a.name + "|" + id;
    if (state.seen.indexOf(key) >= 0) return;
    state.received++;
    await rlog("QQ_RECV " + a.name + " " + id + " from=" + from + " len=" + text.length);
    __maybeCleanMedia();
    try { pushEvent(a.name, id, from, text); } catch (e0) {}
    var acc = await process(a.name, "qq", from, id, text, (state.chatFix && state.chatFix[a.name]) || a.chatId);
    if (acc === "__EMPTY__") { state.seen.push(key); if (state.seen.length > 1024) state.seen.shift(); void saveSeen(); return; }
    if (!acc) { await rlog("QQ_REQUEUE " + a.name + " " + id); return; }
    state.seen.push(key); if (state.seen.length > 1024) state.seen.shift(); void saveSeen();
    state.replied++;
    try {
        var tok = await qqTokenOf(a);
        var path = scene === "c2c" ? ("/v2/users/" + encodeURIComponent(from) + "/messages") : ("/v2/groups/" + encodeURIComponent(groupOpenid) + "/messages");
        var _qtxt = __cleanText(acc);
        if (!_qtxt) { await rlog("REPLY_EMPTY " + a.name); return; }
        var _qparts = __splitLong(_qtxt, QQ_TEXT_LIMIT);
        if (_qparts.length > 1) { await rlog("QQ_SPLIT " + a.name + " parts=" + _qparts.length + " len=" + _qtxt.length); }
        for (var qi = 0; qi < _qparts.length; qi++) {
            if (qi > 0) { await sleep(300); }
            var res = await qqHttp("POST", "https://api.sgroup.qq.com" + path, tok, { content: _qparts[qi], msg_type: 0, msg_id: id });
            await rlog("QQ_REPLY " + a.name + " " + id + " " + JSON.stringify(res || {}).slice(0, 80));
        }
    } catch (e) { await rlog("QQ_REPLY_ERR " + a.name + " " + errText(e)); }
}

async function startHttp(acc, gen) {
    var cfg = acc.cfg;
    var a = {
        name: cfg.name, cfg: cfg,
        token: cfg.token || "",
        baseUrl: String(cfg.baseUrl || ("http://127.0.0.1:" + (cfg.port || 8789))).replace(/\/+$/, ""),
        chatId: cfg.chatId || "",
        syncBuf: cfg.syncBuf || "",
        running: false
    };
    acc.runtime = a;
    a.running = true;
    await rlog("HTTP_START " + cfg.name + " " + a.baseUrl + " chat=" + (a.chatId || "-"));
    await markRun(cfg.name, true);
    void __wxTick(a, gen);
}

// ============ 生命周期 ============

var GW_SRC = "#!/usr/bin/env python3\nimport json, sys, os, re, queue, uuid, argparse, threading, time\nfrom http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\n\nHUB = \"/storage/emulated/0/Download/Operit/bridge_hub\"\nMEDIA_DIR = HUB + \"/media\"\nRTLOG = HUB + \"/rt.log\"\n\ndef trim_log():\n    try:\n        if os.path.getsize(RTLOG) > 524288:\n            with open(RTLOG, \"r\", encoding=\"utf-8\", errors=\"ignore\") as f:\n                tail = f.readlines()[-300:]\n            with open(RTLOG, \"w\", encoding=\"utf-8\") as f:\n                f.writelines(tail)\n    except Exception:\n        pass\n\ndef wlog(msg):\n    try:\n        trim_log()\n        with open(RTLOG, \"a\", encoding=\"utf-8\") as f:\n            f.write(time.strftime(\"%H:%M:%S \", time.localtime()) + msg + \"\\n\")\n    except Exception:\n        pass\n\nclass PortState(object):\n    def __init__(self, port, key, allow_public):\n        self.port = port\n        self.key = key or \"\"\n        self.allow_public = bool(allow_public)\n        self.q = queue.Queue()\n        self.pend = {}\n        self.lock = threading.Lock()\n\n\ndef _img_ext(ct):\n    s = str(ct or \"\").lower()\n    if \"png\" in s: return \".png\"\n    if \"gif\" in s: return \".gif\"\n    if \"webp\" in s: return \".webp\"\n    return \".jpg\"\n\n\ndef save_image(src, tag):\n    \"\"\"\u4ece url / data uri \u62ff\u56fe\u5e76\u5b58\u5230 MEDIA_DIR\uff0c\u8fd4\u56de\u672c\u5730\u8def\u5f84\u6216\u7a7a\u4e32\u3002\"\"\"\n    try:\n        os.makedirs(MEDIA_DIR, exist_ok=True)\n    except Exception:\n        pass\n    s = str(src or \"\").strip()\n    if not s:\n        return \"\"\n    try:\n        if s.startswith(\"data:\"):\n            head, _, b64 = s.partition(\",\")\n            import base64\n            raw = base64.b64decode(b64)\n            ext = _img_ext(head)\n        elif s.startswith(\"http://\") or s.startswith(\"https://\"):\n            import urllib.request\n            rq = urllib.request.Request(s, headers={\"User-Agent\": \"Mozilla/5.0\"})\n            with urllib.request.urlopen(rq, timeout=40) as r:\n                raw = r.read()\n                ext = _img_ext(r.headers.get(\"Content-Type\"))\n        elif os.path.isabs(s) and os.path.isfile(s):\n            return s\n        else:\n            return \"\"\n        if not raw:\n            return \"\"\n        out = os.path.join(MEDIA_DIR, \"gw_\" + tag + ext)\n        with open(out, \"wb\") as f:\n            f.write(raw)\n        wlog(\"GW IMG %s %d\" % (out, len(raw)))\n        return out\n    except Exception as e:\n        wlog(\"GW IMG_ERR %s\" % str(e)[:100])\n        return \"\"\n\n\ndef make_handler(st):\n    class H(BaseHTTPRequestHandler):\n        def log_message(self, *a): pass\n        def _out(self, code, obj):\n            b = json.dumps(obj, ensure_ascii=False).encode(\"utf-8\")\n            self.send_response(code)\n            self.send_header(\"Content-Type\", \"application/json; charset=utf-8\")\n            self.send_header(\"Content-Length\", str(len(b)))\n            self.end_headers()\n            self.wfile.write(b)\n        def _lan(self):\n            if st.allow_public: return True\n            ip = self.client_address[0]\n            if ip.startswith((\"127.\", \"10.\", \"192.168.\", \"fe80\", \"::1\")): return True\n            return re.match(r\"^172\\.(1[6-9]|2\\d|3[01])\\.\", ip) is not None\n        def _auth(self):\n            if not st.key: return True\n            h = self.headers.get(\"Authorization\", \"\")\n            if h.startswith(\"Bearer \"): h = h[7:]\n            return h == st.key\n        def _read_chunked(self):\n            data = b\"\"\n            while True:\n                line = self.rfile.readline().strip()\n                if not line: break\n                try: n = int(line.split(b\";\")[0], 16)\n                except Exception: break\n                if n == 0:\n                    try: self.rfile.readline()\n                    except Exception: pass\n                    break\n                data += self.rfile.read(n)\n                try: self.rfile.readline()\n                except Exception: pass\n            return data\n        def _body(self):\n            try:\n                te = (self.headers.get(\"Transfer-Encoding\") or \"\").lower()\n                if \"chunked\" in te:\n                    return json.loads(self._read_chunked().decode(\"utf-8\") or \"{}\")\n                n = int(self.headers.get(\"Content-Length\", \"0\"))\n                return json.loads(self.rfile.read(n).decode(\"utf-8\") or \"{}\")\n            except Exception:\n                return {}\n        def do_GET(self):\n            if not self._lan(): return self._out(403, {\"error\": \"public access disabled\"})\n            p = self.path.split(\"?\")[0]\n            if p in (\"/health\", \"/\"):\n                return self._out(200, {\"ok\": True, \"service\": \"operit-gw\", \"port\": st.port, \"auth\": bool(st.key), \"public\": st.allow_public, \"pending\": len(st.pend), \"queued\": st.q.qsize()})\n            if p == \"/v1/models\":\n                return self._out(200, {\"object\": \"list\", \"data\": [{\"id\": \"operit-bridge\", \"object\": \"model\"}]})\n            return self._out(404, {\"error\": \"not found\"})\n        def do_POST(self):\n            ip = self.client_address[0]\n            if not self._lan():\n                wlog(\"GW 403-public \" + ip + \" \" + self.path)\n                return self._out(403, {\"error\": \"public access disabled\"})\n            p = self.path.split(\"?\")[0]\n            body = self._body()\n            if p.endswith(\"/log\"):\n                if not (ip.startswith(\"127.\") or ip in (\"::1\", \"localhost\")):\n                    wlog(\"GW 403-log \" + ip)\n                    return self._out(403, {\"error\": \"log only from localhost\"})\n                try:\n                    lines = body.get(\"lines\") or []\n                    if isinstance(lines, str): lines = [lines]\n                    with open(RTLOG, \"a\", encoding=\"utf-8\") as f:\n                        for ln in lines: f.write(str(ln) + \"\\n\")\n                except Exception:\n                    pass\n                trim_log()\n                return self._out(200, {\"errcode\": 0})\n            if not self._auth():\n                wlog(\"GW 401 \" + ip + \" \" + p)\n                return self._out(401, {\"error\": {\"message\": \"invalid api key\", \"type\": \"auth\"}})\n            if p.endswith(\"/chat/completions\"):\n                text = \"\"\n                imgs = []\n                for m in (body.get(\"messages\") or []):\n                    c = m.get(\"content\")\n                    if isinstance(c, str):\n                        if m.get(\"role\") == \"user\": text = c\n                        continue\n                    if not isinstance(c, list):\n                        continue\n                    tt = []\n                    for x in c:\n                        if not isinstance(x, dict):\n                            continue\n                        tp = x.get(\"type\") or \"\"\n                        if tp == \"text\":\n                            tt.append(str(x.get(\"text\") or \"\"))\n                        elif tp == \"image_url\":\n                            iu = x.get(\"image_url\")\n                            if isinstance(iu, dict): iu = iu.get(\"url\")\n                            if iu: imgs.append(str(iu))\n                        elif tp == \"input_image\" and x.get(\"image_url\"):\n                            imgs.append(str(x.get(\"image_url\")))\n                        elif tp in (\"file\", \"file_url\", \"input_file\", \"attachment\"):\n                            fu = x.get(tp) or x.get(\"file_url\") or x.get(\"url\")\n                            if isinstance(fu, dict): fu = fu.get(\"url\") or fu.get(\"file_url\")\n                            if fu: imgs.append(str(fu))\n                        elif tp == \"audio\" or tp == \"input_audio\":\n                            au = x.get(\"audio\") or x.get(\"input_audio\")\n                            if isinstance(au, dict): au = au.get(\"url\") or au.get(\"data\")\n                            if isinstance(au, str) and au:\n                                if au.startswith(\"http\") or au.startswith(\"data:\"):\n                                    imgs.append(au)\n                                else:\n                                    imgs.append(\"data:audio/wav;base64,\" + au)\n                    if m.get(\"role\") == \"user\":\n                        text = \"\".join(tt)\n                if imgs:\n                    rid0 = \"gw-\" + uuid.uuid4().hex[:16]\n                    paths = []\n                    for k, u in enumerate(imgs[:4]):\n                        pth = save_image(u, rid0 + \"_\" + str(k))\n                        paths.append(pth or \"[\u56fe\u7247\u4e0b\u8f7d\u5931\u8d25]\")\n                    ext = \"\\n\".join([\"[\u56fe\u7247] \" + p for p in paths])\n                    text = (text + \"\\n\" + ext) if text else ext\n                if not text: return self._out(400, {\"error\": {\"message\": \"empty message\"}})\n                rid = \"gw-\" + uuid.uuid4().hex[:16]\n                src = body.get(\"user\") or (\"port-%d\" % st.port)\n                q = queue.Queue()\n                with st.lock: st.pend[rid] = q\n                st.q.put({\"id\": rid, \"from\": src, \"text\": text})\n                wlog(\"GW QUEUE %s from=%s len=%d\" % (rid, src, len(text)))\n                t0 = time.time()\n                try:\n                    reply = q.get(timeout=int(body.get(\"timeout\", 120)))\n                except queue.Empty:\n                    with st.lock: st.pend.pop(rid, None)\n                    wlog(\"GW TIMEOUT %s %.1fs\" % (rid, time.time() - t0))\n                    return self._out(504, {\"error\": {\"message\": \"operit timeout\"}})\n                wlog(\"GW DONE %s %.1fs len=%d\" % (rid, time.time() - t0, len(reply or \"\")))\n                return self._out(200, {\"id\": \"chatcmpl-\" + rid, \"object\": \"chat.completion\", \"model\": body.get(\"model\") or \"operit-bridge\",\n                    \"choices\": [{\"index\": 0, \"message\": {\"role\": \"assistant\", \"content\": reply}, \"finish_reason\": \"stop\"}],\n                    \"usage\": {\"prompt_tokens\": 0, \"completion_tokens\": 0, \"total_tokens\": 0}})\n            if p.endswith(\"/getupdates\"):\n                msgs = []\n                while len(msgs) < 10:\n                    try: msgs.append(st.q.get_nowait())\n                    except queue.Empty: break\n                if msgs: wlog(\"GW PULL %d pending=%d\" % (len(msgs), len(st.pend)))\n                return self._out(200, {\"errcode\": 0, \"get_updates_buf\": str(st.port), \"msgs\": msgs})\n            if p.endswith(\"/sendmessage\"):\n                rid = body.get(\"reply_to\") or \"\"\n                with st.lock: q = st.pend.pop(rid, None)\n                if q: q.put(body.get(\"text\") or \"\")\n                wlog(\"GW PUSH %s delivered=%s len=%d\" % (rid, bool(q), len(body.get(\"text\") or \"\")))\n                return self._out(200, {\"errcode\": 0, \"delivered\": bool(q)})\n            return self._out(404, {\"errcode\": 404})\n    return H\n\ndef serve(cfg):\n    st = PortState(cfg[\"port\"], cfg.get(\"key\", \"\"), cfg.get(\"allow_public\", False))\n    srv = ThreadingHTTPServer((\"0.0.0.0\", st.port), make_handler(st))\n    print(\"gw listening %d key=%s public=%s\" % (st.port, bool(st.key), st.allow_public), flush=True)\n    wlog(\"GW LISTEN port=%d auth=%s public=%s\" % (st.port, bool(st.key), st.allow_public))\n    srv.serve_forever()\n\nif __name__ == \"__main__\":\n    ap = argparse.ArgumentParser()\n    ap.add_argument(\"--config\", default=\"\")\n    ap.add_argument(\"--port\", type=int, default=0)\n    ap.add_argument(\"--key\", default=\"\")\n    ap.add_argument(\"--allow-public\", action=\"store_true\")\n    a = ap.parse_args()\n    if a.config and os.path.exists(a.config):\n        cfgs = json.load(open(a.config, encoding=\"utf-8\"))\n    else:\n        cfgs = [{\"port\": a.port or 8789, \"key\": a.key, \"allow_public\": a.allow_public}]\n    print(\"gw started %d ports\" % len(cfgs), flush=True)\n    wlog(\"GW BOOT ports=%d\" % len(cfgs))\n    for c in cfgs:\n        t = threading.Thread(target=serve, args=(c,), daemon=True)\n        t.start()\n    threading.Event().wait()\n";
var GW_PATH = "/mnt/android/sdcard/Download/Operit/bridge_hub/gw.py";
var WXPOLL_SRC = "# -*- coding: utf-8 -*-\nimport json, time, os, threading\nimport urllib.request\n\nHUB = \"/storage/emulated/0/Download/Operit/bridge_hub\"\nINBOX = HUB + \"/wx_inbox.jsonl\"\nTYPING_DIR = HUB + \"/typing\"\nMEDIA_DIR = HUB + \"/media\"\nBUF_LOCK = threading.Lock()\nSEEN = set()\nSEEN_LOCK = threading.Lock()\nLANES = 3\nGAP = 6\nTK_MS = 1500\nTICKET = {}\nTK_LOCK = threading.Lock()\n\n\ndef wlog(m):\n    try:\n        with open(HUB + \"/wxpoll.log\", \"a\", encoding=\"utf-8\") as f:\n            f.write(time.strftime(\"%H:%M:%S \", time.localtime()) + str(m) + chr(10))\n    except Exception:\n        pass\n\n\ndef post(url, body, headers, timeout=40):\n    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method=\"POST\")\n    with urllib.request.urlopen(req, timeout=timeout) as r:\n        return json.loads(r.read().decode(\"utf-8\"))\n\n\ndef mid_of(m):\n    v = m.get(\"msg_id\")\n    if v:\n        return str(v)\n    try:\n        it = (m.get(\"item_list\") or [])[0]\n        if isinstance(it, dict) and it.get(\"msg_id\"):\n            return str(it[\"msg_id\"])\n    except Exception:\n        pass\n    return str(m.get(\"message_id\") or \"\")\n\n\ndef mx_headers(token):\n    return {\"Content-Type\": \"application/json\", \"Authorization\": \"Bearer \" + token,\n            \"AuthorizationType\": \"ilink_bot_token\", \"User-Agent\": \"operit-bridge-wxpoll\"}\n\n\ndef guess_ext(raw):\n    if not raw:\n        return \"\"\n    h = raw[:16]\n    if h[:3] == b\"\\xff\\xd8\\xff\":\n        return \".jpg\"\n    if h[:8] == b\"\\x89PNG\\r\\n\\x1a\\n\":\n        return \".png\"\n    if h[:6] in (b\"GIF87a\", b\"GIF89a\"):\n        return \".gif\"\n    if h[:4] == b\"RIFF\" and raw[8:12] == b\"WEBP\":\n        return \".webp\"\n    if h[:4] == b\"RIFF\" and raw[8:12] == b\"WAVE\":\n        return \".wav\"\n    if h[4:8] == b\"ftyp\":\n        return \".mp4\"\n    if h[:4] == b\"OggS\":\n        return \".ogg\"\n    if h[:3] == b\"ID3\":\n        return \".mp3\"\n    if h[:4] == b\"%PDF\":\n        return \".pdf\"\n    if h[:4] == b\"PK\\x03\\x04\":\n        return \".zip\"\n    if h[:2] == b\"BM\":\n        return \".bmp\"\n    if h[:2] == b\"AM\":\n        return \".amr\"\n    if h[:2] == b\"#!\":\n        return \".silk\"\n    return \"\"\n\n\ndef media_daemon():\n    try:\n        os.makedirs(MEDIA_DIR, exist_ok=True)\n    except Exception:\n        pass\n    while True:\n        try:\n            names = os.listdir(MEDIA_DIR) if os.path.isdir(MEDIA_DIR) else []\n        except Exception:\n            names = []\n        for fn in names:\n            if not fn.startswith(\"job_\") or not fn.endswith(\".json\"):\n                continue\n            jp = os.path.join(MEDIA_DIR, fn)\n            tag = fn[4:-5]\n            try:\n                job = json.load(open(jp, encoding=\"utf-8\"))\n            except Exception:\n                try:\n                    os.remove(jp)\n                except Exception:\n                    pass\n                continue\n            try:\n                req = urllib.request.Request(job[\"url\"])\n                req.add_header(\"User-Agent\", \"Mozilla/5.0\")\n                with urllib.request.urlopen(req, timeout=120) as r:\n                    cl = r.headers.get(\"Content-Length\")\n                    if cl and int(cl) > 67108864:\n                        raise Exception(\"file too large: \" + str(cl))\n                    chunks = []\n                    got = 0\n                    while True:\n                        part = r.read(262144)\n                        if not part:\n                            break\n                        got += len(part)\n                        if got > 67108864:\n                            raise Exception(\"file too large: \" + str(got))\n                        chunks.append(part)\n                    raw = b\"\".join(chunks)\n                kh = (job.get(\"key\") or \"\").strip()\n                if kh and len(kh) == 32:\n                    from Crypto.Cipher import AES\n                    from Crypto.Util.Padding import unpad\n                    raw = unpad(AES.new(bytes.fromhex(kh), AES.MODE_ECB).decrypt(raw), 16)\n                out_path = job[\"out\"]\n                if not os.path.splitext(out_path)[1]:\n                    out_path = out_path + guess_ext(raw)\n                with open(out_path, \"wb\") as f:\n                    f.write(raw)\n                with open(os.path.join(MEDIA_DIR, \"done_\" + tag + \".json\"), \"w\", encoding=\"utf-8\") as f:\n                    json.dump({\"ok\": True, \"path\": out_path}, f)\n                wlog(\"MEDIA_OK \" + out_path + \" \" + str(len(raw)))\n            except Exception as e:\n                try:\n                    with open(os.path.join(MEDIA_DIR, \"done_\" + tag + \".json\"), \"w\", encoding=\"utf-8\") as f:\n                        json.dump({\"ok\": False, \"err\": str(e)[:120]}, f)\n                except Exception:\n                    pass\n                wlog(\"MEDIA_ERR \" + str(e)[:120])\n            try:\n                os.remove(jp)\n            except Exception:\n                pass\n        time.sleep(0.3)\n\n\ndef get_ticket(name, token, base):\n    with TK_LOCK:\n        if name in TICKET:\n            return TICKET[name]\n    try:\n        d = json.load(open(HUB + \"/accounts/\" + name + \"/account.json\", encoding=\"utf-8\"))\n        uid = d.get(\"wechatUserId\") or \"\"\n        j = post(base + \"/ilink/bot/getconfig\",\n                 {\"ilink_user_id\": uid, \"context_token\": \"\", \"base_info\": {\"channel_version\": \"2.0.0\"}},\n                 mx_headers(token), 15)\n        tk = j.get(\"typing_ticket\") or \"\"\n        if tk:\n            with TK_LOCK:\n                TICKET[name] = tk\n        return tk\n    except Exception as e:\n        wlog(\"TK_ERR \" + name + \" \" + str(e)[:100])\n        return \"\"\n\n\ndef send_typing(name, token, base, status):\n    tk = get_ticket(name, token, base)\n    if not tk:\n        return False\n    try:\n        d = json.load(open(HUB + \"/accounts/\" + name + \"/account.json\", encoding=\"utf-8\"))\n        uid = d.get(\"wechatUserId\") or \"\"\n        post(base + \"/ilink/bot/sendtyping\",\n             {\"ilink_user_id\": uid, \"typing_ticket\": tk, \"status\": status,\n              \"base_info\": {\"channel_version\": \"2.0.0\"}}, mx_headers(token), 10)\n        return True\n    except Exception as e:\n        wlog(\"TP_ERR \" + name + \" s=\" + str(status) + \" \" + str(e)[:80])\n        return False\n\n\ndef typing_daemon():\n    active = {}\n    while True:\n        try:\n            names = os.listdir(TYPING_DIR) if os.path.isdir(TYPING_DIR) else []\n        except Exception:\n            names = []\n        now = time.time()\n        for fn in names:\n            if not fn.endswith(\".json\"):\n                continue\n            name = fn[:-5]\n            try:\n                age = now - os.path.getmtime(os.path.join(TYPING_DIR, fn))\n            except Exception:\n                age = 999\n            if age > 30:\n                try:\n                    os.remove(os.path.join(TYPING_DIR, fn))\n                except Exception:\n                    pass\n                if name in active:\n                    info = active.pop(name)\n                    send_typing(info[0], info[1], info[2], 2)\n                continue\n            if name in active:\n                info = active[name]\n                if now - info[3] >= TK_MS / 1000.0:\n                    send_typing(info[0], info[1], info[2], 1)\n                    active[name] = (info[0], info[1], info[2], now, info[4] + 1)\n            else:\n                try:\n                    d = json.load(open(HUB + \"/accounts/\" + name + \"/account.json\", encoding=\"utf-8\"))\n                    tok = d.get(\"wechatToken\") or d.get(\"token\") or \"\"\n                    base = (d.get(\"baseUrl\") or \"https://ilinkai.weixin.qq.com\").rstrip(\"/\")\n                except Exception:\n                    continue\n                if not tok:\n                    continue\n                send_typing(name, tok, base, 1)\n                active[name] = (name, tok, base, now, 1)\n        for name in list(active.keys()):\n            if name not in [x[:-5] for x in names if x.endswith(\".json\")]:\n                info = active.pop(name)\n                send_typing(info[0], info[1], info[2], 2)\n        time.sleep(0.4)\n\n\ndef poll(acc, lane):\n    name = acc.get(\"name\") or \"\"\n    token = acc.get(\"token\") or \"\"\n    base = (acc.get(\"baseUrl\") or \"https://ilinkai.weixin.qq.com\").rstrip(\"/\")\n    if not name or not token:\n        return\n    if lane > 0:\n        time.sleep(lane * GAP)\n    path = HUB + \"/accounts/\" + name + \"/sync_buf.txt\"\n    try:\n        buf = open(path, encoding=\"utf-8\").read().strip()\n    except Exception:\n        buf = \"\"\n    h = mx_headers(token)\n    wlog(\"LANE \" + name + \" #\" + str(lane) + \" START\")\n    while True:\n        try:\n            j = post(base + \"/ilink/bot/getupdates\", {\"get_updates_buf\": buf,\n                     \"base_info\": {\"channel_version\": \"2.0.0\"}}, h, 40)\n            nb = j.get(\"get_updates_buf\") or \"\"\n            if nb and nb != buf:\n                buf = nb\n                with BUF_LOCK:\n                    try:\n                        open(path, \"w\", encoding=\"utf-8\").write(nb)\n                    except Exception:\n                        pass\n            msgs = j.get(\"msgs\") or j.get(\"message_list\") or []\n            if msgs:\n                try:\n                    with open(INBOX, \"a\", encoding=\"utf-8\") as f:\n                        for m in msgs:\n                            _mid = mid_of(m)\n                            _dup = False\n                            if _mid:\n                                with SEEN_LOCK:\n                                    if _mid in SEEN:\n                                        _dup = True\n                                    else:\n                                        SEEN.add(_mid)\n                                        if len(SEEN) > 2000:\n                                            SEEN.clear()\n                            if _dup:\n                                continue\n                            f.write(json.dumps({\"acc\": name, \"m\": m}, ensure_ascii=False) + chr(10))\n                except Exception as e2:\n                    wlog(\"WRITE_ERR \" + str(e2)[:80])\n                wlog(\"GET \" + name + \" lane=\" + str(lane) + \" n=\" + str(len(msgs)))\n        except Exception as e:\n            wlog(\"ERR \" + name + \"#\" + str(lane) + \" \" + str(e)[:120])\n            time.sleep(3)\n\n\ndef main():\n    try:\n        os.makedirs(TYPING_DIR, exist_ok=True)\n        os.makedirs(MEDIA_DIR, exist_ok=True)\n    except Exception:\n        pass\n    threading.Thread(target=typing_daemon, daemon=True).start()\n    threading.Thread(target=media_daemon, daemon=True).start()\n    try:\n        cfgs = json.load(open(HUB + \"/wxpoll_cfg.json\", encoding=\"utf-8\"))\n    except Exception as e:\n        wlog(\"NO_CFG \" + str(e)[:100])\n        cfgs = []\n    for acc in cfgs:\n        for lane in range(LANES):\n            threading.Thread(target=poll, args=(acc, lane), daemon=True).start()\n    wlog(\"STARTED\")\n    while True:\n        time.sleep(60)\n\n\nif __name__ == \"__main__\":\n    main()\n";
var WXPOLL_PATH = "/mnt/android/sdcard/Download/Operit/bridge_hub/wxpoll.py";
var WX_INBOX = HUB + "wx_inbox.jsonl";
var __inboxOff = 0;
var __wxPollStarted = false;
async function ensureWxPoll() {
    if (__wxPollStarted) return;
    try {
        var list = [];
        for (var i = 0; i < (state.accounts || []).length; i++) {
            var sl = state.accounts[i];
            var rt = sl && sl.runtime;
            if (!rt || !rt.token) continue;
            if (sl.cfg && sl.cfg.channel === "http") continue;
            list.push({ name: rt.name, token: rt.token, baseUrl: rt.baseUrl });
        }
        if (!list.length) return;
        await writeFile(HUB + "wxpoll_cfg.json", JSON.stringify(list));
        await writeFile(WXPOLL_PATH, WXPOLL_SRC);
        await __termExec("cd /storage/emulated/0/Download/Operit/bridge_hub && if [ -f wxpoll.pid ] && kill -0 $(cat wxpoll.pid) 2>/dev/null; then kill $(cat wxpoll.pid) 2>/dev/null; fi; sleep 1; rm -f wx_inbox.jsonl wxpoll.pid; rm -rf typing; mkdir -p typing; (setsid nohup python3 wxpoll.py >> wxpoll.log 2>&1 & echo $! > wxpoll.pid); sleep 1; echo WXPOLL_SPAWNED $(cat wxpoll.pid)");
        __wxPollStarted = true;
        __inboxOff = 0;
        await rlog("WXPOLL_START n=" + list.length);
    } catch (e) { await rlog("WXPOLL_ERR " + errText(e)); }
}
async function wxInboxTick() {
    try {
        var txt = await readFile(WX_INBOX);
        if (!txt) return;
        if (txt.length < __inboxOff) __inboxOff = 0;
        if (txt.length <= __inboxOff) return;
        var chunk = txt.slice(__inboxOff);
        __inboxOff = txt.length;
        var lines = chunk.split(String.fromCharCode(10));
        for (var li = 0; li < lines.length; li++) {
            var ln = lines[li].trim();
            if (!ln) continue;
            var o = null;
            try { o = JSON.parse(ln); } catch (e0) { continue; }
            var rt2 = state.wxRuntime && state.wxRuntime[o.acc];
            if (!rt2) continue;
            try { await wxHandle(rt2, state.gen, o.m); } catch (e1) { await rlog("WX_INBOX_ERR " + errText(e1)); }
        }
        if (__inboxOff > 200000) { try { await writeFile(WX_INBOX, ""); __inboxOff = 0; } catch (e2) { } }
        __maybeCleanMedia();
    } catch (e) { }
}

async function __termExec(cmd) {
    var T = (typeof Tools !== "undefined" && Tools && Tools.System) ? Tools.System.terminal : null;
    if (!T) { await rlog("NO_TERMINAL_API"); return null; }
    try {
        if (!state.sid) {
            state.termGen = (state.termGen || 0) + 1;
            var nm = "bridge_hub" + (state.termGen > 1 ? "_g" + state.termGen : "");
            var c = await T.create(nm);
            state.sid = (c && (c.sessionId || c.id)) || null;
            if (!state.sid) throw new Error("CREATE_NO_SESSION");
        }
        var r = await T.exec(state.sid, String(cmd));
        if (r && r.timedOut) throw new Error("TERM_TIMEOUT");
        return r || { output: "" };
    } catch (e) {
        state.sid = null;
        await rlog("TERM_ERR " + errText(e));
        return null;
    }
}
async function ensureGateway() {
    var ports = [];
    try {
        var cfg = state.cfg || state.cfgOverride || {};
        for (var i = 0; i < (cfg.accounts || []).length; i++) {
            var a = cfg.accounts[i];
            if (a.channel !== "http" || a.enabled === false || !a.port) continue;
            ports.push({ port: Number(a.port), key: a.token || "", allow_public: !!a.allowPublic });
        }
    } catch (e) {}
    if (!ports.length) { await rlog("GW_NO_PORTS"); return; }

    var want = JSON.stringify(ports);
    var curTxt = "";
    try { curTxt = await readFile(HUB + "gw_ports.json"); } catch (e) {}
    var same = false;
    try { same = (JSON.stringify(JSON.parse(curTxt)) === want); } catch (e) { same = false; }

    var alive = 0;
    for (var pi = 0; pi < ports.length; pi++) {
        try {
            var r = await Tools.Net.http({ url: "http://127.0.0.1:" + ports[pi].port + "/health", method: "GET", connect_timeout: 2, read_timeout: 2, responseType: "text" });
            if (r && r.statusCode === 200) alive++;
        } catch (e) {}
    }
    var _curGw = "";
    try { _curGw = await readFile(GW_PATH); } catch (eG) { }
    await rlog("GW_CHECK cur=" + String(_curGw || "").length + " want=" + GW_SRC.length);
    try {
        await writeFile(GW_PATH, GW_SRC);
        var _cp = await __termExec("echo U1JDPS9kYXRhL2RhdGEvYXBwLm9wZXJpdC9maWxlcy9ydW50aW1lL2lkZW50aXRpZXM7IEY9JChmaW5kICRTUkMgLXBhdGggKi9wbHVnaW5zL2RhdGEvYnJpZGdlX2h1Yi9ndy5weSAyPi9kZXYvbnVsbCB8IGhlYWQgLTEpOyBpZiBbIC1mICRGIF07IHRoZW4gY3AgLWYgJEYgL3N0b3JhZ2UvZW11bGF0ZWQvMC9Eb3dubG9hZC9PcGVyaXQvYnJpZGdlX2h1Yi9ndy5weSAmJiBlY2hvIEdXX0NQX09LOyBlbHNlIGVjaG8gR1dfQ1BfTk9TUkM7IGZp | base64 -d | sh");
        await rlog("GW_SYNC " + String((_cp && _cp.output) || "-").trim().slice(0, 40));
    } catch (eW2) { await rlog("GW_SYNC_ERR " + errText(eW2)); }
    if (same && alive === ports.length) { await rlog("GW_ALIVE " + ports.length); return; }

    await writeFile(HUB + "gw_ports.json", want);
    try { await __termExec("cd /storage/emulated/0/Download/Operit/bridge_hub && if [ -f gw.pid ] && kill -0 $(cat gw.pid) 2>/dev/null; then kill $(cat gw.pid) 2>/dev/null; fi; sleep 1; rm -f gw.pid"); } catch (e) {}

    if (_curGw !== GW_SRC) { await writeFile(GW_PATH, GW_SRC); }

    try {
        var sp = await __termExec("cd /storage/emulated/0/Download/Operit/bridge_hub && (setsid nohup python3 gw.py --config gw_ports.json >> gw.log 2>&1 & echo $! > gw.pid); sleep 2; echo GW_SPAWNED $(cat gw.pid 2>/dev/null)");
        await rlog("GW_SPAWN " + String((sp && sp.output) || "-").trim().slice(0, 60));
    } catch (e2) { await rlog("GW_SPAWN_ERR " + errText(e2)); }
    try {
        var hz = await Tools.Net.http({ url: "http://127.0.0.1:" + ports[0].port + "/health", method: "GET", connect_timeout: 3, read_timeout: 3, responseType: "text" });
        await rlog("GW_HEALTH " + (hz ? hz.statusCode : "-"));
    } catch (e3) { await rlog("GW_HEALTH_ERR " + errText(e3)); }
}

async function restore() {
    try { ensureIpc(); } catch (eIr) { }
    try {
        if (state.running) return;
        var cfg = state.cfgOverride ? state.cfgOverride : normalize(await loadJson(CFG_PATH, DEFAULT_CFG));
        state.cfgOverride = cfg;
        state.running = true; state.gen++;
        var gen = state.gen;
        await loadSeen();
        try { await ensureGateway(); }
        catch (eG) { try { await writeFile(HUB + "boot_err.txt", "GW: " + String(eG && (eG.stack || eG.message) || eG)); } catch (eW) {} }
        state.accounts = [];
        for (var i = 0; i < cfg.accounts.length; i++) (function () {
            var c = cfg.accounts[i]; if (c.enabled === false) return;
            state.accounts.push({ cfg: c });
        })();
        await rlog("START gen=" + gen + " accounts=" + state.accounts.length);
        for (var j = 0; j < state.accounts.length; j++) {
            var acc = state.accounts[j];
            try {
                var ch = acc.cfg.channel || "wechat";
                try {
                    var _ajR = await readJsonSafe(HUB + "accounts/" + acc.cfg.name + "/account.json", {});
                    if (_ajR && _ajR.type) { var _wantR = cfgChannel(_ajR.type); if (_wantR !== ch) { ch = _wantR; acc.cfg.channel = _wantR; await rlog("CH_FIX " + acc.cfg.name + " -> " + _wantR); } }
                } catch (eF) {}
                if (ch === "http") await startHttp(acc, gen);
                else if (ch === "wechat") await startWechat(acc, gen);
                else if (ch === "qq") await startQQ(acc, gen);
                else await rlog("CH_UNSUPPORTED " + (acc.cfg.name || "?") + " channel=" + ch);
            } catch (e) { await rlog("ACC_ERR " + (acc.cfg && acc.cfg.name) + " " + errText(e)); }
        }
    } catch (e) { await rlog("RESTORE_ERR " + errText(e)); }
}

function stop(killGateway) {
    state.running = false; state.gen++;
    for (var i = 0; i < state.accounts.length; i++) {
        var a = state.accounts[i];
        if (a.runtime) a.runtime.running = false;
    }
    state.accounts = [];
    if (killGateway) { __wxPollStarted = false; try { void __termExec("cd /storage/emulated/0/Download/Operit/bridge_hub && if [ -f wxpoll.pid ] && kill -0 $(cat wxpoll.pid) 2>/dev/null; then kill $(cat wxpoll.pid) 2>/dev/null; fi; rm -f wxpoll.pid"); } catch (eKw) { } try { void __termExec("cd /storage/emulated/0/Download/Operit/bridge_hub && if [ -f gw.pid ] && kill -0 $(cat gw.pid) 2>/dev/null; then kill $(cat gw.pid) 2>/dev/null; fi; rm -f gw.pid"); } catch (e) {} }
    void rlog("STOP");
}


async function statusSnapshot() {
    var cfg = state.cfg || state.cfgOverride || await loadJson(CFG_PATH, DEFAULT_CFG);
    var names = await indexList();
    var runTable = await readJsonSafe(RUN_PATH, {});
    var seen = {};
    for (var i = 0; i < names.length; i++) seen[names[i]] = 1;
    for (var j = 0; j < (cfg.accounts || []).length; j++) {
        var n = cfg.accounts[j] && cfg.accounts[j].name;
        if (n && !seen[n]) { seen[n] = 1; names.push(n); }
    }
    var list = [];
    for (var k = 0; k < names.length; k++) {
        var nm = names[k];
        var aj = await readJsonSafe(HUB + "accounts/" + nm + "/account.json", {});
        var bj = await readJsonSafe(HUB + "accounts/" + nm + "/binding.json", {});
        var ce = null;
        for (var m = 0; m < (cfg.accounts || []).length; m++) { if (cfg.accounts[m].name === nm) { ce = cfg.accounts[m]; break; } }
        var type = acctType(aj, ce);
        var slot = null;
        for (var r = 0; r < state.accounts.length; r++) { var cand = state.accounts[r]; if (cand && cand.cfg && cand.cfg.name === nm) { slot = cand; break; } }
        var rt = slot && slot.runtime;
        var running = !!(rt && rt.running) || !!(runTable[nm] && (Date.now() - Number(runTable[nm]) < 300000));
        var tok = (ce && ce.token) || aj.token || aj.wechatToken || "";
        list.push({
            name: nm, type: type,
            chatId: (rt && rt.chatId) || bj.chatId || (ce && ce.chatId) || "",
            chatTitle: bj.chatTitle || "",
            enabled: bj.enabled !== false && !(ce && ce.enabled === false),
            running: running,
            state: running ? (type === "wechat" ? "轮询中" : (type === "public" ? "网关中" : "运行中")) : "未启动",
            port: (ce && ce.port) || aj.port || "",
            allowPublic: !!(ce && ce.allowPublic) || !!aj.allowPublic,
            baseUrl: (ce && ce.baseUrl) || aj.baseUrl || "",
            hasToken: !!tok,
            appSecretSet: !!aj.appSecret,
            tokenReady: !!tok,
            wechatTokenPreview: tok ? (String(tok).slice(0, 6) + "…" + String(tok).slice(-4)) : "",
            wechatAccountId: aj.wechatAccountId || "",
            wechatUserId: aj.wechatUserId || "",
            appId: aj.appId || "",
            accessTokenPreview: tok ? (String(tok).slice(0, 6) + "…" + String(tok).slice(-4)) : "",
            tokenLen: tok ? String(tok).length : 0,
            tokenFull: (type === "public" ? tok : ""),
            token: tok ? (String(tok).slice(0, 6) + "…" + String(tok).slice(-4)) : ""
        });
    }
    return { running: state.running, gen: state.gen, accountCount: list.length, indexList: names,
        uiKind: __UI_KIND, uiKeys: __UI_KEYS, uiHasDefault: __UI_HAS_DEFAULT, uiErr: __UI_ERR,
        uiKeysRuntime: state.uiKeys || "",
        received: state.received, replied: state.replied, accounts: list,
        io: state.io || "-", ioErr: state.ioErr || "",
        logLines: state.logLines.length, logs: state.logLines.slice(-40),
        lastLog: state.logLines.slice(-3).join("\n") };
}

var QR_SRC = "import sys, json, base64, io\nimport segno\n\n# 目标像素尺寸：与 UI 里 WebView 的可用宽度匹配，避免被裁切\nTARGET_PX = 600\n\nargfile = sys.argv[1]\ntext = io.open(argfile, encoding='utf-8').read().strip()\nif not text:\n    print(json.dumps({\"success\": False, \"error\": \"empty\"}))\n    sys.exit(0)\n\nqr = segno.make(text, error='m')\n\ndef png_with_target(qr, target=TARGET_PX, border=2):\n    # segno 的 scale 是每个模块的像素数；先按 scale=1 估算模块数，再反推 scale\n    n = qr.symbol_size(scale=1, border=border)[0]\n    if not n or n <= 0:\n        n = 40\n    scale = max(2, int(target / float(n)))\n    buf = io.BytesIO()\n    qr.save(buf, kind='png', scale=scale, border=border)\n    return buf.getvalue(), n, scale\n\n# 优先 PNG\ntry:\n    png, n, scale = png_with_target(qr)\n    b64 = base64.b64encode(png).decode('ascii')\n    print(json.dumps({\n        \"success\": True,\n        \"data_uri\": \"data:image/png;base64,\" + b64,\n        \"fmt\": \"png\",\n        \"modules\": n,\n        \"scale\": scale,\n        \"px\": n * scale\n    }))\n    sys.exit(0)\nexcept Exception as e:\n    png_err = str(e)\n\n# 回退 SVG\ntry:\n    buf2 = io.BytesIO()\n    qr.save(buf2, kind='svg', scale=6, border=2)\n    svg = buf2.getvalue().decode('utf-8')\n    b64 = base64.b64encode(svg.encode('utf-8')).decode('ascii')\n    print(json.dumps({\"success\": True, \"data_uri\": \"data:image/svg+xml;base64,\" + b64, \"fmt\": \"svg\", \"png_error\": png_err}))\n    sys.exit(0)\nexcept Exception as e2:\n    print(json.dumps({\"success\": False, \"error\": \"png:\" + png_err + \" svg:\" + str(e2)}))";
var VER = "1.3.18";

async function readJsonSafe(p, def) { try { var t = await readFile(p); if (!t) return def; return JSON.parse(t); } catch (e) { return def; } }
async function writeJson(p, obj) { return await writeFile(p, JSON.stringify(obj, null, 2)); }
async function indexList() { var d = await readJsonSafe(HUB + "accounts/index.json", { list: [] }); return Array.isArray(d.list) ? d.list : []; }
async function setIndex(list) { return await writeJson(HUB + "accounts/index.json", { list: list }); }
function acctType(aj, ce) {
    var t = (aj && aj.type) || "";
    if (t) return t === "http" ? "public" : t;
    var ch = ce && ce.channel;
    if (ch === "http" || ch === "public") return "public";
    if (ch === "qq") return "qq";
    return "wechat";
}
function cfgChannel(type) { return type === "public" ? "http" : (type === "qq" ? "qq" : "wechat"); }
async function cfgOf(name) {
    var cfg = state.cfg || state.cfgOverride || normalize(await loadJson(CFG_PATH, DEFAULT_CFG));
    for (var i = 0; i < (cfg.accounts || []).length; i++) if (cfg.accounts[i].name === name) return cfg.accounts[i];
    return null;
}
async function putCfg(name, patch) {
    var cfg = normalize(await loadJson(CFG_PATH, DEFAULT_CFG));
    var hit = null;
    for (var i = 0; i < cfg.accounts.length; i++) if (cfg.accounts[i].name === name) { hit = cfg.accounts[i]; break; }
    if (!hit) {
        var _ajP = await readJsonSafe(HUB + "accounts/" + name + "/account.json", {});
        var _chP = (_ajP && _ajP.type) ? cfgChannel(_ajP.type) : "wechat";
        if (patch && patch.channel) _chP = patch.channel;
        hit = { name: name, channel: _chP, enabled: true, chatId: "" };
        cfg.accounts.push(hit);
    }
    for (var k in patch) hit[k] = patch[k];
    await writeJson(CFG_PATH, cfg);
    state.cfgOverride = cfg; state.cfg = cfg;
    return hit;
}
async function rmCfg(name) {
    var cfg = normalize(await loadJson(CFG_PATH, DEFAULT_CFG));
    var out = [];
    for (var i = 0; i < cfg.accounts.length; i++) if (cfg.accounts[i].name !== name) out.push(cfg.accounts[i]);
    cfg.accounts = out;
    await writeJson(CFG_PATH, cfg);
    state.cfgOverride = cfg; state.cfg = cfg;
}
async function reload() { stop(); await sleep(200); await restore(); }
async function startOne(name) {
    for (var s0 = 0; s0 < state.accounts.length; s0++) {
        var ex0 = state.accounts[s0];
        if (ex0 && ex0.cfg && ex0.cfg.name === name && ex0.runtime && ex0.runtime.running) return true;
    }
    var cfg = normalize(await loadJson(CFG_PATH, DEFAULT_CFG));
    var ce = null;
    for (var i = 0; i < cfg.accounts.length; i++) if (cfg.accounts[i].name === name) { ce = cfg.accounts[i]; break; }
    if (!ce) return false;
    var gen = state.gen;
    var slot = { cfg: ce };
    state.accounts.push(slot);
    try {
        if (ce.channel === "http") await startHttp(slot, gen);
        else if (ce.channel === "wechat") await startWechat(slot, gen);
        else if (ce.channel === "qq") await startQQ(slot, gen);
        else { await rlog("CH_UNSUPPORTED " + name + " channel=" + ce.channel); return false; }
    } catch (e) { await rlog("ACC_ERR " + name + " " + errText(e)); return false; }
    return true;
}
async function stopOne(name) {
    for (var i = 0; i < state.accounts.length; i++) {
        var a = state.accounts[i];
        if (a && a.cfg && a.cfg.name === name) { if (a.runtime) a.runtime.running = false; state.accounts.splice(i, 1); await markRun(name, false); return true; }
    }
    return false;
}
function pushEvent(name, id, from, text) {
    if (!state.msgs[name]) state.msgs[name] = [];
    state.msgs[name].push({ msg_id: id, from: from, text: text, at: Date.now() });
    if (state.msgs[name].length > 30) state.msgs[name].shift();
}
async function genQr(text) {
    try {
        await writeFile(HUB + "qr_in.json", JSON.stringify({ text: String(text) }));
        await writeFile(HUB + "core/scripts/qrgen.py", QR_SRC);
        var r = await __termExec("cd /storage/emulated/0/Download/Operit/bridge_hub && python3 core/scripts/qrgen.py qr_in.json 2>/dev/null | tail -1");
        var out = String((r && r.output) || "").trim();
        var j = JSON.parse(out);
        return j;
    } catch (e) { var __m = errText(e); if (__m.indexOf("executing") >= 0) __m = "目标对话正在执行中，请等空闲后再试"; return { success: false, error: __m }; }
}

var B64C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64bytes(arr) {
    var out = "", i = 0;
    while (i < arr.length) {
        var b0 = arr[i++], b1 = i < arr.length ? arr[i++] : NaN, b2 = i < arr.length ? arr[i++] : NaN;
        var n = (b0 << 16) | ((isNaN(b1) ? 0 : b1) << 8) | (isNaN(b2) ? 0 : b2);
        out += B64C.charAt((n >> 18) & 63) + B64C.charAt((n >> 12) & 63);
        out += isNaN(b1) ? "=" : B64C.charAt((n >> 6) & 63);
        out += isNaN(b2) ? "=" : B64C.charAt(n & 63);
    }
    return out;
}
function wxUin() {
    var r = Math.floor(Math.random() * 0xffffffff);
    return b64bytes([(r >> 24) & 255, (r >> 16) & 255, (r >> 8) & 255, r & 255]);
}
async function qrWatchLoop(accName, qid) {
    for (var qi = 0; qi < 90; qi++) {
        var stq2 = null;
        try {
            stq2 = await wxApi("ilink/bot/get_qrcode_status?qrcode=" + encodeURIComponent(qid), "", 20);
        } catch (eW) { stq2 = null; }
        if (stq2 && stq2.status === "confirmed" && stq2.bot_token) {
            try {
                var pA = HUB + "accounts/" + accName + "/account.json";
                var cA = await readJsonSafe(pA, { type: "wechat" });
                cA.type = "wechat";
                cA.token = stq2.bot_token;
                cA.baseUrl = stq2.baseurl || "https://ilinkai.weixin.qq.com";
                cA.wechatAccountId = stq2.ilink_bot_id || "";
                cA.wechatUserId = stq2.ilink_user_id || "";
                cA.savedAt = new Date().toISOString();
                await writeJson(pA, cA);
                await putCfg(accName, { channel: "wechat" });
                await rlog("QR_AUTO_CONFIRMED acc=" + accName + " tokenLen=" + String(stq2.bot_token).length);
                await stopOne(accName);
                await startOne(accName);
            } catch (eS) { await rlog("QR_AUTO_SAVE_ERR " + errText(eS)); }
            return;
        }
        if (stq2 && stq2.status === "expired") { await rlog("QR_AUTO_EXPIRED acc=" + accName); return; }
        await sleep(1500);
    }
    await rlog("QR_WATCH_TIMEOUT acc=" + accName);
}

async function wxApi(path, token, timeout) {
    var r = await Tools.Net.http({
        url: "https://ilinkai.weixin.qq.com/" + path,
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + (token || ""),
            "AuthorizationType": "ilink_bot_token",
            "X-WECHAT-UIN": wxUin()
        },
        connect_timeout: 10,
        read_timeout: timeout || 15,
        responseType: "text"
    });
    var code = r && r.statusCode;
    if (!(code >= 200 && code < 300)) throw new Error("HTTP " + code + " " + String((r && r.content) || "").slice(0, 120));
    var txt = String((r && r.content) || "");
    if (!txt.trim()) throw new Error("空响应");
    return JSON.parse(txt);
}
async function firstWechatAccount() {
    var names = await indexList();
    for (var i = 0; i < names.length; i++) {
        var aj = await readJsonSafe(HUB + "accounts/" + names[i] + "/account.json", {});
        if (acctType(aj, null) === "wechat") return names[i];
    }
    return names.length ? names[0] : "";
}

var RUN_PATH = HUB + "run_state.json";
var __runQ = Promise.resolve();
function markRun(name, on) {
    __runQ = __runQ.then(async function () {
        try {
            var tbl = await readJsonSafe(RUN_PATH, {});
            tbl[name] = on ? Date.now() : 0;
            await writeJson(RUN_PATH, tbl);
        } catch (e) {}
    });
    return __runQ;
}

var TRASH_DIR = HUB + "accounts/.trash/";
var TRASH_IDX = TRASH_DIR + "index.json";
async function trashLoad() { var a = await readJsonSafe(TRASH_IDX, []); return Array.isArray(a) ? a : []; }
async function trashSave(a) { return await writeJson(TRASH_IDX, a); }
async function softDelete(name, type, extra) {
    try { await Tools.Files.mkdir(TRASH_DIR); } catch (e) {}
    var dir = name + "-" + Date.now();
    var moved = false;
    try { await Tools.Files.move(HUB + "accounts/" + name, TRASH_DIR + dir); moved = true; }
    catch (eM) {
        try { await __termExec("mv /storage/emulated/0/Download/Operit/bridge_hub/accounts/" + name + " /storage/emulated/0/Download/Operit/bridge_hub/accounts/.trash/" + dir); moved = true; } catch (e2) {}
    }
    if (!moved) return false;
    var arr = await trashLoad();
    var rec = { dir: dir, name: name, type: type, deletedAt: Date.now() };
    if (extra) { for (var k in extra) rec[k] = extra[k]; }
    arr.push(rec); await trashSave(arr);
    return true;
}

async function collectSeeds(cfg) {
    var seeds = {};
    var list = (cfg && cfg.accounts) || [];
    for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (!a || a.channel === "http") continue;
        seeds[a.name] = {
            account: await readFile(HUB + "accounts/" + a.name + "/account.json"),
            binding: await readFile(HUB + "accounts/" + a.name + "/binding.json"),
            sync: await readFile(HUB + "accounts/" + a.name + "/sync_buf.txt")
        };
    }
    return seeds;
}

async function handleTool(name, p) {
    var full = String(name || "");
    var short = full.indexOf(":") >= 0 ? full.split(":").pop() : full;
    p = p || {};
    try {
        if (short === "bridge_status") { var st = await statusSnapshot(); st.success = true; st.ver = VER; return st; }
        if (short === "bridge_clip") {
            var _t = String((p && p.text) || "");
            if (!_t) return { success: false, error: "空内容" };
            try {
                var _b = b64bytes(Array.prototype.slice.call(new TextEncoder().encode(_t)));
                await __termExec("echo '" + _b + "' | base64 -d > /data/local/tmp/_clip.txt && cmd clipboard set-text $(cat /data/local/tmp/_clip.txt) 2>/dev/null; rm -f /data/local/tmp/_clip.txt");
                return { success: true };
            } catch (e) { var __m = errText(e); if (__m.indexOf("executing") >= 0) __m = "目标对话正在执行中，请等空闲后再试"; return { success: false, error: __m }; }
        }
        if (short === "trash_list") {
            var tl = await trashLoad();
            return { success: true, items: tl, accounts: (await statusSnapshot()).accounts };
        }
        if (short === "trash_restore") {
            var dirs = Array.isArray(p.dirs) ? p.dirs : String(p.dirs || "").split(",").filter(Boolean);
            if (!dirs.length) return { success: false, error: "请先勾选" };
            var ta = await trashLoad(); var done = []; var renamed = [];
            for (var ti = 0; ti < ta.length; ti++) {
                var rec = ta[ti];
                if (dirs.indexOf(rec.dir) < 0) continue;
                var target = rec.name;
                var ex0 = false;
                try { ex0 = await Tools.Files.exists(HUB + "accounts/" + target); } catch (eX0) { ex0 = false; }
                if (ex0) {
                    for (var n2 = 1; n2 < 100; n2++) {
                        target = rec.name + " (" + n2 + ")";
                        var ex1 = false;
                        try { ex1 = await Tools.Files.exists(HUB + "accounts/" + target); } catch (eX1) { ex1 = false; }
                        if (!ex1) break;
                    }
                }
                try { await Tools.Files.move(TRASH_DIR + rec.dir, HUB + "accounts/" + target); } catch (eR) {
                    try { await __termExec("mv /storage/emulated/0/Download/Operit/bridge_hub/accounts/.trash/" + rec.dir + " /storage/emulated/0/Download/Operit/bridge_hub/accounts/" + target); } catch (eR2) { continue; }
                }
                try {
                    var aj9 = await readJsonSafe(HUB + "accounts/" + target + "/account.json", {});
                    if (aj9 && typeof aj9 === "object") { aj9.name = target; await writeJson(HUB + "accounts/" + target + "/account.json", aj9); }
                } catch (eN) { }
                var ix9 = await indexList(); if (ix9.indexOf(target) < 0) { ix9.push(target); await setIndex(ix9); }
                var patch9 = { channel: cfgChannel(rec.type || "wechat"), enabled: true };
                if (rec.chatId) patch9.chatId = rec.chatId;
                if (rec.port) patch9.port = rec.port;
                await putCfg(target, patch9);
                ta.splice(ti, 1); ti--;
                done.push(target);
                if (target !== rec.name) renamed.push(rec.name + " → " + target);
            }
            await trashSave(ta);
            void reload();
            return { success: done.length > 0, restored: done, renamed: renamed, items: ta, accounts: (await statusSnapshot()).accounts };
        }
        if (short === "trash_purge") {
            var dirs2 = Array.isArray(p.dirs) ? p.dirs : String(p.dirs || "").split(",").filter(Boolean);
            if (!dirs2.length) return { success: false, error: "请先勾选" };
            var tb = await trashLoad(); var left = []; var gone = [];
            for (var tj = 0; tj < tb.length; tj++) {
                var r2 = tb[tj];
                if (dirs2.indexOf(r2.dir) < 0) { left.push(r2); continue; }
                var full = "/storage/emulated/0/Download/Operit/bridge_hub/accounts/.trash/" + r2.dir;
                try { await Tools.Files.deleteFile(full); } catch (e1) { try { await Tools.Files.delete(full); } catch (e2) { void __termExec("rm -rf " + full); } }
                gone.push(r2.name);
            }
            await trashSave(left);
            return { success: true, purged: gone, items: left };
        }
        if (short === "bridge_log") {
            var actL = String(p.action || "");
            if (actL === "clear") {
                try { await writeFile(HUB + "rt.log", ""); } catch (eL) { }
                state.logLines = [];
                return { success: true, cleared: true };
            }
            return { success: false, error: "unknown action" };
        }
        if (short === "bridge_ui") { state.uiKeys = String((p && p.keys) || ""); await rlog("UI_KEYS " + state.uiKeys.slice(0, 200)); return { success: true }; }

        if (short === "bridge_accounts") {
            var action = String(p.action || "list");
            var nm = String(p.account || "");
            var type = String(p.type || "wechat");
            if (action === "add") {
                if (!nm) return { success: false, error: "缺少 account" };
                var _exist = await readJsonSafe(HUB + "accounts/" + nm + "/account.json", null);
                if (_exist) return { success: false, error: "账号已存在：" + nm };
                var _existBind = await readJsonSafe(HUB + "accounts/" + nm + "/binding.json", null);
                if (_existBind) return { success: false, error: "账号目录已存在：" + nm };
                var usePort = 0;
                if (type === "public") {
                    var used0 = {};
                    var cfgs0 = normalize(await loadJson(CFG_PATH, DEFAULT_CFG));
                    for (var u0 = 0; u0 < cfgs0.accounts.length; u0++) { var pp0 = Number(cfgs0.accounts[u0].port || 0); if (pp0) used0[pp0] = 1; }
                    usePort = 8789; while (used0[usePort]) usePort++;
                }
                await writeJson(HUB + "accounts/" + nm + "/account.json", { type: type, createdAt: Date.now(), port: usePort });
                await writeJson(HUB + "accounts/" + nm + "/binding.json", { chatId: "", chatTitle: "", enabled: true });
                var ix = await indexList(); if (ix.indexOf(nm) < 0) ix.push(nm);
                await setIndex(ix);
                var patch0 = { channel: cfgChannel(type), enabled: true };
                if (usePort) { patch0.port = usePort; patch0.baseUrl = "http://127.0.0.1:" + usePort; }
                await putCfg(nm, patch0);
                void reload();
                var st2 = await statusSnapshot(); st2.success = true; return st2;
            }
            if (action === "remove") {
                var ix2 = await indexList(); var o = [];
                for (var i = 0; i < ix2.length; i++) if (ix2[i] !== nm) o.push(ix2[i]);
                await setIndex(o); await rmCfg(nm); await stopOne(nm);
                var _aj = await readJsonSafe(HUB + "accounts/" + nm + "/account.json", {});
                var _ce = await cfgOf(nm);
                await softDelete(nm, acctType(_aj, _ce), { chatId: (_ce && _ce.chatId) || "", port: (_ce && _ce.port) || 0 });
                void reload();
                var st3 = await statusSnapshot(); st3.success = true; return st3;
            }
            if (action === "rename") {
                var nn = String(p.new_name || "");
                if (!nn) return { success: false, error: "缺少 new_name" };
                var _dup = await readJsonSafe(HUB + "accounts/" + nn + "/account.json", null);
                if (_dup) return { success: false, error: "目标账号已存在：" + nn };
                var ix3 = await indexList();
                for (var q = 0; q < ix3.length; q++) if (ix3[q] === nm) ix3[q] = nn;
                await setIndex(ix3);
                try { void __termExec("cd /storage/emulated/0/Download/Operit/bridge_hub/accounts && mv " + nm + " " + nn); } catch (e) {}
                var ce0 = await cfgOf(nm);
                var keep = { channel: (ce0 && ce0.channel) || "wechat", enabled: !(ce0 && ce0.enabled === false) };
                if (ce0 && ce0.chatId) keep.chatId = ce0.chatId;
                if (ce0 && ce0.port) keep.port = ce0.port;
                if (ce0 && ce0.token) keep.token = ce0.token;
                if (ce0 && ce0.baseUrl) keep.baseUrl = ce0.baseUrl;
                await stopOne(nm); await rmCfg(nm); await putCfg(nn, keep);
                void reload();
                var st4 = await statusSnapshot(); st4.success = true; return st4;
            }
            if (action === "enable" || action === "disable") {
                var bj = await readJsonSafe(HUB + "accounts/" + nm + "/binding.json", {});
                bj.enabled = action === "enable";
                await writeJson(HUB + "accounts/" + nm + "/binding.json", bj);
                await putCfg(nm, { enabled: bj.enabled });
                if (bj.enabled) await startOne(nm); else await stopOne(nm);
                var st5 = await statusSnapshot(); st5.success = true; return st5;
            }
            var st6 = await statusSnapshot(); st6.success = true; return st6;
        }

        if (short === "bridge_process") {
            var act = String(p.action || "status"), account = String(p.account || "");
            if (act === "start") await startOne(account);
            else if (act === "stop") await stopOne(account);
            var stp = await statusSnapshot(); stp.success = true; return stp;
        }

        if (short === "bridge_bind") {
            var ac = String(p.account || "");
            var cid = String(p.chat_id || "");
            var title = String(p.chat_title || "");
            await writeJson(HUB + "accounts/" + ac + "/binding.json", { chatId: cid, chatTitle: title, enabled: true });
            await putCfg(ac, { chatId: cid });
            await stopOne(ac); await startOne(ac);
            var stb = await statusSnapshot(); stb.success = true; return stb;
        }
        if (short === "bridge_unbind") {
            var ac2 = String(p.account || "");
            var bj2 = await readJsonSafe(HUB + "accounts/" + ac2 + "/binding.json", {});
            bj2.chatId = ""; bj2.chatTitle = "";
            await writeJson(HUB + "accounts/" + ac2 + "/binding.json", bj2);
            await putCfg(ac2, { chatId: "" });
            await stopOne(ac2);
            var stu = await statusSnapshot(); stu.success = true; return stu;
        }
        if (short === "bridge_config") {
            var ac3 = String(p.account || "");
            var raw = p.config;
            var obj = {};
            if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch (e) { return { success: false, error: "config JSON 解析失败" }; } }
            else if (raw && typeof raw === "object") obj = raw;
            var cur = await readJsonSafe(HUB + "accounts/" + ac3 + "/account.json", {});
            for (var kk in obj) cur[kk] = obj[kk];
            await writeJson(HUB + "accounts/" + ac3 + "/account.json", cur);
            var patch = {};
            if (cur.port) patch.port = Number(cur.port);
            if (cur.baseUrl) patch.baseUrl = cur.baseUrl;
            if (cur.token) patch.token = cur.token;
            if (cur.type) patch.channel = cfgChannel(cur.type);
            if (cur.allowPublic !== undefined) patch.allowPublic = !!cur.allowPublic;
            await putCfg(ac3, patch);
            if (patch.port || patch.allowPublic !== undefined || patch.token !== undefined) { try { await ensureGateway(); } catch (eG3) {} }
            var stc = await statusSnapshot(); stc.success = true; return stc;
        }
        if (short === "bridge_public_cfg") {
            var pc = await readJsonSafe(HUB + "public/config.json", { allowedChats: [], denyByDefault: false, publicInstances: [] });
            if (String(p.action || "get") === "set") {
                if (!Array.isArray(pc.allowedChats)) pc.allowedChats = [];
                if (p.allow_chat) { if (pc.allowedChats.indexOf(String(p.allow_chat)) < 0) pc.allowedChats.push(String(p.allow_chat)); }
                if (p.remove_chat) { var na = []; for (var z = 0; z < pc.allowedChats.length; z++) if (pc.allowedChats[z] !== String(p.remove_chat)) na.push(pc.allowedChats[z]); pc.allowedChats = na; }
                if (p.clear_allowed) pc.allowedChats = [];
                await writeJson(HUB + "public/config.json", pc);
            }
            return { success: true, allowedChats: pc.allowedChats || [] };
        }
        if (short === "bridge_token") {
            var ac4 = String(p.account || "");
            var ce4 = await cfgOf(ac4);
            var aj4 = await readJsonSafe(HUB + "accounts/" + ac4 + "/account.json", {});
            var isPub4 = (ce4 && ce4.channel === "http") || aj4.type === "public";
            if (!isPub4) return { success: false, error: "只有「公开接口」账号需要密钥，微信账号不需要" };
            var cur2 = await readJsonSafe(HUB + "accounts/" + ac4 + "/account.json", {});
            if (p.clear) { cur2.token = ""; cur2.accessToken = ""; await writeJson(HUB + "accounts/" + ac4 + "/account.json", cur2); await putCfg(ac4, { token: "" }); try { await ensureGateway(); } catch (eG1) { } return { success: true, token: "" }; }
            var hex = "0123456789abcdef", key = "sk-";
            for (var z2 = 0; z2 < 48; z2++) key += hex.charAt(Math.floor(Math.random() * 16));
            cur2.token = key; if (!cur2.type) cur2.type = "public";
            await writeJson(HUB + "accounts/" + ac4 + "/account.json", cur2);
            await putCfg(ac4, { token: key });
            try { await ensureGateway(); } catch (eG2) { }
            return { success: true, account: ac4, token: key };
        }
        if (short === "bridge_list_chats") {
            try {
                var lr = await Tools.Chat.listChats();
                var arr = (lr && (lr.chats || lr.items || lr.list)) || (Array.isArray(lr) ? lr : []);
                var out = [];
                for (var i2 = 0; i2 < arr.length; i2++) {
                    var c2 = arr[i2] || {};
                    out.push({ id: c2.chatId || c2.id || "", title: c2.title || c2.name || "(未命名)" });
                }
                return { success: true, chats: out };
            } catch (e) { return { success: false, error: errText(e), chats: [] }; }
        }
        if (short === "bridge_poll") {
            var one = String(p.account || "");
            var accs = [];
            for (var nm2 in state.msgs) {
                if (one && nm2 !== one) continue;
                accs.push({ name: nm2, messages: state.msgs[nm2].slice(-12) });
            }
            return { success: true, accounts: accs };
        }
        if (short === "bridge_pump") {
            var done = [];
            for (var i3 = 0; i3 < state.accounts.length; i3++) {
                var a3 = state.accounts[i3];
                if (!a3 || !a3.runtime || !a3.runtime.running) continue;
                try { await wxLoopOnce(a3.runtime, state.gen); done.push(a3.cfg.name); } catch (e) {}
            }
            return { success: true, pumped: done, injected: [], nextMsgId: 0, skipped: [] };
        }
        if (short === "bridge_qr") {
            return await genQr(p.text || "");
        }
        if (short === "bridge_test") {
            var ac5 = String(p.account || "");
            var cfg5 = normalize(await loadJson(CFG_PATH, DEFAULT_CFG));
            var ce5 = null;
            for (var i5 = 0; i5 < cfg5.accounts.length; i5++) if (cfg5.accounts[i5].name === ac5) { ce5 = cfg5.accounts[i5]; break; }
            if (!ce5) return { success: false, error: "账号不存在" };
            var steps = [];
            steps.push({ name: "账号配置", ok: true, detail: ce5.channel });
            var bj5 = await readJsonSafe(HUB + "accounts/" + ac5 + "/binding.json", {});
            var cid5 = ce5.chatId || bj5.chatId || "";
            steps.push({ name: "对话绑定", ok: !!cid5, detail: cid5 || "未绑定" });
            if (!cid5) return { success: true, ok: false, detail: "未绑定对话", steps: steps };
            var t0 = Date.now();
            var rep = await ask(cid5, "桥接自检：收到请回复 ok");
            steps.push({ name: "AI 回复", ok: !!rep, detail: (Date.now() - t0) + "ms, " + String(rep || "").length + " 字" });
            return { success: true, ok: !!rep, detail: rep ? ("已通，用时 " + (Date.now() - t0) + "ms") : "无回复", steps: steps, reply: rep || "" };
        }
        if (short === "bridge_wechat_import") {
            var ac6 = String(p.account || "");
            var aj6 = await readJsonSafe(HUB + "accounts/" + ac6 + "/account.json", {});
            var tok = aj6.wechatToken || aj6.token || aj6.accessToken || "";
            if (!tok) return { success: false, error: "account.json 里没有 token" };
            await putCfg(ac6, { channel: "wechat" });
            state.seeds = await collectSeeds(normalize(await loadJson(CFG_PATH, DEFAULT_CFG)));
            await stopOne(ac6); await startOne(ac6);
            return { success: true, account: ac6, token: String(tok).slice(0, 6) + "…" };
        }
        if (short === "setup_bridge") {
            var qid = String(p.qrcode_id || "");
            var accName = String(p.account || "") || await firstWechatAccount();
            if (!accName) return { success: false, step: "error", error: "没有微信账号，请先新增一个 wechat 账号" };
            if (!qid) {
                try {
                    await rlog("QR_REQUEST acc=" + accName);
                    var q = await wxApi("ilink/bot/get_bot_qrcode?bot_type=3", "", 12);
                    var qurl = q.qrcode_img_content || q.qrcode || "";
                    var qqid = q.qrcode || "";
                    await rlog("QR_OK id=" + String(qqid).slice(0, 8) + " urlLen=" + String(qurl).length);
                    void qrWatchLoop(accName, qqid);
                    return { success: true, step: "get_qrcode", qrcode_url: qurl, qrcode_id: qqid, account: accName, instruction: "扫码后带 qrcode_id 再次调用" };
                } catch (e) {
                    await rlog("QR_ERR " + errText(e));
                    return { success: false, step: "error", error: errText(e) };
                }
            }
            try {
                var stq = null;
                var __dl = Date.now() + Number(p.wait_ms || 0);
                do {
                    stq = await wxApi("ilink/bot/get_qrcode_status?qrcode=" + encodeURIComponent(qid), "", 20);
                    if (stq && (stq.status === "confirmed" || stq.status === "expired")) break;
                    if (!p.wait_ms) break;
                    await sleep(1000);
                } while (Date.now() < __dl);
                if (stq.status === "confirmed") {
                    if (!stq.bot_token) return { success: false, step: "error", error: "登录确认但未返回 bot_token" };
                    var accPath = HUB + "accounts/" + accName + "/account.json";
                    var curAcc = await readJsonSafe(accPath, { type: "wechat" });
                    curAcc.type = "wechat";
                    curAcc.token = stq.bot_token;
                    curAcc.baseUrl = stq.baseurl || "https://ilinkai.weixin.qq.com";
                    curAcc.wechatAccountId = stq.ilink_bot_id || "";
                    curAcc.wechatUserId = stq.ilink_user_id || "";
                    curAcc.savedAt = new Date().toISOString();
                    await writeJson(accPath, curAcc);
                    await putCfg(accName, { channel: "wechat" });
                    await rlog("QR_CONFIRMED acc=" + accName + " tokenLen=" + String(stq.bot_token).length);
                    await stopOne(accName);
                    await startOne(accName);
                    return { success: true, step: "confirmed", logged_in: true, account: accName, token: String(stq.bot_token).slice(0, 6) + "…" };
                }
                if (stq.status === "expired") return { success: true, step: "expired", message: "二维码已过期，请重新获取" };
                return { success: true, step: "waiting", message: "等待扫码确认", status: stq.status || "" };
            } catch (e) {
                return { success: true, step: "waiting", message: "等待扫码（本轮超时，继续轮询）" };
            }
        }
        return { success: false, error: "unknown tool: " + short };
    } catch (e) { var __m = errText(e); if (__m.indexOf("executing") >= 0) __m = "目标对话正在执行中，请等空闲后再试"; return { success: false, error: __m }; }
}

async function handleRequest(req) {
    try {
        var action = req && req.action;
        if (action === "tool") return await handleTool(req.tool, req.params || {});
        if (action === "getConfig") {
            var raw = await loadJson(CFG_PATH, DEFAULT_CFG);
            return { success: true, config: normalize(raw), status: await statusSnapshot() };
        }
        if (action === "setConfig") {
            var c = normalize(req.config || {});
            await writeFile(CFG_PATH, JSON.stringify(c, null, 2));
            stop();
            await sleep(200);
            await restore();
            return { success: true, status: await statusSnapshot() };
        }
        if (action === "startWith") {
            state.cfgOverride = req.config || state.cfgOverride;
            state.seeds = req.seeds || {};
            stop();
            await sleep(200);
            await restore();
            return { success: true, status: await statusSnapshot() };
        }
        if (action === "reload") { stop(); await sleep(200); await restore(); return { success: true, status: await statusSnapshot() }; }
        if (action === "stop") { stop(true); return { success: true, status: await statusSnapshot() }; }
        if (action === "status") return { success: true, status: await statusSnapshot() };
        return { success: false, error: "unknown action: " + action };
    } catch (e) { var __m = errText(e); if (__m.indexOf("executing") >= 0) __m = "目标对话正在执行中，请等空闲后再试"; return { success: false, error: __m }; }
}

function registerToolPkg() {
    // 再次确保 IPC 通道已注册（UI runtime 早于 main 加载时会报 channel is not registered）
    try { __ipcReady = false; ensureIpc(); } catch (eC) { try { console.log("[bridge] ipc re-register: " + errText(eC)); } catch (eD) {} }
    try {
        var screen = __pickScreen();
        if (screen) {
            ToolPkg.registerToolboxUiModule({ id: "bridge_settings", runtime: "compose_dsl", screen: screen, params: {}, title: { zh: "桥接设置", en: "Bridge Settings" } });
            try { ToolPkg.registerUiRoute({ id: "bridge_settings_route", route: "toolpkg:com.operit.bridge_hub:ui:bridge_settings_sidebar", runtime: "compose_dsl", screen: screen, params: {}, title: { zh: "桥接设置", en: "Bridge Settings" } }); } catch (eR) {}
            try { ToolPkg.registerNavigationEntry({ id: "bridge_settings_sidebar", route: "toolpkg:com.operit.bridge_hub:ui:bridge_settings_sidebar", surface: "main_sidebar_plugins", title: { zh: "桥", en: "Bridge" }, icon: "hub", order: 11 }); } catch (eN) {}
            try { console.log("[bridge] ui registered"); } catch (e3) {}
        } else {
            try { console.log("[bridge] ui module NOT loaded"); } catch (e4) {}
        }
    } catch (e3) { try { console.log("[bridge] ui " + errText(e3)); } catch (e4) {} }
    try {
        ToolPkg.registerAppLifecycleHook({ id: "bridge_create", event: "application_on_create", function: exports.restore });
        ToolPkg.registerAppLifecycleHook({ id: "bridge_fg", event: "application_on_foreground", function: exports.restore });
        ToolPkg.registerAppLifecycleHook({ id: "bridge_term", event: "application_on_terminate", function: exports.stop });
    } catch (e) { try { console.log("[bridge] hook " + errText(e)); } catch (e2) {} }
    return true;
}

try { setInterval(function () { try { ToolPkg.ipc.on(CHANNEL, handleRequest); } catch (eRr) { } }, 5000); } catch (eSi) { }
try { setInterval(function () { void wxInboxTick(); }, 800); } catch (eIb) { }
exports.registerToolPkg = registerToolPkg;
exports.restore = restore;
exports.stop = stop;

// [tick] qqbot gateway.js 写法：setTimeout 自链驱动，避免单个长请求卡死整条循环
function __wxTick(a, gen) {
    if (!(state.running && a.running && gen === state.gen)) return;
    Promise.resolve()
        .then(function () { return wxLoopOnce(a, gen); })
        .catch(function () {})
        .then(function () { setTimeout(function () { __wxTick(a, gen); }, 300); });
}

async function wxLoopOnce(a, gen) {
    for (var ri = 0; ri < 3 && state.retry.length > 0; ri++) {
        var item = state.retry.shift();
        if (!item || item.gen !== state.gen) continue;
        try { await wxHandle(item.acc, item.gen, item.m); } catch (e) {}
    }
    try {
        var _pt0 = Date.now();
        var j = await wxPost(a, "/ilink/bot/getupdates", { get_updates_buf: a.syncBuf, base_info: { channel_version: "2.0.0" } }, ((a.cfg && a.cfg.channel === "http") ? 3 : 40));
        var _pdt = Date.now() - _pt0;
        a.errN = 0;
        if (j.errcode === -14) {
            var nx = (state.wxExpired[a.name] || 0) + 1; state.wxExpired[a.name] = nx;
            if (nx === 1 || nx % 10 === 0) await rlog("WX_SESSION_EXPIRED " + a.name + " n=" + nx + " 需更新token，60s后重试");
            a.errN = 0; await sleep(60000); return;
        }
        if (j.errcode && j.errcode !== 0) { await rlog("WX_ERRCODE " + a.name + " " + j.errcode); await sleep(5000); return; }
        if (j.get_updates_buf) { a.syncBuf = j.get_updates_buf; await writeFile(HUB + "accounts/" + a.name + "/sync_buf.txt", a.syncBuf); }
        try { await markRun(a.name, true); } catch (eH) {}
        var msgs = j.msgs || j.message_list || [];
        if (msgs.length) await rlog("WX_POLL " + a.name + " ms=" + _pdt + " n=" + msgs.length);
        for (var i = 0; i < msgs.length; i++) { try { await wxHandle(a, gen, msgs[i]); } catch (e) { await rlog("WX_HANDLE_ERR " + a.name + " " + errText(e)); } }
        if (a.cfg && a.cfg.channel === "http" && msgs.length === 0) await sleep(800);
    } catch (e) {
        a.errN = (a.errN || 0) + 1;
        if (a.errN === 1 || a.errN % 10 === 0) await rlog("WX_POLL_ERR " + a.name + " n=" + a.errN + " " + errText(e));
        await sleep(Math.min(60000, 2000 * Math.pow(2, Math.min(4, a.errN - 1))));
    }
}
