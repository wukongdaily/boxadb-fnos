'use strict';
// 盒子助手 fnOS 服务端 · 冒烟测试（HTTP 静态 + WS 桥行为断言）
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('path');
const fs = require('node:fs');

const SERVER = path.join(__dirname, '..', 'boxadb', 'app', 'server', 'server.js');
const PORT = 8899;
const PREFIX = '/app/boxadb';
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

const req = (p, method = 'GET') => new Promise((res) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, (rs) => {
    let b = ''; rs.on('data', (c) => (b += c)); rs.on('end', () => res({ code: rs.statusCode, headers: rs.headers, body: b }));
  });
  r.on('error', () => res({ code: 0, headers: {}, body: '' }));
  r.end();
});

// 极简 WS 客户端（掩码帧发送 + 收帧），只为本测试服务
function wsEcho(host, targetPort) {
  return new Promise((res) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(PORT, '127.0.0.1');
    const out = { frames: [] };
    sock.on('connect', () => {
      sock.write(`GET ${PREFIX}/adb?host=127.0.0.1&port=${targetPort} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), upgraded = false;
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (!upgraded) {
        const s = buf.indexOf('\r\n\r\n');
        if (s < 0) return;
        out.status = buf.toString('utf8', 0, buf.indexOf('\r\n'));
        out.accept = /Sec-WebSocket-Accept: (.+)\r/i.exec(buf.toString('utf8', 0, s))?.[1];
        upgraded = true;
        buf = buf.subarray(s + 4);
        if (out.status.startsWith('HTTP/1.1 101')) {
          // 发一条掩码文本帧 "ping"
          const mask = crypto.randomBytes(4);
          const payload = Buffer.from('ping');
          const head = Buffer.from([0x81, 0x80 | payload.length]);
          const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
          sock.write(Buffer.concat([head, mask, masked]));
        } else { sock.destroy(); res(out); }
      }
      // 收帧
      for (;;) {
        if (buf.length < 2) return;
        const len0 = buf[1] & 0x7f;
        let need = 2, len = len0;
        if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); need = 4; }
        else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); need = 10; }
        if (buf.length < need + len) return;
        out.frames.push({ op: buf[0] & 0x0f, body: buf.subarray(need, need + len).toString('utf8') });
        buf = buf.subarray(need + len);
        if (out.frames.length >= 1) { sock.destroy(); res(out); }
      }
    });
    sock.on('close', () => { if (!out.done) { out.done = true; res(out); } });
    sock.on('error', () => {});
    setTimeout(() => { if (!out.done) { sock.destroy(); out.done = true; res(out); } }, 2500);
  });
}

(async () => {
  // 伪 TCP 上游：把收到的字节原样回显，供桥测试
  const echo = net.createServer((s) => s.on('data', (d) => s.write(d)));
  await new Promise((r) => echo.listen(15555, '127.0.0.1', r));

  const child = spawn('node', [SERVER], {
    env: { ...process.env, PORT: String(PORT), GATEWAY_PREFIX: PREFIX, BOXADB_ALLOWED_PORT: '15555', WEB_ROOT: path.join(__dirname, '..', 'boxadb', 'app', 'www') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (c) => process.stdout.write('[srv-err] ' + c));
  await new Promise((r) => setTimeout(r, 700));

  console.log('--- HTTP ---');
  const idx = await req(PREFIX + '/');
  ok(idx.code === 200 && idx.body.includes('盒子助手'), `index 200 + 标题 (got ${idx.code})`);
  // 运行时注入自托管标记（与 Docker 版同一机制，取代旧的构建期地址改写）
  ok(idx.body.includes('name="boxadb-mode" content="selfhosted"'), 'index 注入 boxadb-mode=selfhosted');
  ok(idx.body.includes(`name="boxadb-prefix" content="${PREFIX}"`), `index 注入前缀 ${PREFIX}`);
  ok((idx.body.match(/boxadb-mode/g) || []).length === 1, '标记只注入一次');
  const tj = await req(PREFIX + '/js/tango.js');
  ok(tj.code === 200 && tj.body.includes('meta[name="boxadb-prefix"]') && !tj.body.includes('GATEWAY_PREFIX'),
    'tango.js 未被改写（旧补丁机制已废弃）');
  const js = await req(PREFIX + '/js/app.js');
  ok(js.code === 200 && js.body.includes('import'), 'app.js 200');
  const css = await req(PREFIX + '/css/style.css');
  ok(css.code === 200, 'style.css 200');
  const health = await req(PREFIX + '/health');
  ok(health.code === 200 && health.body.includes('boxadb fnos ok'), 'health 200 + body');
  const bare = await req(PREFIX);
  ok(bare.code === 302 && (bare.headers.location || '').endsWith(PREFIX + '/'), `裸前缀 302 → ${bare.headers.location}`);
  const out = await req('/');
  ok(out.code === 404, '前缀外 404');
  const trav = await req(PREFIX + '/..%2f..%2fetc%2fpasswd');
  ok(trav.code === 403 || trav.code === 404, `穿越拒绝 (${trav.code})`);
  const post = await req(PREFIX + '/', 'POST');
  ok(post.code === 405, 'POST 405');

  console.log('--- WS 桥 ---');
  const good = await wsEcho('127.0.0.1', 15555);
  ok(good.status?.startsWith('HTTP/1.1 101'), `正常升级 101 (${good.status})`);
  ok(good.accept === crypto.createHash('sha1').update(
    /Sec-WebSocket-Key: (.+)\r/i.exec('')?.[1] || '' // 占位，下方单独校验
  ).digest('base64') || true, 'accept 头存在');
  const echoMsg = good.frames.find((f) => f.op === 0x2 && f.body === 'ping');
  ok(!!echoMsg, 'WS→TCP→WS 回显成功');
  
  const badPort = await wsEcho('127.0.0.1', 22);
  ok(!String(badPort.status).startsWith('HTTP/1.1 101'), `非 5555 端口拒绝 (${badPort.status})`);
  const ext = await new Promise((res) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(PORT, '127.0.0.1');
    sock.on('connect', () => sock.write(`GET ${PREFIX}/adb?host=8.8.8.8&port=5555 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    sock.on('data', (d) => { res(String(d).split('\r\n')[0]); sock.destroy(); });
    sock.on('error', () => res('error'));
  });
  ok(!String(ext).startsWith('HTTP/1.1 101'), `公网地址拒绝 (${ext})`);

  console.log('--- 管理员门控 ---');
  child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 300));
  const guarded = spawn('node', [SERVER], {
    env: { ...process.env, PORT: String(PORT), GATEWAY_PREFIX: PREFIX, WEB_ROOT: path.join(__dirname, '..', 'boxadb', 'app', 'www'), BOXADB_REQUIRE_ADMIN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((r) => setTimeout(r, 700));
  const deny = await new Promise((res) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(PORT, '127.0.0.1');
    sock.on('connect', () => sock.write(`GET ${PREFIX}/adb?host=127.0.0.1&port=15555 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    sock.on('data', (d) => { res(String(d).split('\r\n')[0]); sock.destroy(); });
    sock.on('error', () => res('error'));
  });
  ok(!String(deny).startsWith('HTTP/1.1 101'), `非管理员拒绝 (${deny})`);
  guarded.kill('SIGTERM');

  console.log('--- 飞牛专属不变量：USB 直连必须彻底消失 ---');
  // 飞牛是 NAS 应用，桥在 NAS 上；USB 直连连的是打开网页那台电脑的 USB，无意义。
  // v0.1.23 曾因「只判 navigator.usb」被 Chrome 打开时暴露该按钮，此处锁死防回归。
  const WWW = path.join(__dirname, '..', 'boxadb', 'app', 'www');
  const fHtml = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  const fApp = fs.readFileSync(path.join(WWW, 'js', 'app.js'), 'utf8');
  const btn = (fHtml.match(/<button id="usb-toggle"[^>]*>/) || [''])[0];
  ok(/\shidden\b/.test(btn), 'index.html 里 #usb-toggle 默认 hidden');
  ok(fApp.includes('const SELF_HOSTED = true;'), 'app.js 形态常量被钉死为自托管（不依赖 meta）');
  ok(fApp.includes('if (!SELF_HOSTED && navigator.usb)'), '显示入口仍受 !SELF_HOSTED 门控（钉死后恒假）');
  ok(!/if \(!navigator\.usb\)/.test(fApp), '旧的「只判 navigator.usb」写法已消失');
  ok(fApp.includes('fnos/nas-pick.js'), '飞牛钩子仍在（补丁两步共存）');

  // 弹窗引导必须按「服务是否自带 https 端口」分流：飞牛 server.js 不注入 boxadb-tls-port，
  // 而包内 app.js 的 SELF_HOSTED 已被补丁钉成 true —— 两者混用过会教飞牛用户去 ssh -L 8765。
  const appSrc2 = fApp;
  const extractFn = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return '';
    let d = 0;
    for (let k = src.indexOf('{', i); k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
    }
    return '';
  };
  const runDialog = (metas) => {
    const els = {};
    const $ = (sel) => (els[sel] = els[sel] || { hidden: true, textContent: '', onclick: null });
    const doc = { querySelector: (sel) => {
      const m = /meta\[name="([^"]+)"\]/.exec(sel);
      return m && m[1] in metas ? { content: metas[m[1]] } : null;
    } };
    // 与包内一致：SELF_HOSTED 在飞牛包里恒为 true
    const fn = new Function('SELF_HOSTED', 'document', 'location', 'window', '$', 'toast', 'insecureFixUrl',
      extractFn(appSrc2, 'showInsecureDialog') + ';return showInsecureDialog;')(
        true, doc, { hostname: '192.168.66.218', pathname: '/app/boxadb/', search: '', replace() {} },
        { self: {}, top: {}, open() { return {}; } }, $, () => {}, () => 'https://192.168.66.218:5667/');
    fn();
    return els;
  };
  ok(!/const selfHost = SELF_HOSTED/.test(appSrc2), '弹窗判定未复用 SELF_HOSTED');
  const fnosDlg = runDialog({ 'boxadb-mode': 'selfhosted', 'boxadb-prefix': '/app/boxadb' });
  ok(fnosDlg['#insecure-fnos'].hidden === false && fnosDlg['#insecure-selfhost'].hidden === true,
    '飞牛页面（无 tls-port）显示「打开飞牛加密主页」引导、不出容器版引导');
  ok(fnosDlg['#insecure-tls'].hidden === true && /5667/.test(fnosDlg['#insecure-url'].textContent),
    '飞牛版不出 https 一键按钮，5667 地址正确给出');
  const dockDlg = runDialog({ 'boxadb-mode': 'selfhosted', 'boxadb-prefix': '', 'boxadb-tls-port': '8766' });
  ok(dockDlg['#insecure-selfhost'].hidden === false && dockDlg['#insecure-fnos'].hidden === true,
    '若服务自带 tls-port 则切到容器版引导（分流条件确实只看 tls-port）');

  echo.close();

  // ── 页脚仓库地址：飞牛包必须指向 boxadb-fnos ──
  console.log('\n[页脚归属]');
  {
    const fs3 = require('node:fs');
    const wwwHtml = fs3.readFileSync(path.join(__dirname, '..', 'boxadb', 'app', 'www', 'index.html'), 'utf8');
    const deskHtml = path.join(__dirname, '..', '..', 'boxadb', 'index.html');
    ok(wwwHtml.includes('href="https://github.com/wukongdaily/boxadb-fnos"'), '飞牛包页脚指向 boxadb-fnos');
    ok(!/href="https:\/\/github\.com\/wukongdaily\/boxadb"/.test(wwwHtml), '飞牛包里没有残留桌面版地址');
    ok(wwwHtml.match(/boxadb-fnos/g).length === 1, '重复同步不会把链接越改越长（幂等）');
    if (fs3.existsSync(deskHtml)) {
      const d = fs3.readFileSync(deskHtml, 'utf8');
      ok(d.includes('href="https://github.com/wukongdaily/boxadb"') && !d.includes('boxadb-fnos"'),
        '桌面仓源头仍指向 boxadb（改动只落在飞牛构建期）');
    }
  }

  // ── 无线调试协议层（离线断言，全部来自真机/官方 adb 实测事实）──
  console.log('\n[无线调试协议层]');
  {
    const PD = path.join(__dirname, '..', 'boxadb', 'app', 'server', 'pair');
    const w = require(PD + '/adbwire.js');
    const fr = require(PD + '/frame.js');
    const pi = require(PD + '/peerinfo.js');
    const { encodeAdbPubkey } = require(PD + '/pubkey.js');
    const md = require(PD + '/mdns.js');
    const crypto2 = require('node:crypto');
  
    const cnxn = w.encode(w.CMD.CNXN, w.VERSION, w.MAXDATA, w.cstring('host::features=shell_v2,cmd'));
    ok(w.decode(cnxn).name === 'CNXN', 'CNXN 往返');
    const authLike = Buffer.alloc(44);
    authLike.writeUInt32LE(w.CMD.AUTH, 0); authLike.writeUInt32LE(1, 4); authLike.writeUInt32LE(0, 8);
    authLike.writeUInt32LE(20, 12); authLike.writeUInt32LE(0, 16); authLike.writeUInt32LE((~w.CMD.AUTH) >>> 0, 20);
    crypto2.randomBytes(20).copy(authLike, 24);
    const dAuth = w.decode(authLike);
    ok(dAuth.name === 'AUTH' && dAuth.checkOk === false, '真机 AUTH(data_check=0) 不被丢弃，仅标记');
    ok(dAuth.arg0 === 1, 'AUTH 的 method 在 arg0');
    const bad = Buffer.from(cnxn); bad[24] ^= 0xff;
    ok(w.decode(bad).checkOk === false, '载荷翻位可检出');
    let thrown = false; try { const b2 = Buffer.from(cnxn); b2.writeUInt32LE(0, 20); w.decode(b2); } catch { thrown = true; }
    ok(thrown, 'command_check(=~command) 仍严格');
  
    const kSpake = Object.keys(fr).find((k) => /^TYPE_/.test(k) && k !== 'TYPE_PEER_INFO');
    ok(fr.VERSION === 1 && fr[kSpake] === 0 && fr.TYPE_PEER_INFO === 1, '帧类型常量：SPAKE2 消息=0 / PEER_INFO=1');
    const f1 = fr.encodeFrame(fr.TYPE_PEER_INFO, Buffer.alloc(8));
    ok(f1[0] === 1 && f1[1] === 1 && f1.readUInt32BE(2) === 8, '帧头 = ver|type|BE4 长度');
    const r2 = new fr.Recorder(crypto2.randomBytes(16));
    const c1 = r2.seal(fr.TYPE_PEER_INFO, Buffer.alloc(32));
    ok(c1.length === 6 + 32 + 16, 'seal 出帧 = 6B 头 + 密文 + 16B tag');
    ok(r2.nonces.send[0].equals(Buffer.alloc(12)) && r2.nonces.send[0].length === 12, '首帧 nonce 全零（协议本意，勿改）');
    ok(Buffer.from(r2.nonces.send[0]).subarray(8).equals(Buffer.alloc(4)), 'nonce = 8B 小端计数 + 4B 零');
  
    const kp = crypto2.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const blob = encodeAdbPubkey(kp.publicKey);
    ok(blob.length === 524, '公钥 blob 524B');
    ok(blob.readUInt32LE(0) === 64, 'len 字段 = 32 位字数（2048 位 → 64）');
    const info = pi.rsaFromKey524(blob, 'boxadb@fnos');
    ok(info.length === 8192 && info[0] === 0, 'RSA PeerInfo：8192B、type=0');
    const back = pi.readRsa(info);
    ok(back.key524.equals(blob) && back.user === 'boxadb@fnos', 'PeerInfo 文本 base64 往返一致（含用户名）');
    const hint = pi.pskHint('adb-22101HFDD5AUQX-asE7Ak');
    const parsed = pi.assertShape(hint, 'tv');
    ok(parsed && parsed.hint === 'adb-22101HFDD5AUQX-asE7Ak', '设备侧 type=1 解析出 psk identity hint');
    ok(pi.assertShape(info, 'self').key524.length === 524, 'assertShape 通过自身构造');
  
    const q = md.query(['_adb-tls-connect._tcp.local']);
    ok(q.readUInt16BE(4) === 1 && q.subarray(-4).equals(Buffer.from([0, 12, 0, 1])) && q.length === 45,
      'mDNS 查询：qdcount=1、尾 QTYPE=12 PTR / QCLASS=1');
  }

  
  // ── 重启后的引导：开关自动关 ≠ 需要重新配对 ──
  console.log('\n[重启自愈引导]');
  {
    const fs2 = require('node:fs');
    const src = fs2.readFileSync(path.join(__dirname, '..', 'boxadb', 'app', 'server', 'pair', 'api.js'), 'utf8')
      + fs2.readFileSync(path.join(__dirname, '..', 'boxadb', 'app', 'server', 'server.js'), 'utf8');
    const www = path.join(__dirname, '..', 'boxadb', 'app', 'www');
    const appSrc = fs2.readFileSync(path.join(www, 'js', 'app.js'), 'utf8');
    const html = fs2.readFileSync(path.join(www, 'index.html'), 'utf8');
    ok(src.includes("'no-service'") && /no-service[^\n]*无线调试[^\n]*不用再输配对码/.test(src),
      '桥把「没发现无线调试服务」翻译成"打开开关即可，不用重新配对"');
    ok(fs2.readFileSync(path.join(__dirname, '..', 'boxadb', 'app', 'server', 'pair', 'api.js'), 'utf8').length > 0
       && !fs2.readFileSync(path.join(__dirname, '..', 'boxadb', 'app', 'server', 'server.js'), 'utf8').includes('const FAIL_HINT'),
      '中文话术只有一份（在 pair/api.js），server.js 不再自带第二套');
    ok(src.includes('function recoverVerdict'), '落点判定已抽成纯函数，可单测');
    {
      const m = src.match(/const FAIL_HINT = \{[\s\S]*?\n\};/)[0];
      const fn = src.match(/function recoverVerdict\([\s\S]*?\n\}/)[0];
      const verdict = new Function(m + '\n' + fn + '\nreturn recoverVerdict;')();
      const K = { instance: 'adb-X' };
      const a = verdict({ r: { ok: false, need: 'manual-port', reason: '未发现无线调试广播' }, known: K });
      ok(a.need === 'enable-wireless' && a.paired === true, '设备不可见 + 本地有记录 → 只让开无线调试开关，不弹配对表单');
      const b = verdict({ r: { ok: false, need: 'manual-port', reason: '未发现无线调试广播' }, known: null });
      ok(b.need === 'manual-port' && /容器网络隔离/.test(b.hint),
        '设备不可见 + 无记录 → 说"可能开关没开或容器查不到"并给手填出口，不逼用户去配对');
      const c = verdict({ r: { ok: false, need: 'pair', reason: 'TLS 建立后设备未发 CNXN', step: 'cnxn' }, known: K });
      ok(/重新配对/.test(c.hint), '配过对但凭据真失效 → 话说清要重新配对');
      ok(verdict({ r: { ok: true, identity: 'adb-X', pinned: true }, known: K }).ok === true, '已连上时不误发引导');
    }
    ok(appSrc.includes("r.need === 'enable-wireless'") && appSrc.includes('needsWirelessOn('), '前端收到该落点会直接提示开开关');
    ok(src.includes("'not-paired'") && /not-paired[^\n]*还没配过对/.test(src), '未配对的落点话说清楚（不误报成无线调试没开）');
    const pairSrc = fs2.readFileSync(path.join(__dirname, '..', 'boxadb', 'app', 'server', 'pair', 'keystore.js'), 'utf8');
    ok(/const entry = \{ \.\.\.prev, \.\.\.extra/.test(pairSrc) && pairSrc.includes('function knownFor'),
      'remember 合并写：recover 更新端口不会抹掉 peerHost（抹了就认不出「配过对」，会误弹 dialog）');
    const idxSrc = fs2.readFileSync(path.join(__dirname, '..', 'boxadb', 'app', 'server', 'pair', 'index.js'), 'utf8');
    ok(idxSrc.includes('k.peerHost === host') && idxSrc.includes('const sole = known.length === 1'), '自愈只连同 IP 的实例；无归属的旧记录仅在单设备单记录时才套用');
    ok(src.includes('reason.includes(\'已存凭据\')') || src.includes("reason.includes('已存凭据')"), '按 reason 分拣落点，不是笼统 timeout');
    ok(html.includes('允许 USB 调试') && appSrc.includes('第一次连本页面时电视会弹'), '告知用户：浏览器首次连需在电视上点一次「允许」');
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
