'use strict';

const API = 'https://www.googleapis.com/youtube/v3/';
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube';
const SCOPE = YT_SCOPE + ' email'; // email はアカウント選択を省くためだけに使う
const PAGE_TARGET = 15;   // 1回の読み込みで表示したい件数
const MAX_PAGES = 3;      // 1回の読み込みで叩く検索ページ数の上限（1ページ = 100ユニット）
const FEED_PER_CHANNEL = 5;
const FEED_MAX = 150;
const FEED_TTL = 30 * 60 * 1000; // 新着一覧を使い回す時間（30分）
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

// OAuth クライアントID（公開されても問題ない値）。設定画面で別のIDを入れればそちらが優先されます
const BUILTIN_CLIENT_ID = '716629250048-ju4p6ojm89eap92s31kle5877afkvd2f.apps.googleusercontent.com';

const DEFAULTS = { apiKey: '', clientId: BUILTIN_CLIENT_ID, minMin: 4, maxMin: 0, order: 'relevance', period: '',
  minViews: 0, jaOnly: true, noLive: false, blocked: [], autoNext: true, cc: false, speed: 1, historyOn: true };
const HISTORY_MAX = 500;      // 再生履歴は最新500本まで（それより古いものは自動で消える）
const RESUME_MIN = 5;         // 5秒以上進んでいたら続きから再生

// ---------- 保存 ----------
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できない環境 */ }
}
function remove(key) { try { localStorage.removeItem(key); } catch { /* noop */ } }
let settings = Object.assign({}, DEFAULTS, load('mytube.settings', {}));
if (!settings.clientId) settings.clientId = BUILTIN_CLIENT_ID;
const persist = () => save('mytube.settings', settings);

function today() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Los_Angeles' }); } // APIの枠は太平洋時間でリセット
function addQuota(units) {
  const q = load('mytube.quota', { day: today(), used: 0 });
  if (q.day !== today()) { q.day = today(); q.used = 0; }
  q.used += units; save('mytube.quota', q);
}
function quotaUsed() {
  const q = load('mytube.quota', { day: today(), used: 0 });
  return q.day === today() ? q.used : 0;
}

// ---------- DOM ヘルパー ----------
const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}
function setMsg(node, text, isError) {
  node.textContent = text || '';
  node.classList.toggle('error', !!isError);
}
let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

const els = { form: $('searchForm'), q: $('q'), chips: $('chips'), dialog: $('settings'),
  search: { view: $('searchView'), list: $('list'), status: $('status'), more: $('more'), empty: $('empty') },
  feed: { view: $('feedView'), list: $('feedList'), status: $('feedStatus'), empty: $('feedEmpty') },
  library: { view: $('libraryView') } };

let state = { query: '', pageToken: null, shown: new Set(), loading: false, tab: 'search', feedLoading: false };

// ---------- ユーティリティ ----------
function parseDuration(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}
function fmtDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function fmtCount(n) {
  n = +n || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '億';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return n.toLocaleString('ja-JP');
}
const fmtViews = (n) => fmtCount(n) + '回';
function fmtAgo(dateStr) {
  const d = (Date.now() - new Date(dateStr)) / 1000;
  const units = [[31536000, '年'], [2592000, 'か月'], [604800, '週間'], [86400, '日'], [3600, '時間'], [60, '分']];
  for (const [s, label] of units) if (d >= s) return Math.floor(d / s) + label + '前';
  return 'たった今';
}
function decode(html) { const t = document.createElement('textarea'); t.innerHTML = html || ''; return t.value; }
const hasKana = (s) => /[぀-ヿ]/.test(s || '');
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const isBlocked = (channelId) => settings.blocked.some((b) => b.id === channelId);

// ---------- 再生履歴（このスマホの中だけに保存） ----------
let watchHistory = load('mytube.history', []);
const saveHistory = () => save('mytube.history', watchHistory);
const histGet = (id) => watchHistory.find((e) => e.id === id);

// 1秒以上再生したら記録。最後まで（残り30秒以内）見たら「視聴済み」
function recordProgress(v, pos, ended, duration) {
  if (!settings.historyOn || !v || !(ended || pos >= 1)) return;
  let e = histGet(v.id);
  if (e) watchHistory.splice(watchHistory.indexOf(e), 1);
  else e = { id: v.id, title: v.title, channel: v.channel, channelId: v.channelId, thumb: v.thumb, thumbs: v.thumbs,
    sec: v.sec, live: v.live, views: v.views, published: v.published, cat: v.cat };
  e.dismissed = false;
  const dur = v.sec || duration || 0;
  if (!e.sec && dur) e.sec = Math.round(dur);
  const tail = Math.min(30, dur * 0.1);
  e.at = Date.now();
  if (ended || (dur > 0 && pos >= dur - tail)) { e.done = true; e.pos = 0; }
  else { e.done = false; e.pos = Math.floor(pos); }
  watchHistory.unshift(e);
  if (watchHistory.length > HISTORY_MAX) watchHistory.length = HISTORY_MAX;
  saveHistory();
  document.querySelectorAll(`main [data-vid="${CSS.escape(v.id)}"]`).forEach((row) => decorateRow(row, v));
}

// 一覧のサムネに「視聴済み」や進み具合のバーを付ける
function decorateRow(row, v) {
  const thumb = row.querySelector('.thumb');
  thumb.querySelectorAll('.prog, .wbadge').forEach((n) => n.remove());
  row.classList.remove('watched');
  const e = histGet(v.id);
  if (!e) return;
  if (e.done) {
    row.classList.add('watched');
    thumb.append(h('span', { class: 'wbadge', text: '視聴済み' }));
  } else if (e.pos > 0 && (e.sec || v.sec)) {
    const pct = Math.min(100, Math.max(3, (e.pos / (e.sec || v.sec)) * 100));
    thumb.append(h('span', { class: 'prog' }, h('span', { style: `width:${pct}%` })));
  }
}

// ---------- ログイン（Google Identity Services） ----------
// ページだけのアプリには1時間で切れる通行証（アクセストークン）しか出ないため、
// ・前回のアカウントを覚えて選択画面を省く
// ・切れたあと最初にタップしたときに先回りで取り直す
// ことで、ログインし直しを意識しなくて済むようにしている
let auth = load('mytube.auth', null); // { token, exp, name, avatar, email }
let tokenClient = null;
let tokenClientHint = null;
let pendingLogin = null;
let tokenPromise = null;
let gisPromise = null;

const isLoggedIn = () => !!auth?.name;
const tokenValid = () => !!auth?.token && auth.exp - 60000 > Date.now();

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => { gisPromise = null; reject(new Error('Googleのログイン部品を読み込めませんでした。通信状況を確認してください。')); };
      document.head.append(s);
    });
  }
  return gisPromise;
}

function initTokenClient() {
  const hint = auth?.email || '';
  if (tokenClient && tokenClientHint === hint) return;
  if (!settings.clientId || !window.google?.accounts?.oauth2) return;
  tokenClientHint = hint;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: settings.clientId,
    scope: SCOPE,
    include_granted_scopes: true,
    login_hint: hint || undefined, // 前回のアカウントを指定して、アカウント選択を省く
    callback: (resp) => {
      const p = pendingLogin; pendingLogin = null;
      if (resp.error) { p?.reject(new Error('ログインできませんでした（' + resp.error + '）')); return; }
      if (google.accounts.oauth2.hasGrantedAllScopes && !google.accounts.oauth2.hasGrantedAllScopes(resp, YT_SCOPE)) {
        p?.reject(new Error('YouTubeへのアクセスが許可されませんでした。もう一度ログインして、すべての項目を許可してください。'));
        return;
      }
      auth = Object.assign({}, auth, { token: resp.access_token, exp: Date.now() + (+resp.expires_in || 3600) * 1000 });
      save('mytube.auth', auth);
      if (!auth.email) fetchEmail();
      p?.resolve();
    },
    error_callback: (err) => {
      const p = pendingLogin; pendingLogin = null;
      p?.reject(new Error(err?.type === 'popup_closed' ? 'ログインがキャンセルされました。' : 'ログイン画面を開けませんでした。ポップアップのブロックを確認してください。'));
    },
  });
}

// アカウント選択を省くために、ログインしたメールアドレスを覚える（このスマホの中だけ）
async function fetchEmail() {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + auth.token } });
    const d = await r.json();
    if (d.email && auth) { auth.email = d.email; save('mytube.auth', auth); }
  } catch { /* 取れなくても動作に影響なし */ }
}

// 必ずボタンを押した直後に呼ぶ（ポップアップがブロックされないように）。同時に呼ばれても1回にまとめる
function requestToken() {
  if (tokenPromise) return tokenPromise;
  if (!settings.clientId) return Promise.reject(new Error('先に設定で「OAuth クライアントID」を入れてください。'));
  initTokenClient();
  if (!tokenClient) return loadGis().then(() => { initTokenClient(); return requestToken(); });
  tokenPromise = new Promise((resolve, reject) => {
    pendingLogin = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: isLoggedIn() ? '' : 'consent' });
  }).finally(() => { tokenPromise = null; });
  return tokenPromise;
}

async function ensureToken() {
  if (tokenValid()) return;
  await requestToken();
}

// 切れている（もうすぐ切れる）ときは、画面のどこかを最初にタップした瞬間に取り直しておく
let lastAutoRefresh = 0;
document.addEventListener('click', () => {
  if (!isLoggedIn() || !settings.clientId || tokenPromise) return;
  if (auth.token && auth.exp - Date.now() > 5 * 60 * 1000) return;
  if (Date.now() - lastAutoRefresh < 10 * 60 * 1000) return; // キャンセルされたら10分は再挑戦しない
  lastAutoRefresh = Date.now();
  requestToken().catch(() => {});
}, true);

async function login() {
  await requestToken();
  const me = await apiAuth('GET', 'channels', { part: 'snippet', mine: 'true' }, null, 1);
  const ch = me.items?.[0];
  auth.name = ch ? ch.snippet.title : 'Googleアカウント';
  auth.avatar = ch?.snippet?.thumbnails?.default?.url || '';
  save('mytube.auth', auth);
  renderAccount();
  if (state.tab === 'library') loadLibrary();
}

async function withLogin(fn) {
  if (!isLoggedIn()) await login(); else await ensureToken();
  return fn();
}

function logout() {
  if (auth?.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(auth.token, () => {});
  auth = null; remove('mytube.auth'); remove('mytube.feed');
  tokenClient = null;
  els.feed.list.replaceChildren();
  renderAccount();
  if (state.tab === 'feed') showFeedEmpty();
  if (state.tab === 'library') loadLibrary();
}

// ---------- アイコン ----------
const ICONS = {
  you: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  vdots: '<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>',
  play: '<path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor" stroke="none"/>',
  like: '<path d="M7 10v11H3V10zM7 10l4-7c1.5 0 2.5 1 2.2 2.6L12.6 9H19a2 2 0 0 1 2 2.3l-1.3 7.5A2 2 0 0 1 17.7 21H7z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
};
function icon(name, cls) {
  const s = h('span', { class: 'ic' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' });
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return s;
}

function renderAccount() {
  $('navYouIcon').replaceChildren(isLoggedIn() && auth.avatar
    ? h('img', { src: auth.avatar, alt: '', referrerpolicy: 'no-referrer' }) : icon('you'));
  $('accountName').textContent = isLoggedIn() ? `${auth.name} でログイン中` : 'ログインしていません';
  $('loginBtn').hidden = isLoggedIn();
  $('logoutBtn').hidden = !isLoggedIn();
}

// ---------- API ----------
function apiError(res, data, authed) {
  const reason = data.error?.errors?.[0]?.reason || '';
  if (reason === 'quotaExceeded') return new Error('今日のAPI使用量の上限に達しました。日本時間の夕方（午後4〜5時ごろ）にリセットされます。');
  if (reason === 'commentsDisabled') return new Error('この動画はコメントがオフになっています。');
  if (reason === 'subscriptionDuplicate') { const e = new Error('すでに登録済みです。'); e.reason = reason; return e; }
  if (reason === 'subscriptionForbidden') return new Error('このチャンネルは登録できません。');
  if (reason === 'playlistNotFound') return new Error('再生リストが見つかりません。');
  if (authed && res.status === 401) {
    if (auth) { auth.token = ''; auth.exp = 0; save('mytube.auth', auth); }
    return new Error('ログインの有効期限が切れました。もう一度ボタンを押してください。');
  }
  if (authed && reason === 'insufficientPermissions') return new Error('権限が足りません。一度ログアウトして、ログインし直してください。');
  if (!authed && (reason === 'keyInvalid' || reason === 'badRequest' && res.status === 400)) return new Error('APIキーが正しくないようです。設定を確認してください。');
  if (!authed && res.status === 403 && /referer|blocked/i.test(reason + (data.error?.message || ''))) return new Error('APIキーがこのサイトで使えません。Google Cloud でキーの制限（ウェブサイト）を確認してください。');
  const e = new Error(data.error?.message ? '通信エラー：' + data.error.message : `通信エラー（${res.status}）`);
  e.status = res.status; e.reason = reason;
  return e;
}

function buildUrl(path, params) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) url.searchParams.set(k, v);
  return url;
}

async function api(path, params, cost) {
  if (!settings.apiKey) throw new Error('先に設定からAPIキーを入れてください。');
  const url = buildUrl(path, params);
  url.searchParams.set('key', settings.apiKey);
  const res = await fetch(url);
  addQuota(cost);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, data, false);
  return data;
}

async function apiAuth(method, path, params, body, cost) {
  const res = await fetch(buildUrl(path, params), {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + auth.token }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  addQuota(cost);
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, data, true);
  return data;
}

