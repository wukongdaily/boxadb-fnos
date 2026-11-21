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


## ❤️ 想支持作者 ☕️
<a href="https://wkdaily.cpolar.top/01" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
       alt="Buy Me A Coffee"
       style="width:15%; height:auto;">
</a>
