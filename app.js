'use strict';

const API = 'https://www.googleapis.com/youtube/v3/';
const SCOPE = 'https://www.googleapis.com/auth/youtube';
const PAGE_TARGET = 15;   // 1回の読み込みで表示したい件数
const MAX_PAGES = 3;      // 1回の読み込みで叩く検索ページ数の上限（1ページ = 100ユニット）
const FEED_PER_CHANNEL = 5;
const FEED_MAX = 150;
const FEED_TTL = 30 * 60 * 1000; // 新着一覧を使い回す時間（30分）
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

// OAuth クライアントID（公開されても問題ない値）。設定画面で別のIDを入れればそちらが優先されます
const BUILTIN_CLIENT_ID = '716629250048-ju4p6ojm89eap92s31kle5877afkvd2f.apps.googleusercontent.com';

const DEFAULTS = { apiKey: '', clientId: BUILTIN_CLIENT_ID, minMin: 4, maxMin: 0, order: 'relevance', period: '',
  minViews: 0, jaOnly: true, noLive: false, blocked: [], autoNext: true, cc: false, speed: 1 };

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

// ---------- ログイン（Google Identity Services） ----------
let auth = load('mytube.auth', null); // { token, exp, name, avatar }
let tokenClient = null;
let pendingLogin = null;
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
  if (tokenClient || !settings.clientId || !window.google?.accounts?.oauth2) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: settings.clientId,
    scope: SCOPE,
    callback: (resp) => {
      const p = pendingLogin; pendingLogin = null;
      if (resp.error) { p?.reject(new Error('ログインできませんでした（' + resp.error + '）')); return; }
      auth = Object.assign({}, auth, { token: resp.access_token, exp: Date.now() + (+resp.expires_in || 3600) * 1000 });
      save('mytube.auth', auth);
      p?.resolve();
    },
    error_callback: (err) => {
      const p = pendingLogin; pendingLogin = null;
      p?.reject(new Error(err?.type === 'popup_closed' ? 'ログインがキャンセルされました。' : 'ログイン画面を開けませんでした。ポップアップのブロックを確認してください。'));
    },
  });
}

// 必ずボタンを押した直後に呼ぶ（ポップアップがブロックされないように）
function requestToken() {
  if (!settings.clientId) return Promise.reject(new Error('先に設定で「OAuth クライアントID」を入れてください。'));
  initTokenClient();
  if (!tokenClient) return loadGis().then(() => { initTokenClient(); return requestToken(); });
  return new Promise((resolve, reject) => {
    pendingLogin = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: isLoggedIn() ? '' : 'consent' });
  });
}

async function ensureToken() {
  if (tokenValid()) return;
  await requestToken();
}

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
  els.feed.list.replaceChildren();
  renderAccount();
  if (state.tab === 'feed') showFeedEmpty();
  if (state.tab === 'library') loadLibrary();
}

function renderAccount() {
  const btn = $('account');
  btn.replaceChildren();
  if (isLoggedIn() && auth.avatar) {
    btn.append(h('img', { src: auth.avatar, alt: '', referrerpolicy: 'no-referrer' }));
  } else {
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>';
  }
  btn.setAttribute('aria-label', isLoggedIn() ? `${auth.name}（設定を開く）` : 'Googleでログイン');
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
  return { id: v.id, sec, live, title: v.snippet.title,
    channel: v.snippet.channelTitle, channelId: v.snippet.channelId,
    published: v.snippet.publishedAt, views: v.statistics?.viewCount,
    thumb: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url };
}

// 動画IDの順番を保ったまま詳細を取得
async function fetchVideoItems(ids, opts) {
  const out = [];
  for (const part of chunk(ids, 50)) {
    const det = await api('videos', { part: 'snippet,contentDetails,statistics,liveStreamingDetails', id: part.join(',') }, 1);
    const byId = new Map((det.items || []).map((v) => [v.id, v]));
    for (const id of part) {
      const v = byId.get(id);
      const item = v && toItem(v, opts);
      if (item) out.push(item);
    }
  }
  return out;
}

