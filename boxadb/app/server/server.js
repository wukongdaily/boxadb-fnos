#!/usr/bin/env node
'use strict';

// 盒子助手 · 飞牛 fnOS 服务端（MIT）
// 职责只有两件事：
//   1) 把盒子助手的网页（app/www）发给浏览器；
//   2) 在浏览器的 WebSocket 与局域网盒子之间搬运 TCP 字节。
// 本服务不解析 ADB 协议——ADB 全部由浏览器端的 MIT 引擎处理，
// 这里只是 WebSocket(RFC 6455, IETF 公开规范) 与 TCP 之间的透明管道。
//
// 运行形态：飞牛统一网关把 https://<NAS>/app/boxadb/* 校验登录态后
// 转发到本服务的 Unix socket；页面与桥同源，因此不存在混合内容问题。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');
const mdns = require('./pair/mdns.js');
const keystore = require('./pair/keystore.js');
const wireless = require('./pair/index.js');
const pairApi = require('./pair/api.js');

// ── 配置（飞牛生命周期注入；本地开发可省略）──
const conf = {
  socketPath: process.env.SOCKET_PATH || '',                       // Unix socket 路径
  devPort: Number(process.env.PORT || 8765),                       // 无 socket 时的本地调试端口
  webRoot: process.env.WEB_ROOT || path.join(__dirname, '..', 'www'),
  prefix: (process.env.GATEWAY_PREFIX || '/app/boxadb').replace(/\/+$/, ''),
  adminRequired: process.env.BOXADB_REQUIRE_ADMIN === '1',
  tunnelPort: Number(process.env.BOXADB_ALLOWED_PORT || 5555),     // 唯一放行的目标端口
  idleExitSec: Number(process.env.BRIDGE_IDLE_SECONDS || 0),       // >0：无会话 N 秒后自退
  stateDir: process.env.TRIM_PKGVAR || path.join(os.tmpdir(), 'boxadb-fnos'),
  pinPort: Number(process.env.BOXADB_PIN_PORT || 5555),
};

// ── WebSocket 帧编解码（按 RFC 6455 实现；服务端发出帧不加掩码）──
const Op = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function encodeFrame(op, body = Buffer.alloc(0)) {
  const len = body.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | op, len]);
  } else if (len <= 0xffff) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | op; head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | op; head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, body]);
}

function encodeClose(code, text = '') {
  const reason = Buffer.from(String(text).slice(0, 120));
  const body = Buffer.alloc(2 + reason.length);
  body.writeUInt16BE(code, 0);
  reason.copy(body, 2);
  return encodeFrame(Op.CLOSE, body);
}

// 把socket上的字节流拼装成完整消息；控制帧即时回调，数据帧凑齐 FIN 后回调
class FrameStream {
  constructor(onData, onControl) {
    this.onData = onData;
    this.onControl = onControl;
    this.buf = Buffer.alloc(0);
    this.partial = [];
    this.failed = false;
  }
  push(chunk) {
    if (this.failed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      for (;;) {
        if (this.buf.length < 2) return;
        const b0 = this.buf[0], b1 = this.buf[1];
        const final = (b0 & 0x80) !== 0;
        const op = b0 & 0x0f;
        let len = b1 & 0x7f;
        let head = 2;
        if (len === 126) {
          if (this.buf.length < 4) return;
          len = this.buf.readUInt16BE(2); head = 4;
        } else if (len === 127) {
          if (this.buf.length < 10) return;
          const big = this.buf.readBigUInt64BE(2); head = 10;
          if (big > 64n * 1024n * 1024n) { this.fail('帧超限'); return; }
          len = Number(big);
        }
        let mask = null;
        if ((b1 & 0x80) !== 0) {
          if (this.buf.length < head + 4) return;
          mask = this.buf.subarray(head, head + 4); head += 4;
        }
        if (this.buf.length < head + len) return;
        const body = Buffer.from(this.buf.subarray(head, head + len));
        this.buf = this.buf.subarray(head + len);
        if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
        this.dispatch(op, final, body);
        if (this.buf.length === 0) return;
      }
    } catch (err) { this.fail(err.message || String(err)); }
  }
  dispatch(op, final, body) {
    if (op === Op.CLOSE || op === Op.PING || op === Op.PONG) {
      this.onControl(op, body);
      return;
    }
    if (op === Op.TEXT || op === Op.BIN) {
      if (final) { this.partial = []; this.onData(body); }
      else { this.partial = [body]; }
      return;
    }
    if (op === Op.CONT) {
      if (!this.partial.length) { this.fail('孤立的 continuation 帧'); return; }
      this.partial.push(body);
      if (final) { this.onData(Buffer.concat(this.partial)); this.partial = []; }
      return;
    }
    this.fail(`未知操作码 0x${op.toString(16)}`);
  }
  fail(msg) { this.failed = true; this.onControl(Op.CLOSE, Buffer.from(msg.slice(0, 120))); }
}

