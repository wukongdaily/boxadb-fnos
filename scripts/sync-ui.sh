#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/../boxadb"
PKG="$ROOT/boxadb"
DST="$PKG/app/www"
mkdir -p "$DST"

# 同步前端（rsync --delete：以桌面版为准；剔除 NAS 包不需要的桌面专属/开发文件）
rsync -a --delete --delete-excluded \
  --exclude 'AppIcon.icns' --exclude 'AppIcon.ico' \
  --exclude 'AppIcon.png'  --exclude '*.swift' \
  "$SRC/index.html" "$SRC/css" "$SRC/js" "$SRC/assets" "$DST/"

# tango.js 不再打「同源地址补丁」：桥地址改由服务端运行时注入
# <meta name="boxadb-mode|boxadb-prefix">，与 Docker 版共用同一套逻辑。
# 因此飞牛包里的 tango.js 必须与桌面源码逐字节一致，不一致就是机制漂移，直接失败。
diff -q "$SRC/js/tango.js" "$DST/js/tango.js" >/dev/null || {
  echo "sync-ui: www/js/tango.js 与桌面源码不一致（构建期改写机制已废弃，请勿再加补丁）" >&2; exit 1; }
grep -qF 'meta[name="boxadb-prefix"]' "$DST/js/tango.js" || {
  echo "sync-ui: tango.js 缺少运行时前缀探测，服务端注入将无效果" >&2; exit 1; }

# 给 app.js 注入飞牛专属钩子（桌面源码保持干净，只在 www 副本里加）
python3 "$ROOT/scripts/patch-app-fnos.py" "$DST/js/app.js" "$DST/index.html"

# 应用飞牛专属 overlay（fnos 选择器模块 + 官方 SDK）→ www/fnos（镜像同步，不用 rm）
if [ -d "$ROOT/fnos-overlay/fnos" ]; then
  mkdir -p "$DST/fnos"
  rsync -a --delete "$ROOT/fnos-overlay/fnos/" "$DST/fnos/"
fi

echo "UI 同步完成 → $DST"
