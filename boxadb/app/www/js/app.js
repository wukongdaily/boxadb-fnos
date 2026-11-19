'use strict';
import * as BoxTerm from './terminal.js';
import * as Icons from './icons.js';

// 自托管形态（Docker / 飞牛应用）由服务端在 index.html 注入这个 meta。
// 该形态下桥跑在 NAS 上，「USB 直连」连的是打开网页那台电脑的 USB，
// 与「远端桥走网络」的定位冲突，所以整个入口不渲染；Pages / 桌面版才显示。
const SELF_HOSTED = true;  // 飞牛=NAS 应用，永不自助 USB；此常量由 patch-app-fnos.py 钉死

const state = {
  connected: false,
  connecting: false,
  demo: false,
  device: null,
  ip: '',
  prefs: {},
  appsScope: 'third', // 应用管理分组：third 第三方 / system 系统
};

// ── 小工具（function 声明，避免顶层调用时的 TDZ）────────
function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function loadPrefs() { try { return JSON.parse(localStorage.getItem('boxadb') || '{}'); } catch { return {}; } }
function savePrefs() { try { localStorage.setItem('boxadb', JSON.stringify(state.prefs)); } catch {} }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function formatBytes(n){ const u=['B','KB','MB','GB']; let i=0; while(n>=1024&&i<3){n/=1024;i++;} return n.toFixed(n<10&&i?1:0)+' '+u[i]; }
function hue(str){ let h=0; for(let i=0;i<(str||'').length;i++) h=(h*31+str.charCodeAt(i))>>>0; return `hsl(${h%360} 50% 34%)`; }
function toast(msg, kind='info', ms=2800){ const el=document.createElement('div'); el.className='toast'+(kind!=='info'?' '+kind:''); el.textContent=msg; $('#toasts').appendChild(el); setTimeout(()=>{el.style.opacity='0';el.style.transition='opacity .2s';},ms-200); setTimeout(()=>el.remove(),ms); }

// ── 惰性加载传输层 ─────────────────────────────────────
let _t = null;
async function tango() { if (!_t) _t = await import('./tango.js'); return _t; }

// 连接失败后，请服务端自动发现并确保 5555 可用（最多等 15 秒；超时/出错返回 null）
async function discoverPort(ip){
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch {} }, 15000) : null;
  try {
    const r = await fetch(`discover?host=${encodeURIComponent(ip)}`, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    return await r.json().catch(() => null);
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); }
}

// ── 假设备（仅 ?demo=1 预览用）─────────────────────────
function demoDevice(ip='192.168.66.172'){ return { brand:'ONN', model:'ONN Google TV (Android 14)', android:'Android 14（SDK 34）', cpu:'Amlogic S905X4', gpu:'Mali-G31', arch:'64 位', mem:'可用 1.2 GB / 共 2.9 GB', resolution:'3840 × 2160', appCount:'18 个', uptime:'2 天 6 小时', storageText:'已用 4.1 GB / 共 11 GB（剩 6.9 GB）', storagePct:37, addr:`${ip}:5555` }; }
const DEMO_APPS = [
  { pkg:'com.netflix.ninja', name:'Netflix' }, { pkg:'com.google.android.youtube.tv', name:'YouTube' },
  { pkg:'tv.pluto.android', name:'Pluto TV' }, { pkg:'org.xbmc.kodi', name:'Kodi' },
  { pkg:'com.spotify.tv.android', name:'Spotify' }, { pkg:'com.plexapp.android', name:'Plex' },
];
const DEMO_SYSTEM_APPS = [
  { pkg:'com.android.settings', name:'设置' }, { pkg:'com.android.systemui', name:'系统界面' },
  { pkg:'com.google.android.tv', name:'电视服务' }, { pkg:'com.android.bluetooth', name:'蓝牙' },
  { pkg:'com.google.android.gms', name:'Google 服务', disabled:true }, { pkg:'com.android.providers.media', name:'媒体存储' },
];