// ── 会话计数与空闲自退 ──
let liveTunnels = 0;
let idleTimer = null;
function tunnelOpened() { liveTunnels++; if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }
function tunnelClosed() {
  liveTunnels = Math.max(0, liveTunnels - 1);
  if (conf.idleExitSec > 0 && liveTunnels === 0) {
    idleTimer = setTimeout(() => {
      if (liveTunnels === 0) process.exit(0);   // 释放一切，可在应用中心再次启动
    }, conf.idleExitSec * 1000);
  }
}

// ── 桥接：WS ↔ TCP ──
function openTunnel(ws, target) {
  const upstream = net.connect({ host: target.host, port: target.port });
  upstream.setNoDelay(true);
  let upstreamReady = false;
  const queued = [];
  let downstreamOpen = true;
  const finish = (why) => {
    if (downstreamOpen) {
      downstreamOpen = false;
      try { ws.write(encodeClose(1000, why)); } catch {}
      try { ws.destroy(); } catch {}
    }
    upstream.destroy();
    tunnelClosed();
    say(`tunnel end [${target.host}:${target.port}] ${why}`);
  };

  upstream.on('connect', () => {
    upstreamReady = true;
    for (const b of queued) upstream.write(b);
    queued.length = 0;
  });
  upstream.on('data', (chunk) => ws.write(encodeFrame(Op.BIN, chunk)));
  upstream.on('end', () => finish('upstream closed'));
  upstream.on('error', (e) => finish(`upstream error: ${e.message}`));

  const frames = new FrameStream(
    (payload) => {
      if (!downstreamOpen) return;
      if (upstreamReady) upstream.write(payload);
      else queued.push(payload);
    },
    (op, body) => {
      if (op === Op.CLOSE) finish('client sent close');
      else if (op === Op.PING) ws.write(encodeFrame(Op.PONG, body));
    }
  );
  ws.on('data', (c) => frames.push(c));
  ws.on('close', () => finish('client disconnected'));
  ws.on('error', () => finish('client socket error'));
}

// ── WebSocket 升级（RFC 6455 第 4.2 节握手）──
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptValue = (nonce) =>
  crypto.createHash('sha1').update(nonce + WS_GUID).digest('base64');

function isPrivateIPv4(host) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  const [a, b] = host.split('.').map(Number);
  if (a === 10 || a === 127 || (a === 192 && b === 168)) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function handleUpgrade(req, socket, head) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
  if (url.pathname !== `${conf.prefix}/adb`) { socket.destroy(); return; }

  const target = { host: url.searchParams.get('host') || '', port: Number(url.searchParams.get('port')) };
  const reject = (code, msg) => {
    socket.write(`HTTP/1.1 ${code}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
    socket.destroy();
    say(`tunnel rejected: ${msg}`);
  };

  if (conf.adminRequired && String(req.headers['x-trim-isadmin'] || '').toLowerCase() !== 'true') {
    return reject(403, 'bridge is restricted to fnOS administrators');
  }
  if (!isPrivateIPv4(target.host)) {
    return reject(403, 'target host must be a private IPv4 address');
  }
  if (target.port !== conf.tunnelPort) {
    return reject(403, `target port must be ${conf.tunnelPort}`);
  }
  const nonce = req.headers['sec-websocket-key'];
  if (!nonce || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy(); return;
  }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptValue(nonce)}\r\n\r\n`
  );
  socket.setNoDelay(true);
  if (head && head.length) socket.emit('data', head);
  tunnelOpened();
  say(`tunnel open [${target.host}:${target.port}]`);
  openTunnel(socket, target);
}

