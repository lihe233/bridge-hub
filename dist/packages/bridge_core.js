/* METADATA
{
    "name": "bridge_core",
    "display_name": { "zh": "桥核心", "en": "Bridge Core" },
    "description": { "zh": "桥的核心控制：账号、绑定、凭证、队列、测试（API 2.0 移植版，接口与原版一致）。", "en": "Bridge core (API 2.0 port, same tool surface)." },
    "tools": [
        { "name": "bridge_status", "parameters": [] },
        { "name": "bridge_accounts", "parameters": [ { "name": "action", "type": "string", "required": false }, { "name": "account", "type": "string", "required": false }, { "name": "type", "type": "string", "required": false }, { "name": "new_name", "type": "string", "required": false } ] },
        { "name": "bridge_process", "parameters": [ { "name": "action", "type": "string", "required": true }, { "name": "account", "type": "string", "required": false } ] },
        { "name": "bridge_bind", "parameters": [ { "name": "account", "type": "string", "required": true }, { "name": "chat_id", "type": "string", "required": true }, { "name": "chat_title", "type": "string", "required": false } ] },
        { "name": "bridge_unbind", "parameters": [ { "name": "account", "type": "string", "required": true } ] },
        { "name": "bridge_config", "parameters": [ { "name": "account", "type": "string", "required": true }, { "name": "config", "type": "string", "required": true } ] },
        { "name": "bridge_public_cfg", "parameters": [ { "name": "action", "type": "string", "required": true }, { "name": "allow_chat", "type": "string", "required": false }, { "name": "remove_chat", "type": "string", "required": false }, { "name": "clear_allowed", "type": "boolean", "required": false } ] },
        { "name": "bridge_token", "parameters": [ { "name": "account", "type": "string", "required": false }, { "name": "clear", "type": "boolean", "required": false } ] },
        { "name": "bridge_list_chats", "parameters": [] },
        { "name": "bridge_poll", "parameters": [ { "name": "account", "type": "string", "required": false } ] },
        { "name": "bridge_pump", "parameters": [] },
        { "name": "bridge_qr", "parameters": [ { "name": "text", "type": "string", "required": true } ] },
        { "name": "bridge_test", "parameters": [ { "name": "account", "type": "string", "required": true } ] },
        { "name": "bridge_wechat_import", "parameters": [ { "name": "account", "type": "string", "required": true } ] }
                            ]
}
*/

Object.defineProperty(exports, "__esModule", { value: true });

var CHANNEL = "bridge_hub2.service";
function call(name, params) { return ToolPkg.ipc.call(CHANNEL, { action: "tool", tool: name, params: params || {} }, { targetRuntime: "main" }); }

function mk(n) { return function (params) { return call(n, params); }; }

var NAMES = ["bridge_status","bridge_accounts","bridge_process","bridge_bind","bridge_unbind","bridge_config","bridge_public_cfg","bridge_token","bridge_list_chats","bridge_poll","bridge_pump","bridge_qr","bridge_test","bridge_wechat_import"];
for (var i = 0; i < NAMES.length; i++) { exports[NAMES[i]] = mk(NAMES[i]); }
