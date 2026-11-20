#!/usr/bin/env python3
# 飞牛构建期补丁，三件事，各自幂等：
#   A. 给同步进来的 www/js/app.js 注入「从 NAS 选择」钩子
#   B. 硬关掉「USB 直连」入口
#   C. 把页脚仓库链接改写成本项目（桌面源码指向 boxadb，飞牛包必须指向 boxadb-fnos）
# 飞牛是 NAS 应用：adb 桥跑在 NAS 上，USB 直连连的是打开网页那台电脑的 USB，
# 语义上根本不该存在。而浏览器里 navigator.usb 是否存在完全不可控（用户常用
# Chrome/Edge 打开 /app/boxadb/，那时它是存在的）——所以这里不接受任何运行时条件，
# 直接把形态常量钉死为自托管，让 !SELF_HOSTED 恒为假，入口永远亮不起来。
# 桌面源码保持干净，飞牛专属改动只落在飞牛包的 www 副本里。失败即报错，绝不静默放过。
import sys, io

path = sys.argv[1]
html_path = sys.argv[2] if len(sys.argv) > 2 else ''
src = io.open(path, encoding='utf-8').read()
changed = False
notes = []

# ── A：NAS 文件选择钩子 ──────────────────────────────────────────
if 'fnos/nas-pick.js' not in src:
    anchor = "  renderStatus();\n  if (location.search.includes('demo=1')) seedDemo();"
    inject = (
        "  renderStatus();\n"
        "  // ── 飞牛版钩子（由 patch-app-fnos.py 在构建期注入，桌面源码不含此段）──\n"
        "  window.__boxadb = { addFiles, toast };\n"
        "  import('../fnos/nas-pick.js').catch(() => {});\n"
        "  if (location.search.includes('demo=1')) seedDemo();"
    )
    if anchor not in src:
        sys.stderr.write('ERROR: app.js boot 锚点未找到，飞牛钩子注入失败\n')
        sys.exit(2)
    src = src.replace(anchor, inject, 1)
    changed = True
    notes.append('飞牛钩子已注入')

# ── B：永久关闭 USB 直连 ─────────────────────────────────────────
DISABLED = 'const SELF_HOSTED = true;'
if DISABLED not in src:
    # 上游形态常量声明（boxadb/js/app.js 里按注入 meta 判定），把它钉死成 true
    import re
    pat = re.compile(r"const SELF_HOSTED = !!document\.querySelector\([^)]*\);")
    if not pat.search(src):
        # 上游若改了判定写法甚至删掉常量，说明「USB 入口」可能重新变成可见 —— 必须失败，不许静默出包
        sys.stderr.write(
            'ERROR: 未找到 SELF_HOSTED 常量声明，无法确认 USB 直连已关闭。\n'
            '       请检查 boxadb/js/app.js 的形态判定是否改名或移除，并同步本补丁。\n')
        sys.exit(4)
    src = pat.sub(
        DISABLED + '  // 飞牛=NAS 应用，永不自助 USB；此常量由 patch-app-fnos.py 钉死', src, 1)
    changed = True
    notes.append('USB 直连已永久关闭')

# ── C：页脚仓库地址 ──────────────────────────────────────────────
DESKTOP_URL = 'https://github.com/wukongdaily/boxadb"'
FNOS_URL = 'https://github.com/wukongdaily/boxadb-fnos"'
if html_path:
    html = io.open(html_path, encoding='utf-8').read()
    if FNOS_URL not in html:
        if DESKTOP_URL not in html:
            sys.stderr.write('ERROR: 页脚里找不到桌面版仓库链接，无法确认飞牛地址已改写\n')
            sys.exit(6)
        html = html.replace(DESKTOP_URL, FNOS_URL, 1)
        io.open(html_path, 'w', encoding='utf-8').write(html)
        notes.append('页脚已指向 boxadb-fnos')
    # 幂等重跑时也要确认没有退回桌面地址
    if FNOS_URL not in html:
        sys.stderr.write('ERROR: 出包校验失败 —— 页脚未指向 boxadb-fnos\n')
        sys.exit(6)

# ── 出包前硬校验：三道门缺一不可 ─────────────────────────────────
must = [
    ('fnos/nas-pick.js', '飞牛钩子'),
    (DISABLED, 'SELF_HOSTED 已钉死为 true'),
    ('if (!SELF_HOSTED && navigator.usb)', 'USB 入口仍受 !SELF_HOSTED 门控'),
]
for needle, label in must:
    if needle not in src:
        sys.stderr.write('ERROR: 出包校验失败 —— %s 未生效（缺少 %r）\n' % (label, needle))
        sys.exit(5)

if changed:
    io.open(path, 'w', encoding='utf-8').write(src)
print('app.js 补丁完成：' + ('、'.join(notes) if notes else '已是目标状态，无需改动'))
