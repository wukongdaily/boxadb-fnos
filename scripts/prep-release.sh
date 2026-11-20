#!/usr/bin/env bash
#
# scripts/prep-release.sh — BoxADB「飞牛版」一键发布脚本
#
# 固化了 fnOS 发布的真实流程，避免每次手工踩坑：
#   1) 用官方 `fnpack build` 正规出 fpk（绝不手工 tar / 复用旧 app.tgz）
#   2) 把 fnpack build 就地污染的源码 manifest（键值对齐 + 注入 checksum）
#      还原成「干净版」：相对上次提交只改 version 那一行
#   3) 预览将要提交的内容 → 交互确认（默认 y/N，防误发）
#   4) commit（信息全英文）→ tag v<ver> → push（遇 GitHub 瞬断自动重试）
#   5) gh release create，附上 outputs/boxadb-<ver>.fpk
#
# 用法:
#   scripts/prep-release.sh <三段版本号> [选项]
#   scripts/prep-release.sh 0.1.23 --notes "修复了 xxx"
#
# 选项:
#   --notes "<text>"   Release 正文（默认给一段占位）
#   --msg "<text>"     git commit message（必须 ASCII 英文；默认 "Release v<ver>"）
#   --yes | -y         跳过交互确认（自动化用；慎用）
#   --no-publish       只 build+还原+本地 commit+tag，不 push、不发 Release
#   --build-only       只 build+还原+预览，不 commit（等价预演）
#   --dry-run          全流程空跑，连 build 都不实际执行，只回显命令
#   -h | --help        帮助
#
# 环境:
#   FNPACK=/path/to/fnpack   指定 fnpack 可执行文件（默认找 PATH 再退 ~/.local/bin/fnpack）
#
# 退出码非 0 即中止，绝不静默半途发布。

set -euo pipefail

# ── 定位仓库根（不依赖调用时的当前目录）────────────────────────
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$ROOT" ] || { echo "错误：当前不在 git 仓库内，请在 boxadb-fnos 仓库目录运行本脚本。" >&2; exit 1; }
APP_DIR="$ROOT/boxadb"                       # fnpack 项目目录
REL_MANIFEST="boxadb/manifest"               # 相对 git 根
# --directory 默认就是 "."，APP_DIR 本身即应用源码目录；曾误传 "boxadb" 导致 fnpack 失败（详见 4/8 注释）
FPK_NAME="boxadb.fpk"                        # fnpack 固定产出名
OUT_DIR="$(cd "$ROOT/.." && pwd)/outputs"    # fpk 交付目录
REPO_DEFAULT="wukongdaily/boxadb-fnos"

# ── 参数解析 ──────────────────────────────────────────────────
VER=""; NOTES=""; COMMIT_MSG=""; ASSUME_YES=0; PUBLISH=1; BUILD_ONLY=0; DRY=0

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

NEW_VER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) NOTES="${2:?--notes 需要值}"; shift 2;;
    --msg) COMMIT_MSG="${2:?--msg 需要值}"; shift 2;;
    --yes|-y) ASSUME_YES=1; shift;;
    --no-publish) PUBLISH=0; shift;;
    --build-only) BUILD_ONLY=1; shift;;
    --dry-run) DRY=1; shift;;
    -h|--help) usage; exit 0;;
    -*) echo "未知选项: $1" >&2; usage; exit 2;;
    *)
      if [ -z "$NEW_VER" ]; then NEW_VER="$1"; shift
      else echo "多余参数: $1" >&2; exit 2; fi;;
  esac
done

[ -n "$NEW_VER" ] || { echo "错误：缺少三段版本号，例：scripts/prep-release.sh 0.1.23" >&2; exit 2; }
# 飞牛商店规则：版本号必须 3 段 x.y.z（4 段无效）
if ! printf '%s' "$NEW_VER" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "错误：版本号 '$NEW_VER' 不合法，必须是三段 x.y.z（如 0.1.23）" >&2; exit 2
fi
VER="$NEW_VER"

[ -n "$COMMIT_MSG" ] || COMMIT_MSG="Release v$VER"
[ -n "$NOTES" ] || NOTES="飞牛版 v$VER（本条由 prep-release.sh 自动创建，请按需补充本次更新内容）。"
# commit message 必须纯 ASCII 英文（项目铁律）
if printf '%s' "$COMMIT_MSG" | LC_ALL=C grep -q '[^ -~]'; then
  echo "错误：commit message 含非 ASCII 字符，发布提交信息必须全英文：$COMMIT_MSG" >&2; exit 2
fi

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m注意：\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m错误：\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi; }

# ── 环境检查 ──────────────────────────────────────────────────
say "1/8 检查环境"
[ -d "$APP_DIR" ] || die "找不到项目目录 $APP_DIR"