// ── 静态页 ──
const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', ico: 'image/x-icon',
  webp: 'image/webp', woff: 'font/woff', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8',
};

// 自托管标记：与 Docker 版同一套机制 —— 前端据此把桥地址切成「同源 + 网关前缀」，
// 因此 www 里的 JS 与桌面源码逐字节一致，不需要任何构建期地址改写。
function markSelfHosted(buf) {
  const s = buf.toString('utf8');
  if (s.includes('boxadb-mode')) return buf;
  const i = s.indexOf('<head');
  if (i < 0) return buf;
  const j = s.indexOf('>', i);
  if (j < 0) return buf;
  const at = j + 1;
  const meta = `\n<meta name="boxadb-mode" content="selfhosted"><meta name="boxadb-prefix" content="${conf.prefix}">`;
  return Buffer.from(s.slice(0, at) + meta + s.slice(at), 'utf8');
}

function servePage(req, res, url) {
  let rel = '/';
  try { rel = decodeURIComponent(url.pathname.slice(conf.prefix.length)) || '/'; }
  catch { res.writeHead(400).end('bad request'); return; }
  if (rel === '/' || rel === '') rel = '/index.html';

  const root = path.resolve(conf.webRoot);
  const file = path.resolve(root, '.' + path.posix.normalize(rel));
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    };
    let body = null;
    if (/^index\.html$/i.test(path.basename(file))) {
      try { body = markSelfHosted(fs.readFileSync(file)); headers['Content-Length'] = body.length; }
      catch { body = null; }
    }
    headers['Content-Length'] = body ? body.length : st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    if (body) { res.end(body); return; }
    fs.createReadStream(file).pipe(res);
  });
}

// ── 「从 NAS 选择安装包」：调飞牛开放 API 校验用户 ACL，再读授权文件回流浏览器 ──
const APP_NAME = 'boxadb';
const OPENAPI_SOCKET = '/var/run/trim_open_gateway_apiscope.socket';
const NAS_EXT = new Set(['apk', 'xapk', 'apkm']);

// 通过 Unix Socket 调 fnOS 后端 API（POST /api/v1/trimapp，Bearer TRIM_API_TOKEN）
function trimCall(reqName, data) {
  return new Promise((resolve, reject) => {
    const token = process.env.TRIM_API_TOKEN;
    if (!token) return reject(new Error('TRIM_API_TOKEN 未注入'));
    const body = JSON.stringify({ reqId: String(Date.now()), req: reqName, appName: APP_NAME, data });
    const rq = http.request({
      socketPath: OPENAPI_SOCKET, path: '/api/v1/trimapp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'Content-Length': Buffer.byteLength(body) },
    }, (rs) => {
      let d = ''; rs.on('data', (c) => { d += c; }); rs.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    rq.on('error', reject);
    rq.write(body); rq.end();
  });
}

function json(res, code, obj) { const s = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(s); }

// 只允许 /vol 卷下、扩展名合规、不含越权的绝对路径
function nasPathOk(p) {
  if (typeof p !== 'string' || !p.startsWith('/vol')) return false;
  if (p.includes('\0') || p.includes('..')) return false;
  const norm = path.posix.normalize(p);
  if (norm !== p) return false;
  const dot = norm.lastIndexOf('.');
  if (dot < 0 || dot < norm.lastIndexOf('/')) return false;
  return NAS_EXT.has(norm.slice(dot + 1).toLowerCase());
}

async function handleNasFile(req, res, url) {
  const uid = Number(req.headers['x-trim-userid']);
  if (!Number.isFinite(uid)) return json(res, 403, { error: 'no-user' });
  const p = url.searchParams.get('path') || '';
  if (!nasPathOk(p)) return json(res, 400, { error: 'bad-path' });
  let acl;
  try { acl = await trimCall('trim.file.checkUserACL', { uid, path: p }); }
  catch (e) { say(`nasfile acl error: ${e.message}`); return json(res, 502, { error: 'acl-check-failed' }); }
  const entry = Array.isArray(acl && acl.data) ? acl.data.find((x) => x.path === p) : null;
  if (!entry || entry.readable !== true) return json(res, 403, { error: 'not-readable' });
  fs.stat(p, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'not-found' });
    const name = p.slice(p.lastIndexOf('/') + 1);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const s = fs.createReadStream(p);
    s.on('error', () => { try { res.destroy(); } catch {} });
    s.pipe(res);
    say(`nasfile serve [uid=${uid}] ${p} (${st.size}B)`);
  });
}