// ---------- 動画データ ----------
// filter=false のときは条件で除外しない（自分の再生リストや高評価一覧など）
function toItem(v, { lang = false, views = false, filter = true, skipBlocked = false } = {}) {
  const sec = parseDuration(v.contentDetails?.duration);
  const live = v.snippet.liveBroadcastContent;
  if (filter) {
    const isLive = live !== 'none' || !!v.liveStreamingDetails;
    if (!skipBlocked && isBlocked(v.snippet.channelId)) return null;
    if (settings.noLive && isLive) return null;
    if (live === 'none') {
      if (settings.minMin > 0 && sec < settings.minMin * 60) return null;
      if (settings.maxMin > 0 && sec > settings.maxMin * 60) return null;
    }
    if (views && settings.minViews > 0 && (+v.statistics?.viewCount || 0) < settings.minViews) return null;
    if (lang && settings.jaOnly && !hasKana(v.snippet.title) && !hasKana(v.snippet.description) &&
        !(v.snippet.defaultAudioLanguage || v.snippet.defaultLanguage || '').startsWith('ja')) return null;
  }
  return { id: v.id, sec, live, title: v.snippet.title, cat: v.snippet.categoryId,
    channel: v.snippet.channelTitle, channelId: v.snippet.channelId,
    published: v.snippet.publishedAt, views: v.statistics?.viewCount,
    thumb: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
    // 画面に合わせて選べるよう、用意されている大きいサイズも覚えておく（standard=640, maxres=1280 は無い動画もある）
    thumbs: { h: v.snippet.thumbnails?.high?.url, s: v.snippet.thumbnails?.standard?.url, x: v.snippet.thumbnails?.maxres?.url },
    short: detectShort(v, sec) };
}

// 縦長の動画（ショート）かどうか。API の埋め込みサイズ（縦横比）で判定し、無ければ長さ60秒以下で判定
function detectShort(v, sec) {
  const w = +v.player?.embedWidth; const ht = +v.player?.embedHeight;
  if (w && ht) return ht > w;
  return sec > 0 && sec <= 60;
}
const isShort = (v) => (v.short != null ? !!v.short : (v.sec > 0 && v.sec <= 60));

// サムネイル画像：端末の画面幅と画素密度に合わせて、ブラウザが一番合う解像度を選ぶ
const THUMB_SIZES = {
  row: '(min-width: 720px) 900px, 100vw',
  compact: '(min-width: 720px) 380px, 42vw',
  card: '(min-width: 720px) 260px, 62vw',
  short: '(min-width: 720px) 180px, 42vw',
};
function thumbImg(v, kind) {
  if (!v.id) return h('img', { src: v.thumb || 'icon.svg', alt: '', loading: 'lazy' });
  const base = `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/`;
  const t = v.thumbs || {};
  const set = [[v.thumb || base + 'mqdefault.jpg', 320], [t.h || base + 'hqdefault.jpg', 480]];
  if (t.s) set.push([t.s, 640]);
  if (t.x) set.push([t.x, 1280]);
  return h('img', { src: t.h || base + 'hqdefault.jpg', srcset: set.map(([u, w]) => `${u} ${w}w`).join(', '),
    sizes: THUMB_SIZES[kind], alt: '', loading: 'lazy', decoding: 'async' });
}

// 動画IDの順番を保ったまま詳細を取得
async function fetchVideoItems(ids, opts) {
  const out = [];
  for (const part of chunk(ids, 50)) {
    const det = await api('videos', { part: 'snippet,contentDetails,statistics,liveStreamingDetails,player', maxWidth: 240, id: part.join(',') }, 1);
    const byId = new Map((det.items || []).map((v) => [v.id, v]));
    for (const id of part) {
      const v = byId.get(id);
      const item = v && toItem(v, opts);
      if (item) out.push(item);
    }
  }
  return out;
}

// ---------- チャンネルアイコン（まとめて取得してスマホに保存） ----------
let avatarCache = load('mytube.avatars', {});
let avatarTimer = null;
function avatarImg(channelId) {
  return h('img', { class: 'av', 'data-ch': channelId, src: avatarCache[channelId] || null, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
}
function fillAvatars() {
  clearTimeout(avatarTimer);
  avatarTimer = setTimeout(async () => {
    if (!settings.apiKey) return;
    const imgs = [...document.querySelectorAll('img[data-ch]')];
    const missing = [...new Set(imgs.filter((i) => !i.getAttribute('src')).map((i) => i.dataset.ch).filter((id) => id && !(id in avatarCache)))];
    for (const part of chunk(missing, 50)) {
      try {
        const r = await api('channels', { part: 'snippet', id: part.join(','), maxResults: 50 }, 1);
        for (const c of r.items || []) avatarCache[c.id] = c.snippet.thumbnails?.default?.url || '';
        for (const id of part) if (!(id in avatarCache)) avatarCache[id] = '';
      } catch { break; }
    }
    const keys = Object.keys(avatarCache);
    if (keys.length > 1500) for (const k of keys.slice(0, keys.length - 1500)) delete avatarCache[k];
    save('mytube.avatars', avatarCache);
    document.querySelectorAll('img[data-ch]').forEach((img) => { const u = avatarCache[img.dataset.ch]; if (u && !img.getAttribute('src')) img.src = u; });
  }, 250);
}

function durText(v) { return v.live === 'live' ? 'ライブ' : v.live === 'upcoming' ? '予定' : fmtDuration(v.sec || 0); }

// ---------- 一覧の表示 ----------
// menu: (v, row, removeRow) => [{ label, onclick }]  … その一覧だけの「︙」メニュー項目
// 縦長の動画（ショート）は、普通の一覧から外して「ショート」の棚（縦長カードの横スクロール）にまとめる
function renderVideos(container, items, { append = false, menu = null, compact = false, extra = null } = {}) {
  if (!append || !container._items) { container.replaceChildren(); container._items = []; }
  const shorts = [];
  let anchor = null;
  for (const v of items) {
    if (!compact && isShort(v)) {
      if (!anchor) { anchor = h('div'); container.append(anchor); }
      shorts.push(v);
      continue;
    }
    container._items.push(v);
    container.append(renderRow(v, container._items, { menu, compact, extra }));
  }
  if (shorts.length) anchor.replaceWith(shortsShelf(shorts, menu));
  fillAvatars();
}

function shortsShelf(items, menu) {
  const q = items.slice();
  return h('section', { class: 'shorts-sec' },
    h('div', { class: 'section-head' }, h('h2', { class: 'shorts-h' }, h('span', { class: 'shorts-mark', text: 'S' }), 'ショート')),
    h('div', { class: 'carousel' }, q.map((v) => shortCard(v, q, menu))));
}

function shortCard(v, queue, menu) {
  const play = () => openPlayer(v, queue);
  const card = h('article', { class: 'short-card', 'data-vid': v.id, 'data-channel': v.channelId },
    h('button', { class: 'thumb short-thumb', type: 'button', 'aria-label': '再生', onclick: play }, thumbImg(v, 'short')),
    h('div', { class: 'card-meta' },
      h('div', { class: 'mtext' },
        h('button', { class: 'title', type: 'button', text: decode(v.title), onclick: play }),
        h('div', { class: 'sub', text: `${fmtCount(v.views)} 回視聴` })),
      h('button', { class: 'kebab', type: 'button', 'aria-label': 'メニュー', onclick: () => openVideoMenu(v, card, queue, menu) }, icon('vdots'))));
  decorateRow(card, v);
  return card;
}

function renderRow(v, queue, { menu = null, compact = false, extra = null } = {}) {
  const play = () => openPlayer(v, queue);
  const goCh = () => openChannel(v.channelId, decode(v.channel));
  const row = h('article', { class: compact ? 'item compact' : 'item', 'data-channel': v.channelId, 'data-vid': v.id },
    h('button', { class: 'thumb', type: 'button', 'aria-label': '再生', onclick: play },
      thumbImg(v, compact ? 'compact' : 'row'),
      h('span', { class: 'dur', text: durText(v) })),
    h('div', { class: 'meta' },
      compact ? null : h('button', { class: 'av-btn', type: 'button', 'aria-label': decode(v.channel), onclick: goCh }, avatarImg(v.channelId)),
      h('div', { class: 'mtext' },
        h('button', { class: 'title', type: 'button', text: decode(v.title), onclick: play }),
        h('div', { class: 'sub' },
          h('button', { class: 'chname', type: 'button', text: decode(v.channel), onclick: goCh }),
          ` ・ ${fmtCount(v.views)} 回視聴 ・ ${fmtAgo(v.published)}`),
        extra ? h('div', { class: 'sub', text: extra(v) }) : null),
      h('button', { class: 'kebab', type: 'button', 'aria-label': 'メニュー', onclick: () => openVideoMenu(v, row, queue, menu) }, icon('vdots'))));
  decorateRow(row, v);
  return row;
}

function openVideoMenu(v, row, queue, menu) {
  const removeRow = () => { const i = queue.indexOf(v); if (i >= 0) queue.splice(i, 1); row.remove(); };
  const opts = menu ? menu(v, row, removeRow) : [];
  opts.push({ label: '再生リストに保存', onclick: () => saveToPlaylist(v) });
  opts.push({ label: '共有', onclick: () => shareVideo(v) });
  opts.push({ label: 'チャンネルを表示', onclick: () => openChannel(v.channelId, decode(v.channel)) });
  opts.push({ label: 'このチャンネルを除外（今後表示しない）', onclick: () => blockChannel(v.channelId, decode(v.channel)) });
  openMenu(decode(v.title), opts);
}

function blockChannel(id, name) {
  if (!isBlocked(id)) { settings.blocked.push({ id, name }); persist(); }
  document.querySelectorAll(`main [data-channel="${CSS.escape(id)}"], #upNext [data-channel="${CSS.escape(id)}"]`).forEach((n) => n.remove());
  toast(`「${name}」を除外しました。設定からいつでも戻せます。`);
}

// 「さらに読み込む」付きの一覧
function pagedList(box, fetchPage, { menu = null, compact = false, extra = null, summary = null, emptyText = '動画がありません。' } = {}) {
  const status = h('div', { class: 'status', 'aria-live': 'polite' });
  const list = h('div', { class: 'list' });
  const more = h('button', { class: 'more', type: 'button', text: 'さらに読み込む', hidden: true });
  box.append(status, list, more);
  let token = ''; let loading = false; let started = false;
  const loadMore = async () => {
    if (loading) return;
    loading = true; more.hidden = true;
    setMsg(status, '読み込んでいます…');
    try {
      const r = await fetchPage(token);
      token = r.next || '';
      renderVideos(list, r.items, { append: started, menu, compact, extra });
      started = true;
      const n = list.querySelectorAll('[data-vid]').length;
      setMsg(status, n ? (summary ? summary(n) : `${n}件`) : (token ? '条件に合う動画がこのページにありませんでした。' : emptyText));
      more.hidden = !token;
    } catch (e) {
      setMsg(status, e.message, true);
      more.hidden = !token;
    } finally { loading = false; }
  };
  more.addEventListener('click', loadMore);
  loadMore();
  return { list, status };
}

// ---------- 検索 ----------
async function fetchBatch() {
  const kept = [];
  let pages = 0;
  while (kept.length < PAGE_TARGET && pages < MAX_PAGES) {
    pages++;
    const params = { part: 'snippet', type: 'video', maxResults: 50, q: state.query,
      order: settings.order, pageToken: state.pageToken || '' };
    if (settings.jaOnly) { params.relevanceLanguage = 'ja'; params.regionCode = 'JP'; }
    // 長さの粗い絞り込みはAPI側で（short=4分未満 / medium=4〜20分 / long=20分超）
    if (settings.minMin >= 20) params.videoDuration = 'long';
    if (settings.maxMin > 0 && settings.maxMin < 4) params.videoDuration = 'short';
    if (settings.period) params.publishedAfter = new Date(Date.now() - settings.period * 86400000).toISOString();

    const res = await api('search', params, 100);
    state.pageToken = res.nextPageToken || null;
    const ids = (res.items || [])
      .filter((it) => it.id?.videoId && !state.shown.has(it.id.videoId) && !isBlocked(it.snippet.channelId))
      .map((it) => it.id.videoId);
    if (ids.length) {
      for (const item of await fetchVideoItems(ids, { lang: true, views: true })) {
        state.shown.add(item.id);
        kept.push(item);
      }
    }
    if (!state.pageToken) break;
  }
  return kept;
}

async function runSearch(reset) {
  if (state.loading) return;
  setTab('search');
  if (!settings.apiKey) { setMsg(els.search.status, '先に設定からAPIキーを入れてください。', true); openSettings(); return; }
  if (reset) {
    state.query = els.q.value.trim();
    if (!state.query) return;
    state.pageToken = null; state.shown = new Set();
    els.search.list.replaceChildren(); els.search.list._items = [];
    window.scrollTo({ top: 0 });
  }
  state.loading = true;
  els.search.empty.hidden = true; els.search.more.hidden = true;
  setMsg(els.search.status, '検索しています…');
  try {
    const items = await fetchBatch();
    renderVideos(els.search.list, items, { append: true });
    const total = els.search.list.querySelectorAll('[data-vid]').length;
    setMsg(els.search.status, total ? `${total}件表示中（条件に合わない動画は除外済み）` : '条件に合う動画が見つかりませんでした。条件をゆるめてみてください。');
    els.search.more.hidden = !state.pageToken;
  } catch (e) {
    setMsg(els.search.status, e.message, true);
  } finally {
    state.loading = false;
  }
}

// ---------- 登録チャンネルの新着 ----------
async function pool(items, limit, fn) {
  const out = []; let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]).catch(() => null); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function fetchFeed() {
  const channels = [];
  let pageToken = '';
  do {
    const res = await apiAuth('GET', 'subscriptions', { part: 'snippet', mine: 'true', maxResults: 50, pageToken }, null, 1);
    for (const s of res.items || []) channels.push(s.snippet.resourceId.channelId);
    pageToken = res.nextPageToken || '';
    setMsg(els.feed.status, `登録チャンネルを読み込み中…（${channels.length}件）`);
  } while (pageToken);
  if (!channels.length) return { items: [], channels: 0 };

  let done = 0;
  const lists = await pool(channels, 6, async (id) => {
    const res = await apiAuth('GET', 'playlistItems', { part: 'contentDetails', playlistId: 'UU' + id.slice(2), maxResults: FEED_PER_CHANNEL }, null, 1);
    done++;
    if (done % 10 === 0) setMsg(els.feed.status, `新着を集めています…（${done}/${channels.length}チャンネル）`);
    return (res.items || []).map((it) => ({ id: it.contentDetails.videoId, at: it.contentDetails.videoPublishedAt || '' }));
  });
  const seen = new Set();
  const recent = lists.flat().filter((x) => x && x.id && !seen.has(x.id) && seen.add(x.id))
    .sort((a, b) => (b.at > a.at ? 1 : -1)).slice(0, FEED_MAX);
  const items = await fetchVideoItems(recent.map((x) => x.id), {});
  items.sort((a, b) => (b.published > a.published ? 1 : -1));
  return { items, channels: channels.length };
}

function showFeedEmpty() {
  els.feed.list.replaceChildren();
  setMsg(els.feed.status, '');
  els.feed.empty.hidden = false;
  $('feedRefresh').hidden = true;
}

function renderFeed(cache) {
  els.feed.empty.hidden = true;
  renderVideos(els.feed.list, cache.items.filter((v) => !isBlocked(v.channelId)));
  const t = new Date(cache.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  setMsg(els.feed.status, cache.items.length
    ? `${cache.channels}チャンネルの新着 ${els.feed.list.querySelectorAll('[data-vid]').length}件（${t} 更新・長さなどの条件を適用済み）`
    : '新着が見つかりませんでした。');
  $('feedRefresh').hidden = false;
}

async function loadFeed(force) {
  if (state.feedLoading) return;
  if (!isLoggedIn()) { showFeedEmpty(); return; }
  const cache = load('mytube.feed', null);
  if (!force && cache && Date.now() - cache.at < FEED_TTL) { renderFeed(cache); return; }
  state.feedLoading = true;
  els.feed.empty.hidden = true;
  setMsg(els.feed.status, '新着を読み込んでいます…');
  try {
    await ensureToken();
    const res = await fetchFeed();
    const fresh = { at: Date.now(), items: res.items, channels: res.channels };
    save('mytube.feed', fresh);
    renderFeed(fresh);
  } catch (e) {
    setMsg(els.feed.status, e.message, true);
    $('feedRefresh').hidden = false;
  } finally {
    state.feedLoading = false;
  }
}

// ---------- 戻るボタンの管理 ----------
const nav = [];
function navPush(kind) { nav.push(kind); history.pushState({ mytube: nav.length }, ''); }
function navClose(kind) {
  if (nav[nav.length - 1] === kind) { history.back(); return; } // popstate 側で閉じる
  const i = nav.lastIndexOf(kind);
  if (i >= 0) nav.splice(i, 1);
  doClose(kind);
}
// 実際に何か閉じたら true
function doClose(kind) {
  if (kind === 'player' && playerMode === 'full') { minimizePlayer(); return true; }
  if (kind === 'detail' && detailStack.length) { closeDetailTop(); return true; }
  return false;
}
let ignorePop = 0;
window.addEventListener('popstate', () => {
  if (ignorePop) { ignorePop--; return; }
  let kind = nav.pop();
  // すでに閉じている画面の分は飛ばして、次に閉じられるものを閉じる
  while (kind && !doClose(kind)) {
    kind = nav.pop();
    if (kind) { ignorePop++; history.back(); }
  }
});

// ---------- タブ（下のメニュー）・検索モード・詳細ページ ----------
const detailStack = [];
let lastTab = 'home';
function showTabView() {
  const t = state.tab;
  $('homeView').hidden = t !== 'home';
  els.search.view.hidden = t !== 'search';
  els.feed.view.hidden = t !== 'feed';
  els.library.view.hidden = t !== 'library';
  els.chips.hidden = t !== 'search';
  $('topMain').hidden = t === 'search';
  $('topSearch').hidden = t !== 'search';
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
}
function setTab(tab) {
  if (tab !== 'search') lastTab = tab;
  state.tab = tab;
  detailStack.length = 0;
  $('detailView').hidden = true;
  showTabView();
}
function loadTab(tab) {
  if (tab === 'home') loadHome(false);
  if (tab === 'feed') loadFeed(false);
  if (tab === 'library') loadLibrary();
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  const same = state.tab === b.dataset.tab && !detailStack.length;
  setTab(b.dataset.tab);
  if (same) window.scrollTo({ top: 0, behavior: 'smooth' });
  loadTab(b.dataset.tab);
}));
$('openSearch').addEventListener('click', () => { setTab('search'); els.q.focus(); });
$('searchBack').addEventListener('click', () => { setTab(lastTab); loadTab(lastTab); });

