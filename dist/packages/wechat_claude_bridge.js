/* METADATA
{
    "name": "wechat_claude_bridge",
    "display_name": { "zh": "微信接入", "en": "WeChat Bridge" },
    "description": { "zh": "微信 iLink 接入控制（2.0 版：扫码登录暂未移植，可用 bridge_wechat_import 导入已有凭证）。", "en": "WeChat iLink control (2.0)." },
    "tools": [
        { "name": "setup_bridge", "parameters": [
            { "name": "show_qrcode", "type": "boolean", "required": false },
            { "name": "qrcode_id", "type": "string", "required": false },
            { "name": "poll_once", "type": "boolean", "required": false },
            { "name": "wait_ms", "type": "number", "required": false },
            { "name": "account", "type": "string", "required": false }
        ] }
    ]
}
*/

Object.defineProperty(exports, "__esModule", { value: true });

var CHANNEL = "bridge_hub.service";
function call(name, params) { return ToolPkg.ipc.call(CHANNEL, { action: "tool", tool: name, params: params || {} }, { targetRuntime: "main" }); }

async function setup_bridge(params) { return await call("setup_bridge", params); }

exports.setup_bridge = setup_bridge;