FNPACK="${FNPACK:-}"
if [ -z "$FNPACK" ]; then
  if command -v fnpack >/dev/null 2>&1; then FNPACK="$(command -v fnpack)"
  elif [ -x "$HOME/.local/bin/fnpack" ]; then FNPACK="$HOME/.local/bin/fnpack"
  else die "未找到 fnpack。装到 ~/.local/bin/fnpack 或用 FNPACK=/path 指定（见 developer.fnnas.com/docs/cli/fnpack）"; fi
fi
[ "$DRY" = 1 ] || [ -x "$FNPACK" ] || die "fnpack 不可执行：$FNPACK"
say "  fnpack = $FNPACK ($("$FNPACK" --version 2>/dev/null | head -1 || echo 未知版本))"

GIT_URL="$(git remote get-url origin 2>/dev/null || true)"
[ -n "$GIT_URL" ] || die "origin 远程未配置"
[ "$PUBLISH" = 1 ] && case "$GIT_URL" in https://*) warn "origin 走 HTTPS，push 若反复 SSL_ERROR_SYSCALL 属 GitHub 瞬断，脚本会自动重试；长期建议改用 SSH remote。";; esac

if [ "$PUBLISH" = 1 ] && [ "$DRY" != 1 ]; then
  command -v gh >/dev/null 2>&1 || die "需要 gh CLI 发布 Release；请装 gh 并用 --no-publish 只做提交/打包"
  export GH_CONFIG_DIR="${GH_CONFIG_DIR:-$HOME/.config/gh}"; unset XDG_CONFIG_HOME || true
  gh auth status >/dev/null 2>&1 || die "gh 未登录（或 token 未写入配置）。先跑：gh auth login"
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
  [ -n "${REPO:-}" ] || REPO="$REPO_DEFAULT"
  say "  gh 目标仓库 = $REPO"
fi

CUR_VER="$(sed -n 's/^version=//p' "$APP_DIR/manifest" | head -1)"
[ -n "$CUR_VER" ] || die "读不到当前 manifest 的 version"
if [ "$CUR_VER" = "$VER" ]; then warn "新版本号与当前源码 manifest 一致（$VER）——若刚发布过同版本，飞牛不会刷新，请确认确是重新发布"; fi

# tag 已存在？
if git rev-parse -q --verify "refs/tags/v$VER" >/dev/null; then
  die "本地已存在 tag v$VER。请先决定：删旧 tag（git tag -d v$VER && git push origin :refs/tags/v$VER）或换版本号。"
fi

# 工作区应基本干净（忽略 build 产物），避免把无关改动一起提交
if [ "$BUILD_ONLY" != 1 ] && [ "$DRY" != 1 ]; then
  DIRTY="$(git status --porcelain | grep -vE '\.fpk$|app\.tgz$' || true)"
  if [ -n "$DIRTY" ]; then
    warn "工作区存在其它未提交改动（将与本次发布一起进入 commit，确认是预期的）："
    printf '%s\n' "$DIRTY" | sed 's/^/    /'
  fi
fi

# ── 2) 把源码 manifest 的 version 改成目标（供 build 读取）──────
say "2/8 设定版本号 version=$VER（$CUR_VER → $VER）"
if [ "$DRY" = 1 ]; then
  printf '    [dry-run] 将 manifest 内 version 设为 %s 后 build\n' "$VER"
else
  sed -i '' "s/^version=.*/version=$VER/" "$APP_DIR/manifest"
fi

# ── 3) 同步产物必须来自共享仓真源（www + pair）───────────────────
# pair/ 与 www/ 是同步产物而非本仓手写副本：不在出包前同步，全新克隆出的
# fpk 就缺 13 个配对模块，装上后 server.js 直接起不来。sync-ui.sh 自带逐字节
# 一致性断言，上游缺失或不一致都会非零退出，所以这是硬闸。
say "3/8 同步 UI 与配对模块（真源 = ../boxadb）"
if [ "$DRY" = 1 ]; then
  printf '    [dry-run] 将执行：bash scripts/sync-ui.sh\n'
else
  bash "$ROOT/scripts/sync-ui.sh" | sed 's/^/    /'
fi

# ── 3) fnpack build 正规出包 ───────────────────────────────────
# 血泪教训（v0.1.24 误产出事件）：fnpack 失败时只把错误写进 stdout、退出码仍为 0；
# 且 build 前工作区若残留上一次的 boxadb.fpk，旧的「文件是否存在」判断会被残留满足，
# 于是把上一版包当成本次产物交付（SHA-256 与上一版完全相同）。故此处三重防线缺一不可：
#   ① build 前清残留  ② 按日志关键字判成败  ③ 出包后校验版本与前端字节一致性
say "4/8 fnpack build"
if [ "$DRY" = 1 ]; then
  printf '    [dry-run] cd "%s" && "%s" build\n' "$APP_DIR" "$FNPACK"
  DRY_FPK="$OUT_DIR/boxadb-$VER.fpk"
