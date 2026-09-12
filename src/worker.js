/* MUSK RADAR — イーロン・マスク動向レーダー（Cloudflare Worker）
   アクセスのたびにGoogle News RSS（日本語）を複数クエリで取得・マージし、
   日本語の動向ページとしてSSR配信する。/api/news はJSONを返す（CORS許可）。 */

const CACHE_TTL_MS = 10 * 60 * 1000; // 10分間は同一の結果を再利用
const FEED_TIMEOUT_MS = 12000;
const FEED_STAGGER_MS = 250;   // Google Newsのバースト制限(503)を避けるためずらす
const MAX_ITEMS = 120;
const NEW_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6時間以内はNEW
const PAGE_SIZE = 40;          // 初期表示件数（「さらに読む」で展開）

const FEEDS = [
  { id: 'general',   label: '総合',     q: 'イーロン・マスク OR イーロンマスク OR Elon Musk' },
  { id: 'youtube',   label: 'YouTube',  q: 'イーロン・マスク YouTube OR ユーチューブ' },
  { id: 'statement', label: '発言',     q: 'イーロン・マスク 発言 OR 発信' },
  { id: 'spacex',    label: 'SpaceX',   q: 'スペースX OR スターシップ OR スターリンク' },
  { id: 'tesla',     label: 'Tesla',    q: 'テスラ マスク' },
  { id: 'xai',       label: 'xAI・AI',  q: 'Grok OR xAI' },
  { id: 'edu',       label: '教育',     q: 'マスク 学校 OR Astra Nova OR Ad Astra' }
];

const CAT_LABELS = {
  general: '総合', youtube: 'YouTube', statement: '発言', spacex: 'SpaceX',
  tesla: 'Tesla', xai: 'xAI・AI', edu: '教育'
};
const CAT_COLORS = {
  general: '#8b95a7', youtube: '#ff5252', statement: '#ffd166', spacex: '#37f2e6',
  tesla: '#6f8cff', xai: '#b388ff', edu: '#2fd06a'
};

/* タイトルからカテゴリを自動付与（複数フィード由来のタグと併合） */
const KEYWORD_CATS = [
  [/youtube|ユーチューブ|配信|出演|インタビュー|対談|ポッドキャスト/i, 'youtube'],
  [/発言|投稿|ポスト|表明|声明|語った|明かした|断言|主張/i, 'statement'],
  [/スペースX|SpaceX|ファルコン|スターリンク|スターシップ|打ち上げ|ロケット/i, 'spacex'],
  [/テスラ|Tesla|サイバートラック|FSD/i, 'tesla'],
  [/Grok|xAI|人工知能|AI/i, 'xai'],
  [/学校|教育|Astra ?Nova|Ad ?Astra|スクール/i, 'edu']
];

let memCache = { ts: 0, items: null, errors: [] };

/* ---------------- RSS ---------------- */
function feedUrl(q) {
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=ja&gl=JP&ceid=JP:ja';
}

function decodeEntities(s) {
  return s
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&');
}

function pick(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1].trim() : '';
}

function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function parseFeed(xml, feedId) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks.slice(0, 40)) {
    const title = decodeEntities(pick(b, 'title')).replace(/<!\[CDATA\[|\]\]>/g, '');
    const link = pick(b, 'link');
    const pubDate = pick(b, 'pubDate');
    const source = decodeEntities(pick(b, 'source')).replace(/<!\[CDATA\[|\]\]>/g, '') || 'Google News';
    const srcUrl = (b.match(/<source url="([^"]+)"/) || [])[1] || '';
    const d = pubDate ? new Date(pubDate) : new Date();
    if (!title || !link || isNaN(d.getTime())) continue;
    items.push({ title, link, date: d.getTime(), source, srcDomain: domainOf(srcUrl), cats: [feedId] });
  }
  return items;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchFeedOnce(feed) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(feedUrl(feed.q), {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MuskRadar/1.0)' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const xml = await res.text();
    return parseFeed(xml, feed.id);
  } finally {
    clearTimeout(t);
  }
}

async function fetchFeed(feed, attempt) {
  attempt = attempt || 0;
  try {
    return await fetchFeedOnce(feed);
  } catch (e) {
    if (attempt < 2) {
      await sleep(900 + attempt * 900);
      return fetchFeed(feed, attempt + 1);
    }
    throw e;
  }
}

