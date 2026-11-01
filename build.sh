#!/bin/sh
# 打包为 .toolpkg（插件市场用）
set -e
VER=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="/storage/emulated/0/Download/bridge_hub-v${VER}.toolpkg"
rm -f "$OUT"
python3 - "$OUT" <<'PY'
import zipfile, os, sys
out = sys.argv[1]
skip = {'.git', 'build.sh', '.DS_Store'}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in skip]
        for f in files:
            if f in skip or f.endswith('.toolpkg'):
                continue
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, '.'))
print('built', out, os.path.getsize(out), 'bytes')
PY
node --check dist/main.js
node --check dist/ui/bridge_settings/index.ui.js
node --check dist/packages/bridge_core.js
node --check dist/packages/wechat_claude_bridge.js
echo OK