else
  rm -f "$APP_DIR/$FPK_NAME" "$APP_DIR/app.tgz"
  BUILD_LOG="$( cd "$APP_DIR" && "$FNPACK" build 2>&1 )"; BUILD_RC=$?
  printf '%s\n' "$BUILD_LOG" | sed 's/^/    /'
  if [ "$BUILD_RC" != 0 ] || printf '%s' "$BUILD_LOG" | grep -qiE 'fail|error|no such file'; then
    die "fnpack build 未成功（退出码 $BUILD_RC，或日志含失败关键字），已中止。"
  fi
  BUILT_FPK="$APP_DIR/$FPK_NAME"
  [ -f "$BUILT_FPK" ] || die "fnpack 未产出预期包：$BUILT_FPK"

  say "  校验包内产物"
  TMP_CHK="$(mktemp -d)"
  tar -xf "$BUILT_FPK" -C "$TMP_CHK" 2>/dev/null || die "无法解包校验：$BUILT_FPK"
  PKG_VER="$(sed -n 's/^version[[:space:]=]*\([^[:space:]]*\).*/\1/p' "$TMP_CHK/manifest" | head -1)"
  [ "$PKG_VER" = "$VER" ] || die "包内版本=$PKG_VER ≠ 目标版本=$VER（疑似残留包），已中止。"
  tar -xzf "$TMP_CHK/app.tgz" -C "$TMP_CHK" 2>/dev/null || die "包内缺 app.tgz，已中止。"
  for f in www/index.html www/js/app.js www/js/tango.js www/css/style.css; do
    H_PKG="$(shasum -a 256 "$TMP_CHK/$f" 2>/dev/null | cut -d' ' -f1)"
    H_SRC="$(shasum -a 256 "$APP_DIR/app/$f" 2>/dev/null | cut -d' ' -f1)"
    [ -f "$APP_DIR/app/$f" ] || die "源码里找不到 $f（$APP_DIR/app/$f），校验无效，已中止。"
    [ -n "$H_PKG" ] && [ "$H_PKG" = "$H_SRC" ] || die "包内 $f 与源码不一致（源码 ${H_SRC:0:8} / 包内 ${H_PKG:0:8}），已中止。"
    printf '    ✓ %-18s 与源码逐字节一致\n' "$f"
  done
  # 飞牛专属不变量：USB 直连必须已被补丁关闭
  grep -q 'const SELF_HOSTED = true;' "$TMP_CHK/www/js/app.js" || die "包内 app.js 未钉死 SELF_HOSTED，USB 直连可能重现，已中止。"
  BTN_LINE="$(grep -o '<button id="usb-toggle"[^>]*>' "$TMP_CHK/www/index.html" | head -1)"
  printf '%s' "$BTN_LINE" | grep -q ' hidden' || die "包内 index.html 的 #usb-toggle 未默认 hidden，已中止。"
  echo "    ✓ USB 直连入口已在包内硬关闭（SELF_HOSTED=true + 默认 hidden）"
  rm -rf "$TMP_CHK"

  mkdir -p "$OUT_DIR"
  cp "$BUILT_FPK" "$OUT_DIR/boxadb-$VER.fpk"
  DRY_FPK="$OUT_DIR/boxadb-$VER.fpk"
  say "  已复制交付包 → $DRY_FPK ($(du -h "$DRY_FPK" | cut -f1))，包内版本与前端均已校验"
fi

# ── 4) 还原源码 manifest 为「干净版」（只 version 一行变化）───────
say "5/8 还原源码 manifest 为干净版（剔除 fnpack 注入的对齐+checksum）"
if [ "$DRY" = 1 ]; then
  printf '    [dry-run] 取 HEAD 的紧凑版 manifest，仅把 version 改为 %s\n' "$VER"
else
  git show "HEAD:$REL_MANIFEST" > "$APP_DIR/manifest"
  sed -i '' "s/^version=.*/version=$VER/" "$APP_DIR/manifest"
  MANIFEST_DIFF="$(git diff -- "$REL_MANIFEST")"
  LINES_CHANGED="$(printf '%s\n' "$MANIFEST_DIFF" | grep -cE '^[+-]' || true)"
  if printf '%s' "$MANIFEST_DIFF" | grep -qE 'checksum|  = |^[+-](appname|platform|micro_app) '; then
    die "manifest 还原不干净（疑似 HEAD 已被污染），已中止。请人工检查：git diff -- $REL_MANIFEST"
  fi
  if [ "$LINES_CHANGED" -gt 6 ]; then
    warn "manifest diff 行数偏多，请确认只动了 version："; printf '%s\n' "$MANIFEST_DIFF" | sed 's/^/    /'
  fi
  # 清掉 build 中间产物（均已被 .gitignore 忽略，删了避免工作区脏）
  rm -f "$APP_DIR/$FPK_NAME" "$APP_DIR/app.tgz"