function openDetail(title, render) {
  const node = h('div');
  detailStack.push({ title, node });
  showDetail();
  navPush('detail');
  render(node);
}
function showDetail() {
  const top = detailStack[detailStack.length - 1];
  if (!top) { $('detailView').hidden = true; showTabView(); return; }
  els.search.view.hidden = els.feed.view.hidden = els.library.view.hidden = $('homeView').hidden = true;
  els.chips.hidden = true;
  $('detailView').hidden = false;
  $('detailTitle').textContent = top.title;
  $('detailBody').replaceChildren(top.node);
  window.scrollTo({ top: 0 });
}
function closeDetailTop() { detailStack.pop(); showDetail(); }
$('detailBack').addEventListener('click', () => navClose('detail'));

function loginPrompt(text) {
  const msg = h('p', { class: 'hint' });
  return h('div', { class: 'empty' }, text, h('br'),
    h('button', { class: 'more', type: 'button', text: 'Googleでログイン',
      onclick: () => login().catch((e) => setMsg(msg, e.message, true)) }), msg);
}

// ---------- マイページ ----------
function myPageHeader() {
  const msg = h('p', { class: 'hint' });
  const head = h('div', { class: 'me-head' },
    isLoggedIn() && auth.avatar ? h('img', { class: 'me-av', src: auth.avatar, alt: '', referrerpolicy: 'no-referrer' }) : h('span', { class: 'me-av' }, icon('you')),
    h('div', { class: 'me-text' },
      h('div', { class: 'n', text: isLoggedIn() ? auth.name : 'ログインしていません' }),
      isLoggedIn()
        ? h('button', { class: 'link', type: 'button', text: 'ログアウト', onclick: () => { logout(); toast('ログアウトしました。'); } })
        : h('button', { class: 'primary-btn', type: 'button', text: 'Googleでログイン', onclick: () => login().catch((e) => setMsg(msg, e.message, true)) })),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': '設定', onclick: openSettings }, icon('settings')));
  return h('div', {}, head, msg);
}

function historyShelf() {
  const items = watchHistory.slice(0, 12);
  const all = h('button', { class: 'small', type: 'button', text: 'すべて表示', onclick: openHistory });
  if (!items.length) {
    return h('section', { class: 'home-sec' }, h('div', { class: 'section-head' }, h('h2', { text: '履歴' })),
      h('p', { class: 'hint', text: 'まだ再生履歴はありません。1秒以上再生した動画がここに並びます。' }));
  }
  return shelf('履歴', items, (v, row, removeRow) => [{ label: '履歴から削除', onclick: () => {
    watchHistory = watchHistory.filter((x) => x.id !== v.id); saveHistory(); removeRow();
  } }], all);
}

async function loadLibrary() {
  const box = $('libContent');
  const base = () => [myPageHeader(), historyShelf()];
  if (!isLoggedIn()) {
    box.replaceChildren(...base(), h('p', { class: 'hint', text: 'ログインすると、再生リストや高評価した動画もここに表示されます。' }));
    return;
  }
  box.replaceChildren(...base(), h('div', { class: 'status', text: '読み込んでいます…' }));
  try {
    await ensureToken();
    const res = await apiAuth('GET', 'playlists', { part: 'snippet,contentDetails,status', mine: 'true', maxResults: 50 }, null, 1);
    const lists = res.items || [];
    const form = createPlaylistForm();
    box.replaceChildren(...base(),
      h('div', { class: 'section-head' },
        h('h2', { text: '再生リスト' }),
        h('button', { class: 'small', type: 'button', text: '＋ 新規作成', onclick: () => { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('input').focus(); } })),
      form,
      h('div', { class: 'lib-rows' },
        h('button', { class: 'lib-row', type: 'button', onclick: openLiked },
          h('span', { class: 'ph' }, icon('like')), h('span', {}, h('span', { class: 't', text: '高評価した動画' }))),
        lists.map((p) => playlistRow(p, true))));
  } catch (e) {
    box.replaceChildren(...base(), h('div', { class: 'status error', text: e.message }));
  }
}

function createPlaylistForm(onCreated) {
  const title = h('input', { type: 'text', placeholder: '再生リストの名前', 'aria-label': '再生リストの名前', maxlength: '150' });
  const privacy = h('select', { 'aria-label': '公開設定' },
    h('option', { value: 'private', text: '非公開' }), h('option', { value: 'unlisted', text: '限定公開' }), h('option', { value: 'public', text: '公開' }));
  const msg = h('p', { class: 'hint' });
  const form = h('form', { hidden: true },
    h('div', { class: 'form-row' }, title, privacy, h('button', { class: 'primary-btn', type: 'submit', text: '作成' })), msg);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = title.value.trim();
    if (!name) { setMsg(msg, '名前を入れてください。', true); return; }
    setMsg(msg, '作成しています…');
    withLogin(() => apiAuth('POST', 'playlists', { part: 'snippet,status' }, { snippet: { title: name }, status: { privacyStatus: privacy.value } }, 50))
      .then((p) => { toast(`「${name}」を作成しました。`); if (onCreated) onCreated(p); else loadLibrary(); })
      .catch((err) => setMsg(msg, err.message, true));
  });
  return form;
}

function playlistRow(p, own) {
  const thumb = p.snippet.thumbnails?.high?.url || p.snippet.thumbnails?.medium?.url;
  const privacy = { private: '非公開', unlisted: '限定公開', public: '公開' }[p.status?.privacyStatus] || '';
  return h('button', { class: 'lib-row', type: 'button', onclick: () => openPlaylist(p, own) },
    thumb ? h('img', { src: thumb, alt: '', loading: 'lazy' }) : h('span', { class: 'ph', text: '≡' }),
    h('span', {},
      h('span', { class: 't', text: decode(p.snippet.title) }), h('br'),
      h('span', { class: 'sub', text: [`${p.contentDetails?.itemCount ?? 0}本`, privacy].filter(Boolean).join(' ・ ') })));
}

function openLiked() {
  openDetail('高評価した動画', (box) => {
    pagedList(box, async (token) => {
      await ensureToken();
      const r = await apiAuth('GET', 'videos', { part: 'snippet,contentDetails,statistics,player', maxWidth: 240, myRating: 'like', maxResults: 50, pageToken: token }, null, 1);
      return { items: (r.items || []).map((v) => toItem(v, { filter: false })), next: r.nextPageToken };
    }, { compact: true, summary: (n) => `${n}件`, emptyText: '高評価した動画はまだありません。' });
  });
}

