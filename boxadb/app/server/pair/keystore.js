'use strict';
// 桥的身份与配对凭据：adbkey 私钥、自签证书、每台设备的 psk/identity
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { selfSigned } = require('./x509.js');
const { encodeAdbPubkey } = require('./pubkey.js');

const FILE = 'adb-peer.json';
let dir = '';
let cache = null;

function init(stateDir) {
  dir = stateDir;
  fs.mkdirSync(dir, { recursive: true });
  cache = null;
  return dir;
}
const file = () => path.join(dir, FILE);

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch { cache = { identites: {} }; }
  if (!cache.identites) cache.identites = {};
  return cache;
}
function save() { fs.writeFileSync(file(), JSON.stringify(cache, null, 1), { mode: 0o600 }); }

function identity() {
  const c = load();
  if (c.adbkeyPem && c.certPem) {
    const privateKey = crypto.createPrivateKey(c.adbkeyPem);
    return { privateKey, publicKey: crypto.createPublicKey(privateKey), keyPem: c.adbkeyPem, certPem: c.certPem };
  }
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  c.adbkeyPem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  c.certPem = selfSigned(kp).pem;
  c.pubkeyB64 = encodeAdbPubkey(kp.publicKey).toString('base64');
  save();
  return { privateKey: crypto.createPrivateKey(c.adbkeyPem), publicKey: kp.publicKey, keyPem: c.adbkeyPem, certPem: c.certPem };
}

function remember(inst, pskBuf, extra = {}) {
  const c = load();
  c.identites[inst] = { psk: pskBuf.toString('hex'), ...extra, at: new Date().toISOString() };
  save();
}
const lookup = inst => load().identites[inst] || null;
function list() {
  const c = load();
  return Object.entries(c.identites).map(([instance, v]) => ({ instance, port: v.port || null, at: v.at || null }));
}
function forget(inst) { delete load().identites[inst]; save(); }
const fingerprint = () => {
  const c = load();
  if (!c.certPem) return null;
  try { return crypto.createHash('sha256').update(fs.readFileSync(file())).digest('hex').slice(0, 12); } catch { return null; }
};

module.exports = { init, identity, remember, lookup, list, forget, fingerprint };