fi

# ── 5) 预览将要提交的内容 + 确认门 ─────────────────────────────
say "6/8 预览待提交内容"
[ "$DRY" = 1 ] && { warn "dry-run：跳过实际 git diff"; } || {
  echo "   相对 HEAD 的改动（--stat）:"
  git --no-pager diff --stat HEAD | sed 's/^/     /'
  echo "   未跟踪文件（应无 build 残留）:"
  git ls-files --others --exclude-standard | sed 's/^/     /'
  echo "   manifest 具体 diff:"
  git --no-pager diff -- "$REL_MANIFEST" | sed 's/^/     /'
}

if [ "$BUILD_ONLY" = 1 ]; then
  say "（--build-only）到此为止：已 build + 还原 manifest，未提交。产物：$DRY_FPK"
  exit 0
fi

if [ "$DRY" = 1 ]; then
  printf '    [dry-run] 将执行：git add -A && git commit -m "%s" && git tag v%s\n' "$COMMIT_MSG" "$VER"
  [ "$PUBLISH" = 1 ] && printf '    [dry-run] 将执行：git push origin main && git push origin v%s && gh release create v%s "%s" ...\n' "$VER" "$VER" "$DRY_FPK"
  say "（--dry-run）预演结束，未做任何改动。"; exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
  echo
  if [ "$PUBLISH" = 1 ]; then PROMPT="确认提交 v$VER、推送并创建 GitHub Release？[y/N] "
  else PROMPT="确认提交 v$VER（本地 commit+tag，不推送不发布）？[y/N] "; fi
  read -r -p "$PROMPT" ans
  case "$ans" in [yY]|[yY][eE][sS]) : ;; *) echo "已取消。build 产物与还原后的 manifest 均保留在工作区，可自行检查。"; exit 1;; esac
fi

# ── 6) commit + tag ────────────────────────────────────────────
say "7/8 提交 + 打 tag"
git add -A
if git diff --cached --quiet; then
  warn "暂存区无变化（manifest 版本号可能已是 $VER 且无其它改动）——若确要空发本次 tag，去掉该保护手动操作。"
fi
git commit -m "$COMMIT_MSG"
git tag "v$VER"
say "  commit=$(git rev-parse --short HEAD)  tag=v$VER"

# ── 7) push（带重试）+ 发 Release ──────────────────────────────
if [ "$PUBLISH" != 1 ]; then
  say "（--no-publish）已完成本地 commit+tag，未 push、未发 Release。"
  say "稍后可自行：git push origin main && git push origin v$VER ；或用不带 --no-publish 重跑发布步骤。"
  exit 0
fi

push_retry() {  # 用法: push_retry <ref>
  local ref="$1" i
  for i in 1 2 3 4 5; do
    if git push origin "$ref" 2>/tmp/boxadb-push.err; then say "  push $ref 成功（第 $i 次）"; return 0; fi
    warn "push $ref 第 $i 次失败: $(tail -1 /tmp/boxadb-push.err)"; sleep 4
  done
  die "push $ref 连续 5 次失败，最后错误：$(cat /tmp/boxadb-push.err)"
}

say "8/8 推送 + 发布 Release"
git pull --rebase origin main || warn "pull --rebase 未成功（可能无上游改动），继续尝试推送"
push_retry "main"
push_retry "v$VER"

if gh release view "v$VER" --repo "$REPO" >/dev/null 2>&1; then
  warn "Release v$VER 已存在，改为更新其附件与说明。"
  gh release upload "v$VER" "$DRY_FPK" --clobber --repo "$REPO"
  gh release edit "v$VER" --repo "$REPO" --title "盒子助手 BoxADB v$VER" --notes "$NOTES"
else
  gh release create "v$VER" "$DRY_FPK" --repo "$REPO" \
    --title "盒子助手 BoxADB v$VER" --notes "$NOTES"
fi

# 校验
REMOTE_MAIN="$(gh api "repos/$REPO/git/ref/heads/main" -q .object.sha 2>/dev/null | cut -c1-7 || echo '?')"
LOCAL_HEAD="$(git rev-parse --short HEAD)"
[ "$REMOTE_MAIN" = "$LOCAL_HEAD" ] && say "  远端 main = 本地 HEAD = $LOCAL_HEAD ✓" || warn "  远端 main=$REMOTE_MAIN 与本地=$LOCAL_HEAD 不一致，请检查。"

echo
say "发布完成 ✅  Release: https://github.com/$REPO/releases/tag/v$VER"
