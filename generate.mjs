#!/usr/bin/env node
// Correlate $THREE price action with three.ws X (Twitter) posts.
//
// Usage:
//   node scripts/x-post-price-correlation.mjs <posts1.json> [posts2.json ...] [--out reports/x-price]
//
// Handles the three.ws scraper schema ({ tweets:[{ text, timestamp, metrics:{likes,
// retweets,replies,views}, type:{isRetweet,isReply}, url }] }) as well as generic
// array / {data|tweets|posts} shapes. Posts are deduped by tweet id across all files
// and tagged by account (parsed from the status URL).
//
// Price history is pulled from GeckoTerminal (free, no key) for the $THREE pool, and a
// current snapshot from DexScreener. No mocks, no synthetic data.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const POOL = '5ByL7MZoLABYnwMPZKPKjf4MGkZ7FeBzrAnos19Pre2z'; // pumpswap THREE/SOL
const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';

const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const outBase = outArg !== -1 ? args[outArg + 1] : 'scripts/.corr-out';
const acctArg = args.indexOf('--accounts');
const ACCOUNTS = acctArg !== -1 ? args[acctArg + 1].toLowerCase().split(',') : null;
const ownOnly = args.includes('--own');
const valueArgs = new Set([outArg + 1, acctArg + 1].filter((i) => i > 0));
const postsPaths = args.filter((a, i) => !a.startsWith('--') && !valueArgs.has(i));

if (!postsPaths.length) {
  console.error('Usage: node scripts/test-corr.mjs <posts1.json> [posts2.json ...] [--out scripts/.corr-out]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(1000 * (i + 1));
    }
  }
}

// ---- load + normalize posts ----------------------------------------------
// "271K" -> 271000, "1.2M" -> 1200000, "" -> 0
function num(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/,/g, '');
  if (!s) return 0;
  const m = s.match(/^([\d.]+)\s*([KkMmBb]?)$/);
  if (!m) return Number(s) || 0;
  const mult = { '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()];
  return Math.round(parseFloat(m[1]) * mult);
}

function loadFile(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const arr = Array.isArray(raw)
    ? raw
    : raw.data || raw.tweets || raw.posts || raw.results || [];
  if (!Array.isArray(arr)) throw new Error(`No posts array in ${path}`);

  const pick = (o, keys) => keys.map((k) => o[k]).find((v) => v != null);
  return arr.map((p) => {
    const ts = pick(p, ['created_at', 'createdAt', 'date', 'timestamp', 'time']);
    const ms = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts);
    const text = (pick(p, ['text', 'full_text', 'content', 'tweet', 'body']) || '').replace(/\s+/g, ' ').trim();
    const m = p.metrics || p;
    const t = p.type || {};
    const url = p.url || '';
    const account = (url.match(/x\.com\/([^/]+)\/status/) || url.match(/twitter\.com\/([^/]+)\/status/) || [, p.profile || 'unknown'])[1];
    return {
      id: p.id || p.id_str || url || `${account}:${ms}`,
      account,
      url,
      ms, ts,
      text,
      likes: num(pick(m, ['likes', 'like_count', 'favorite_count', 'favoriteCount'])),
      rts: num(pick(m, ['retweets', 'retweet_count', 'retweetCount', 'reposts'])),
      views: num(pick(m, ['views', 'view_count', 'impressions', 'impression_count'])),
      replies: num(pick(m, ['replies', 'reply_count', 'replyCount'])),
      isReply: !!(t.isReply || p.in_reply_to_status_id || p.in_reply_to_user_id || /^@/.test(text)),
      isRT: !!(t.isRetweet || /^RT @/.test(text)),
    };
  }).filter((p) => Number.isFinite(p.ms));
}

function loadPosts(paths) {
  const byId = new Map();
  for (const path of paths) {
    for (const p of loadFile(path)) {
      if (ACCOUNTS && !ACCOUNTS.includes(String(p.account).toLowerCase())) continue;
      if (ownOnly && (p.isReply || p.isRT)) continue; // original posts only
      // keep the record with the most engagement signal on dup id
      const prev = byId.get(p.id);
      if (!prev || p.likes + p.views + p.rts > prev.likes + prev.views + prev.rts) byId.set(p.id, p);
    }
  }
  return [...byId.values()].sort((a, b) => a.ms - b.ms);
}