// ---------- 一覧の表示 ----------
function renderVideos(container, items, { append = false, controls = null } = {}) {
  if (!append || !container._items) { container.replaceChildren(); container._items = []; }
  for (const v of items) {
    container._items.push(v);
    container.append(renderRow(v, container._items, controls));
  }
}

function renderRow(v, queue, controls) {
  const play = () => openPlayer(v, queue);
  const row = h('article', { class: 'item', 'data-channel': v.channelId },
    h('button', { class: 'thumb', 'aria-label': '再生', onclick: play },
      h('img', { src: v.thumb || 'icon.svg', alt: '', loading: 'lazy' }),
      h('span', { class: 'dur', text: v.live === 'live' ? 'ライブ' : v.live === 'upcoming' ? '予定' : fmtDuration(v.sec) })),
    h('div', { class: 'meta' },
      h('button', { class: 'title', text: decode(v.title), onclick: play }),
      h('div', { class: 'sub' },
        h('button', { class: 'link', text: decode(v.channel), onclick: () => openChannel(v.channelId, decode(v.channel)) }),
        ` ・ ${fmtViews(v.views)} ・ ${fmtAgo(v.published)}`)));
  const meta = row.lastChild;
  if (controls) meta.append(controls(v, row));
  else meta.append(h('button', { class: 'block', text: 'このチャンネルを除外', onclick: () => blockChannel(v.channelId, decode(v.channel)) }));
  return row;
}

function blockChannel(id, name) {
  if (!isBlocked(id)) { settings.blocked.push({ id, name }); persist(); }
  document.querySelectorAll(`main .item[data-channel="${CSS.escape(id)}"]`).forEach((n) => n.remove());
  toast(`「${name}」を除外しました。設定からいつでも戻せます。`);
}

// 「さらに読み込む」付きの一覧
function pagedList(box, fetchPage, { controls = null, summary = null, emptyText = '動画がありません。' } = {}) {
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
      renderVideos(list, r.items, { append: started, controls });
      started = true;
      const n = list.children.length;
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
    const total = els.search.list.children.length;
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
    ? `${cache.channels}チャンネルの新着 ${els.feed.list.children.length}件（${t} 更新・長さなどの条件を適用済み）`
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

// ---------- タブと詳細ページ ----------
const detailStack = [];
function showTabView() {
  els.search.view.hidden = state.tab !== 'search';
  els.feed.view.hidden = state.tab !== 'feed';
  els.library.view.hidden = state.tab !== 'library';
  els.chips.hidden = state.tab !== 'search';
}
function setTab(tab) {
  state.tab = tab;
  detailStack.length = 0;
  $('detailView').hidden = true;
  showTabView();
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  setTab(b.dataset.tab);
  if (b.dataset.tab === 'feed') loadFeed(false);
  if (b.dataset.tab === 'library') loadLibrary();
}));

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
  els.search.view.hidden = els.feed.view.hidden = els.library.view.hidden = true;
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