/* エッジキャッシュ（全isolate共有）: Cloudflare Cache APIを利用 */
const EDGE_KEY = 'https://musk.toriumis.com/__news_cache__';

async function readEdge() {
  try {
    const r = await caches.default.match(new Request(EDGE_KEY));
    if (!r) return null;
    const d = await r.json();
    return (d && Array.isArray(d.items)) ? d : null;
  } catch (e) { return null; }
}

function writeEdge(data, ctx) {
  try {
    const r = new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=1800' }
    });
    const p = caches.default.put(new Request(EDGE_KEY), r);
    if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  } catch (e) { /* best effort */ }
}

/* Workers KV: 全isolate・再デプロイ後も生きる永続キャッシュ */
async function readKV(env) {
  try {
    if (!env || !env.NEWS_KV) return null;
    const d = await env.NEWS_KV.get('news', 'json');
    return (d && Array.isArray(d.items) && d.items.length) ? d : null;
  } catch (e) { return null; }
}

function writeKV(env, data, ctx) {
  try {
    if (!env || !env.NEWS_KV) return;
    const p = env.NEWS_KV.put('news', JSON.stringify(data), { expirationTtl: 3600 });
    if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  } catch (e) { /* best effort */ }
}

async function fetchAllFeeds() {
  const results = [];
  for (const feed of FEEDS) {
    results.push(fetchFeed(feed).then(
      (v) => ({ status: 'fulfilled', value: v }),
      (e) => ({ status: 'rejected', reason: e })
    ));
    await sleep(FEED_STAGGER_MS);
  }
  return Promise.all(results);
}

async function mergeFeeds(settled) {
  const byLink = new Map();
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const it of r.value) {
        // eduフィードはタイトルに関連語を含むものだけ採用（クエリが本文一致でノイズを拾うため）
        if (FEEDS[i].id === 'edu' && !/マスク|スクール|学校|教育|Astra/i.test(it.title)) continue;
        const key = it.title.replace(/[\s。、．「」『』()（）\[\]]/g, '');
        if (byLink.has(key)) {
          const ex = byLink.get(key);
          if (ex.date < it.date) { it.cats = union(it.cats, ex.cats); byLink.set(key, it); }
          else { ex.cats = union(ex.cats, it.cats); }
        } else {
          byLink.set(key, it);
        }
      }
    } else {
      errors.push(FEEDS[i].id + ': ' + String(r.reason).slice(0, 80));
    }
  });

  let items = Array.from(byLink.values());
  for (const it of items) {
    for (const [re, cat] of KEYWORD_CATS) {
      if (re.test(it.title) && !it.cats.includes(cat)) it.cats.push(cat);
    }
  }
  items.sort((a, b) => b.date - a.date);

  // 新着上位 + カテゴリごとに最低4件を保証（古い記事でも各カテゴリが枯れないように）
  const main = items.slice(0, MAX_ITEMS);
  const seen = new Set(main);
  for (const feed of FEEDS) {
    let have = main.filter(it => it.cats.includes(feed.id)).length;
    if (have >= 4) continue;
    for (const it of items) {
      if (have >= 4) break;
      if (!seen.has(it) && it.cats.includes(feed.id)) { main.push(it); seen.add(it); have++; }
    }
  }
  main.sort((a, b) => b.date - a.date);
  return { items: main, errors };
}

async function getItems(ctx, env) {
  const now = Date.now();
  // 1) isolateのメモリキャッシュ
  if (memCache.items && memCache.items.length && now - memCache.ts < CACHE_TTL_MS) {
    return memCache;
  }
  // 2) Workers KV（Cronが10分ごとに更新する永続キャッシュ）
  const kv = await readKV(env);
  if (kv && now - kv.ts < CACHE_TTL_MS + 5 * 60 * 1000) {
    memCache = kv;
    return memCache;
  }
  // 3) ライブ取得（1回目）
  let merged = await mergeFeeds(await fetchAllFeeds());
  // 0件なら2秒待って1回だけ再試行（Googleの一時制限対策）
  if (!merged.items.length) {
    await sleep(2000);
    merged = await mergeFeeds(await fetchAllFeeds());
  }
  const items = merged.items;
  const errors = merged.errors;

  if (items.length) {
    memCache = { ts: Date.now(), items, errors, stale: false };
    lastGood = memCache;
    writeEdge(memCache, ctx);
    writeKV(env, memCache, ctx);
    return memCache;
  }
  // 4) 取得失敗時のフォールバック: メモリ → KV → エッジキャッシュ
  if (lastGood && lastGood.items && lastGood.items.length) {
    return { ts: lastGood.ts, items: lastGood.items, errors, stale: true };
  }
  if (kv && kv.items.length) {
    return { ts: kv.ts, items: kv.items, errors, stale: true };
  }
  const edge = await readEdge();
  if (edge && edge.items.length) {
    return { ts: edge.ts, items: edge.items, errors, stale: true };
  }
  return { ts: Date.now(), items: [], errors, stale: true };
}