// ---- price history (paginated hourly OHLCV) -------------------------------
async function fetchOhlcv(timeframe, aggregate, earliestSec) {
  const out = [];
  let before = Math.floor(Date.now() / 1000) + 3600;
  for (let page = 0; page < 12; page++) {
    const url = `${GT}/pools/${POOL}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=1000&before_timestamp=${before}`;
    const j = await getJson(url);
    const list = j?.data?.attributes?.ohlcv_list || [];
    if (!list.length) break;
    out.push(...list);
    const oldest = list[list.length - 1][0];
    if (oldest <= earliestSec) break;
    before = oldest;
    await sleep(400);
  }
  // dedupe + sort ascending: [ts, o, h, l, c, v]
  const map = new Map(out.map((c) => [c[0], c]));
  return [...map.values()].sort((a, b) => a[0] - b[0]);
}

// nearest candle at-or-before t (seconds)
function candleAt(candles, tSec) {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid][0] <= tSec) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans === -1 ? null : candles[ans];
}
const closeAt = (candles, tSec) => candleAt(candles, tSec)?.[4] ?? null;

const pct = (a, b) => (a == null || b == null || b === 0 ? null : ((a - b) / b) * 100);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const std = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? null : num / Math.sqrt(dx * dy);
}

function classify(p) {
  if (p.isRT) return 'retweet';
  if (p.isReply) return 'reply';
  const t = p.text.toLowerCase();
  if (/(launch|announc|introduc|shipp|now live|released|new|update|drop)/.test(t)) return 'announcement';
  if (/\b(gm|gn|wen|lfg|🚀|🔥|ser|fam)\b/.test(t)) return 'engagement';
  return 'other';
}

// ---- chart export (TradingView lightweight-charts, self-contained) --------
const toBars = (raw) => raw.map((c) => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4] }))
  .sort((a, b) => a.time - b.time)
  .filter((b, i, a) => i === 0 || b.time !== a[i - 1].time);

function aggregateDaily(hourly) {
  const days = new Map();
  for (const c of hourly) {
    const d = Math.floor(c[0] / 86400) * 86400;
    const cur = days.get(d);
    if (!cur) days.set(d, { time: d, open: c[1], high: c[2], low: c[3], close: c[4] });
    else { cur.high = Math.max(cur.high, c[2]); cur.low = Math.min(cur.low, c[3]); cur.close = c[4]; }
  }
  return [...days.values()].sort((a, b) => a.time - b.time);
}