function openPlaylist(p, own) {
  openDetail(decode(p.snippet.title), (box) => {
    const titleEl = h('div', { class: 'ch-head' }, h('div', {},
      h('div', { class: 'n', text: decode(p.snippet.title) }),
      h('div', { class: 'sub', text: `${p.contentDetails?.itemCount ?? 0}本${own ? '' : ' ・ ' + decode(p.snippet.channelTitle || '')}` })));
    const msg = h('p', { class: 'hint', 'aria-live': 'polite' });
    const acts = h('div', { class: 'acts' });
    const head = h('div', { class: 'detail-head' }, titleEl, acts, msg);
    box.append(head);

    let listRef = null;
    acts.append(h('button', { class: 'primary-btn', type: 'button', text: '▶ 全部再生', onclick: () => {
      const q = listRef?.list._items || [];
      if (q.length) openPlayer(q[0], q); else setMsg(msg, '再生できる動画がありません。', true);
    } }));

    if (own) {
      acts.append(h('button', { class: 'small', type: 'button', text: '名前を変更', onclick: () => {
        const input = h('input', { type: 'text', value: decode(p.snippet.title), 'aria-label': '新しい名前', maxlength: '150' });
        const f = h('form', { class: 'form-row' }, input, h('button', { class: 'primary-btn', type: 'submit', text: '保存' }));
        f.addEventListener('submit', (e) => {
          e.preventDefault();
          const name = input.value.trim(); if (!name) return;
          setMsg(msg, '保存しています…');
          withLogin(() => apiAuth('PUT', 'playlists', { part: 'snippet' }, { id: p.id, snippet: { title: name, description: p.snippet.description || '' } }, 50))
            .then(() => { p.snippet.title = name; titleEl.querySelector('.n').textContent = name; $('detailTitle').textContent = name; f.remove(); setMsg(msg, '名前を変更しました。'); })
            .catch((err) => setMsg(msg, err.message, true));
        });
        head.insertBefore(f, msg); input.focus();
      } }));
      let armed = false;
      const del = h('button', { class: 'small', type: 'button', text: '削除', onclick: () => {
        if (!armed) { armed = true; del.textContent = 'もう一度押すと削除します'; setTimeout(() => { armed = false; del.textContent = '削除'; }, 4000); return; }
        setMsg(msg, '削除しています…');
        withLogin(() => apiAuth('DELETE', 'playlists', { id: p.id }, null, 50))
          .then(() => { toast(`「${decode(p.snippet.title)}」を削除しました。`); navClose('detail'); loadLibrary(); })
          .catch((err) => setMsg(msg, err.message, true));
      } });
      acts.append(del);
    }

    const menu = own ? (v, row, removeRow) => [
      { label: '上へ移動', onclick: () => movePlaylistItem(p, v, row, -1, msg) },
      { label: '下へ移動', onclick: () => movePlaylistItem(p, v, row, 1, msg) },
      { label: 'リストから外す', onclick: () => {
        withLogin(() => apiAuth('DELETE', 'playlistItems', { id: v.plItemId }, null, 50))
          .then(() => { removeRow(); toast('リストから外しました。'); })
          .catch((err) => setMsg(msg, err.message, true));
      } }] : null;

    listRef = pagedList(box, async (token) => {
      const params = { part: 'snippet,contentDetails', playlistId: p.id, maxResults: 50, pageToken: token };
      const r = own ? (await ensureToken(), await apiAuth('GET', 'playlistItems', params, null, 1)) : await api('playlistItems', params, 1);
      const meta = new Map((r.items || []).map((it) => [it.contentDetails.videoId, { plItemId: it.id, position: it.snippet.position }]));
      const items = await fetchVideoItems([...meta.keys()], { filter: false });
      for (const it of items) Object.assign(it, meta.get(it.id));
      return { items, next: r.nextPageToken };
    }, { menu, compact: true, summary: (n) => `${n}本（削除・非公開の動画は表示されません）` });
  });
}

function movePlaylistItem(p, v, row, dir, msg) {
  const list = row.parentNode; const q = list._items;
  const i = q.indexOf(v); const other = q[i + dir];
  if (!other) return;
  const target = other.position;
  withLogin(() => apiAuth('PUT', 'playlistItems', { part: 'snippet' },
    { id: v.plItemId, snippet: { playlistId: p.id, resourceId: { kind: 'youtube#video', videoId: v.id }, position: target } }, 50))
    .then(() => {
      other.position += dir < 0 ? 1 : -1; v.position = target;
      q[i] = other; q[i + dir] = v;
      if (dir < 0) list.insertBefore(row, row.previousSibling); else list.insertBefore(row.nextSibling, row);
      setMsg(msg, '並べ替えました。');
    })
    .catch((err) => setMsg(msg, err.message, true));
}

// ---------- チャンネル登録ボタン ----------
function subscribeButton(channelId) {
  const btn = h('button', { class: 'sub-btn', type: 'button', text: '登録', 'aria-pressed': 'false' });
  let subId = null; let busy = false;
  const set = (id) => { subId = id; btn.textContent = id ? '登録済み' : '登録'; btn.setAttribute('aria-pressed', String(!!id)); };
  const check = () => apiAuth('GET', 'subscriptions', { part: 'id', mine: 'true', forChannelId: channelId }, null, 1)
    .then((r) => set(r.items?.[0]?.id || null));
  if (isLoggedIn() && tokenValid()) check().catch(() => {});
  btn.addEventListener('click', () => {
    if (busy) return; busy = true;
    const wasLoggedIn = isLoggedIn();
    withLogin(async () => {
      if (!wasLoggedIn) { await check(); if (subId) { toast('すでに登録済みです。'); return; } }
      if (subId) {
        await apiAuth('DELETE', 'subscriptions', { id: subId }, null, 50);
        set(null); toast('チャンネル登録を解除しました。');
      } else {
        try {
          const r = await apiAuth('POST', 'subscriptions', { part: 'snippet' }, { snippet: { resourceId: { kind: 'youtube#channel', channelId } } }, 50);
          set(r.id); toast('チャンネル登録しました。');
        } catch (e) { if (e.reason === 'subscriptionDuplicate') { await check(); toast('すでに登録済みです。'); } else throw e; }
      }
      remove('mytube.feed'); // 新着一覧を作り直す
    }).catch((e) => toast(e.message)).finally(() => { busy = false; });
  });
  return btn;
}

// ---------- チャンネルページ ----------
function openChannel(channelId, name) {
  if (playerMode === 'full') minimizePlayer();
  openDetail(name || 'チャンネル', async (box) => {
    const status = h('div', { class: 'status', text: '読み込んでいます…' });
    box.append(status);
    let ch;
    try {
      ch = (await api('channels', { part: 'snippet,statistics,contentDetails', id: channelId }, 1)).items?.[0];
      if (!ch) throw new Error('チャンネルが見つかりませんでした。');
    } catch (e) { setMsg(status, e.message, true); return; }
    status.remove();
    const st = ch.statistics || {};
    box.append(h('div', { class: 'detail-head' },
      h('div', { class: 'ch-head' },
        h('img', { src: ch.snippet.thumbnails?.medium?.url || ch.snippet.thumbnails?.default?.url || 'icon.svg', alt: '', referrerpolicy: 'no-referrer' }),
        h('div', { style: 'flex:1;min-width:0' },
          h('div', { class: 'n', text: ch.snippet.title }),
          h('div', { class: 'sub', text: [st.hiddenSubscriberCount ? '' : `登録者 ${fmtCount(st.subscriberCount)}人`, `動画 ${fmtCount(st.videoCount)}本`].filter(Boolean).join(' ・ ') })),
        subscribeButton(channelId))));

    const content = h('div');
    const tabs = [['動画', () => {
      const uploads = ch.contentDetails?.relatedPlaylists?.uploads || 'UU' + channelId.slice(2);
      pagedList(content, async (token) => {
        const r = await api('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: 50, pageToken: token }, 1);
        const items = await fetchVideoItems((r.items || []).map((it) => it.contentDetails.videoId), { skipBlocked: true });
        return { items, next: r.nextPageToken };
      }, { summary: (n) => `${n}件（長さなどの条件に合わない動画は除外）` });
    }], ['再生リスト', async () => {
      const s = h('div', { class: 'status', text: '読み込んでいます…' }); content.append(s);
      try {
        const r = await api('playlists', { part: 'snippet,contentDetails', channelId, maxResults: 50 }, 1);
        const lists = r.items || [];
        s.textContent = lists.length ? `${lists.length}件` : '公開されている再生リストはありません。';
        content.append(h('div', { class: 'lib-rows' }, lists.map((p) => playlistRow(p, false))));
      } catch (e) { setMsg(s, e.message, true); }
    }], ['概要', () => {
      content.append(h('div', { class: 'prewrap', text: ch.snippet.description || '（説明はありません）' }),
        h('p', { class: 'hint', text: `開設日 ${new Date(ch.snippet.publishedAt).toLocaleDateString('ja-JP')} ・ 総再生回数 ${fmtViews(st.viewCount)}` }));
    }]];
    const bar = h('div', { class: 'subtabs', role: 'tablist' });
    tabs.forEach(([label, show], i) => {
      bar.append(h('button', { type: 'button', role: 'tab', text: label, 'aria-selected': String(i === 0), onclick: (e) => {
        bar.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b === e.currentTarget)));
        content.replaceChildren(); show();
      } }));
    });
    box.append(bar, content);
    tabs[0][1]();
  });
}

// ---------- クイックフィルタ ----------
const CHIPS = [
  { label: '4分以上', on: () => settings.minMin === 4, toggle: () => { settings.minMin = settings.minMin === 4 ? 0 : 4; } },
  { label: '20分以上', on: () => settings.minMin === 20, toggle: () => { settings.minMin = settings.minMin === 20 ? 0 : 20; } },
  { label: '新しい順', on: () => settings.order === 'date', toggle: () => { settings.order = settings.order === 'date' ? 'relevance' : 'date'; } },
  { label: '再生回数順', on: () => settings.order === 'viewCount', toggle: () => { settings.order = settings.order === 'viewCount' ? 'relevance' : 'viewCount'; } },
  { label: '日本語のみ', on: () => settings.jaOnly, toggle: () => { settings.jaOnly = !settings.jaOnly; } },
  { label: '今週', on: () => settings.period === '7', toggle: () => { settings.period = settings.period === '7' ? '' : '7'; } },
  { label: 'ライブ除外', on: () => settings.noLive, toggle: () => { settings.noLive = !settings.noLive; } },
];
function renderChips() {
  els.chips.replaceChildren(...CHIPS.map((c) => h('button', { class: 'chip', type: 'button', text: c.label, 'aria-pressed': String(c.on()),
    onclick: () => { c.toggle(); persist(); renderChips(); if (state.query) runSearch(true); } })));
}

// ---------- 設定シート ----------
function openSettings() {
  $('apiKey').value = settings.apiKey;
  $('clientId').value = settings.clientId;
  $('minMin').value = settings.minMin;
  $('maxMin').value = settings.maxMin;
  $('order').value = settings.order;
  $('period').value = settings.period;
  $('minViews').value = settings.minViews;
  $('jaOnly').checked = settings.jaOnly;
  $('noLive').checked = settings.noLive;
  $('autoNext').checked = settings.autoNext;
  $('cc').checked = settings.cc;
  $('speed').value = String(settings.speed);
  $('historyOn').checked = settings.historyOn;
  $('historyInfo').textContent = `いま ${watchHistory.length}本記録しています（最新${HISTORY_MAX}本まで・このスマホの中だけに保存）。`;
  $('accountMsg').textContent = '';
  renderBlocked();
  renderAccount();
  $('quota').textContent = `約 ${quotaUsed().toLocaleString('ja-JP')} / 10,000 ユニット（検索1ページ = 100、新着の更新 ≒ 登録チャンネル数、高評価・保存・登録・コメント投稿 = 各50、それ以外の読み込み = 1）`;
  els.dialog.showModal();
}
function renderBlocked() {
  $('blockedList').replaceChildren(...settings.blocked.map((b) => h('li', {},
    h('span', { text: b.name }),
    h('button', { type: 'button', text: '戻す', onclick: () => { settings.blocked = settings.blocked.filter((x) => x.id !== b.id); persist(); renderBlocked(); } }))));
  $('blockedEmpty').hidden = settings.blocked.length > 0;
}
function readSettingsForm() {
  const num = (id) => Math.max(0, parseInt($(id).value, 10) || 0);
  const newClient = $('clientId').value.trim() || BUILTIN_CLIENT_ID;
  if (newClient !== settings.clientId) { tokenClient = null; settings.clientId = newClient; }
  settings.apiKey = $('apiKey').value.trim();
  settings.minMin = num('minMin');
  settings.maxMin = num('maxMin');
  settings.order = $('order').value;
  settings.period = $('period').value;
  settings.minViews = num('minViews');
  settings.jaOnly = $('jaOnly').checked;
  settings.noLive = $('noLive').checked;
  settings.autoNext = $('autoNext').checked;
  settings.cc = $('cc').checked;
  settings.speed = parseFloat($('speed').value) || 1;
  settings.historyOn = $('historyOn').checked;
  persist();
  updateSpeedLabel();
  if (settings.clientId) loadGis().then(initTokenClient).catch(() => {});
}
$('openSettings').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => els.dialog.close());
els.dialog.addEventListener('click', (e) => { if (e.target === els.dialog) els.dialog.close(); });
$('saveSettings').addEventListener('click', () => {
  readSettingsForm(); renderChips(); els.dialog.close();
  if (state.tab === 'search' && state.query && !detailStack.length) runSearch(true);
  if (state.tab === 'feed' && isLoggedIn()) { const c = load('mytube.feed', null); if (c) renderFeed(c); }
});
$('clientId').addEventListener('change', () => { readSettingsForm(); });
$('loginBtn').addEventListener('click', () => {
  readSettingsForm();
  $('accountMsg').textContent = '';
  login().then(() => { $('accountMsg').textContent = 'ログインしました。'; })
    .catch((e) => { $('accountMsg').textContent = e.message; });
});
$('logoutBtn').addEventListener('click', () => { logout(); $('accountMsg').textContent = 'ログアウトしました。'; });
let clearArmed = false;
$('clearHistory').addEventListener('click', () => {
  const b = $('clearHistory');
  if (!clearArmed) { clearArmed = true; b.textContent = 'もう一度押すと全部消します'; setTimeout(() => { clearArmed = false; b.textContent = '再生履歴をすべて消す'; }, 4000); return; }
  clearArmed = false; b.textContent = '再生履歴をすべて消す';
  watchHistory = []; saveHistory();
  $('historyInfo').textContent = '再生履歴を消しました。';
  document.querySelectorAll('main [data-vid]').forEach((row) => { row.classList.remove('watched'); row.querySelectorAll('.prog, .wbadge').forEach((n) => n.remove()); });
});

// ---------- 選択メニュー（下から出るシート） ----------
function openMenu(title, options, hint) {
  $('menuTitle').textContent = title;
  $('menuList').replaceChildren(...options.map((o) => h('li', {},
    h('button', { type: 'button', text: o.label, 'aria-current': o.selected ? 'true' : null,
      onclick: () => { $('menuDialog').close(); o.onclick(); } }))));
  $('menuHint').hidden = !hint; $('menuHint').textContent = hint || '';
  if (!$('menuDialog').open) $('menuDialog').showModal();
}
$('menuClose').addEventListener('click', () => $('menuDialog').close());
$('menuDialog').addEventListener('click', (e) => { if (e.target === $('menuDialog')) $('menuDialog').close(); });

