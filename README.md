# 盒子助手 · 飞牛 fnOS 版 [![bilibili](https://img.shields.io/badge/_B站_·_反馈-A0AABC?style=flat&logo=bilibili&logoColor=fff&labelColor=FB7299&color=3a3a44)](https://www.bilibili.com/video/BV1e4sp6nETW/)

- 飞牛 Native 应用：**点飞牛桌面图标 → 打开的就是盒子助手网页**（经统一网关，
与 NAS 登录态同源）
- 📦 装应用：把手机/电脑上的 .apk / .xapk / .apkm 直接装进盒子（支持批量、自动按盒子架构把关，装错版本会当场提醒你）。
- 🗂 管应用：看已装列表，启动 / 强制停止 / 卸载 / 清除数据，系统应用可禁用。
- 🎮 当遥控器：方向键、返回、主页、菜单、音量、电源、播放/快进退、流媒体info键。
- ⌨️ ADB 终端 + 截图 + 重启，还有完整设备信息（型号、CPU、内存、存储占用等）。

## 截图
<!-- ✅ 点图片看原图 -->
[<img src="screenshot/boxadb_hero.jpg" width="1080" alt="盒子助手界面">](https://raw.githubusercontent.com/wukongdaily/boxadb-fnos/main/screenshot/boxadb_hero.jpg)


## 在 fnOS 安装

应用中心 → [手动安装fpk](https://github.com/wukongdaily/boxadb-fnos/releases) 或 未来上架后 搜索盒子助手下载安装即可


## 自动准备 5555（可选增强）

Android 11+ 的「无线调试」使用**随机端口**，电视重启后 adbd 不再监听 5555；
而浏览器端 ADB 引擎（ya-webadb 的 `AdbDaemonTransport`）没有 pairing 客户端，
无法走无线调试的 TLS 配对，只能使用 5555 传统模式（电视上弹窗允许密钥）。

**连接流程（对能正常连上的电视零影响）**：

1. 先按原方式连接 `ip:5555`，成功即结束（**不发起任何额外请求**）；
2. **只有连接失败时**，才调用 `GET /app/boxadb/discover?host=<盒子IP>`：
   - `5555` 已在监听 → 直接返回；
   - 否则用 mDNS（`_adb-tls-connect._tcp`）读出盒子**当前**的无线调试端口，
     调用系统 `adb connect` + `adb tcpip 5555` 切回 5555；
3. 修复成功后**自动重连一次**；失败则提示原因并保留原始错误。

**可选依赖**（缺失时只有自动修复不可用，其余行为完全不变）：

- `avahi-browse`（`apt install avahi-utils`）—— mDNS 查询
- `adb` —— 切换端口。本功能只用到 `adb connect` / `adb devices` / `adb tcpip`，
  **任意版本均可**；但下面「首次准备」的方式 B 需要 `adb pair`，该命令要求 **30.0.0+**
  （Debian main 自带 29.0.6 不含 `pair`，因此推荐 `apt install -t bookworm-backports adb`）

**首次准备（每台电视只需一次，二选一）**：

- **方式 A（最省事，不需要配对，也不需要高版本 adb）**：
  在任意一台电脑上 USB 连接电视，执行一次
  ```bash
  adb tcpip 5555
  ```
  之后首次连接时在电视上点「允许」即可；
- **方式 B（无需 USB，但需要 adb ≥ 30）**：电视打开「无线调试 → 使用配对码配对设备」并**保持弹窗不要关闭**，
  在 NAS 上执行：
  ```bash
  adb pair <电视IP>:<配对端口> <6位配对码>
  ```
  配对一次后，后续由本功能的 `/discover` 自动维持 5555，不再需要手动操作。

**安全**：该接口要求管理员头 `x-trim-isadmin: true`，目标必须是**私网 IPv4**，
只允许操作 `5555`（与桥接端口一致）；`execFile` 固定参数，不经过 shell。

## 相关项目

本项目的界面，就是下面这个桌面 / 网页版「盒子助手」的同一套前端，为飞牛 fnOS 做的原生移植——功能一致，按场景二选一：

- **[boxadb（桌面 / 网页版）](https://github.com/wukongdaily/boxadb)** —— 电脑开本地桥，浏览器直接访问 <https://wukongdaily.github.io/boxadb/>，支持 WebUSB 数据线直连。
- **boxadb-fnos（本项目 · 飞牛版）** —— 盒子助手常驻 NAS、经统一网关同源，手机在客厅也能开网页连盒子，不必在每台电脑另开桥。

## 第三方组件致谢（均为 MIT）

- **[@yume-chan/ya-webadb (Tango)](https://github.com/yume-chan/ya-webadb)** —— ADB 协议引擎（Simon Chan）
- **[xterm.js](https://xtermjs.org/)** —— 浏览器终端
- **[fflate](https://github.com/101arrowz/fflate)** —— APK/XAPK 解包

版权声明与许可全文见 [`boxadb/app/www/js/vendor/THIRD-PARTY-LICENSES.md`](boxadb/app/www/js/vendor/THIRD-PARTY-LICENSES.md)。

## 许可

[MIT](LICENSE)
