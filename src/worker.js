/* MUSK RADAR — イーロン・マスク動向レーダー（Cloudflare Worker）
   アクセスのたびにGoogle News RSS（日本語）を複数クエリで取得・マージし、
   日本語の動向ページとしてSSR配信する。/api/news はJSONを返す（CORS許可）。 */

const CACHE_TTL_MS = 10 * 60 * 1000; // 10分間は同一の結果を再利用
const FEED_TIMEOUT_MS = 12000;
const FEED_STAGGER_MS = 250;   // Google Newsのバースト制限(503)を避けるためずらす
const MAX_ITEMS = 120;

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

/* タイトルからカテゴリを自動付与（複数フィード由来のタグと併合） */
const KEYWORD_CATS = [
  [/youtube|ユーチューブ|配信|出演|インタビュー|対談|ポッドキャスト/i, 'youtube'],
  [/発言|投稿|ポスト|表明|声明|語った|明かした|断言|主張/i, 'statement'],
  [/スペースX|SpaceX|ファルコン|スターリンク|スターシップ|打ち上げ|ロケット/i, 'spacex'],
  [/テスラ|Tesla|モデル[_vari0-9 ]*|サイバートラック|FSD/i, 'tesla'],
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

function parseFeed(xml, feedId) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks.slice(0, 40)) {
    const title = decodeEntities(pick(b, 'title')).replace(/<!\[CDATA\[|\]\]>/g, '');
    const link = pick(b, 'link');
    const pubDate = pick(b, 'pubDate');
    const source = decodeEntities(pick(b, 'source')).replace(/<!\[CDATA\[|\]\]>/g, '') || 'Google News';
    const d = pubDate ? new Date(pubDate) : new Date();
    if (!title || !link || isNaN(d.getTime())) continue;
    items.push({ title, link, date: d.getTime(), source, cats: [feedId] });
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

async function getItems() {
  if (memCache.items && Date.now() - memCache.ts < CACHE_TTL_MS) {
    return memCache;
  }
  // バースト制限を避けるため、フィードを少しずつずらして投入
  const results = [];
  for (const feed of FEEDS) {
    results.push(fetchFeed(feed).then(
      (v) => ({ status: 'fulfilled', value: v }),
      (e) => ({ status: 'rejected', reason: e })
    ));
    await sleep(FEED_STAGGER_MS);
  }
  const settled = await Promise.all(results);
  const byLink = new Map();
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const it of r.value) {
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
  items = main;

  if (items.length === 0 && lastGood && lastGood.items && lastGood.items.length) {
    return { ts: lastGood.ts, items: lastGood.items, errors, stale: true };
  }
  memCache = { ts: Date.now(), items, errors, stale: items.length === 0 };
  if (items.length) lastGood = memCache;
  return memCache;
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

/* ---------------- HTML ---------------- */
const CSS = `
:root{--bg:#0a0c11;--panel:#12161f;--line:#232a38;--text:#e8ecf4;--sub:#8b95a7;--accent:#ff3b30;--cyan:#37f2e6}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans","Yu Gothic UI","Meiryo",system-ui,sans-serif;line-height:1.7;padding-bottom:60px}
a{color:inherit;text-decoration:none}
.wrap{max-width:900px;margin:0 auto;padding:20px 16px}
header{border-bottom:1px solid var(--line);background:rgba(10,12,17,.92);position:sticky;top:0;z-index:10;backdrop-filter:blur(8px)}
.hwrap{max-width:900px;margin:0 auto;padding:14px 18px;display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
.logo{font-family:ui-monospace,Consolas,monospace;font-size:20px;font-weight:800}
.logo b{color:var(--accent)}
.tagline{color:var(--sub);font-size:11px;letter-spacing:2px}
.meta{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--sub);margin:14px 0 4px}
.meta b{color:var(--cyan)}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.chipbtn{padding:7px 14px;border-radius:999px;border:1px solid var(--line);color:var(--sub);font-size:13px;font-weight:700;background:none;cursor:pointer;font-family:inherit}
.chipbtn.on{border-color:var(--cyan);color:var(--cyan)}
.search{width:100%;background:#0d1119;border:1px solid var(--line);border-radius:10px;color:var(--text);padding:10px 14px;font-size:14px;font-family:inherit;margin:6px 0 4px}
.search:focus{outline:none;border-color:var(--cyan)}
.dayhead{font-family:ui-monospace,Consolas,monospace;color:var(--cyan);font-size:13px;font-weight:700;margin:22px 0 8px;letter-spacing:1px}
.item{display:block;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px 16px;margin-bottom:9px;transition:border-color .12s}
.item:hover{border-color:#3a465c}
.item .top{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:11px;font-family:ui-monospace,Consolas,monospace;color:var(--sub)}
.item .src{color:var(--cyan)}
.item .t{font-size:14.5px;margin-top:4px;font-weight:600}
.tag{display:inline-block;font-size:10px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--sub)}
.err{color:#ff8a80;font-size:12px;font-family:ui-monospace,Consolas,monospace;margin-top:8px}
footer{border-top:1px solid var(--line);color:var(--sub);font-size:12px;text-align:center;padding:24px 16px;margin-top:30px}
footer a{color:var(--cyan);text-decoration:underline}
.hidden{display:none}
`;

function renderHTML(data) {
  const { items, errors, ts } = data;
  const cats = Object.keys(CAT_LABELS);
  const chipBtns = ['<button class="chipbtn on" data-cat="all">すべて</button>']
    .concat(cats.map(c => `<button class="chipbtn" data-cat="${c}">${CAT_LABELS[c]}</button>`))
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
      const tags = it.cats.filter(c => c !== 'general').map(c => `<span class="tag">${CAT_LABELS[c] || c}</span>`).join(' ');
      return `<a class="item" href="${esc(it.link)}" target="_blank" rel="noopener" data-cats="${it.cats.join(',')}" data-title="${esc(it.title.toLowerCase())}">
<div class="top"><span class="src">${esc(it.source)}</span><span>${jst(it.date, 'time')}</span>${tags ? '<span>' + tags + '</span>' : ''}</div>
<div class="t">${esc(it.title)}</div></a>`;
    }).join('');
  }

  const errHTML = errors.length ? `<div class="err">一部のフィード取得に失敗: ${esc(errors.join(' / '))}</div>` : '';
  const body = items.length ? listHTML : '<div class="err">ニュースを取得できませんでした。数分後に自動再試行します。</div>';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MUSK RADAR — イーロン・マスク動向を日本語でリアルタイム追跡</title>