// ---------- プレーヤー ----------
let ytPlayer = null;
let ytCc = null;
let ytApiPromise = null;
let playerMode = 'closed'; // 'full' | 'mini' | 'closed'
let current = null;
let queue = [];
let rating = 'none';
let likeCount = null;
let detailToken = 0;
let commentsFor = null;
const sleep = { timer: null, tick: null, endAt: 0, endOfVideo: false };
const playerReport = (t, err) => setMsg($('pMsg'), t, err);

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { ytApiPromise = null; reject(new Error('プレーヤーを読み込めませんでした。通信状況を確認してください。')); };
      document.head.append(s);
    });
  }
  return ytApiPromise;
}

async function loadIntoPlayer(id, start = 0) {
  await loadYouTubeApi();
  if (ytPlayer && ytCc === settings.cc && typeof ytPlayer.loadVideoById === 'function') {
    ytPlayer.loadVideoById({ videoId: id, startSeconds: start });
    return;
  }
  if (ytPlayer) { try { ytPlayer.destroy(); } catch { /* noop */ } }
  const host = h('div');
  $('frame').replaceChildren(host);
  ytCc = settings.cc;
  setCcUi(settings.cc);
  ytPlayer = new YT.Player(host, {
    width: '100%', height: '100%', videoId: id,
    // controls: 0 … YouTube 側の操作ボタンを消し、MyTube の操作バー（動画の下）で操作する
    playerVars: { autoplay: 1, playsinline: 1, controls: 0, fs: 0, rel: 0, iv_load_policy: 3, hl: 'ja', cc_lang_pref: 'ja', cc_load_policy: settings.cc ? 1 : 0, start: Math.floor(start) },
    events: {
      onReady: (e) => { try { e.target.setPlaybackRate(settings.speed); e.target.playVideo(); } catch { /* noop */ } },
      onStateChange: onYtState,
    },
  });
}

// 再生中は3秒ごとに位置を記録
let progressTimer = null;
function saveCurrentProgress(ended) {
  if (!current || !ytPlayer) return;
  try {
    const pos = ended ? 0 : ytPlayer.getCurrentTime();
    if (!ended && ytPlayer.getVideoData?.().video_id && ytPlayer.getVideoData().video_id !== current.id) return; // まだ前の動画
    recordProgress(current, pos, ended, ytPlayer.getDuration?.());
  } catch { /* noop */ }
}
function stopProgressTimer() { clearInterval(progressTimer); progressTimer = null; }
function setMiniPlaying(playing) {
  for (const id of ['miniPlay', 'playBtn']) {
    $(id).replaceChildren(icon(playing ? 'pause' : 'play'));
    $(id).setAttribute('aria-label', playing ? '一時停止' : '再生');
  }
}

// ---------- 操作バー（動画の下） ----------
let seeking = false;
function updateTimeUi() {
  if (!ytPlayer?.getDuration || seeking) return;
  try {
    const dur = ytPlayer.getDuration() || 0; const cur = ytPlayer.getCurrentTime() || 0;
    $('ptime').textContent = `${fmtDuration(Math.floor(cur))} / ${fmtDuration(Math.floor(dur))}`;
    const p = dur ? (cur / dur) * 1000 : 0;
    $('seek').value = String(Math.round(p));
    $('seek').style.setProperty('--p', `${p / 10}%`);
  } catch { /* noop */ }
}
setInterval(() => { if (playerMode === 'full') updateTimeUi(); }, 500);
$('seek').addEventListener('input', () => {
  seeking = true;
  const p = +$('seek').value / 1000;
  $('seek').style.setProperty('--p', `${p * 100}%`);
  try { $('ptime').textContent = `${fmtDuration(Math.floor(p * ytPlayer.getDuration()))} / ${fmtDuration(Math.floor(ytPlayer.getDuration()))}`; } catch { /* noop */ }
});
$('seek').addEventListener('change', () => {
  try { ytPlayer.seekTo((+$('seek').value / 1000) * ytPlayer.getDuration(), true); } catch { /* noop */ }
  seeking = false;
});
const skip = (sec) => {
  try {
    const dur = ytPlayer.getDuration() || Infinity;
    ytPlayer.seekTo(Math.min(Math.max(0, ytPlayer.getCurrentTime() + sec), dur - 1), true);
    updateTimeUi();
  } catch { /* noop */ }
};
$('back10').addEventListener('click', () => skip(-10));
$('fwd10').addEventListener('click', () => skip(10));
const togglePlay = () => {
  try { if (ytPlayer.getPlayerState() === window.YT.PlayerState.PLAYING) ytPlayer.pauseVideo(); else ytPlayer.playVideo(); } catch { /* noop */ }
};
$('playBtn').addEventListener('click', togglePlay);

// 字幕のオン・オフ（日本語を優先）
let ccOn = false;
function setCcUi(on) { ccOn = on; $('ccBtn').setAttribute('aria-pressed', String(on)); }
$('ccBtn').addEventListener('click', () => {
  if (!ytPlayer) return;
  try {
    if (ccOn) { ytPlayer.unloadModule('captions'); setCcUi(false); toast('字幕：オフ'); }
    else {
      ytPlayer.loadModule('captions');
      setTimeout(() => { try { ytPlayer.setOption('captions', 'track', { languageCode: 'ja' }); } catch { /* noop */ } }, 500);
      setCcUi(true); toast('字幕：オン（字幕がない動画では表示されません）');
    }
  } catch { toast('この動画では字幕を切り替えられませんでした。'); }
});

// 全画面（横向き）。操作バーは動画の下に残す
$('fsBtn').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    await $('player').requestFullscreen({ navigationUI: 'hide' });
    try { await screen.orientation?.lock?.('landscape'); } catch { /* 向きを固定できない端末もある */ }
  } catch { toast('全画面にできませんでした。'); }
});
document.addEventListener('fullscreenchange', () => {
  $('fsBtn').setAttribute('aria-label', document.fullscreenElement ? '全画面を終了' : '全画面');
  if (!document.fullscreenElement) { try { screen.orientation?.unlock?.(); } catch { /* noop */ } }
});

function onYtState(e) {
  const S = window.YT.PlayerState;
  if (e.data === S.PLAYING) {
    if (!progressTimer) progressTimer = setInterval(() => saveCurrentProgress(false), 3000);
    setTimeout(() => saveCurrentProgress(false), 1200); // 1秒再生した時点で記録
    try { if (ytPlayer.getPlaybackRate() !== settings.speed) ytPlayer.setPlaybackRate(settings.speed); } catch { /* noop */ }
    setMiniPlaying(true);
  } else {
    stopProgressTimer();
    if (e.data === S.PAUSED) saveCurrentProgress(false);
    if (e.data === S.ENDED) saveCurrentProgress(true);
    if (e.data === S.PAUSED || e.data === S.ENDED) setMiniPlaying(false);
  }
  if (e.data === S.ENDED) {
    if (sleep.endOfVideo) { clearSleep(); toast('タイマーで停止しました。'); return; }
    if (settings.autoNext) playNext();
  }
}

function nextItem() {
  const i = queue.indexOf(current);
  for (let j = i + 1; j < queue.length; j++) if (!isBlocked(queue[j].channelId)) return queue[j];
  return null;
}
function playNext() { const n = nextItem(); if (n) openPlayer(n, queue, { keepMode: true }); }

function openPlayer(v, list, { keepMode = false } = {}) {
  if (playerMode !== 'closed' && current && current.id !== v.id) saveCurrentProgress(false); // 前の動画の位置を保存
  stopProgressTimer();
  current = v;
  queue = Array.isArray(list) && list.includes(v) ? list : [v];
  if (!keepMode || playerMode === 'closed') showFullPlayer();
  $('player').hidden = false;
  $('player').dataset.short = isShort(v) ? '1' : ''; // ショートは縦長に表示
  renderPlayerInfo(v);
  const e = histGet(v.id);
  const start = settings.historyOn && e && !e.done && e.pos >= RESUME_MIN ? e.pos : 0;
  if (start) {
    $('pMsg').classList.remove('error');
    $('pMsg').replaceChildren(`前回の続き（${fmtDuration(start)}）から再生しています。 `,
      h('button', { class: 'link', type: 'button', text: '最初から見る', onclick: () => {
        try { ytPlayer.seekTo(0, true); ytPlayer.playVideo(); } catch { /* noop */ }
        $('pMsg').textContent = '';
      } }));
    const shownFor = v.id;
    setTimeout(() => { if (current?.id === shownFor && /前回の続き/.test($('pMsg').textContent)) $('pMsg').textContent = ''; }, 10000);
  }
  loadIntoPlayer(v.id, start).catch((err) => playerReport(err.message, true));
}

function showFullPlayer() {
  const wasFull = playerMode === 'full';
  playerMode = 'full';
  $('player').className = 'player full';
  $('player').hidden = false;
  document.body.classList.remove('has-mini');
  if (!wasFull) navPush('player');
}
function minimizePlayer() {
  if (playerMode !== 'full') return;
  playerMode = 'mini';
  $('player').className = 'player mini' + miniCornerClass();
  document.body.classList.add('has-mini');
}
function closePlayer() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  saveCurrentProgress(false);
  stopProgressTimer();
  playerMode = 'closed';
  try { ytPlayer?.stopVideo(); } catch { /* noop */ }
  $('player').hidden = true;
  document.body.classList.remove('has-mini');
  clearSleep();
  if ($('menuDialog').open) $('menuDialog').close();
  if ($('commentsDialog').open) $('commentsDialog').close();
}

function setRating(r) {
  rating = r;
  $('pLike').setAttribute('aria-pressed', String(r === 'like'));
  $('pDislike').setAttribute('aria-pressed', String(r === 'dislike'));
  $('pLikeCount').textContent = likeCount == null ? '高評価' : fmtCount(likeCount);
}

function renderUpNext() {
  const box = $('upNext');
  box.replaceChildren();
  const i = queue.indexOf(current);
  const rest = queue.slice(i + 1).filter((v) => !isBlocked(v.channelId)).slice(0, 20);
  if (rest.length && isShort(current)) box.append(shortsShelf(rest)); // ショートの続きは縦長の棚で
  else for (const v of rest) box.append(renderRow(v, queue));
  $('upNextEmpty').hidden = rest.length > 0;
  fillAvatars();
}

function renderPlayerInfo(v) {
  const token = ++detailToken;
  likeCount = null; commentsFor = null;
  $('pTitle').textContent = decode(v.title);
  $('miniT').textContent = decode(v.title);
  $('miniSub').textContent = decode(v.channel);
  $('pStats').textContent = `${fmtCount(v.views)} 回視聴 ${fmtAgo(v.published)}`;
  $('pTitleBtn').setAttribute('aria-expanded', 'false');
  $('pDescBox').hidden = true;
  $('pDesc').textContent = '';
  $('chapters').replaceChildren(); $('chapters').hidden = true;
  $('pChName').textContent = decode(v.channel);
  $('pChSubs').textContent = '';
  if (avatarCache[v.channelId]) $('pChAv').src = avatarCache[v.channelId]; else $('pChAv').removeAttribute('src');
  $('pSubWrap').replaceChildren(subscribeButton(v.channelId));
  setRating('none'); setMsg($('pMsg'), '');
  $('cCount').textContent = '';
  $('cPreview').textContent = 'タップしてコメントを表示';
  $('autoNextToggle').checked = settings.autoNext;
  renderUpNext();
  $('pInfo').scrollTop = 0;

  if (isLoggedIn() && tokenValid()) {
    apiAuth('GET', 'videos/getRating', { id: v.id }, null, 1)
      .then((r) => { if (token === detailToken) setRating(r.items?.[0]?.rating || 'none'); }).catch(() => {});
  }
  api('videos', { part: 'snippet,statistics', id: v.id }, 1).then((r) => {
    const d = r.items?.[0];
    if (!d || token !== detailToken) return;
    const st = d.statistics || {};
    $('pStats').textContent = `${fmtCount(st.viewCount)} 回視聴 ${fmtAgo(d.snippet.publishedAt)}`;
    likeCount = st.likeCount != null ? +st.likeCount : null;
    setRating(rating);
    $('pDesc').textContent = d.snippet.description || '（説明はありません）';
    $('cCount').textContent = st.commentCount != null ? fmtCount(st.commentCount) : '';
    const chapters = parseChapters(d.snippet.description);
    if (chapters.length) {
      $('chapters').replaceChildren(...chapters.map((c) => h('button', { type: 'button', onclick: () => { try { ytPlayer.seekTo(c.sec, true); ytPlayer.playVideo(); } catch { /* noop */ } } },
        h('span', { class: 'ts', text: c.t }), h('span', { text: c.label }))));
      $('chapters').hidden = false;
    }
  }).catch(() => {});
  api('channels', { part: 'snippet,statistics', id: v.channelId }, 1).then((r) => {
    const c = r.items?.[0];
    if (!c || token !== detailToken) return;
    const url = c.snippet.thumbnails?.default?.url;
    if (url) { $('pChAv').src = url; avatarCache[v.channelId] = url; save('mytube.avatars', avatarCache); }
    if (!c.statistics?.hiddenSubscriberCount) $('pChSubs').textContent = `チャンネル登録者数 ${fmtCount(c.statistics?.subscriberCount)}人`;
  }).catch(() => {});
  api('commentThreads', { part: 'snippet', videoId: v.id, maxResults: 1, order: 'relevance', textFormat: 'plainText' }, 1).then((r) => {
    if (token !== detailToken) return;
    const t = r.items?.[0]?.snippet?.topLevelComment?.snippet;
    $('cPreview').textContent = t ? `${t.authorDisplayName}：${decode(t.textDisplay)}` : 'まだコメントはありません。最初のコメントを書いてみましょう。';
  }).catch((e) => { if (token === detailToken && /コメントがオフ/.test(e.message)) $('cPreview').textContent = 'この動画はコメントがオフになっています。'; });
}