// ── 顶栏 & 连接 ────────────────────────────────────────
function renderStatus() {
  const pill=$('#status-pill'), btn=$('#connect-btn');
  if (state.connecting)     { pill.className='pill busy'; pill.textContent=state.demo?'演示中':'连接中…'; btn.textContent='断开'; btn.disabled=true; }
  else if (state.connected) { pill.className='pill on';   pill.textContent=state.demo?'演示中':'已连接';   btn.textContent='断开'; btn.disabled=state.demo; }
  else                      { pill.className='pill off';  pill.textContent='未连接'; btn.textContent='连接'; btn.disabled=false; }
  renderDeviceInfo();
  if (typeof updateSummary==='function') updateSummary();
}
function renderDeviceInfo(){
  const d=state.device;
  const set=(id,v)=>{const e=$(id); if(e) e.textContent=v;};
  set('#i-model',d?.model??'—'); set('#i-brand',d?.brand??'—'); set('#i-android',d?.android??'—');
  set('#i-cpu',d?.cpu??'—'); set('#i-gpu',d?.gpu??'—'); set('#i-arch',d?.arch??'—');
  set('#i-mem',d?.mem??'—'); set('#i-res',d?.resolution??'—');
  set('#i-appcount',d?.appCount??'—'); set('#i-uptime',d?.uptime??'—');
  set('#i-storage',d?.storageText??'—');
  const pct=(d&&d.storagePct)||0;
  const pctEl=$('#i-storage-pct'); if(pctEl) pctEl.textContent=d?`· 已用 ${pct}%`:'';
  const bar=$('#i-storage-bar'); if(bar){ bar.style.width=Math.min(100,pct)+'%'; bar.style.background=pct>90?'var(--danger)':(pct>70?'var(--warn)':'var(--accent)'); }
}
async function doConnect() {
  if (state.demo) return;
  // crypto.subtle 只在安全上下文（https 或 localhost）可用——没有它无法生成 ADB 密钥
  if (!(window.isSecureContext && window.crypto && window.crypto.subtle)) {
    showInsecureDialog(); return;
  }
  if (state.connected) { const T=await tango(); await T.disconnect(); BoxTerm.closeSession(); Icons.reset(); state.connected=false; state.device=null; renderStatus(); toast('已断开','warn'); return; }
  const ip=$('#device-ip').value.trim();
  state.ip=ip; state.prefs.ip=ip; savePrefs();
  state.connecting=true; renderStatus();
  let explained=false;   // 已经给过具体原因的提示，就不再叠加一条通用报错
  try {
    const T=await tango();
    try {
      await T.connect({ ip });                     // 原有路径：能连上的电视完全不受影响
    } catch (firstErr) {
      // 连不上才尝试「自动准备 5555」（Android 11+ 电视重启后 adbd 会改用随机端口）
      const info=await discoverPort(ip);
      if(info&&info.ok&&info.repaired){
        toast('已自动切换端口，重连中...');
        await T.connect({ ip, port: info.port });
      }else{
        if(info&&info.needPair){
          // 只有"已发现端口但未授权"才需要配对：短提示 + 闪烁按钮
          toast('Chromecast with Google TV 首次连接请先配对（点右上角闪烁的「配对」）','warn',6000);
          revealPairBtn(true);
          explained=true;
        }else if(info&&info.error){
          // 其它情况（如无线调试没开、没装 adb）只提示，不显示配对按钮
          // —— 这时配对也帮不上忙，用户该先按提示开启/安装
          toast(info.error,'warn',6000); explained=true;
        }
        throw firstErr;
      }
    }
    state.device=await T.fetchDevice(ip);
    state.connected=true;
    hidePairBtn();   // 连接成功就收起「配对」（它只是按需提示，不该常驻）
    toast(`已连接：${state.device.brand} ${state.device.model}`);
  } catch (err) {
    if(!explained) toast(err.message,'err',4200);
  } finally { state.connecting=false; renderStatus(); if (state.connected) refreshApps(); }
}
async function doConnectUsb() {
  if (state.demo) return;
  if (!(window.isSecureContext && window.crypto && window.crypto.subtle)) {
    showInsecureDialog(); return;
  }
  if (state.connected) { toast('已连接；如需换连接方式，请先点上方「断开」。', 'warn'); return; }
  state.connecting=true; renderStatus();
  try {
    const T=await tango();
    await T.connectUsb();
    state.device=await T.fetchDevice('USB');
    state.connected=true;
    toast(`已连接（USB）：${state.device.brand} ${state.device.model}`);
  } catch (err) {
    toast('USB 连接失败：'+err.message,'err',4800);
  } finally { state.connecting=false; renderStatus(); if (state.connected) refreshApps(); }
}
function bindHeader(){
  $('#connect-btn').addEventListener('click', doConnect);
  $('#device-ip').addEventListener('keydown', e=>{ if(e.key==='Enter') doConnect(); });
  const ut=$('#usb-toggle'); if (ut) ut.addEventListener('click', ()=>{ const p=$('#usb-panel'); if (p) p.hidden=!p.hidden; });
  const ub=$('#connect-usb-btn'); if (ub) ub.addEventListener('click', doConnectUsb);
  const uc=$('#usb-close'); if (uc) uc.addEventListener('click', ()=>{ const p=$('#usb-panel'); if (p) p.hidden=true; });
  // HTML 里默认 hidden：仅 Pages / 桌面版 + 浏览器支持 WebUSB 才显示；自托管永不显示
  if (!SELF_HOSTED && navigator.usb) { const t=$('#usb-toggle'); if (t) t.hidden=false; }
  else { const p=$('#usb-panel'); if (p) p.hidden=true; }
  state.prefs=loadPrefs();
  if (state.prefs.ip) $('#device-ip').value=state.prefs.ip;
}