/* 古いキャッシュ（取得失敗時のフォールバック用に保持） */
let lastGood = null;

function union(a, b) {
  const s = new Set(a);
  for (const x of b) s.add(x);
  return Array.from(s);
}

/* ---------------- 表示ユーティリティ ---------------- */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function jst(ts, mode) {
  const d = new Date(ts);
  const opts = { timeZone: 'Asia/Tokyo' };
  if (mode === 'time') return d.toLocaleTimeString('ja-JP', { ...opts, hour: '2-digit', minute: '2-digit' });
  if (mode === 'full') return d.toLocaleString('ja-JP', { ...opts, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ja-JP', { ...opts, year: 'numeric', month: 'numeric', day: 'numeric' });
}

function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'たった今';
  if (s < 3600) return Math.floor(s / 60) + '分前';
  if (s < 86400) return Math.floor(s / 3600) + '時間前';
  return Math.floor(s / 86400) + '日前';
}

function dayKeyJST(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' }); // YYYY-MM-DD
}

function dayLabel(key) {
  const today = dayKeyJST(Date.now());
  const yesterday = dayKeyJST(Date.now() - 86400000);
  if (key === today) return '今日';
  if (key === yesterday) return '昨日';
  const [y, m, d] = key.split('-');
  return `${y}年${parseInt(m)}月${parseInt(d)}日`;
}

function primaryCat(cats) {
  for (const c of cats) if (c !== 'general') return c;
  return 'general';
}

/* ---------------- HTML ---------------- */
const CSS = `
:root{--bg:#0a0c11;--panel:#12161f;--panel2:#171c28;--line:#232a38;--text:#e8ecf4;--sub:#8b95a7;--accent:#ff3b30;--cyan:#37f2e6}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans","Yu Gothic UI","Meiryo",system-ui,sans-serif;line-height:1.7;padding-bottom:60px}
a{color:inherit;text-decoration:none}
.wrap{max-width:920px;margin:0 auto;padding:20px 16px}
header{border-bottom:1px solid var(--line);background:rgba(10,12,17,.94);position:sticky;top:0;z-index:10;backdrop-filter:blur(10px)}
.hwrap{max-width:920px;margin:0 auto;padding:12px 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.radar{position:relative;width:42px;height:42px;border-radius:50%;border:1px solid #1a5f5a;overflow:hidden;flex:none}
.radar::before{content:"";position:absolute;inset:0;background:conic-gradient(from 0deg,rgba(55,242,230,.45),transparent 70deg);animation:sweep 3.2s linear infinite}
.radar::after{content:"";position:absolute;left:58%;top:34%;width:5px;height:5px;border-radius:50%;background:var(--accent);box-shadow:0 0 6px var(--accent)}
.radar .ring{position:absolute;inset:28%;border:1px solid rgba(55,242,230,.25);border-radius:50%}
@keyframes sweep{to{transform:rotate(360deg)}}
.titles{flex:1;min-width:200px}
.logo{font-family:ui-monospace,Consolas,monospace;font-size:20px;font-weight:800;letter-spacing:1px}
.logo b{color:var(--accent)}
.tagline{color:var(--sub);font-size:11px;letter-spacing:2px}
.sister{font-size:11px;color:var(--cyan);border:1px solid #1a5f5a;border-radius:999px;padding:4px 12px;white-space:nowrap}
.sister:hover{background:#0f1a1e}
.meta{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:var(--sub);margin:14px 0 4px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.meta b{color:var(--cyan)}
.live{display:inline-block;width:7px;height:7px;border-radius:50%;background:#2fd06a;box-shadow:0 0 6px #2fd06a;animation:pulse 2s infinite;margin-right:5px}
@keyframes pulse{50%{opacity:.35}}
.search{width:100%;background:#0d1119;border:1px solid var(--line);border-radius:10px;color:var(--text);padding:11px 14px;font-size:14px;font-family:inherit;margin:10px 0 4px}
.search:focus{outline:none;border-color:var(--cyan)}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 6px}
.chipbtn{padding:7px 13px;border-radius:999px;border:1px solid var(--line);color:var(--sub);font-size:12.5px;font-weight:700;background:none;cursor:pointer;font-family:inherit;transition:border-color .12s,color .12s}
.chipbtn .n{font-family:ui-monospace,Consolas,monospace;font-size:10px;opacity:.75;margin-left:4px}
.chipbtn.on{border-color:var(--cc,var(--cyan));color:var(--cc,var(--cyan))}
.dayhead{font-family:ui-monospace,Consolas,monospace;color:var(--cyan);font-size:13px;font-weight:700;margin:22px 0 10px;letter-spacing:1px;display:flex;align-items:center;gap:10px}
.dayhead::after{content:"";flex:1;height:1px;background:var(--line)}
.item{position:relative;display:flex;gap:12px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--cc,#8b95a7);border-radius:12px;padding:12px 14px;margin-bottom:9px;transition:transform .12s ease,border-color .12s ease,background .12s ease}
.item:hover{transform:translateX(3px);background:var(--panel2)}
.item .fav{width:22px;height:22px;border-radius:5px;margin-top:2px;flex:none;background:#0d1119}
.item .body{flex:1;min-width:0}
.item .top{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:11px;font-family:ui-monospace,Consolas,monospace;color:var(--sub)}
.item .src{color:var(--cyan)}
.item .rel{color:var(--sub)}
.item .new{color:#fff;background:var(--accent);border-radius:4px;padding:0 6px;font-size:10px;font-weight:800;letter-spacing:1px}
.item .t{font-size:14.5px;margin-top:3px;font-weight:600;line-height:1.55}
.tag{display:inline-block;font-size:10px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--sub)}
.morebtn{display:block;width:100%;padding:12px;margin:16px 0;background:none;border:1px dashed var(--line);border-radius:12px;color:var(--sub);font-size:13px;font-weight:700;font-family:inherit;cursor:pointer}
.morebtn:hover{border-color:var(--cyan);color:var(--cyan)}
.err{color:#ff8a80;font-size:12px;font-family:ui-monospace,Consolas,monospace;margin-top:8px}
footer{border-top:1px solid var(--line);color:var(--sub);font-size:12px;text-align:center;padding:26px 16px;margin-top:34px}
footer a{color:var(--cyan);text-decoration:underline}
.hidden{display:none}
@media(max-width:560px){.item .fav{display:none}.logo{font-size:17px}.sister{display:none}}
`;

function renderHTML(data) {
  const { items, errors, ts } = data;

  // カテゴリ別件数
  const counts = { all: items.length };
  for (const c of Object.keys(CAT_LABELS)) counts[c] = items.filter(it => it.cats.includes(c)).length;

  const chipBtns = ['<button class="chipbtn on" data-cat="all">すべて<span class="n">' + counts.all + '</span></button>']
    .concat(Object.keys(CAT_LABELS).map(c =>
      `<button class="chipbtn" data-cat="${c}" style="--cc:${CAT_COLORS[c]}">${CAT_LABELS[c]}<span class="n">${counts[c]}</span></button>`))
    .join('');

  // 日付ごとにグループ化
  const groups = new Map();
  for (const it of items) {
    const k = dayKeyJST(it.date);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  let listHTML = '';
  for (const [k, arr] of groups) {
    listHTML += `<div class="dayhead" data-day="${k}">${dayLabel(k)}</div>`;
    listHTML += arr.map(it => {
      const pc = primaryCat(it.cats);
      const tags = it.cats.filter(c => c !== 'general').map(c => `<span class="tag">${CAT_LABELS[c] || c}</span>`).join(' ');
      const isNew = Date.now() - it.date < NEW_THRESHOLD_MS;
      const fav = it.srcDomain
        ? `<img class="fav" src="https://www.google.com/s2/favicons?domain=${esc(it.srcDomain)}&sz=64" width="22" height="22" alt="" onerror="this.style.display='none'">`
        : '';
      return `<a class="item" href="${esc(it.link)}" target="_blank" rel="noopener" style="--cc:${CAT_COLORS[pc]}" data-cats="${it.cats.join(',')}" data-title="${esc(it.title.toLowerCase())}">
${fav}<div class="body">
<div class="top"><span class="src">${esc(it.source)}</span><span class="rel">${jst(it.date, 'time')} · ${relTime(it.date)}</span>${isNew ? '<span class="new">NEW</span>' : ''}${tags ? '<span>' + tags + '</span>' : ''}</div>
<div class="t">${esc(it.title)}</div></div></a>`;
    }).join('');
  }

  const errHTML = errors.length ? `<div class="err">一部のフィード取得に失敗: ${esc(errors.join(' / '))}</div>` : '';
  const body = items.length
    ? listHTML + (items.length > PAGE_SIZE ? `<button class="morebtn" id="more">さらに読む（残り ${Math.max(0, items.length - PAGE_SIZE)}件）</button>` : '')
    : '<div class="err">ニュースを取得できませんでした。2分後に自動再試行します。</div>';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MUSK RADAR — イーロン・マスク動向を日本語でリアルタイム追跡</title>
<meta name="description" content="イーロン・マスクの発言・YouTube出演・SpaceX・Tesla・xAI・教育に関する日本語ニュースを自動収集・リアルタイム表示。">
<meta property="og:title" content="MUSK RADAR — イーロン・マスク動向レーダー">
<meta property="og:description" content="マスクの発言・YouTube出演・SpaceX・Tesla・xAI・教育の日本語ニュースをリアルタイム自動収集。">
<meta property="og:type" content="website">
<meta property="og:url" content="https://musk.toriumis.com/">
<meta name="theme-color" content="#0a0c11">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<meta http-equiv="refresh" content="${items.length ? 600 : 120}">
<style>${CSS}</style>
</head>
<body>
<header><div class="hwrap">
<div class="radar"><div class="ring"></div></div>
<div class="titles">
<div class="logo">MUSK<b>RADAR</b></div>
<div class="tagline">イーロン・マスクの動向を、日本語で。</div>
</div>
<a class="sister" href="https://human-os.toriumis.com/">🎓 姉妹サイト HUMAN OS</a>
</div></header>
<div class="wrap">
<div class="meta"><span><span class="live"></span>LIVE</span><span>最終更新 <b>${jst(ts, 'full')}</b> JST</span><span>${items.length}件</span><span id="next" data-updated="${ts}">次の更新まで --:--</span></div>
<input class="search" id="q" type="search" placeholder="キーワードで絞り込み（例: スターシップ、関税、Grok…）">
<div class="chips">${chipBtns}</div>
${errHTML}
<div id="list">${body}</div>
</div>
<footer>
<p>MUSK RADAR — Google News RSSをCloudflare Workerがリアルタイム取得・マージして配信。10分ごとに自動更新。</p>
<p>姉妹サイト: <a href="https://human-os.toriumis.com/">HUMAN OS — マスク流の学び方（教育）</a> · API: <a href="/api/news">/api/news</a></p>
<p style="margin-top:6px;opacity:.7">© 2026 toriumib</p>
</footer>
<script>
(function(){
  var cat='all', q='';
  function apply(){
    var idx=0;
    document.querySelectorAll('.item').forEach(function(el){
      var okCat = cat==='all' || (el.getAttribute('data-cats')||'').split(',').indexOf(cat)>=0;
      var okQ = !q || (el.getAttribute('data-title')||'').indexOf(q)>=0;
      var folded = el.classList.contains('folded');
      el.classList.toggle('hidden', !(okCat && okQ));
      if(okCat && okQ && !folded && typeof el.dataset.idx === 'undefined'){}
    });
    document.querySelectorAll('.dayhead').forEach(function(d){
      var any=false; var el=d.nextElementSibling;
      while(el && el.classList && el.classList.contains('item')){ if(!el.classList.contains('hidden')){any=true;break;} el=el.nextElementSibling; }
      d.classList.toggle('hidden', !any);
    });
    var more=document.getElementById('more');
    if(more){ more.classList.toggle('hidden', q!=='' || cat!=='all'); }
  }
  // ページング: 先頭${PAGE_SIZE}件のみ表示
  var all=document.querySelectorAll('.item');
  all.forEach(function(el,i){ if(i>=${PAGE_SIZE}) el.classList.add('folded','hidden'); });
  var more=document.getElementById('more');
  if(more){ more.addEventListener('click',function(){
    document.querySelectorAll('.item.folded').forEach(function(el){ el.classList.remove('folded','hidden'); });
    more.remove();
  }); }
  document.querySelectorAll('.chipbtn').forEach(function(b){
    b.addEventListener('click',function(){
      document.querySelectorAll('.chipbtn').forEach(function(x){x.classList.remove('on')});
      b.classList.add('on'); cat=b.getAttribute('data-cat');
      if(cat!=='all'){ document.querySelectorAll('.item.folded').forEach(function(el){ el.classList.remove('folded','hidden'); }); if(more) more.remove(); }
      apply();
    });
  });
  document.getElementById('q').addEventListener('input',function(e){
    q=e.target.value.trim().toLowerCase();
    if(q!==''){ document.querySelectorAll('.item.folded').forEach(function(el){ el.classList.remove('folded','hidden'); }); if(more) more.remove(); }
    apply();
  });
  // 次回更新カウントダウン（10分周期）
  var nx=document.getElementById('next');
  if(nx){
    var target=parseInt(nx.getAttribute('data-updated'),10)+600000;
    setInterval(function(){
      var s=Math.max(0,Math.floor((target-Date.now())/1000));
      if(s<=0){ location.reload(); return; }
      nx.textContent='次の更新まで '+Math.floor(s/60)+':'+('0'+(s%60)).slice(-2);
    },1000);
  }
})();
</script>
</body>
</html>`;
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0a0c11"/><circle cx="30" cy="34" r="10" fill="none" stroke="#37f2e6" stroke-width="3"/><circle cx="44" cy="20" r="4" fill="#ff3b30"/><line x1="37" y1="27" x2="42" y2="22" stroke="#37f2e6" stroke-width="2.5"/></svg>`;

const MANIFEST = JSON.stringify({
  name: 'MUSK RADAR — マスク動向レーダー',
  short_name: 'MUSK RADAR',
  description: 'イーロン・マスクの動向を日本語でリアルタイム追跡',
  lang: 'ja',
  start_url: '/',
  display: 'standalone',
  background_color: '#0a0c11',
  theme_color: '#0a0c11',
  icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
});

/* ---------------- ハンドラ ---------------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/favicon.svg') {
      return new Response(FAVICON, { headers: { 'content-type': 'image/svg+xml' } });
    }
    if (url.pathname === '/manifest.webmanifest') {
      return new Response(MANIFEST, { headers: { 'content-type': 'application/manifest+json' } });
    }

    const data = await getItems(ctx, env);

    if (url.pathname === '/api/debug') {
      // キャッシュ無視の生データ検査
      const results = await Promise.allSettled(FEEDS.map(fetchFeed));
      const info = FEEDS.map((f, i) => {
        if (results[i].status !== 'fulfilled') return { id: f.id, err: String(results[i].reason).slice(0, 100) };
        const arr = results[i].value;
        return {
          id: f.id, count: arr.length,
          firstCats: arr.slice(0, 2).map(x => x.cats),
          sample: arr.slice(0, 1).map(x => x.title.slice(0, 40))
        };
      });
      return new Response(JSON.stringify({ info }, null, 1), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    }

    if (url.pathname === '/api/news') {
      const cat = url.searchParams.get('cat');
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, MAX_ITEMS);
      let items = data.items;
      if (cat) items = items.filter(it => it.cats.includes(cat));
      const payload = {
        updated: data.ts,
        updatedJST: jst(data.ts, 'full'),
        stale: !!data.stale,
        count: items.length,
        items: items.slice(0, limit).map(it => ({
          title: it.title, link: it.link, source: it.source,
          date: it.date, dateJST: jst(it.date, 'full'), cats: it.cats
        }))
      };
      const good = data.items.length && !data.stale;
      return new Response(JSON.stringify(payload), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': good ? 'public, max-age=300' : 'public, max-age=30, must-revalidate'
        }
      });
    }

    const html = renderHTML(data);
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=120' }
    });
  },

  /* 10分ごとのCron: KV/エッジキャッシュを事前ウォーム（訪問者の待ち時間をゼロにする） */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(getItems(ctx, env));
  }
};