function parseChapters(desc) {
  const out = [];
  for (const line of (desc || '').split('\n')) {
    const m = line.match(/(?:^|[\s(（[【])((?:\d{1,2}:)?\d{1,2}:\d{2})(?=$|[\s)）\]】\-–—:：|・])/);
    if (!m) continue;
    const sec = m[1].split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
    const label = line.replace(m[1], '').replace(/^[\s\-–—:：|・()（）[\]【】]+|[\s\-–—|]+$/g, '').trim();
    out.push({ sec, t: m[1], label: label || m[1] });
  }
  return out.length >= 2 ? out : [];
}

$('pTitleBtn').addEventListener('click', () => {
  const open = $('pTitleBtn').getAttribute('aria-expanded') !== 'true';
  $('pTitleBtn').setAttribute('aria-expanded', String(open));
  $('pDescBox').hidden = !open;
});

function rate(target) {
  const v = current; if (!v) return;
  const next = rating === target ? 'none' : target;
  withLogin(() => apiAuth('POST', 'videos/rate', { id: v.id, rating: next }, null, 50))
    .then(() => {
      if (likeCount != null) { if (rating === 'like') likeCount--; if (next === 'like') likeCount++; }
      setRating(next);
      toast({ like: '高評価しました。', dislike: '低評価しました（数は相手に表示されません）。', none: '評価を取り消しました。' }[next]);
    })
    .catch((e) => playerReport(e.message, true));
}
$('pLike').addEventListener('click', () => rate('like'));
$('pDislike').addEventListener('click', () => rate('dislike'));