// ── 配对（无线调试）────────────────────────────────────
function openPairModal(){
  const ip=$('#device-ip').value.trim() || state.prefs.ip || '';
  const m=$('#pair-modal'); if(!m) return;
  m.classList.remove('hidden');
  const b=$('#pair-btn'); if(b) b.classList.remove('blink');   // 找到入口了就停止闪烁
  $('#pair-hint').textContent = ip ? `目标：${ip}` : '请先在上方填写盒子 IP';
  const p=$('#pair-port'); if(p){ p.value=''; p.focus(); }
  const c=$('#pair-code'); if(c) c.value='';
}
function closePairModal(){ $('#pair-modal')?.classList.add('hidden'); }
// 默认隐藏「配对」按钮：只有连不上且原因是"无线调试/未授权"时才显示，
// 避免对普通 Android TV 用户造成误导（他们根本不需要配对）
function revealPairBtn(blink){ const b=$('#pair-btn'); if(b){ b.style.display=''; b.classList.toggle('blink', !!blink); } }
function hidePairBtn(){ const b=$('#pair-btn'); if(b){ b.style.display='none'; b.classList.remove('blink'); } }
function bindPair(){
  $('#pair-btn')?.addEventListener('click', openPairModal);
  $('#pair-cancel')?.addEventListener('click', closePairModal);
  $('#pair-modal')?.addEventListener('click', e=>{ if(e.target && e.target.id==='pair-modal') closePairModal(); });
  document.addEventListener('keydown', e=>{ if(e.key==='Escape') closePairModal(); });
  $('#pair-submit')?.addEventListener('click', async ()=>{
    const ip=$('#device-ip').value.trim();
    const port=Number($('#pair-port').value.trim());
    const code=$('#pair-code').value.trim();
    if(!ip) return toast('请先填写盒子 IP','err');
    if(!Number.isInteger(port) || port<=0) return toast('请填写配对端口（配对弹窗里 IP 后面的数字）','err');
    if(!/^\d{6}$/.test(code)) return toast('配对码应为 6 位数字','err');
    const btn=$('#pair-submit'); btn.disabled=true;
    $('#pair-hint').textContent='正在配对…（配对弹窗要保持打开）';
    try{
      const r=await fetch('pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:ip,port,code})});
      const info=await r.json().catch(()=>null);
      if(info&&info.ok){ toast('配对成功，正在连接…'); closePairModal(); setTimeout(doConnect,300); }
      else { const msg=(info&&info.error)||'配对失败'; $('#pair-hint').textContent=msg; toast(msg,'err',5200); }
    }catch(err){ $('#pair-hint').textContent='请求失败：'+err.message; }
    finally{ btn.disabled=false; }
  });
}

// ── 标签页 ─────────────────────────────────────────────
function bindTabs(){
  $$('.tab').forEach(t=>t.addEventListener('click',()=>{
    $$('.tab').forEach(x=>x.classList.remove('active')); t.classList.add('active');
    $$('.panel').forEach(p=>p.classList.add('hidden'));
    const view=$('#view-'+t.dataset.view); view.classList.remove('hidden');
    try { t.scrollIntoView({inline:'center',block:'nearest',behavior:'smooth'}); } catch {}
    if(t.dataset.view==='terminal'){ BoxTerm.open($('#term')); }
  }));
}
// 标签条溢出时，用左右箭头引导“还能滑”；能排下时自动隐藏
function bindTabsNav(){
  const tabs=$('#tabs'); if(!tabs) return;
  const L=$('#tabs-left'), R=$('#tabs-right');
  function refresh(){
    const overflow=tabs.scrollWidth-tabs.clientWidth>2;
    const atL=tabs.scrollLeft<=2;
    const atR=tabs.scrollLeft+tabs.clientWidth>=tabs.scrollWidth-2;
    if(L) L.classList.toggle('show', overflow && !atL);
    if(R) R.classList.toggle('show', overflow && !atR);
  }
  const step=()=>Math.max(140, tabs.clientWidth*0.8);
  tabs.addEventListener('scroll',refresh,{passive:true});
  window.addEventListener('resize',refresh);
  if(L) L.addEventListener('click',()=>tabs.scrollBy({left:-step(),behavior:'smooth'}));
  if(R) R.addEventListener('click',()=>tabs.scrollBy({left:step(),behavior:'smooth'}));
  requestAnimationFrame(refresh);
  window.addEventListener('load',refresh);
}

// ── 安装队列 ───────────────────────────────────────────
function detectKind(n){ n=n.toLowerCase();
  if(n.endsWith('.apk'))return{k:'APK',i:'📱'}; if(n.endsWith('.xapk'))return{k:'XAPK',i:'📦'};
  if(n.endsWith('.apkm'))return{k:'APKM',i:'🧱'}; return{k:'未知',i:'❓'};}
function addFiles(files){ const ul=$('#install-queue');
  for(const f of files){ const {k,i}=detectKind(f.name); const li=document.createElement('li'); li.className='q-item'; li._file=f;
    li.innerHTML=`<div class="q-ic">${i}</div><div class="q-main"><div class="q-name">${escapeHtml(f.name)}</div>
      <div class="q-meta">${formatBytes(f.size)} · ${k} · <span class="status">待安装</span></div><div class="q-bar"><i></i></div></div>
      <span class="badge detect">待安装</span><button class="btn primary q-install">安装</button><button class="q-x" title="移除">×</button>`;
    ul.appendChild(li);
    li.querySelector('.q-x').onclick=()=>{ li.remove(); updateSummary(); };
    li.querySelector('.q-install').onclick=()=>installOne(li);
  }
  updateSummary();
}
function updateSummary(){ const items=$$('#install-queue .q-item'); const n=items.length; const bytes=items.reduce((s,li)=>s+((li._file&&li._file.size)||0),0);
  const sum=$('#queue-summary'); if(sum) sum.textContent = n? `队列 ${n} 个 · ${formatBytes(bytes)}` : '队列为空';
  const all=$('#install-all'); if(all) all.disabled = n===0 || state.demo || !state.connected;
  const clr=$('#clear-queue'); if(clr) clr.disabled = n===0;
}
async function installOne(li){
  const file=li._file; const badge=li.querySelector('.badge'), status=li.querySelector('.status'), btn=li.querySelector('.q-install'), bar=li.querySelector('.q-bar>i');
  if(!state.connected){ toast('请先连接盒子','warn'); return; }
  if(state.demo){ toast('演示模式无设备，连接后才能安装','warn'); return; }
  if(li._installing) return;
  li._installing=true; btn.disabled=true; badge.className='badge detect'; badge.textContent='安装中'; status.textContent='准备…'; bar.style.width='0';
  try{
    const T=await tango();
    await T.installFile(file,(done,total)=>{ const p=Math.min(99,Math.round(done/((total||file.size)||1)*100)); bar.style.width=p+'%'; status.textContent=p+'%'; });
    badge.className='badge ok'; badge.textContent='完成'; bar.style.width='100%'; status.textContent='已安装'; toast(`已安装：${file.name}`);
  }catch(err){ badge.className='badge err'; badge.textContent='失败'; status.textContent=err.message; toast('安装失败：'+err.message,'err',4200); }
  finally{ li._installing=false; btn.disabled=false; updateSummary(); }
}
async function installAll(){ const items=$$('#install-queue .q-item');
  for(const li of items){ const st=li.querySelector('.badge')?.textContent; if(st==='完成'||st==='安装中') continue; await installOne(li); } }
function clearQueue(){ $('#install-queue').innerHTML=''; updateSummary(); }
function bindInstall(){ const dz=$('#dropzone'), input=$('#file-input');
  dz.addEventListener('click',e=>{ if(e.target.tagName!=='BUTTON') input.click(); });
  $('#pick-files').addEventListener('click',()=>input.click());
  input.addEventListener('change',()=>{ addFiles(input.files); input.value=''; });
  ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('drag');}));
  ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('drag');}));
  dz.addEventListener('drop',e=>addFiles(e.dataTransfer.files));
  $('#install-all').addEventListener('click',installAll);
  $('#clear-queue').addEventListener('click',clearQueue);
  updateSummary();
}