function buildChartHtml(payload) {
  const TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>three.ws · posts vs price</title>
<script src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
<style>
  :root{--bg:#0a0b0e;--panel:#12141a;--line:#1e2230;--txt:#e7ecf3;--mut:#8b93a7;--cyan:#22d3ee;--mag:#f472b6;--up:#22c55e;--down:#ef4444}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--txt)}
  header{display:flex;align-items:center;gap:18px;padding:12px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap}
  header h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.2px}
  header .price{color:var(--mut)}
  header .price b{color:var(--txt)}
  .tf{display:flex;gap:6px;margin-left:auto}
  .tf button{background:var(--panel);color:var(--mut);border:1px solid var(--line);border-radius:7px;padding:6px 12px;cursor:pointer;font-weight:600}
  .tf button.on{color:#06121a;background:var(--cyan);border-color:var(--cyan)}
  .legend{display:flex;gap:14px;color:var(--mut);font-size:12px}
  .legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:middle}
  .wrap{display:flex;height:calc(100vh - 53px)}
  #chart{flex:1;position:relative}
  aside{width:340px;border-left:1px solid var(--line);overflow-y:auto;background:var(--panel)}
  aside .head{padding:10px 14px;border-bottom:1px solid var(--line);color:var(--mut);font-size:12px;position:sticky;top:0;background:var(--panel);z-index:2}
  .post{padding:10px 14px;border-bottom:1px solid var(--line);cursor:pointer}
  .post:hover{background:#171a22}
  .post .meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--mut);margin-bottom:4px}
  .badge{font-weight:700;padding:1px 6px;border-radius:5px;font-size:10px}
  .post .body{font-size:12.5px;color:var(--txt);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .ret{margin-left:auto;font-weight:700}
  .ret.up{color:var(--up)}.ret.down{color:var(--down)}
  #ov{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:3}
  .bub{position:absolute;width:26px;height:26px;border-radius:50%;border:2px solid #fff;cursor:pointer;pointer-events:auto;box-shadow:0 2px 9px #000b;transition:transform .1s ease}
  .bub img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}
  .bub:hover{transform:scale(1.3);z-index:6}
  .bub .cnt{position:absolute;right:-7px;top:-7px;background:#0d1017;border:1px solid #fff;color:#fff;font-size:9px;font-weight:800;border-radius:9px;min-width:15px;text-align:center;padding:0 3px;line-height:15px}
  .bub .ann{position:absolute;left:-5px;bottom:-7px;color:#22d3ee;font-size:12px;text-shadow:0 1px 2px #000}
  #tip{position:absolute;pointer-events:none;z-index:9;max-width:300px;background:#0d1017f2;border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:none;box-shadow:0 8px 30px #000a}
  #tip .meta{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--mut);margin-bottom:6px}
  #tip .body{font-size:12.5px;margin-bottom:6px}
  #tip .rets{display:flex;gap:12px;font-size:11px;color:var(--mut)}
  #tip .rets b{font-weight:700}
  a{color:inherit;text-decoration:none}
  /* modal */
  #modal{position:fixed;inset:0;z-index:50;background:#05070bd9;backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;padding:24px}
  #modal.on{display:flex}
  #modal .card{width:min(560px,94vw);max-height:86vh;display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 24px 80px #000c;overflow:hidden;animation:pop .12s ease}
  @keyframes pop{from{transform:scale(.97);opacity:.4}to{transform:scale(1);opacity:1}}
  #modal .mhead{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line);font-size:13px;color:var(--mut);flex:0 0 auto}
  #modal .mhead b{color:var(--txt);font-size:14px}
  #modal .back,#modal .x{cursor:pointer;border:1px solid var(--line);border-radius:7px;padding:4px 9px;color:var(--mut);background:#0d1017}
  #modal .back:hover,#modal .x:hover{color:var(--txt);border-color:#33384a}
  #modal .x{margin-left:auto}
  #modal .mlist{overflow-y:auto}
  #modal .row{display:flex;gap:10px;align-items:flex-start;padding:11px 16px;border-bottom:1px solid var(--line);cursor:pointer}
  #modal .row:hover{background:#171a22}
  #modal .row .av{width:30px;height:30px;border-radius:50%;flex:0 0 auto;border:2px solid var(--line);object-fit:cover}
  #modal .row .rmeta{display:flex;gap:7px;align-items:center;font-size:11px;color:var(--mut);margin-bottom:3px;flex-wrap:wrap}
  #modal .row .rbody{font-size:12.5px;color:var(--txt);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  #modal .row .rret{margin-left:auto;font-weight:800;font-size:12px;white-space:nowrap}
  /* detail */
  #modal .detail{padding:16px 18px;overflow-y:auto}
  #modal .dhead{display:flex;gap:12px;align-items:center;margin-bottom:12px}
  #modal .dhead .av{width:46px;height:46px;border-radius:50%;border:2px solid var(--line);object-fit:cover}
  #modal .dhead .h{font-weight:700;font-size:15px}
  #modal .dhead .t{font-size:12px;color:var(--mut)}
  #modal .dtext{font-size:15px;line-height:1.55;white-space:pre-wrap;margin-bottom:16px}
  #modal .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px}
  #modal .grid .cell{background:#0d1017;border:1px solid var(--line);border-radius:9px;padding:9px 10px;text-align:center}
  #modal .grid .cell .k{font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.4px}
  #modal .grid .cell .v{font-size:15px;font-weight:800;margin-top:3px}
  #modal .xbtn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:11px;border-radius:10px;background:#fff;color:#0a0b0e;font-weight:800;font-size:14px}
  #modal .xbtn:hover{background:#d7dde6}
  #modal .badge{font-weight:700;padding:1px 6px;border-radius:5px;font-size:10px}
</style></head>
<body>
<header>
  <h1>three.ws · <span style="color:var(--mut)">posts vs $price</span></h1>
  <span class="price">last <b id="last">—</b> · <b id="count">—</b> posts</span>
  <div class="legend">
    <span><i style="background:var(--cyan)"></i>trythreews</span>
    <span><i style="background:var(--mag)"></i>nichxbt</span>
    <span style="color:var(--mut)">▲ announcement · ⊕N grouped — click any bubble to expand</span>
  </div>
  <div class="tf">
    <button data-tf="15m">15m</button>
    <button data-tf="1h" class="on">1h</button>
    <button data-tf="1d">1d</button>
  </div>
</header>
<div class="wrap">
  <div id="chart"><div id="ov"></div><div id="tip"></div></div>
  <aside><div class="head">POSTS — oldest first · click to locate</div><div id="list"></div></aside>
</div>
<div id="modal"><div class="card"></div></div>
<script>
const DATA = __DATA__;
const AV = DATA.avatars || {};
const COLORS = { trythreews:'#22d3ee', nichxbt:'#f472b6' };
const acctColor = a => COLORS[a] || '#94a3b8';
const esc = s => (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const fmtRet = v => v==null?'—':(v>=0?'+':'')+v.toFixed(1)+'%';
const retColor = v => v==null?'#8b93a7':(v>=0?'#22c55e':'#ef4444');
const cls = v => v==null?'':(v>=0?'up':'down');
const fmtViews = v => !v?'—':(v>=1000?(v/1000).toFixed(0)+'K':String(v));
const fmtTime = s => new Date(s*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const SECS = {'15m':900,'1h':3600,'1d':86400};
let currentTF = '1h';

const el = document.getElementById('chart');
const ov = document.getElementById('ov');
const tip = document.getElementById('tip');
const chart = LightweightCharts.createChart(el, {
  layout:{background:{color:'#0a0b0e'},textColor:'#8b93a7'},
  grid:{vertLines:{color:'#13161e'},horzLines:{color:'#13161e'}},
  rightPriceScale:{borderColor:'#1e2230'},
  timeScale:{borderColor:'#1e2230',timeVisible:true,secondsVisible:false},
  crosshair:{mode:LightweightCharts.CrosshairMode.Normal},
});
const series = chart.addCandlestickSeries({upColor:'#22c55e',downColor:'#ef4444',wickUpColor:'#22c55e',wickDownColor:'#ef4444',borderVisible:false});

const posts = DATA.posts.slice().sort((a,b)=>a.time-b.time);

// lightweight-charts timeToCoordinate() only resolves EXACT bar times, so snap each
// post timestamp to the candle it falls in for the current timeframe.
let barTimes = [];
function snapToBar(t){
  if(!barTimes.length) return t;
  let lo=0, hi=barTimes.length-1, ans=barTimes[0];
  while(lo<=hi){ const m=(lo+hi)>>1; if(barTimes[m]<=t){ ans=barTimes[m]; lo=m+1; } else hi=m-1; }
  return ans;
}

function setTF(tf){
  currentTF = tf;
  series.setData(DATA.candles[tf]);
  barTimes = DATA.candles[tf].map(c=>c.time);
  document.querySelectorAll('.tf button').forEach(b=>b.classList.toggle('on',b.dataset.tf===tf));
  chart.timeScale().fitContent();
  scheduleUpdate();
}
document.querySelectorAll('.tf button').forEach(b=>b.onclick=()=>setTF(b.dataset.tf));

// ---- avatar bubble overlay with proximity clustering ----
const pool=[];
function getBub(i){ if(pool[i]) return pool[i]; const d=document.createElement('div'); d.className='bub'; ov.appendChild(d); pool[i]=d; return d; }
let raf=null;
function scheduleUpdate(){ if(raf) return; raf=requestAnimationFrame(()=>{ raf=null; updateBubbles(); }); }

function bubbleTip(items, x, y){
  // representative = biggest |24h| move in the cluster
  const rep = items.reduce((a,b)=>(Math.abs(b.r24h||0)>Math.abs(a.r24h||0)?b:a), items[0]);
  const more = items.length>1 ? '<span style="color:#8b93a7"> · +'+(items.length-1)+' more here</span>' : '';
  tip.innerHTML='<div class="meta"><span class="badge" style="background:'+acctColor(rep.account)+';color:#06121a">@'+esc(rep.account)+'</span>'+
    '<span>'+fmtTime(rep.time)+'</span><span>· '+fmtViews(rep.views)+' views</span>'+more+'</div>'+
    '<div class="body">'+esc(rep.text)+'</div>'+
    '<div class="rets"><span>1h <b style="color:'+retColor(rep.r1h)+'">'+fmtRet(rep.r1h)+'</b></span>'+
    '<span>4h <b style="color:'+retColor(rep.r4h)+'">'+fmtRet(rep.r4h)+'</b></span>'+
    '<span>24h <b style="color:'+retColor(rep.r24h)+'">'+fmtRet(rep.r24h)+'</b></span></div>';
  tip.style.display='block';
  const tx=Math.min(Math.max(8,x+18), el.clientWidth-310);
  const ty=Math.min(Math.max(8,y-10), el.clientHeight-110);
  tip.style.left=tx+'px'; tip.style.top=ty+'px';
}

function updateBubbles(){
  const ts=chart.timeScale();
  const pts=[];
  for(const p of posts){ const x=ts.timeToCoordinate(snapToBar(p.time)); if(x!=null) pts.push({p,x}); }
  // cluster posts whose screen-x are within TH px (pts already time-sorted ≈ x-sorted)
  const TH=20, clusters=[]; let cur=null;
  for(const it of pts){
    if(cur && it.x-cur.x<=TH){ cur.items.push(it.p); cur.x=it.x; }
    else { cur={x:it.x, items:[it.p]}; clusters.push(cur); }
  }
  let i=0;
  for(const c of clusters){
    const rep = c.items.reduce((a,b)=>(Math.abs(b.r24h||0)>Math.abs(a.r24h||0)?b:a), c.items[0]);
    let y=series.priceToCoordinate(rep.price);
    if(y==null) y=el.clientHeight*0.45;
    const b=getBub(i++);
    const acct=rep.account, img=AV[acct]?'<img src="'+AV[acct]+'"/>':'';
    const ann=c.items.some(p=>p.type==='announcement');
    b.style.display='block';
    b.style.left=(c.x-13)+'px';
    b.style.top=(y-36)+'px';
    b.style.borderColor=acctColor(acct);
    b.innerHTML=img+(c.items.length>1?'<span class="cnt">'+c.items.length+'</span>':'')+(ann?'<span class="ann">▲</span>':'');
    const items=c.items;
    b.onmouseenter=()=>bubbleTip(items, c.x, y);
    b.onmouseleave=()=>{ tip.style.display='none'; };
    b.onclick=()=>{ tip.style.display='none'; if(items.length>1) openCluster(items); else openDetail(items[0]); };
  }
  for(;i<pool.length;i++) pool[i].style.display='none';
}
chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleUpdate);
chart.timeScale().subscribeVisibleTimeRangeChange(scheduleUpdate);
window.addEventListener('resize', scheduleUpdate);

// ---- click-through modal: cluster list -> post detail -> View on X ----
const modal=document.getElementById('modal');
const card=modal.querySelector('.card');
function closeModal(){ modal.classList.remove('on'); card.innerHTML=''; }
modal.addEventListener('click', e=>{ if(e.target===modal) closeModal(); });
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeModal(); });

function rowHTML(p){
  const av=AV[p.account]?'<img class="av" src="'+AV[p.account]+'" style="border-color:'+acctColor(p.account)+'"/>':'<span class="av"></span>';
  return '<div class="row" data-id="'+p.time+'-'+esc(p.account)+'">'+av+
    '<div style="min-width:0;flex:1"><div class="rmeta"><span class="badge" style="background:'+acctColor(p.account)+'22;color:'+acctColor(p.account)+'">@'+esc(p.account)+'</span>'+
    '<span>'+fmtTime(p.time)+'</span>'+(p.type==='announcement'?'<span style="color:#22d3ee">▲ announce</span>':'')+
    '<span class="rret" style="color:'+retColor(p.r24h)+'">'+fmtRet(p.r24h)+' /24h</span></div>'+
    '<div class="rbody">'+esc(p.text)+'</div></div></div>';
}
function cell(k,v,color){ return '<div class="cell"><div class="k">'+k+'</div><div class="v" style="color:'+(color||'var(--txt)')+'">'+v+'</div></div>'; }
function detailHTML(p, backCount){
  const av=AV[p.account]?'<img class="av" src="'+AV[p.account]+'" style="border-color:'+acctColor(p.account)+'"/>':'<span class="av"></span>';
  const back = backCount ? '<span class="back">← '+backCount+' posts</span>' : '';
  const price = p.price!=null ? '$'+Number(p.price).toPrecision(3) : '—';
  return '<div class="mhead">'+back+'<span class="x">esc ✕</span></div>'+
    '<div class="detail"><div class="dhead">'+av+'<div><div class="h">@'+esc(p.account)+'</div><div class="t">'+fmtTime(p.time)+
      (p.type==='announcement'?' · ▲ announcement':'')+' · '+fmtViews(p.views)+' views</div></div></div>'+
    '<div class="dtext">'+esc(p.text)+'</div>'+
    '<div class="grid">'+cell('Price',price)+cell('1h',fmtRet(p.r1h),retColor(p.r1h))+cell('4h',fmtRet(p.r4h),retColor(p.r4h))+cell('24h',fmtRet(p.r24h),retColor(p.r24h))+'</div>'+
    (p.url?'<a class="xbtn" href="'+p.url+'" target="_blank" rel="noopener">View on X →</a>':'<div class="t" style="text-align:center;color:var(--mut)">no link available</div>')+
    '</div>';
}
function openDetail(p, fromItems){
  card.innerHTML=detailHTML(p, fromItems?fromItems.length:0);
  card.querySelector('.x').onclick=closeModal;
  const back=card.querySelector('.back'); if(back) back.onclick=()=>openCluster(fromItems);
  modal.classList.add('on');
}
function openCluster(items){
  const sorted=[...items].sort((a,b)=>a.time-b.time);
  card.innerHTML='<div class="mhead"><b>'+items.length+' posts</b> grouped here · click one'+
    '<span class="x">esc ✕</span></div><div class="mlist">'+sorted.map(rowHTML).join('')+'</div>';
  card.querySelector('.x').onclick=closeModal;
  card.querySelectorAll('.row').forEach((row,idx)=>row.onclick=()=>openDetail(sorted[idx], sorted));
  modal.classList.add('on');
}

// ---- sidebar list ----
const list=document.getElementById('list');
function render(){
  const ordered=[...posts].sort((a,b)=>a.time-b.time);
  list.innerHTML=ordered.map(p=>'<div class="post" data-t="'+p.time+'">'+
    '<div class="meta"><span class="badge" style="background:'+acctColor(p.account)+'22;color:'+acctColor(p.account)+'">@'+esc(p.account)+'</span>'+
    '<span>'+fmtTime(p.time)+'</span>'+(p.type==='announcement'?'<span style="color:#22d3ee">▲ announce</span>':'')+
    '<span class="ret '+cls(p.r24h)+'">'+fmtRet(p.r24h)+' /24h</span></div>'+
    '<div class="body">'+esc(p.text)+'</div></div>').join('');
  list.querySelectorAll('.post').forEach(d=>d.onclick=()=>{
    const t=+d.dataset.t, span=SECS[currentTF]*40;
    chart.timeScale().setVisibleRange({from:t-span,to:t+span});
    scheduleUpdate();
  });
}

document.getElementById('count').textContent=DATA.posts.length;
document.getElementById('last').textContent='$'+DATA.meta.lastPrice;
setTF('1h'); render();
</script></body></html>`;
  return TEMPLATE.replace('__DATA__', JSON.stringify(payload));
}

// ---- main -----------------------------------------------------------------
(async () => {
  const posts = loadPosts(postsPaths);
  const earliestSec = Math.floor(posts[0].ms / 1000) - 3 * 3600;
  const acctCounts = {};
  for (const p of posts) acctCounts[p.account] = (acctCounts[p.account] || 0) + 1;
  console.log(`Loaded ${posts.length} unique posts from ${postsPaths.length} files (${new Date(posts[0].ms).toISOString()} → ${new Date(posts[posts.length - 1].ms).toISOString()})`);
  console.log('By account:', Object.entries(acctCounts).map(([a, n]) => `${a}=${n}`).join(', '));

  console.log('Fetching hourly OHLCV…');
  const hourly = await fetchOhlcv('hour', 1, earliestSec);
  console.log(`Got ${hourly.length} hourly candles (${new Date(hourly[0][0] * 1000).toISOString()} → ${new Date(hourly.at(-1)[0] * 1000).toISOString()})`);

  const snap = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${THREE_MINT}`).catch(() => null);
  const snapPair = snap?.pairs?.[0];

  const WINDOWS = [1, 4, 24]; // hours forward
  const BASE = 1; // baseline lookback hours

  // baseline: distribution of forward returns over ALL candles, per window
  const baseline = {};
  for (const w of WINDOWS) {
    const rets = [];
    for (let i = 0; i + w < hourly.length; i++) {
      const r = pct(hourly[i + w][4], hourly[i][4]);
      if (r != null) rets.push(r);
    }
    baseline[w] = { mean: mean(rets), median: median(rets), std: std(rets), n: rets.length };
  }

  // per-post returns
  const rows = posts
    .filter((p) => p.ms / 1000 >= hourly[0][0] && p.ms / 1000 <= hourly.at(-1)[0])
    .map((p) => {
      const tSec = Math.floor(p.ms / 1000);
      const entry = closeAt(hourly, tSec);
      const before = closeAt(hourly, tSec - BASE * 3600);
      const fwd = {};
      for (const w of WINDOWS) fwd[w] = pct(closeAt(hourly, tSec + w * 3600), entry);
      return {
        ts: new Date(p.ms).toISOString(),
        sec: tSec,
        account: p.account,
        url: p.url,
        type: classify(p),
        text: p.text.slice(0, 80),
        fullText: p.text,
        likes: p.likes, rts: p.rts, views: p.views,
        entry, pre1h: pct(entry, before),
        r1h: fwd[1], r4h: fwd[4], r24h: fwd[24],
      };
    });

  const evaluable = rows.filter((r) => r.entry != null);

  // aggregate stats per window: post-return vs baseline, with z-score of the mean
  const agg = {};
  for (const w of WINDOWS) {
    const key = `r${w}h`;
    const rs = evaluable.map((r) => r[key]).filter((x) => x != null);
    const m = mean(rs);
    const b = baseline[w];
    const se = b.std ? b.std / Math.sqrt(rs.length || 1) : null;
    const med = median(rs);
    agg[w] = {
      postMean: m,
      postMedian: med,
      baselineMean: b.mean,
      baselineMedian: b.median,
      edge: m != null && b.mean != null ? m - b.mean : null,
      medianEdge: med != null && b.median != null ? med - b.median : null,
      z: m != null && se ? (m - b.mean) / se : null,
      winRate: rs.length ? (rs.filter((x) => x > 0).length / rs.length) * 100 : null,
      n: rs.length,
    };
  }

  // by type
  const byType = {};
  for (const r of evaluable) {
    (byType[r.type] ||= []).push(r);
  }
  const typeStats = Object.fromEntries(
    Object.entries(byType).map(([t, rs]) => [t, {
      n: rs.length,
      r1h: mean(rs.map((r) => r.r1h).filter((x) => x != null)),
      r4h: mean(rs.map((r) => r.r4h).filter((x) => x != null)),
      r24h: mean(rs.map((r) => r.r24h).filter((x) => x != null)),
    }]),
  );

  // engagement vs return correlation
  const eng = evaluable.filter((r) => r.r24h != null);
  const corr = {
    likes_vs_r24h: pearson(eng.map((r) => r.likes), eng.map((r) => r.r24h)),
    views_vs_r24h: pearson(eng.filter((r) => r.views > 0).map((r) => r.views), eng.filter((r) => r.views > 0).map((r) => r.r24h)),
  };

  // daily: posts/day vs daily return & volume
  const dayKey = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
  const dayClose = new Map(), dayVol = new Map();
  for (const c of hourly) {
    const d = dayKey(c[0]);
    dayClose.set(d, c[4]);
    dayVol.set(d, (dayVol.get(d) || 0) + c[5]);
  }
  const postsPerDay = new Map();
  for (const p of posts) {
    const d = dayKey(Math.floor(p.ms / 1000));
    postsPerDay.set(d, (postsPerDay.get(d) || 0) + 1);
  }
  const days = [...dayClose.keys()].sort();
  const dailyReturn = days.map((d, i) => (i === 0 ? null : pct(dayClose.get(d), dayClose.get(days[i - 1]))));
  const dailyPosts = days.map((d) => postsPerDay.get(d) || 0);
  const dailyVol = days.map((d) => dayVol.get(d) || 0);
  const dailyCorr = {
    postsPerDay_vs_dailyReturn: pearson(
      dailyPosts.slice(1), dailyReturn.slice(1).map((x) => x ?? 0),
    ),
    postsPerDay_vs_dailyVolume: pearson(dailyPosts, dailyVol),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    token: { symbol: 'THREE', mint: THREE_MINT, pool: POOL },
    currentSnapshot: snapPair && {
      priceUsd: snapPair.priceUsd, marketCap: snapPair.marketCap,
      vol24h: snapPair.volume?.h24, change24h: snapPair.priceChange?.h24,
    },
    coverage: {
      posts: posts.length, evaluable: evaluable.length,
      candles: hourly.length,
      from: new Date(hourly[0][0] * 1000).toISOString(),
      to: new Date(hourly.at(-1)[0] * 1000).toISOString(),
    },
    postWindowReturns: agg,
    baseline,
    byType: typeStats,
    engagementCorrelation: corr,
    dailyCorrelation: dailyCorr,
  };

  mkdirSync(dirname(outBase + '.json'), { recursive: true });
  writeFileSync(outBase + '.json', JSON.stringify(report, null, 2));

  // CSV of per-post detail
  const csv = [
    'timestamp,type,likes,retweets,views,entry_price,pre1h_pct,r1h_pct,r4h_pct,r24h_pct,text',
    ...evaluable.map((r) => [
      r.ts, r.type, r.likes, r.rts, r.views,
      r.entry, r.pre1h?.toFixed(2) ?? '', r.r1h?.toFixed(2) ?? '',
      r.r4h?.toFixed(2) ?? '', r.r24h?.toFixed(2) ?? '',
      JSON.stringify(r.text),
    ].join(',')),
  ].join('\n');
  writeFileSync(outBase + '.csv', csv);

  // console summary
  const f = (x, d = 2) => (x == null ? 'n/a' : x.toFixed(d));
  console.log('\n=== $THREE price vs X posts ===');
  console.log(`Evaluable posts: ${evaluable.length} / ${posts.length}`);
  console.log('\nForward return after a post vs random-hour baseline (median is robust to memecoin outliers):');
  for (const w of WINDOWS) {
    const a = agg[w];
    console.log(`  +${w}h: post median ${f(a.postMedian)}% vs base ${f(a.baselineMedian)}% (edge ${f(a.medianEdge)}pp) | mean ${f(a.postMean)}% vs ${f(a.baselineMean)}% (z=${f(a.z)}) | win ${f(a.winRate, 0)}% (n=${a.n})`);
  }
  console.log('\nBy post type (avg forward return):');
  for (const [t, s] of Object.entries(typeStats)) {
    console.log(`  ${t.padEnd(13)} n=${String(s.n).padEnd(3)} +1h ${f(s.r1h)}%  +4h ${f(s.r4h)}%  +24h ${f(s.r24h)}%`);
  }
  console.log('\nEngagement vs +24h return (Pearson r):');
  console.log(`  likes: ${f(corr.likes_vs_r24h)}   views: ${f(corr.views_vs_r24h)}`);
  console.log('\nDaily (Pearson r):');
  console.log(`  posts/day vs daily return: ${f(dailyCorr.postsPerDay_vs_dailyReturn)}`);
  console.log(`  posts/day vs daily volume: ${f(dailyCorr.postsPerDay_vs_dailyVolume)}`);
  console.log(`\nWrote ${outBase}.json and ${outBase}.csv`);

  if (args.includes('--chart')) {
    console.log('Fetching 15m candles for chart…');
    await sleep(1500);
    const m15 = await fetchOhlcv('minute', 15, earliestSec).catch((e) => { console.warn('15m fetch failed, falling back to hourly:', e.message); return []; });
    console.log(`15m candles: ${m15.length}`);
    const candles = {
      '15m': toBars(m15.length ? m15 : hourly),
      '1h': toBars(hourly),
      '1d': aggregateDaily(hourly),
    };
    const chartPosts = evaluable.map((r) => ({
      time: r.sec, account: r.account, type: r.type, url: r.url, price: r.entry,
      text: r.fullText.slice(0, 1000), views: r.views,
      r1h: r.r1h == null ? null : +r.r1h.toFixed(2),
      r4h: r.r4h == null ? null : +r.r4h.toFixed(2),
      r24h: r.r24h == null ? null : +r.r24h.toFixed(2),
    }));
    const avatarFile = (f) => { try { return 'data:image/jpeg;base64,' + readFileSync(f).toString('base64'); } catch { return null; } };
    const avatars = {
      trythreews: avatarFile('assets/trythreews.jpg'),
      nichxbt: avatarFile('assets/nichxbt.jpg'),
    };
    const payload = {
      meta: { lastPrice: snapPair?.priceUsd ?? hourly.at(-1)[4].toPrecision(4) },
      candles, posts: chartPosts, avatars,
    };
    writeFileSync(outBase + '.html', buildChartHtml(payload));
    console.log(`Wrote ${outBase}.html  →  open it in a browser`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