// 列已授权目录里的 apk/xapk/apkm（目录+每个文件都过 ACL 校验），供「选择文件夹」批量入队
async function handleNasList(req, res, url) {
  const uid = Number(req.headers['x-trim-userid']);
  if (!Number.isFinite(uid)) return json(res, 403, { error: 'no-user' });
  let dir = url.searchParams.get('path') || '';
  if (dir.includes('\0') || dir.includes('..') || !dir.startsWith('/vol')) return json(res, 400, { error: 'bad-path' });
  dir = path.posix.normalize(dir);
  if (!process.env.TRIM_API_TOKEN) return json(res, 503, { error: 'no-token' });
  try {
    // 1) 目录本身可读？
    const dAcl = await trimCall('trim.file.checkUserACL', { uid, path: dir });
    const dEntry = Array.isArray(dAcl && dAcl.data) ? dAcl.data.find((x) => x.path === dir) : null;
    if (!dEntry || dEntry.readable !== true) return json(res, 403, { error: 'dir-not-readable' });
    fs.readdir(dir, (err, names) => {
      if (err) return json(res, 404, { error: 'readdir-failed' });
      const cands = [];
      for (const nm of names) {
        if (nm.includes('/') || nm.includes('..')) continue;
        const dot = nm.lastIndexOf('.');
        if (dot < 0 || !NAS_EXT.has(nm.slice(dot + 1).toLowerCase())) continue;
        cands.push(dir.replace(/\/+$/, '') + '/' + nm);
        if (cands.length >= 300) break;
      }
      if (!cands.length) return json(res, 200, { files: [] });
      // 2) 逐个文件再过一遍 ACL，只保留可读
      trimCall('trim.file.checkUserACL', { uid, path: cands }).then((r) => {
        const ok = new Set((Array.isArray(r && r.data) ? r.data : []).filter((x) => x.readable === true).map((x) => x.path));
        const files = cands.filter((p) => ok.has(p)).map((p) => ({ path: p, name: p.slice(p.lastIndexOf('/') + 1) }));
        json(res, 200, { files });
        say(`naslist [uid=${uid}] ${dir} → ${files.length}/${cands.length}`);
      }).catch((e) => { say(`naslist acl error: ${e.message}`); json(res, 502, { error: 'acl-check-failed' }); });
    });
  } catch (e) { say(`naslist error: ${e.message}`); json(res, 502, { error: 'acl-check-failed' }); }
}

// ── 无线调试配对 / 自愈钉端口 ──
const readBody = (req, limit = 4096) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('bad json')); } });
  req.on('error', reject);
});
const isAdmin = (req) => String(req.headers['x-trim-isadmin'] || '').toLowerCase() === 'true';
const apiGuard = (req, res) => {
  if (conf.adminRequired && !isAdmin(req)) { json(res, 403, { error: 'admin-only' }); return false; }
  return true;
};