// ---------- ライブラリ ----------
async function loadLibrary() {
  const box = $('libContent');
  if (!isLoggedIn()) { box.replaceChildren(loginPrompt('ログインすると、高評価した動画や再生リストをここで見たり整理したりできます。')); return; }
  box.replaceChildren(h('div', { class: 'status', text: '読み込んでいます…' }));
  try {
    await ensureToken();
    const res = await apiAuth('GET', 'playlists', { part: 'snippet,contentDetails,status', mine: 'true', maxResults: 50 }, null, 1);
    const lists = res.items || [];
    const form = createPlaylistForm();
    box.replaceChildren(
      h('div', { class: 'lib-rows' },
        h('button', { class: 'lib-row', type: 'button', onclick: openLiked },
          h('span', { class: 'ph', text: '♥' }), h('span', { class: 't', text: '高評価した動画' }))),
      h('div', { class: 'section-head' },
        h('h2', { text: `再生リスト（${lists.length}）` }),
        h('button', { class: 'small', type: 'button', text: '＋ 新規作成', onclick: () => { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('input').focus(); } })),
      form,
      lists.length ? h('div', { class: 'lib-rows' }, lists.map((p) => playlistRow(p, true)))
        : h('p', { class: 'hint', text: 'まだ再生リストがありません。「＋ 新規作成」から作れます。' }));
  } catch (e) {
    box.replaceChildren(h('div', { class: 'status error', text: e.message }));
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
  const thumb = p.snippet.thumbnails?.medium?.url;
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
      const r = await apiAuth('GET', 'videos', { part: 'snippet,contentDetails,statistics', myRating: 'like', maxResults: 50, pageToken: token }, null, 1);
      return { items: (r.items || []).map((v) => toItem(v, { filter: false })), next: r.nextPageToken };
    }, { summary: (n) => `${n}件`, emptyText: '高評価した動画はまだありません。' });
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

    const controls = own ? (v, row) => h('div', { class: 'row-ctl' },
      h('button', { type: 'button', text: '↑ 上へ', onclick: () => movePlaylistItem(p, v, row, -1, msg) }),
      h('button', { type: 'button', text: '↓ 下へ', onclick: () => movePlaylistItem(p, v, row, 1, msg) }),
      h('button', { type: 'button', text: 'リストから外す', onclick: () => {
        withLogin(() => apiAuth('DELETE', 'playlistItems', { id: v.plItemId }, null, 50))
          .then(() => { const q = row.parentNode._items; q.splice(q.indexOf(v), 1); row.remove(); toast('リストから外しました。'); })
          .catch((err) => setMsg(msg, err.message, true));
      } })) : null;

    listRef = pagedList(box, async (token) => {
      const params = { part: 'snippet,contentDetails', playlistId: p.id, maxResults: 50, pageToken: token };
      const r = own ? (await ensureToken(), await apiAuth('GET', 'playlistItems', params, null, 1)) : await api('playlistItems', params, 1);
      const meta = new Map((r.items || []).map((it) => [it.contentDetails.videoId, { plItemId: it.id, position: it.snippet.position }]));
      const items = await fetchVideoItems([...meta.keys()], { filter: false });
      for (const it of items) Object.assign(it, meta.get(it.id));
      return { items, next: r.nextPageToken };
    }, { controls, summary: (n) => `${n}本（削除・非公開の動画は表示されません）` });
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
  persist();
  updateSpeedLabel();
  if (settings.clientId) loadGis().then(initTokenClient).catch(() => {});
}
$('account').addEventListener('click', () => {
  if (isLoggedIn() || !settings.clientId) { openSettings(); return; }
  login().catch((e) => toast(e.message));
});
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