// 再生リストに保存（再生画面と「︙」メニューの両方から使う）
function saveToPlaylist(v, report = (t, err) => { if (t) toast(t); }) {
  report('再生リストを読み込んでいます…');
  withLogin(() => apiAuth('GET', 'playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: 50 }, null, 1))
    .then((res) => {
      report('');
      const addTo = (p) => {
        report('保存しています…');
        apiAuth('POST', 'playlistItems', { part: 'snippet' },
          { snippet: { playlistId: p.id, resourceId: { kind: 'youtube#video', videoId: v.id } } }, 50)
          .then(() => report(`「${decode(p.snippet.title)}」に保存しました。`))
          .catch((e) => report(e.message, true));
      };
      const options = (res.items || []).map((p) => ({ label: `${decode(p.snippet.title)}（${p.contentDetails?.itemCount ?? 0}本）`, onclick: () => addTo(p) }));
      options.push({ label: '＋ 新しい再生リストを作って保存', onclick: () => {
        $('menuTitle').textContent = '新しい再生リスト';
        const form = createPlaylistForm((p) => { $('menuDialog').close(); addTo(p); });
        form.hidden = false;
        $('menuList').replaceChildren(h('li', {}, form));
        $('menuHint').hidden = true;
        $('menuDialog').showModal();
        form.querySelector('input').focus();
      } });
      openMenu('再生リストに保存', options);
    })
    .catch((e) => report(e.message, true));
}
$('pSave').addEventListener('click', () => { if (current) saveToPlaylist(current, playerReport); });

async function shareVideo(v, report = (t) => toast(t)) {
  const url = `https://youtu.be/${v.id}`;
  if (navigator.share) {
    try { await navigator.share({ title: decode(v.title), url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('リンクをコピーしました。'); }
  catch { report(url); }
}
$('pShare').addEventListener('click', () => { if (current) shareVideo(current, playerReport); });

function updateSpeedLabel() { /* 速度は「その他」メニューに表示 */ }
function openSpeedMenu() {
  openMenu('再生速度', SPEEDS.map((s) => ({ label: s === 1 ? '1倍（標準）' : `${s}倍`, selected: s === settings.speed,
    onclick: () => { settings.speed = s; persist(); try { ytPlayer?.setPlaybackRate(s); } catch { /* noop */ } toast(`再生速度：${s}倍`); } })),
  '選んだ速度は次の動画にも使われます。');
}

function clearSleep() {
  clearTimeout(sleep.timer); clearInterval(sleep.tick);
  sleep.timer = sleep.tick = null; sleep.endAt = 0; sleep.endOfVideo = false;
  $('pTimerLabel').textContent = 'タイマー'; $('pTimer').removeAttribute('aria-pressed');
  $('pTimer').hidden = true; // タイマー中だけ表示する
}
function updateTimerLabel() {
  if (sleep.endOfVideo) { $('pTimerLabel').textContent = 'この動画まで'; return; }
  const left = Math.max(0, Math.ceil((sleep.endAt - Date.now()) / 60000));
  $('pTimerLabel').textContent = `残り${left}分`;
}
function setSleep(min) {
  clearSleep();
  $('pTimer').hidden = false;
  $('pTimer').setAttribute('aria-pressed', 'true');
  if (min === 'end') { sleep.endOfVideo = true; updateTimerLabel(); toast('この動画が終わったら停止します。'); return; }
  sleep.endAt = Date.now() + min * 60000;
  sleep.timer = setTimeout(() => { try { ytPlayer?.pauseVideo(); } catch { /* noop */ } clearSleep(); toast('タイマーで停止しました。'); }, min * 60000);
  sleep.tick = setInterval(updateTimerLabel, 30000);
  updateTimerLabel();
  toast(`${min}分後に停止します。`);
}
function openTimerMenu() {
  const on = sleep.timer || sleep.endOfVideo;
  const opts = [15, 30, 45, 60, 90].map((m) => ({ label: `${m}分後に停止`, onclick: () => setSleep(m) }));
  opts.push({ label: 'この動画が終わったら停止', onclick: () => setSleep('end') });
  if (on) opts.push({ label: 'タイマーを解除', onclick: () => { clearSleep(); toast('タイマーを解除しました。'); } });
  openMenu('スリープタイマー', opts, 'スマホの画面を消すと再生も止まります（ブラウザの仕様です）。');
}
$('pTimer').addEventListener('click', openTimerMenu);

$('pMore').addEventListener('click', () => {
  const v = current; if (!v) return;
  openMenu('その他', [
    { label: `再生速度（いま ${settings.speed}倍）`, onclick: openSpeedMenu },
    { label: sleep.timer || sleep.endOfVideo ? `スリープタイマー（${$('pTimerLabel').textContent}）` : 'スリープタイマー', onclick: openTimerMenu },
    { label: 'YouTubeで開く', onclick: () => window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`, '_blank', 'noopener') },
    { label: 'チャンネルを表示', onclick: () => openChannel(v.channelId, decode(v.channel)) },
    { label: 'このチャンネルを除外（今後表示しない）', onclick: () => { blockChannel(v.channelId, decode(v.channel)); closePlayer(); } },
    { label: 'プレーヤーを閉じる', onclick: closePlayer },
  ]);
});

const goCurrentChannel = () => { if (current) openChannel(current.channelId, decode(current.channel)); };
$('pChannel').addEventListener('click', goCurrentChannel);
$('pChAvBtn').addEventListener('click', goCurrentChannel);
$('autoNextToggle').addEventListener('change', (e) => { settings.autoNext = e.target.checked; persist(); });
$('pMin').addEventListener('click', () => minimizePlayer());
// ---------- 小窓（ミニプレーヤー）：下のバーをドラッグして四隅に移動 ----------
function miniCornerClass() {
  const c = settings.miniCorner || 'bottom-right';
  return (c.startsWith('top') ? ' at-top' : '') + (c.endsWith('left') ? ' at-left' : '');
}
let miniDrag = null;
let miniJustDragged = false;
$('miniTitle').addEventListener('pointerdown', (e) => {
  if (playerMode !== 'mini') return;
  const r = $('player').getBoundingClientRect();
  miniDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: r.left + r.width / 2, cy: r.top + r.height / 2, moved: false };
  $('miniTitle').setPointerCapture(e.pointerId);
});
$('miniTitle').addEventListener('pointermove', (e) => {
  if (!miniDrag || e.pointerId !== miniDrag.id) return;
  const dx = e.clientX - miniDrag.x; const dy = e.clientY - miniDrag.y;
  if (!miniDrag.moved && Math.hypot(dx, dy) < 8) return;
  miniDrag.moved = true;
  $('player').classList.add('dragging');
  $('player').style.transform = `translate(${dx}px, ${dy}px)`;
});
const endMiniDrag = (e) => {
  if (!miniDrag || e.pointerId !== miniDrag.id) return;
  const d = miniDrag; miniDrag = null;
  $('player').style.transform = '';
  $('player').classList.remove('dragging');
  miniJustDragged = d.moved;
  if (!d.moved) return;
  // 指を離した位置に一番近い角へ吸い付ける
  const cx = d.cx + (e.clientX - d.x); const cy = d.cy + (e.clientY - d.y);
  settings.miniCorner = `${cy < innerHeight / 2 ? 'top' : 'bottom'}-${cx < innerWidth / 2 ? 'left' : 'right'}`;
  persist();
  $('player').className = 'player mini' + miniCornerClass();
};
$('miniTitle').addEventListener('pointerup', endMiniDrag);
$('miniTitle').addEventListener('pointercancel', endMiniDrag);
$('miniTitle').addEventListener('click', () => { if (miniJustDragged) { miniJustDragged = false; return; } showFullPlayer(); });
$('miniExpand').addEventListener('click', showFullPlayer);
$('miniClose').addEventListener('click', closePlayer);
$('miniPlay').addEventListener('click', togglePlay);
setMiniPlaying(true);

// ---------- コメント（下から出るシート） ----------
$('cTeaser').addEventListener('click', () => {
  const v = current; if (!v) return;
  $('cTitle').textContent = $('cCount').textContent ? `コメント ${$('cCount').textContent}` : 'コメント';
  if (commentsFor !== v.id) { commentsFor = v.id; startComments(v, $('cArea')); }
  $('commentsDialog').showModal();
});
$('cClose').addEventListener('click', () => $('commentsDialog').close());
$('commentsDialog').addEventListener('click', (e) => { if (e.target === $('commentsDialog')) $('commentsDialog').close(); });

function startComments(v, area) {
  const text = h('textarea', { placeholder: 'コメントを追加…（公開されます）', 'aria-label': 'コメントを書く', maxlength: '10000' });
  const msg = h('p', { class: 'hint', 'aria-live': 'polite' });
  const list = h('div', { class: 'comments' });
  const more = h('button', { class: 'more', type: 'button', text: 'さらに読み込む', hidden: true });
  const compose = h('form', { class: 'compose' }, text,
    h('div', { class: 'acts' }, h('button', { class: 'primary-btn', type: 'submit', text: 'コメント' })), msg);
  compose.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = text.value.trim(); if (!body) return;
    setMsg(msg, '投稿しています…');
    withLogin(() => apiAuth('POST', 'commentThreads', { part: 'snippet' },
      { snippet: { videoId: v.id, topLevelComment: { snippet: { textOriginal: body } } } }, 50))
      .then((t) => { text.value = ''; setMsg(msg, '投稿しました。'); list.prepend(renderThread(t)); })
      .catch((err) => setMsg(msg, err.message, true));
  });
  const status = h('div', { class: 'status' });
  area.replaceChildren(compose, status, list, more);

  let token = '';
  const loadMore = async () => {
    more.hidden = true; setMsg(status, '読み込んでいます…');
    try {
      const r = await api('commentThreads', { part: 'snippet,replies', videoId: v.id, maxResults: 20, order: 'relevance', textFormat: 'plainText', pageToken: token }, 1);
      if (current !== v) return;
      token = r.nextPageToken || '';
      for (const t of r.items || []) list.append(renderThread(t));
      setMsg(status, list.children.length ? '' : 'まだコメントはありません。');
      more.hidden = !token;
    } catch (e) { setMsg(status, e.message, true); if (/コメントがオフ/.test(e.message)) compose.remove(); }
  };
  more.addEventListener('click', loadMore);
  loadMore();
}

function commentNode(c) {
  const s = c.snippet;
  return h('div', { class: 'cmt' },
    h('div', { class: 'who' }, h('b', { text: s.authorDisplayName || '' }), ` ・ ${fmtAgo(s.publishedAt)}`),
    h('div', { class: 'txt', text: decode(s.textDisplay || s.textOriginal || '') }));
}

function renderThread(t) {
  const top = t.snippet.topLevelComment;
  const node = commentNode(top);
  const count = t.snippet.totalReplyCount || 0;
  const replies = h('div', { class: 'replies', hidden: true });
  const acts = h('div', { class: 'cacts' }, `高評価 ${fmtCount(top.snippet.likeCount)}`);
  if (count) {
    const btn = h('button', { type: 'button', text: `返信 ${count}件` });
    btn.addEventListener('click', async () => {
      if (!replies.hidden) { replies.hidden = true; btn.textContent = `返信 ${count}件`; return; }
      replies.hidden = false; btn.textContent = '返信を隠す';
      if (replies.dataset.loaded) return;
      replies.replaceChildren(h('div', { class: 'status', text: '読み込んでいます…' }));
      try {
        const r = await api('comments', { part: 'snippet', parentId: t.id, maxResults: 50, textFormat: 'plainText' }, 1);
        replies.dataset.loaded = '1';
        replies.replaceChildren(...(r.items || []).map(commentNode));
      } catch (e) { replies.replaceChildren(h('div', { class: 'status error', text: e.message })); }
    });
    acts.append(btn);
  }
  acts.append(h('button', { type: 'button', text: '返信', onclick: () => {
    if (node.querySelector('form')) return;
    const text = h('textarea', { placeholder: `${top.snippet.authorDisplayName} さんに返信（公開されます）`, 'aria-label': '返信を書く' });
    const msg = h('p', { class: 'hint' });
    const f = h('form', { class: 'compose' }, text, h('div', { class: 'acts' },
      h('button', { class: 'small', type: 'button', text: 'キャンセル', onclick: () => f.remove() }),
      h('button', { class: 'primary-btn', type: 'submit', text: '返信' })), msg);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = text.value.trim(); if (!body) return;
      setMsg(msg, '送信しています…');
      withLogin(() => apiAuth('POST', 'comments', { part: 'snippet' }, { snippet: { parentId: t.id, textOriginal: body } }, 50))
        .then((c) => { f.remove(); replies.hidden = false; replies.append(commentNode(c)); toast('返信しました。'); })
        .catch((err) => setMsg(msg, err.message, true));
    });
    node.append(f); text.focus();
  } }));
  node.append(acts, replies);
  return node;
}

// アプリを閉じる・切り替えるときも位置を保存
document.addEventListener('visibilitychange', () => { if (document.hidden && playerMode !== 'closed') saveCurrentProgress(false); });
window.addEventListener('pagehide', () => { if (playerMode !== 'closed') saveCurrentProgress(false); });

// ---------- 再生履歴ページ ----------
function openHistory() {
  openDetail('再生履歴', (box) => {
    const msg = h('p', { class: 'hint', 'aria-live': 'polite' });
    const list = h('div', { class: 'list' });
    let armed = false;
    const clearBtn = h('button', { class: 'small', type: 'button', text: 'すべて消す', onclick: () => {
      if (!armed) { armed = true; clearBtn.textContent = 'もう一度押すと全部消します'; setTimeout(() => { armed = false; clearBtn.textContent = 'すべて消す'; }, 4000); return; }
      watchHistory = []; saveHistory(); list.replaceChildren(); setMsg(msg, '再生履歴を消しました。');
      document.querySelectorAll('main [data-vid]').forEach((row) => row.querySelectorAll('.prog, .wbadge').forEach((n) => n.remove()));
      document.querySelectorAll('main .watched').forEach((row) => row.classList.remove('watched'));
    } });
    box.append(h('div', { class: 'detail-head' },
      h('div', { class: 'sub', text: `${watchHistory.length}本（最新${HISTORY_MAX}本まで・このスマホの中だけに保存）${settings.historyOn ? '' : ' ・ 記録は停止中'}` }),
      h('div', { class: 'acts' }, clearBtn), msg), list);
    if (!watchHistory.length) { setMsg(msg, 'まだ再生履歴はありません。動画を1秒以上再生すると、ここに記録されます。'); return; }
    renderVideos(list, watchHistory.slice(), { compact: true,
      extra: (v) => `視聴：${fmtAgo(v.at)}${v.done ? '（最後まで）' : v.pos ? `（${fmtDuration(v.pos)}まで）` : ''}`,
      menu: (v, row, removeRow) => [{ label: '履歴から削除', onclick: () => {
        watchHistory = watchHistory.filter((x) => x.id !== v.id); saveHistory(); removeRow();
        document.querySelectorAll(`main [data-vid="${CSS.escape(v.id)}"]`).forEach((r) => decorateRow(r, v));
      } }] });
  });
}

// ---------- おすすめ（ホーム） ----------
// 公式のおすすめはAPIで取得できないため、MyTubeの再生履歴・高評価・登録チャンネルから自前で作る
const REC_TTL = 6 * 3600 * 1000; // 6時間は作り直さない
const CATEGORY_NAMES = { 1: '映画・アニメ', 2: '車・乗り物', 10: '音楽', 15: 'ペット・動物', 17: 'スポーツ', 19: '旅行・イベント',
  20: 'ゲーム', 22: 'ブログ・日常', 23: 'お笑い', 24: 'エンタメ', 25: 'ニュース・政治', 26: 'ハウツー・スタイル',
  27: '教育', 28: '科学・技術', 29: '社会貢献' };
const STOPWORDS = new Set(('向け おすすめ オススメ 人気 話題 動画 公式 解説 実況 生配信 配信 切り抜き 最新 方法 紹介 簡単 完全 初心者 必見 今日 本日 前編 後編 まとめ ' +
  'ショート 公開 ライブ 企画 総集編 第一弾 チャンネル 限定 特集 本編 予告 速報 衝撃 神回 全部 やってみた してみた ' +
  'shorts short official video the and with for live mv music full part vol feat ver hd 4k youtube new from you this that are').split(' '));
const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;

let hiddenVideos = new Set(load('mytube.hiddenVideos', []));
function hideVideo(id) { hiddenVideos.add(id); save('mytube.hiddenVideos', [...hiddenVideos].slice(-1000)); }
const isWatched = (id) => !!histGet(id)?.done;
const topOf = (map) => [...map].sort((a, b) => b[1] - a[1]);

function tokenize(text) {
  const out = new Set();
  const clean = (text || '').replace(/[【】「」『』［］[\]()（）#＃!！?？|｜:：、。・,./"'~〜\-–—_＿&＆+＋*＊]/g, ' ');
  const words = SEG ? [...SEG.segment(clean)].filter((s) => s.isWordLike).map((s) => s.segment)
    : (clean.match(/[゠-ヿー]{2,}|[一-鿿々]{2,}|[A-Za-z][A-Za-z0-9]{2,}/g) || []);
  for (let w of words) {
    w = w.trim().toLowerCase();
    if (w.length < 2) continue;
    if (/^[\d０-９.,:年月日時分秒回話本]+$/.test(w)) continue;
    if (/^[぀-ゟ]+$/.test(w) && w.length < 4) continue; // 助詞などの短いひらがな
    if (/^[一-鿿][぀-ゟ]{1,2}$/.test(w)) continue; // 「張り」「選び」など動詞の切れ端
    if (/^[a-z]{1,2}$/.test(w) || STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return [...out];
}

// 視聴の傾向を数値にする（最近見たものほど重く、最後まで見た・高評価したものはさらに重く）
function buildSignals(liked) {
  const ch = new Map(); const kw = new Map(); const cat = new Map(); const chNames = new Map();
  const add = (map, k, w) => map.set(k, (map.get(k) || 0) + w);
  const use = (v, w) => {
    if (v.channelId) { add(ch, v.channelId, w); chNames.set(v.channelId, decode(v.channel)); }
    for (const t of tokenize(decode(v.title))) add(kw, t, w);
    for (const tag of (v.tags || []).slice(0, 8)) for (const t of tokenize(tag)) add(kw, t, w * 0.5);
    if (v.cat) add(cat, String(v.cat), w);
  };
  const now = Date.now();
  for (const e of watchHistory) use(e, (e.done ? 1.5 : 1) * Math.exp(-(now - (e.at || now)) / 86400000 / 30));
  for (const v of liked) use(v, 1.5);
  const nameWords = new Set([...chNames.values()].map((n) => n.toLowerCase()));
  return { ch, kw, cat, chNames, nameWords };
}

async function buildRecommendations(progress) {
  let liked = []; const subs = new Set();
  if (isLoggedIn() && tokenValid()) { // ここではログイン画面は出さない（期限切れなら履歴だけで作る）
    try {
      progress('高評価した動画を確認しています…');
      const r = await apiAuth('GET', 'videos', { part: 'snippet', myRating: 'like', maxResults: 50 }, null, 1);
      liked = (r.items || []).map((v) => ({ channelId: v.snippet.channelId, channel: v.snippet.channelTitle,
        title: v.snippet.title, cat: v.snippet.categoryId, tags: v.snippet.tags || [] }));
    } catch { /* 高評価なしで続ける */ }
    try {
      let pt = '';
      do {
        const r = await apiAuth('GET', 'subscriptions', { part: 'snippet', mine: 'true', maxResults: 50, pageToken: pt }, null, 1);
        for (const s of r.items || []) subs.add(s.snippet.resourceId.channelId);
        pt = r.nextPageToken || '';
      } while (pt);
    } catch { /* 登録なしで続ける */ }
  }
  const sig = buildSignals(liked);
  const used = new Set(); const sections = [];
  const keep = (items, n = 20) => items.filter((v) => !isShort(v) && !used.has(v.id) && !hiddenVideos.has(v.id) && !isWatched(v.id))
    .slice(0, n).map((v) => { used.add(v.id); return v; });

  // 1. よく見るのに未登録のチャンネルの新着
  const chans = topOf(sig.ch).filter(([id, s]) => s >= 1.5 && !subs.has(id) && !isBlocked(id)).slice(0, 8);
  if (chans.length) {
    progress('よく見るチャンネルの新着を集めています…');
    const lists = await pool(chans, 4, async ([id]) =>
      (await api('playlistItems', { part: 'contentDetails', playlistId: 'UU' + id.slice(2), maxResults: 4 }, 1)).items || []);
    const ids = lists.filter(Boolean).flat().map((it) => it.contentDetails.videoId);
    const items = (await fetchVideoItems(ids, {})).sort((a, b) => (b.published > a.published ? 1 : -1));
    const k = keep(items);
    if (k.length) sections.push({ title: 'よく見るチャンネルの新着', items: k,
      reason: chans.slice(0, 3).map(([id]) => sig.chNames.get(id)).filter(Boolean).join('、') + ' など、よく見ているチャンネル' });
  }

  // 2. ワードで検索（1語100ユニット）。自分で追加したワード＋履歴から自動で選んだワード
  const hiddenKw = new Set(settings.hiddenKeywords || []);
  const custom = (settings.customKeywords || []).filter((w) => !hiddenKw.has(w));
  const autoCands = topOf(sig.kw).filter(([w, s]) => s >= 1 && !hiddenKw.has(w) && !sig.nameWords.has(w) && !custom.includes(w));
  const autoKws = autoCands.filter(([, s]) => s >= 1.5).slice(0, settings.autoKwCount ?? 2).map(([w]) => w);
  const kwList = [...custom.map((w) => ({ w, mine: true })), ...autoKws.map((w) => ({ w, mine: false }))];
  for (const { w, mine } of kwList) {
    try {
      progress(`「${w}」の動画を探しています…`);
      const params = { part: 'snippet', type: 'video', maxResults: 25, q: w };
      if (settings.jaOnly) { params.relevanceLanguage = 'ja'; params.regionCode = 'JP'; }
      if (settings.minMin >= 20) params.videoDuration = 'long';
      const r = await api('search', params, 100);
      const ids = (r.items || []).filter((it) => it.id?.videoId && !isBlocked(it.snippet?.channelId)).map((it) => it.id.videoId);
      const k = keep(await fetchVideoItems(ids, { lang: true }));
      if (k.length) sections.push({ title: `「${w}」のおすすめ`, keyword: w, custom: mine, items: k,
        reason: mine ? `あなたが追加したワード「${w}」` : `「${w}」が入った動画をよく見ているため` });
    } catch (e) { if (/上限/.test(e.message)) throw e; /* そのワードだけ飛ばす */ }
  }
  const kwCandidates = autoCands.map(([w]) => w).filter((w) => !autoKws.includes(w)).slice(0, 12);

  // 3. 掘り出し物：好きな話題の動画のうち、登録者が少ないのに再生や評価が伸びているチャンネルの動画
  const gemWords = [...new Set([...custom, ...autoKws, ...autoCands.map(([w]) => w)])].slice(0, 4);
  if (gemWords.length) {
    try {
      progress('掘り出し物を探しています…');
      const seenCh = new Set(watchHistory.map((e) => e.channelId));
      const params = { part: 'snippet', type: 'video', maxResults: 50, q: gemWords.join('|'), // | は「どれか」
        publishedAfter: new Date(Date.now() - 365 * 86400000).toISOString() };
      if (settings.jaOnly) { params.relevanceLanguage = 'ja'; params.regionCode = 'JP'; }
      if (settings.minMin >= 20) params.videoDuration = 'long';
      const r = await api('search', params, 100);
      const ids = (r.items || []).filter((it) => it.id?.videoId && !subs.has(it.snippet.channelId) && !seenCh.has(it.snippet.channelId) && !isBlocked(it.snippet.channelId))
        .map((it) => it.id.videoId);
      if (ids.length) {
        const det = await api('videos', { part: 'snippet,contentDetails,statistics,liveStreamingDetails,player', maxWidth: 240, id: ids.join(',') }, 1);
        const chIds = [...new Set((det.items || []).map((v) => v.snippet.channelId))];
        const chs = await api('channels', { part: 'statistics', id: chIds.join(','), maxResults: 50 }, 1);
        const subsOf = new Map((chs.items || []).map((c) => [c.id, c.statistics?.hiddenSubscriberCount ? null : +c.statistics?.subscriberCount]));
        const gems = [];
        for (const v of det.items || []) {
          const item = toItem(v, { lang: true });
          if (!item || isShort(item)) continue;
          const views = +v.statistics?.viewCount || 0; const likes = +v.statistics?.likeCount || 0;
          const subsN = subsOf.get(v.snippet.channelId);
          if (subsN == null || subsN > 50000) continue;      // 登録者5万人以下の小さめのチャンネル
          if (views < 1000) continue;                         // ある程度は見られている
          const likeRate = likes / views;
          if (likeRate < 0.02) continue;                      // 高評価率2%以上
          const reach = Math.min(views / Math.max(subsN, 100), 20); // 登録者数の何倍見られたか
          if (reach < 0.5) continue;
          item.gemScore = likeRate * Math.log10(views) * Math.sqrt(reach);
          gems.push(item);
        }
        gems.sort((a, b) => b.gemScore - a.gemScore);
        const perCh = new Map();
        const picked = gems.filter((g) => { const n = perCh.get(g.channelId) || 0; perCh.set(g.channelId, n + 1); return n < 2; }); // 1チャンネル2本まで
        const k = keep(picked);
        if (k.length) sections.push({ title: '掘り出し物', items: k, gem: true,
          reason: `「${gemWords.join('」「')}」の動画から、登録者が少ないのに評価が高いチャンネルを選んでいます（まだ見たことのないチャンネルだけ）` });
      }
    } catch (e) { if (/上限/.test(e.message)) throw e; }
  }

  // 4. よく見るジャンルの人気動画（「ブログ・日常」は既定のジャンルで好みを表さないので使わない）
  const cats = topOf(sig.cat).filter(([c, s]) => s >= 1 && c !== '22').slice(0, 3);
  for (const [c] of cats) {
    try {
      progress(`${CATEGORY_NAMES[c] || 'ジャンル'}の人気動画を集めています…`);
      const r = await api('videos', { part: 'snippet,contentDetails,statistics,liveStreamingDetails,player', maxWidth: 240, chart: 'mostPopular', regionCode: 'JP', videoCategoryId: c, maxResults: 25 }, 1);
      const k = keep((r.items || []).map((v) => toItem(v, {})).filter(Boolean));
      if (k.length) sections.push({ title: `${CATEGORY_NAMES[c] || '好きなジャンル'}の人気動画`, items: k, reason: `${CATEGORY_NAMES[c] || 'このジャンル'}の動画をよく見ているため` });
    } catch { /* このジャンルは人気一覧がない */ }
  }

  // 材料が足りないときは日本の人気動画
  if (!sections.length) {
    progress('人気の動画を集めています…');
    const r = await api('videos', { part: 'snippet,contentDetails,statistics,liveStreamingDetails,player', maxWidth: 240, chart: 'mostPopular', regionCode: 'JP', maxResults: 30 }, 1);
    const k = keep((r.items || []).map((v) => toItem(v, {})).filter(Boolean));
    if (k.length) sections.push({ title: '日本の人気動画', items: k, reason: '視聴データがまだ少ないため、人気の動画を表示しています。見るほど、あなた向けに変わっていきます。' });
  }
  return { at: Date.now(), basis: watchHistory.length + liked.length, sections, kwCandidates };
}

// 横スクロールの棚（続きから見る・履歴）用の小さいカード
function renderCard(v, queue, { menu = null } = {}) {
  const play = () => openPlayer(v, queue);
  const card = h('article', { class: 'card', 'data-vid': v.id, 'data-channel': v.channelId },
    h('button', { class: 'thumb', type: 'button', 'aria-label': '再生', onclick: play },
      thumbImg(v, 'card'), h('span', { class: 'dur', text: durText(v) })),
    h('div', { class: 'card-meta' },
      h('div', { class: 'mtext' },
        h('button', { class: 'title', type: 'button', text: decode(v.title), onclick: play }),
        h('div', { class: 'sub', text: decode(v.channel) })),
      h('button', { class: 'kebab', type: 'button', 'aria-label': 'メニュー', onclick: () => openVideoMenu(v, card, queue, menu) }, icon('vdots'))));
  decorateRow(card, v);
  return card;
}

function shelf(title, items, menu, action) {
  const q = items.slice();
  return h('section', { class: 'home-sec' },
    h('div', { class: 'section-head' }, h('h2', { text: title }), action || null),
    h('div', { class: 'carousel' }, q.map((v) => renderCard(v, q, { menu }))));
}

let homeFilter = 'all';
function secLabel(s) {
  if (s.keyword) return s.keyword;
  if (s.title === 'よく見るチャンネルの新着') return 'よく見るチャンネル';
  return s.title.replace(/の人気動画$/, '');
}
function interleave(lists) {
  const out = []; const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}
function hideKeyword(keyword) {
  const mine = (settings.customKeywords || []).includes(keyword);
  if (mine) settings.customKeywords = settings.customKeywords.filter((w) => w !== keyword);
  else settings.hiddenKeywords = [...new Set([...(settings.hiddenKeywords || []), keyword])];
  persist();
  const c = load('mytube.rec', null);
  if (c) { c.sections = c.sections.filter((s) => s.keyword !== keyword); save('mytube.rec', c); }
  if (homeFilter === keyword) homeFilter = 'all';
  renderHome(c);
  toast(mine ? `「${keyword}」をおすすめのワードから外しました。` : `「${keyword}」の動画はおすすめに出さないようにしました。`);
}

// ---------- おすすめのワードの編集 ----------
const KW_MAX = 8;
let kwDirty = false;
function kwCostText() {
  const n = (settings.customKeywords || []).length + (settings.autoKwCount ?? 2);
  const per = n * 100 + 120; // ＋掘り出し物の検索100
  return `いまの設定：ワード${n}個＋掘り出し物 → おすすめを1回作るごとに約${per}ユニット（6時間ごとに作り直すので、1日最大 約${per * 4}／10,000）`;
}
function renderKwEditor() {
  const custom = settings.customKeywords || [];
  const hidden = settings.hiddenKeywords || [];
  const rec = load('mytube.rec', null);
  const used = new Set([...custom, ...hidden]);
  const autoNow = (rec?.sections || []).filter((s) => s.keyword && !s.custom).map((s) => s.keyword);
  const cands = [...new Set([...autoNow, ...(rec?.kwCandidates || [])])].filter((w) => !used.has(w));
  const row = (w, label, fn) => h('li', {}, h('span', { text: w }), h('button', { type: 'button', text: label, onclick: fn }));
  $('kwCustom').replaceChildren(...custom.map((w) => row(w, '外す', () => {
    settings.customKeywords = custom.filter((x) => x !== w); persist(); kwDirty = true; renderKwEditor();
  })));
  $('kwCustomEmpty').hidden = custom.length > 0;
  $('kwAutoCount').value = String(settings.autoKwCount ?? 2);
  $('kwCands').replaceChildren(...cands.map((w) => h('button', { class: 'chip', type: 'button', text: (autoNow.includes(w) ? '● ' : '') + w, onclick: () => {
    openMenu(`「${w}」`, [
      { label: '自分のワードに追加（必ず表示する）', onclick: () => addKeyword(w) },
      { label: 'このワードを表示しない', onclick: () => { settings.hiddenKeywords = [...new Set([...hidden, w])]; persist(); kwDirty = true; renderKwEditor(); } },
    ]);
  } })));
  $('kwCandsEmpty').hidden = cands.length > 0;
  $('kwHidden').replaceChildren(...hidden.map((w) => row(w, '戻す', () => {
    settings.hiddenKeywords = hidden.filter((x) => x !== w); persist(); kwDirty = true; renderKwEditor();
  })));
  $('kwHiddenEmpty').hidden = hidden.length > 0;
  $('kwCost').textContent = kwCostText();
}
function addKeyword(raw) {
  const w = raw.trim().replace(/\s+/g, ' ');
  if (!w) return;
  const custom = settings.customKeywords || [];
  if (custom.includes(w)) { setMsg($('kwMsg'), `「${w}」はもう追加されています。`, true); return; }
  if (custom.length >= KW_MAX) { setMsg($('kwMsg'), `自分のワードは${KW_MAX}個までです（使用量が増えすぎないように）。`, true); return; }
  settings.customKeywords = [...custom, w];
  settings.hiddenKeywords = (settings.hiddenKeywords || []).filter((x) => x !== w);
  persist(); kwDirty = true;
  setMsg($('kwMsg'), `「${w}」を追加しました。`);
  renderKwEditor();
}
function openKwEditor() {
  kwDirty = false;
  setMsg($('kwMsg'), '');
  $('kwInput').value = '';
  renderKwEditor();
  $('kwDialog').showModal();
}
$('kwForm').addEventListener('submit', (e) => { e.preventDefault(); addKeyword($('kwInput').value); $('kwInput').value = ''; });
$('kwAutoCount').addEventListener('change', () => { settings.autoKwCount = +$('kwAutoCount').value; persist(); kwDirty = true; $('kwCost').textContent = kwCostText(); });
$('kwClose').addEventListener('click', () => { $('kwDialog').close(); if (kwDirty) toast('変更は次におすすめを作り直したときに反映されます（「更新」ですぐ反映）。'); });
$('kwApply').addEventListener('click', () => { $('kwDialog').close(); setTab('home'); loadHome(true); });
$('kwDialog').addEventListener('click', (e) => { if (e.target === $('kwDialog')) $('kwDialog').close(); });

function renderHome(rec) {
  const box = $('homeContent');
  box.replaceChildren();
  const ok = (v) => !isShort(v) && !hiddenVideos.has(v.id) && !isWatched(v.id) && !isBlocked(v.channelId);
  const secs = (rec?.sections || []).map((s) => ({ ...s, label: secLabel(s), items: s.items.filter(ok) })).filter((s) => s.items.length);
  if (homeFilter !== 'all' && !secs.some((s) => s.label === homeFilter)) homeFilter = 'all';

  // 上のチップ（すべて / 話題 / ジャンル…）
  $('homeChips').replaceChildren(...[['all', 'すべて'], ...secs.map((s) => [s.label, s.label])].map(([key, label]) =>
    h('button', { class: 'chip', type: 'button', text: label, 'aria-pressed': String(homeFilter === key),
      onclick: () => { homeFilter = key; renderHome(load('mytube.rec', null)); window.scrollTo({ top: 0 }); } })),
    h('button', { class: 'chip chip-edit', type: 'button', text: '✎ ワードを編集', onclick: openKwEditor }));
  $('homeChips').hidden = false;

  if (homeFilter === 'all') {
    const cont = watchHistory.filter((e) => !isShort(e) && !e.done && !e.dismissed && e.pos >= RESUME_MIN && !isBlocked(e.channelId)).slice(0, 15);
    if (cont.length) box.append(shelf('続きから見る', cont, (v, row, removeRow) => [{ label: '「続きから見る」から外す', onclick: () => {
      const e = histGet(v.id); if (e) { e.dismissed = true; saveHistory(); }
      removeRow();
    } }]));
  }
  const sel = homeFilter === 'all' ? null : secs.find((s) => s.label === homeFilter);
  if (sel?.reason) box.append(h('p', { class: 'hint', text: sel.reason }));
  const list = sel ? sel.items : interleave(secs.map((s) => s.items));
  const secOf = new Map();
  for (const s of secs) for (const v of s.items) secOf.set(v.id, s);
  if (list.length) {
    const feed = h('div', { class: 'list' });
    box.append(feed);
    renderVideos(feed, list, { menu: (v, row, removeRow) => {
      const s = secOf.get(v.id);
      const o = [{ label: '興味なし', onclick: () => { hideVideo(v.id); removeRow(); toast('この動画はおすすめに表示しません。'); } }];
      if (s?.keyword) o.push({ label: s.custom ? `「${s.keyword}」をおすすめのワードから外す` : `「${s.keyword}」の動画を表示しない`, onclick: () => hideKeyword(s.keyword) });
      return o;
    } });
  }
  if (!box.children.length) box.append(h('div', { class: 'empty', text: 'おすすめにできる動画が見つかりませんでした。「更新」で作り直せます。' }));
  if (rec) setMsg($('homeStatus'), `作成：${fmtAgo(rec.at)}（MyTubeの再生履歴${watchHistory.length}本などから）`);
}

let homeLoading = false;
async function loadHome(force) {
  const status = $('homeStatus');
  if (!settings.apiKey) {
    $('homeChips').hidden = true;
    $('homeContent').replaceChildren(h('div', { class: 'empty', text: '最初に右上の設定ボタンからAPIキーを入れてください。' }));
    setMsg(status, ''); return;
  }
  const cache = load('mytube.rec', null);
  if (!force && cache && Date.now() - cache.at < REC_TTL) { renderHome(cache); return; }
  if (homeLoading) return;
  homeLoading = true; $('homeRefresh').hidden = true;
  if (cache) renderHome(cache);
  setMsg(status, 'おすすめを作っています…');
  try {
    const rec = await buildRecommendations((t) => setMsg(status, t));
    save('mytube.rec', rec);
    renderHome(rec);
  } catch (e) {
    if (!cache) renderHome(null);
    setMsg(status, e.message, true);
  } finally { homeLoading = false; $('homeRefresh').hidden = false; }
}
$('homeRefresh').addEventListener('click', () => loadHome(true));
$('resetRec').addEventListener('click', () => {
  hiddenVideos = new Set(); save('mytube.hiddenVideos', []);
  settings.hiddenKeywords = []; persist();
  watchHistory.forEach((e) => { e.dismissed = false; }); saveHistory();
  remove('mytube.rec');
  $('recMsg').textContent = 'リセットしました。次にホームを開いたときに作り直します。';
});

// ---------- 起動 ----------
els.form.addEventListener('submit', (e) => { e.preventDefault(); els.q.blur(); runSearch(true); });
els.search.more.addEventListener('click', () => runSearch(false));
$('feedRefresh').addEventListener('click', () => loadFeed(true));
$('feedLogin').addEventListener('click', () => {
  login().then(() => loadFeed(true)).catch((e) => setMsg(els.feed.status, e.message, true));
});
renderChips();
renderAccount();
setTab('home');
loadHome(false);
if (settings.clientId) loadGis().then(initTokenClient).catch(() => {}); // 先に読み込んでおくとログインのポップアップが止められにくい
loadYouTubeApi().catch(() => {});