async function handlePair(req, res) {
  if (!apiGuard(req, res)) return;
  let b;
  try { b = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
  const r = await pairApi.pairFlow({ host: String(b.host || '').trim(), pairPort: b.pairPort, code: b.code, connPort: b.connPort, pinPort: conf.pinPort, log: say });
  json(res, r.status, r.body);
}

async function handleRecover(req, res) {
  if (!apiGuard(req, res)) return;
  let b = {};
  try { b = req.method === 'POST' ? await readBody(req) : {}; } catch (e) { return json(res, 400, { error: e.message }); }
  const host = String(b.host || url_q(req, 'host') || '').trim();
  const r = await pairApi.recoverFlow({ host, quick: b.quick === true, pinPort: conf.pinPort, log: say });
  json(res, r.status, r.body);
}

async function handleDiscover(req, res) {
  if (!apiGuard(req, res)) return;
  const r = await pairApi.discoverFlow({ host: url_q(req, 'host') });
  json(res, r.status, r.body);
}

const url_q = (req, k) => { try { return new URL(req.url, 'http://x').searchParams.get(k) || ''; } catch { return ''; } };

// ── HTTP 服务 ──
const app = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400).end('bad request'); return; }

  const apiPost = `${conf.prefix}/pair`, apiRecover = `${conf.prefix}/recover`;
  if (url.pathname === apiPost && req.method === 'POST') { handlePair(req, res); return; }
  if (url.pathname === apiRecover && (req.method === 'POST' || req.method === 'GET')) { handleRecover(req, res); return; }
  if (url.pathname === `${conf.prefix}/discover` && req.method === 'GET') { handleDiscover(req, res); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('method not allowed');
    return;
  }
  if (url.pathname === `${conf.prefix}/health`) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('boxadb fnos ok\n');
    return;
  }
  if (url.pathname === `${conf.prefix}/nasfile`) { handleNasFile(req, res, url); return; }
  if (url.pathname === `${conf.prefix}/naslist`) { handleNasList(req, res, url); return; }
  // 飞牛入口 url=/app/boxadb 不带斜杠：302 到规范地址，
  // 否则页面里的相对资源（css/js）会解析到 /app/ 下而全部 404。
  if (url.pathname === conf.prefix) {
    res.writeHead(302, { Location: `${conf.prefix}/` }).end();
    return;
  }
  if (url.pathname.startsWith(`${conf.prefix}/`)) {
    servePage(req, res, url);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`only ${conf.prefix}/ is served\n`);
});

app.on('upgrade', handleUpgrade);
app.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });

// ── 启动 ──
const say = (...a) => console.log(new Date().toISOString(), ...a);

function boot() {
  keystore.init(conf.stateDir);
  if (conf.socketPath) {
    try { fs.rmSync(conf.socketPath, { force: true }); } catch {}
    app.listen(conf.socketPath, () => {
      say(`boxadb-fnos ready  socket=${conf.socketPath}  prefix=${conf.prefix}  admin=${conf.adminRequired}  tunnelPort=${conf.tunnelPort}`);
    });
  } else {
    app.listen(conf.devPort, '127.0.0.1', () => {
      say(`boxadb-fnos ready (dev) http://127.0.0.1:${conf.devPort}${conf.prefix}/`);
    });
  }
}
boot();

process.on('SIGTERM', () => { app.close(() => process.exit(0)); if (conf.socketPath) { try { fs.rmSync(conf.socketPath, { force: true }); } catch {} } process.exit(0); });
process.on('SIGINT', () => { app.close(() => process.exit(0)); if (conf.socketPath) { try { fs.rmSync(conf.socketPath, { force: true }); } catch {} } process.exit(0); });
process.on('uncaughtException', (e) => console.error(new Date().toISOString(), 'uncaught:', (e && e.stack) || e));
process.on('unhandledRejection', (r) => console.error(new Date().toISOString(), 'unhandled:', r));