// ---------- 選択メニュー（速度・タイマー） ----------
function openMenu(title, options, hint) {
  $('menuTitle').textContent = title;
  $('menuList').replaceChildren(...options.map((o) => h('li', {},
    h('button', { type: 'button', text: o.label, 'aria-current': o.selected ? 'true' : null,
      onclick: () => { $('menuDialog').close(); o.onclick(); } }))));
  $('menuHint').hidden = !hint; $('menuHint').textContent = hint || '';
  $('menuDialog').showModal();
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
let detailToken = 0;
const sleep = { timer: null, tick: null, endAt: 0, endOfVideo: false };

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

async function loadIntoPlayer(id) {
  await loadYouTubeApi();
  if (ytPlayer && ytCc === settings.cc && typeof ytPlayer.loadVideoById === 'function') {
    ytPlayer.loadVideoById(id);
    return;
  }
  if (ytPlayer) { try { ytPlayer.destroy(); } catch { /* noop */ } }
  const host = h('div');
  $('frame').replaceChildren(host, $('miniCover'));
  ytCc = settings.cc;
  ytPlayer = new YT.Player(host, {
    width: '100%', height: '100%', videoId: id,
    playerVars: { autoplay: 1, playsinline: 1, rel: 0, hl: 'ja', cc_lang_pref: 'ja', cc_load_policy: settings.cc ? 1 : 0 },
    events: {
      onReady: (e) => { try { e.target.setPlaybackRate(settings.speed); e.target.playVideo(); } catch { /* noop */ } },
      onStateChange: onYtState,
    },
  });
}

function onYtState(e) {
  const S = window.YT.PlayerState;
  if (e.data === S.PLAYING) {
    try { if (ytPlayer.getPlaybackRate() !== settings.speed) ytPlayer.setPlaybackRate(settings.speed); } catch { /* noop */ }
    $('miniPlay').textContent = '❚❚'; $('miniPlay').setAttribute('aria-label', '一時停止');
  } else if (e.data === S.PAUSED || e.data === S.ENDED) {
    $('miniPlay').textContent = '▶'; $('miniPlay').setAttribute('aria-label', '再生');
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
  current = v;
  queue = Array.isArray(list) && list.includes(v) ? list : [v];
  if (!keepMode || playerMode === 'closed') showFullPlayer(); else if (playerMode === 'full') { /* そのまま */ }
  $('player').hidden = false;
  renderPlayerInfo(v);
  loadIntoPlayer(v.id).catch((e) => setMsg($('pMsg'), e.message, true));
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
  $('player').className = 'player mini';
  document.body.classList.add('has-mini');
}
function closePlayer() {
  playerMode = 'closed';
  try { ytPlayer?.stopVideo(); } catch { /* noop */ }
  $('player').hidden = true;
  document.body.classList.remove('has-mini');
  clearSleep();
  $('menuDialog').open && $('menuDialog').close();
}

function setRating(r) {
  rating = r;
  $('pLike').setAttribute('aria-pressed', String(r === 'like'));
  $('pLike').textContent = r === 'like' ? '高評価済み' : '高評価';
  $('pDislike').setAttribute('aria-pressed', String(r === 'dislike'));
}

function renderPlayerInfo(v) {
  const token = ++detailToken;
  $('pTitle').textContent = decode(v.title);
  $('miniTitle').textContent = decode(v.title);
  $('pStats').textContent = `${fmtViews(v.views)} ・ ${fmtAgo(v.published)}`;
  $('pChannel').textContent = decode(v.channel);
  $('pSubWrap').replaceChildren(subscribeButton(v.channelId));
  $('pOpen').href = `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`;
  setRating('none'); setMsg($('pMsg'), '');
  updateSpeedLabel();
  const n = nextItem();
  $('nextRow').hidden = !n;
  if (n) $('nextTitle').textContent = '次：' + decode(n.title);
  $('chapterBlock').hidden = true; $('chapters').replaceChildren();
  $('descBox').open = false; $('pDesc').textContent = '';
  $('cHead').textContent = 'コメント';
  renderCommentArea(v);
  $('player').querySelector('.info').scrollTop = 0;

  if (isLoggedIn() && tokenValid()) {
    apiAuth('GET', 'videos/getRating', { id: v.id }, null, 1)
      .then((r) => { if (token === detailToken) setRating(r.items?.[0]?.rating || 'none'); }).catch(() => {});
  }
  api('videos', { part: 'snippet,statistics', id: v.id }, 1).then((r) => {
    const d = r.items?.[0];
    if (!d || token !== detailToken) return;
    const st = d.statistics || {};
    $('pStats').textContent = [`${fmtViews(st.viewCount)}`, st.likeCount != null ? `高評価 ${fmtCount(st.likeCount)}` : '', fmtAgo(d.snippet.publishedAt)].filter(Boolean).join(' ・ ');
    $('pDesc').textContent = d.snippet.description || '（説明はありません）';
    if (st.commentCount != null) $('cHead').textContent = `コメント（${fmtCount(st.commentCount)}件）`;
    const chapters = parseChapters(d.snippet.description);
    if (chapters.length) {
      $('chapters').replaceChildren(...chapters.map((c) => h('button', { type: 'button', onclick: () => { try { ytPlayer.seekTo(c.sec, true); ytPlayer.playVideo(); } catch { /* noop */ } } },
        h('span', { class: 'ts', text: c.t }), h('span', { text: c.label }))));
      $('chapterBlock').hidden = false;
    }
  }).catch(() => {});
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

$('pLike').addEventListener('click', () => {
  const v = current; if (!v) return;
  const next = rating === 'like' ? 'none' : 'like';
  withLogin(() => apiAuth('POST', 'videos/rate', { id: v.id, rating: next }, null, 50))
    .then(() => { setRating(next); setMsg($('pMsg'), next === 'like' ? '高評価しました。' : '高評価を取り消しました。'); })
    .catch((e) => setMsg($('pMsg'), e.message, true));
});
$('pDislike').addEventListener('click', () => {
  const v = current; if (!v) return;
  const next = rating === 'dislike' ? 'none' : 'dislike';
  withLogin(() => apiAuth('POST', 'videos/rate', { id: v.id, rating: next }, null, 50))
    .then(() => { setRating(next); setMsg($('pMsg'), next === 'dislike' ? '低評価しました（相手には数は表示されません）。' : '低評価を取り消しました。'); })
    .catch((e) => setMsg($('pMsg'), e.message, true));
});

$('pSave').addEventListener('click', () => {
  const v = current; if (!v) return;
  setMsg($('pMsg'), '再生リストを読み込んでいます…');
  withLogin(() => apiAuth('GET', 'playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: 50 }, null, 1))
    .then((res) => {
      setMsg($('pMsg'), '');
      const addTo = (p) => {
        setMsg($('pMsg'), '保存しています…');
        apiAuth('POST', 'playlistItems', { part: 'snippet' },
          { snippet: { playlistId: p.id, resourceId: { kind: 'youtube#video', videoId: v.id } } }, 50)
          .then(() => setMsg($('pMsg'), `「${decode(p.snippet.title)}」に保存しました。`))
          .catch((e) => setMsg($('pMsg'), e.message, true));
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
    .catch((e) => setMsg($('pMsg'), e.message, true));
});

$('pShare').addEventListener('click', async () => {
  const v = current; if (!v) return;
  const url = `https://youtu.be/${v.id}`;
  if (navigator.share) {
    try { await navigator.share({ title: decode(v.title), url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('リンクをコピーしました。'); }
  catch { setMsg($('pMsg'), url); }
});

function updateSpeedLabel() { $('pSpeed').textContent = `速度 ${settings.speed}x`; }
$('pSpeed').addEventListener('click', () => {
  openMenu('再生速度', SPEEDS.map((s) => ({ label: s === 1 ? '1倍（標準）' : `${s}倍`, selected: s === settings.speed,
    onclick: () => { settings.speed = s; persist(); updateSpeedLabel(); try { ytPlayer?.setPlaybackRate(s); } catch { /* noop */ } } })),
  '選んだ速度は次の動画にも使われます。');
});

function clearSleep() {
  clearTimeout(sleep.timer); clearInterval(sleep.tick);
  sleep.timer = sleep.tick = null; sleep.endAt = 0; sleep.endOfVideo = false;
  $('pTimer').textContent = 'タイマー'; $('pTimer').removeAttribute('aria-pressed');
}
function updateTimerLabel() {
  if (sleep.endOfVideo) { $('pTimer').textContent = 'タイマー：この動画まで'; return; }
  const left = Math.max(0, Math.ceil((sleep.endAt - Date.now()) / 60000));
  $('pTimer').textContent = `タイマー：残り${left}分`;
}
function setSleep(min) {
  clearSleep();
  $('pTimer').setAttribute('aria-pressed', 'true');
  if (min === 'end') { sleep.endOfVideo = true; updateTimerLabel(); toast('この動画が終わったら停止します。'); return; }
  sleep.endAt = Date.now() + min * 60000;
  sleep.timer = setTimeout(() => { try { ytPlayer?.pauseVideo(); } catch { /* noop */ } clearSleep(); toast('タイマーで停止しました。'); }, min * 60000);
  sleep.tick = setInterval(updateTimerLabel, 30000);
  updateTimerLabel();
  toast(`${min}分後に停止します。`);
}
$('pTimer').addEventListener('click', () => {
  const on = sleep.timer || sleep.endOfVideo;
  const opts = [15, 30, 45, 60, 90].map((m) => ({ label: `${m}分後に停止`, onclick: () => setSleep(m) }));
  opts.push({ label: 'この動画が終わったら停止', onclick: () => setSleep('end') });
  if (on) opts.push({ label: 'タイマーを解除', onclick: () => { clearSleep(); toast('タイマーを解除しました。'); } });
  openMenu('スリープタイマー', opts, 'スマホの画面を消すと再生も止まります（ブラウザの仕様です）。');
});

$('pChannel').addEventListener('click', () => { if (current) openChannel(current.channelId, decode(current.channel)); });
$('nextBtn').addEventListener('click', playNext);
$('pMin').addEventListener('click', () => minimizePlayer());
$('pClose').addEventListener('click', closePlayer);
$('pBlock').addEventListener('click', () => { if (current) { blockChannel(current.channelId, decode(current.channel)); closePlayer(); } });
$('miniCover').addEventListener('click', showFullPlayer);
$('miniTitle').addEventListener('click', showFullPlayer);
$('miniClose').addEventListener('click', closePlayer);
$('miniPlay').addEventListener('click', () => {
  try { if (ytPlayer.getPlayerState() === window.YT.PlayerState.PLAYING) ytPlayer.pauseVideo(); else ytPlayer.playVideo(); } catch { /* noop */ }
});

// ---------- コメント ----------
function renderCommentArea(v) {
  const area = $('cArea');
  const loadBtn = h('button', { class: 'small', type: 'button', text: 'コメントを読み込む', onclick: () => { loadBtn.remove(); startComments(v, area); } });
  area.replaceChildren(loadBtn);
}

function startComments(v, area) {
  const text = h('textarea', { placeholder: 'コメントを書く（公開されます）', 'aria-label': 'コメントを書く', maxlength: '10000' });
  const msg = h('p', { class: 'hint', 'aria-live': 'polite' });
  const list = h('div', { class: 'comments' });
  const more = h('button', { class: 'more', type: 'button', text: 'さらに読み込む', hidden: true });
  const compose = h('form', { class: 'compose' }, text,
    h('div', { class: 'acts' }, h('button', { class: 'primary-btn', type: 'submit', text: '投稿' })), msg);
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
    const btn = h('button', { type: 'button', text: `返信 ${count}件を表示` });
    btn.addEventListener('click', async () => {
      if (!replies.hidden) { replies.hidden = true; btn.textContent = `返信 ${count}件を表示`; return; }
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
  acts.append(h('button', { type: 'button', text: '返信する', onclick: () => {
    if (node.querySelector('form')) return;
    const text = h('textarea', { placeholder: `${top.snippet.authorDisplayName} さんに返信（公開されます）`, 'aria-label': '返信を書く' });
    const msg = h('p', { class: 'hint' });
    const f = h('form', { class: 'compose' }, text, h('div', { class: 'acts' },
      h('button', { class: 'small', type: 'button', text: 'やめる', onclick: () => f.remove() }),
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

// ---------- 起動 ----------
els.form.addEventListener('submit', (e) => { e.preventDefault(); els.q.blur(); runSearch(true); });
els.search.more.addEventListener('click', () => runSearch(false));
$('feedRefresh').addEventListener('click', () => loadFeed(true));
$('feedLogin').addEventListener('click', () => {
  login().then(() => loadFeed(true)).catch((e) => setMsg(els.feed.status, e.message, true));
});
renderChips();
renderAccount();
updateSpeedLabel();
setTab('search');
if (settings.clientId) loadGis().then(initTokenClient).catch(() => {}); // 先に読み込んでおくとログインのポップアップが止められにくい
loadYouTubeApi().catch(() => {});
if (!settings.apiKey) setMsg(els.search.status, '最初に右上の設定ボタンからAPIキーを入れてください。');