// ── 应用管理 ───────────────────────────────────────────
async function refreshApps(){ const body=$('#apps-body');
  if(!state.connected){ body.innerHTML='<div class="empty">未连接设备 — 连接后将在此显示应用列表。</div>'; return; }
  const demoList = state.appsScope==='system' ? DEMO_SYSTEM_APPS : DEMO_APPS;
  if(state.demo){ renderAppGrid(demoList); return; }
  body.innerHTML='<div class="empty">正在读取应用列表…</div>';
  try { const T=await tango(); const apps=await T.listApps({scope:state.appsScope}); renderAppGrid(apps); }
  catch(err){ body.innerHTML=`<div class="empty">读取失败：${escapeHtml(err.message)}</div>`; }
}
function renderAppGrid(apps){ Icons.reset(); const q=($('#app-search').value||'').toLowerCase();
  const list=apps.filter(a=>!q||a.name.toLowerCase().includes(q)||a.pkg.toLowerCase().includes(q));
  const body=$('#apps-body'); if(!list.length){ body.innerHTML='<div class="empty">没有匹配的应用</div>'; return; }
  body.innerHTML='<div class="app-grid"></div>'; const g=body.firstElementChild;
  const sys = state.appsScope==='system';
  for(const a of list){ const card=document.createElement('div'); card.className='app-card'+(a.disabled?' off':'');
    const letter=((a.name||a.pkg||'?').trim().charAt(0)||'?').toUpperCase();
    // 第三方：可卸载；系统：不可卸载，只能禁用/启用，其余三个按钮一致
    const dangerBtn = sys
      ? (a.disabled ? '<button class="mini ok" data-act="enable">启用</button>'
                    : '<button class="mini warn" data-act="disable">禁用</button>')
      : '<button class="mini danger" data-act="uninstall">卸载</button>';
    const offTag = a.disabled ? '<span class="tag-off">已禁用</span>' : '';
    card.innerHTML=`<div class="app-ic" data-pkg="${escapeHtml(a.pkg)}" style="background:${hue(a.pkg)};color:#fff;font-weight:700">${escapeHtml(letter)}</div><div class="app-info"><div class="app-name"><span class="app-name-t">${escapeHtml(a.name)}</span>${offTag}</div>
      <div class="app-pkg">${escapeHtml(a.pkg)}</div><div class="app-acts">
      <button class="mini" data-act="launch">启动</button><button class="mini" data-act="stop">强制停止</button>
      ${dangerBtn}<button class="mini" data-act="clear">清除数据</button></div></div>`;
    card.querySelectorAll('.mini').forEach(b=>b.onclick=()=>appAction(b,a)); g.appendChild(card);
  }
  // 首屏已是字母头像；仅连上真机时后台懒加载补真图标（切走/断开会 Icons.reset 取消）
  if(state.connected && !state.demo){ requestAnimationFrame(()=>Icons.attach(g, tango)); }
}
async function appAction(btn,a){ const act=btn.dataset.act;
  if(!state.connected){ toast('未连接设备','warn'); return; }
  if(act==='uninstall' && !confirm(`确认卸载 ${a.name}？`)) return;
  if(act==='clear' && !confirm(`确认清除 ${a.name} 的数据？`)) return;
  if(act==='disable' && !confirm(`确认禁用系统应用「${a.name}」？\n\n禁用后它将停止运行并从桌面消失，可能影响相关系统功能。\n之后可在本列表点「启用」恢复。`)) return;
  if(state.demo){ toast(`（演示）${act}: ${a.pkg}`,'warn'); return; }
  btn.disabled=true;
  try { const T=await tango();
    if(act==='launch') await T.launch(a.pkg);
    else if(act==='stop') await T.forceStop(a.pkg);
    else if(act==='clear') await T.clearData(a.pkg);
    else if(act==='uninstall'){ await T.uninstall(a.pkg); toast(`已卸载 ${a.name}`); await refreshApps(); }
    else if(act==='disable'){ await T.disableApp(a.pkg); toast(`已禁用 ${a.name}`,'warn'); await refreshApps(); }
    else if(act==='enable'){ await T.enableApp(a.pkg); toast(`已启用 ${a.name}`); await refreshApps(); }
  } catch(err){ toast(act+' 失败：'+err.message,'err'); } finally { btn.disabled=false; }
}
function bindApps(){ $('#refresh-apps').addEventListener('click',refreshApps);
  $('#app-search').addEventListener('input',()=>state.connected&&refreshApps());
  $$('#apps-scope .seg-btn').forEach(b=>b.addEventListener('click',()=>{
    if(state.appsScope===b.dataset.scope) return;
    state.appsScope=b.dataset.scope;
    $$('#apps-scope .seg-btn').forEach(x=>{ const on=x===b; x.classList.toggle('active',on); x.setAttribute('aria-selected',on); });
    $('#app-search').value='';
    refreshApps();
  }));
}