<meta name="description" content="イーロン・マスクの発言・YouTube出演・SpaceX・Tesla・xAI・教育に関する日本語ニュースを自動収集・リアルタイム表示。">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta http-equiv="refresh" content="600">
<style>${CSS}</style>
</head>
<body>
<header><div class="hwrap">
<div class="logo">MUSK<b>RADAR</b></div>
<div class="tagline">イーロン・マスクの動向を、日本語で。</div>
</div></header>
<div class="wrap">
<div class="meta">最終更新: <b>${jst(ts, 'full')}</b> JST · ${items.length}件 · 10分ごとに自動更新${data.stale ? ' · <span style="color:#ffb020">⚠ 取得制限中のためキャッシュを表示</span>' : ''} · ソース: Google News (JA)</div>
<input class="search" id="q" type="search" placeholder="キーワードで絞り込み（例: スターシップ、関税、Grok…）">
<div class="chips">${chipBtns}</div>
${errHTML}
<div id="list">${body}</div>
</div>
<footer>
<p>MUSK RADAR — Google News RSSをCloudflare Workerがリアルタイム取得・マージして配信。</p>
<p>姉妹サイト: <a href="https://human-os.toriumis.com/">HUMAN OS — マスク流の学び方（教育）</a> · API: <a href="/api/news">/api/news</a></p>
<p style="margin-top:6px;opacity:.7">© 2026 toriumib</p>
</footer>
<script>
(function(){
  var cat='all', q='';
  function apply(){
    document.querySelectorAll('.item').forEach(function(el){
      var okCat = cat==='all' || (el.getAttribute('data-cats')||'').split(',').indexOf(cat)>=0;
      var okQ = !q || (el.getAttribute('data-title')||'').indexOf(q)>=0;
      el.classList.toggle('hidden', !(okCat && okQ));
    });
    document.querySelectorAll('.dayhead').forEach(function(d){
      var any=false; var el=d.nextElementSibling;
      while(el && el.classList && el.classList.contains('item')){ if(!el.classList.contains('hidden')){any=true;break;} el=el.nextElementSibling; }
      d.classList.toggle('hidden', !any);
    });
  }
  document.querySelectorAll('.chipbtn').forEach(function(b){
    b.addEventListener('click',function(){
      document.querySelectorAll('.chipbtn').forEach(function(x){x.classList.remove('on')});
      b.classList.add('on'); cat=b.getAttribute('data-cat'); apply();
    });
  });
  document.getElementById('q').addEventListener('input',function(e){
    q=e.target.value.trim().toLowerCase(); apply();
  });
})();
</script>
</body>
</html>`;
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0a0c11"/><circle cx="30" cy="34" r="10" fill="none" stroke="#37f2e6" stroke-width="3"/><circle cx="44" cy="20" r="4" fill="#ff3b30"/><line x1="37" y1="27" x2="42" y2="22" stroke="#37f2e6" stroke-width="2.5"/></svg>`;

/* ---------------- ハンドラ ---------------- */
export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/favicon.svg') {
      return new Response(FAVICON, { headers: { 'content-type': 'image/svg+xml' } });
    }

    const data = await getItems();

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
      return new Response(JSON.stringify(payload), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=300'
        }
      });
    }

    const html = renderHTML(data);
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=120' }
    });
  }
};