// ── 遥控器 ─────────────────────────────────────────────
function bindRemote(){
  $$('#view-remote .rkey, #view-remote .dp').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!state.connected){ toast('未连接设备','warn'); return; }
    btn.classList.add('flash'); setTimeout(()=>btn.classList.remove('flash'),120);
    const code=btn.dataset.key, label=btn.title||btn.textContent.trim();
    if(state.demo){ toast(`（演示）${label} → keyevent ${code}`,'info',1200); return; }
    try { const T=await tango(); await T.keyevent(code); } catch(err){ toast('按键失败：'+err.message,'err'); }
  }));
  $$('#view-remote .action').forEach(btn=>btn.addEventListener('click',()=>runDeviceAction(btn.dataset.act,btn)));
}
async function runDeviceAction(act,btn){
  if(!state.connected){ toast('未连接设备','warn'); return; }
  const names={screenshot:'截屏',reboot:'重启'};
  const label=names[act]||act;
  if(state.demo){ toast(`（演示）${label}`,'warn'); return; }
  if(act==='reboot' && !confirm('确认重启盒子？')) return;
  btn.disabled=true;
  try { const T=await tango();
    if(act==='screenshot'){ const blob=await T.screenshot(); downloadBlob(blob, `boxadb-${Date.now()}.png`); toast('已截屏并下载'); }
    else if(act==='reboot'){ await T.reboot(''); toast('已发送重启'); }
  } catch(err){ toast(label+' 失败：'+err.message,'err',4200); } finally { btn.disabled=false; }
}
function downloadBlob(blob,name){ const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }

// ── 日志（一次 logcat -d 抓取；连续流下一步接入）────────
function bindLog(){
  $('#log-start').onclick=async()=>{ if(!state.connected){toast('未连接设备','warn');return;} if(state.demo){toast('（演示）日志稍后接入','warn');return;}
    $('#log-out').textContent='拉取中…'; try{ const T=await tango(); $('#log-out').textContent=await T.shell('logcat -d -v brief -t 400'); }catch(err){ $('#log-out').textContent='! '+err.message; } };
  $('#log-clear').onclick=()=>$('#log-out').textContent='';
  $('#log-download').onclick=()=>{ const txt=$('#log-out').textContent; if(!txt){toast('无日志','warn');return;} downloadBlob(new Blob([txt],{type:'text/plain'}),`logcat-${Date.now()}.txt`); };
  $('#log-filter').addEventListener('input',e=>{ /* 过滤展示下一步增强 */ });
}

function bindProto(){ const b=$('#prototype-banner'); if(b) $('#proto-close')?.addEventListener('click',()=>b.remove()); }

// ── 演示预览 ───────────────────────────────────────────
function seedDemo(){ state.demo=true; state.connected=true; state.device=demoDevice(); renderStatus(); renderAppGrid(DEMO_APPS); }

// ── 非加密访问引导（浏览器禁止 http 页面生成 ADB 密钥）────────
// 计算最可能的 https 地址：飞牛默认 5666(http)→5667(https)；http 默认端口→https 默认端口；其余端口原样保留
// 飞牛网关路径（/app/xxx）统一跳「桌面主页」：应用窗口的开关由飞牛桌面自己负责，
// 我们无法用 URL 让它在原窗口里重开（飞牛没有对外的深链），跳主页最一致、也把整个飞牛迁到加密源
function insecureFixUrl(){
  try{
    const u=new URL(location.href);
    let p=u.port;
    if(p==='5666') p='5667';
    else if(p==='80') p='';
    const host=p?`${u.hostname}:${p}`:u.hostname;
    if(/^\/app\//i.test(u.pathname)) return `https://${host}/`;
    return `https://${host}${u.pathname}${u.search}${u.hash}`;
  }catch(err){ return ''; }
}
function showInsecureDialog(){
  const m=$('#insecure-modal'); if(!m) return;
  // 两套引导按「服务是否自带 https 端口」分流，不能复用 SELF_HOSTED：
  //   · 自托管 Go 桥（Docker / NAS 容器）会注入 boxadb-tls-port → 一键切到自己的 https
  //   · 飞牛走统一网关、没有自带端口（加密入口是 5667）→ 显示「打开飞牛加密主页」
  // SELF_HOSTED 只管 WebUSB 入口门控：飞牛同样是自托管形态，但两套引导文案完全不同。
  const tlsPort=(document.querySelector('meta[name="boxadb-tls-port"]')?.content||'').trim();
  const ownTls=/^\d{2,5}$/.test(tlsPort);
  const fnosBox=$('#insecure-fnos'), selfBox=$('#insecure-selfhost');
  if(fnosBox) fnosBox.hidden = ownTls || !SELF_HOSTED;
  if(selfBox) selfBox.hidden = !ownTls;

  // 自带 https 端口时才给一键跳转（桌面 Pages 两个 meta 都没有，按钮自然隐藏）
  const httpsUrl=ownTls
    ? `https://${location.hostname}:${tlsPort}${location.pathname}${location.search}` : '';
  const tbtn=$('#insecure-tls'), turl=$('#insecure-tls-url');
  if(tbtn) tbtn.hidden=!httpsUrl;
  if(turl) turl.textContent=httpsUrl?`将打开：${httpsUrl}`:'';
  if(tbtn) tbtn.onclick=()=>{
    if(window.self===window.top){ location.replace(httpsUrl); return; }
    const w=window.open(httpsUrl,'_blank','noopener');
    if(!w){ toast('浏览器拦住了新标签，请手动把地址里的 http:// 改成 https://','err',8000); return; }
    toast('证书提示页点「高级 → 继续访问」，只需一次即可长期使用','info',7000);
  };
  const url=ownTls?'':insecureFixUrl();
  const s=$('#insecure-url'); if(s) s.textContent=url?`将打开：${url}`:'';
  const b=$('#insecure-fix');
  if(b) b.onclick=()=>{
    if(!url){ toast('无法自动计算地址，请手动修改','warn'); return; }
    // 顶层打开：直接跳转
    if (window.self === window.top) { location.replace(url); return; }
    // iframe 内（飞牛桌面）：必须开新标签——自签证书警告只在整页才能点「继续访问」，iframe 里点了也过不去
    const w=window.open(url, '_blank', 'noopener');
    if(!w){ toast('浏览器拦住了新标签：请手动把地址里的 http:// 改成 https://、端口 5666 改成 5667','err',8000); return; }
    toast('已打开飞牛加密主页：证书提示页点「高级 → 继续访问」，然后在桌面重新点开「盒子助手」','info',8000);
  };
  const l=$('#insecure-later'); if(l) l.onclick=()=>{ m.hidden=true; };
  m.hidden=false;
}

// ── 启动 ───────────────────────────────────────────────
function boot(){
  bindProto(); bindHeader(); bindPair(); bindTabs(); bindTabsNav(); bindInstall(); bindApps(); bindRemote(); bindLog();
  renderStatus();
  // ── 飞牛版钩子（由 patch-app-fnos.py 在构建期注入，桌面源码不含此段）──
  window.__boxadb = { addFiles, toast };
  import('../fnos/nas-pick.js').catch(() => {});
  if (location.search.includes('demo=1')) seedDemo();
  // 非加密页面整个 ADB 流程都不可用 → 打开页面就主动引导（演示模式除外）
  if (!(window.isSecureContext && window.crypto && window.crypto.subtle) && !state.demo) showInsecureDialog();
}
document.addEventListener('DOMContentLoaded', boot);
