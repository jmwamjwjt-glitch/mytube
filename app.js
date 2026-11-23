'use strict';

const API = 'https://www.googleapis.com/youtube/v3/';
const SCOPE = 'https://www.googleapis.com/auth/youtube';
const PAGE_TARGET = 15;   // 1回の読み込みで表示したい件数
const MAX_PAGES = 3;      // 1回の読み込みで叩く検索ページ数の上限（1ページ = 100ユニット）
const FEED_PER_CHANNEL = 5;
const FEED_MAX = 150;
const FEED_TTL = 30 * 60 * 1000; // 新着一覧を使い回す時間（30分）

// OAuth クライアントID（公開されても問題ない値）。設定画面で別のIDを入れればそちらが優先されます
const BUILTIN_CLIENT_ID = '716629250048-ju4p6ojm89eap92s31kle5877afkvd2f.apps.googleusercontent.com';

const DEFAULTS = { apiKey: '', clientId: BUILTIN_CLIENT_ID, minMin: 4, maxMin: 0, order: 'relevance', period: '',
  minViews: 0, jaOnly: true, noLive: false, blocked: [] };

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

// ---------- 要素 ----------
const $ = (id) => document.getElementById(id);
const els = { form: $('searchForm'), q: $('q'), chips: $('chips'), dialog: $('settings'),
  search: { view: $('searchView'), list: $('list'), status: $('status'), more: $('more'), empty: $('empty') },
  feed: { view: $('feedView'), list: $('feedList'), status: $('feedStatus'), empty: $('feedEmpty') } };

// ---------- 状態 ----------
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
function fmtViews(n) {
  n = +n || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '億回';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万回';
  return n.toLocaleString('ja-JP') + '回';
}
function fmtAgo(dateStr) {
  const d = (Date.now() - new Date(dateStr)) / 1000;
  const units = [[31536000, '年'], [2592000, 'か月'], [604800, '週間'], [86400, '日'], [3600, '時間'], [60, '分']];
  for (const [s, label] of units) if (d >= s) return Math.floor(d / s) + label + '前';
  return 'たった今';
}
function decode(html) { const t = document.createElement('textarea'); t.innerHTML = html; return t.value; }
const hasKana = (s) => /[぀-ヿ]/.test(s || '');
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

function setStatus(view, text, isError) {
  els[view].status.textContent = text || '';
  els[view].status.classList.toggle('error', !!isError);
}

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
}

function logout() {
  if (auth?.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(auth.token, () => {});
  auth = null; remove('mytube.auth'); remove('mytube.feed');
  els.feed.list.replaceChildren();
  renderAccount();
  if (state.tab === 'feed') showFeedEmpty();
}

function renderAccount() {
  const btn = $('account');
  btn.replaceChildren();
  if (isLoggedIn() && auth.avatar) {
    const img = document.createElement('img'); img.src = auth.avatar; img.alt = ''; img.referrerPolicy = 'no-referrer';
    btn.append(img);
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
  if (authed && res.status === 401) {
    if (auth) { auth.token = ''; auth.exp = 0; save('mytube.auth', auth); }
    return new Error('ログインの有効期限が切れました。もう一度ボタンを押してください。');
  }
  if (authed && reason === 'insufficientPermissions') return new Error('権限が足りません。一度ログアウトして、ログインし直してください。');
  if (!authed && (reason === 'keyInvalid' || res.status === 400)) return new Error('APIキーが正しくないようです。設定を確認してください。');
  if (!authed && res.status === 403) return new Error('APIキーがこのサイトで使えません。Google Cloud でキーの制限（ウェブサイト）を確認してください。');
  const e = new Error(data.error?.message || `通信エラー（${res.status}）`);
  e.status = res.status;
  return e;
}

async function api(path, params, cost) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) url.searchParams.set(k, v);
  url.searchParams.set('key', settings.apiKey);
  const res = await fetch(url);
  addQuota(cost);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, data, false);
  return data;
}

async function apiAuth(method, path, params, body, cost) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + auth.token }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  addQuota(cost);
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, data, true);
  return data;
}

// ---------- 絞り込み ----------
function toItem(v, { lang, views }) {
  const sec = parseDuration(v.contentDetails?.duration);
  const live = v.snippet.liveBroadcastContent;
  const isLive = live !== 'none' || !!v.liveStreamingDetails;
  if (settings.blocked.some((b) => b.id === v.snippet.channelId)) return null;
  if (settings.noLive && isLive) return null;
  if (live === 'none') {
    if (settings.minMin > 0 && sec < settings.minMin * 60) return null;
    if (settings.maxMin > 0 && sec > settings.maxMin * 60) return null;
  }
  if (views && settings.minViews > 0 && (+v.statistics?.viewCount || 0) < settings.minViews) return null;
  if (lang && settings.jaOnly && !hasKana(v.snippet.title) && !hasKana(v.snippet.description) &&
      !(v.snippet.defaultAudioLanguage || v.snippet.defaultLanguage || '').startsWith('ja')) return null;
  return { id: v.id, sec, live, title: v.snippet.title,
    channel: v.snippet.channelTitle, channelId: v.snippet.channelId,
    published: v.snippet.publishedAt, views: v.statistics?.viewCount,
    thumb: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url };
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

    const blocked = new Set(settings.blocked.map((b) => b.id));
    const ids = (res.items || [])
      .filter((it) => it.id?.videoId && !state.shown.has(it.id.videoId) && !blocked.has(it.snippet.channelId))
      .map((it) => it.id.videoId);

    if (ids.length) {
      const det = await api('videos', { part: 'snippet,contentDetails,statistics,liveStreamingDetails', id: ids.join(',') }, 1);
      const byId = new Map((det.items || []).map((v) => [v.id, v]));
      for (const id of ids) {
        const v = byId.get(id);
        const item = v && toItem(v, { lang: true, views: true });
        if (!item) continue;
        state.shown.add(id);
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
  if (!settings.apiKey) { setStatus('search', '先に設定からAPIキーを入れてください。', true); openSettings(); return; }
  if (reset) {
    state.query = els.q.value.trim();
    if (!state.query) return;
    state.pageToken = null; state.shown = new Set();
    els.search.list.replaceChildren();
    window.scrollTo({ top: 0 });
  }
  state.loading = true;
  els.search.empty.hidden = true; els.search.more.hidden = true;
  setStatus('search', '検索しています…');
  try {
    const items = await fetchBatch();
    items.forEach((v) => renderItem(v, els.search.list));
    const total = els.search.list.children.length;
    setStatus('search', total ? `${total}件表示中（条件に合わない動画は除外済み）` : '条件に合う動画が見つかりませんでした。条件をゆるめてみてください。');
    els.search.more.hidden = !state.pageToken;
  } catch (e) {
    setStatus('search', e.message, true);
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
  // 1. 登録チャンネル一覧
  const channels = [];
  let pageToken = '';
  do {
    const res = await apiAuth('GET', 'subscriptions', { part: 'snippet', mine: 'true', maxResults: 50, pageToken }, null, 1);
    for (const s of res.items || []) channels.push(s.snippet.resourceId.channelId);
    pageToken = res.nextPageToken || '';
    setStatus('feed', `登録チャンネルを読み込み中…（${channels.length}件）`);
  } while (pageToken);
  if (!channels.length) return { items: [], channels: 0 };

  // 2. 各チャンネルの最新動画（アップロード再生リスト = "UU" + チャンネルIDの3文字目以降）
  let done = 0;
  const lists = await pool(channels, 6, async (id) => {
    const res = await apiAuth('GET', 'playlistItems', { part: 'contentDetails', playlistId: 'UU' + id.slice(2), maxResults: FEED_PER_CHANNEL }, null, 1);
    done++;
    if (done % 10 === 0) setStatus('feed', `新着を集めています…（${done}/${channels.length}チャンネル）`);
    return (res.items || []).map((it) => ({ id: it.contentDetails.videoId, at: it.contentDetails.videoPublishedAt || '' }));
  });
  const seen = new Set();
  const recent = lists.flat().filter((x) => x && x.id && !seen.has(x.id) && seen.add(x.id))
    .sort((a, b) => (b.at > a.at ? 1 : -1)).slice(0, FEED_MAX);

  // 3. 動画の詳細（長さ・再生回数）を取得して絞り込み
  const items = [];
  for (const ids of chunk(recent.map((x) => x.id), 50)) {
    const det = await apiAuth('GET', 'videos', { part: 'snippet,contentDetails,statistics,liveStreamingDetails', id: ids.join(',') }, null, 1);
    for (const v of det.items || []) {
      const item = toItem(v, { lang: false, views: false });
      if (item) items.push(item);
    }
  }
  items.sort((a, b) => (b.published > a.published ? 1 : -1));
  return { items, channels: channels.length };
}

function showFeedEmpty() {
  els.feed.list.replaceChildren();
  setStatus('feed', '');
  els.feed.empty.hidden = false;
  $('feedRefresh').hidden = true;
}

function renderFeed(cache) {
  els.feed.empty.hidden = true;
  els.feed.list.replaceChildren();
  cache.items.filter((v) => !settings.blocked.some((b) => b.id === v.channelId)).forEach((v) => renderItem(v, els.feed.list));
  const t = new Date(cache.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  setStatus('feed', cache.items.length
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
  setStatus('feed', '新着を読み込んでいます…');
  try {
    await ensureToken();
    const res = await fetchFeed();
    const fresh = { at: Date.now(), items: res.items, channels: res.channels };
    save('mytube.feed', fresh);
    renderFeed(fresh);
  } catch (e) {
    setStatus('feed', e.message, true);
    $('feedRefresh').hidden = false;
  } finally {
    state.feedLoading = false;
  }
}

// ---------- タブ ----------
function setTab(tab) {
  state.tab = tab;
  els.search.view.hidden = tab !== 'search';
  els.feed.view.hidden = tab !== 'feed';
  els.chips.hidden = tab !== 'search';
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  setTab(b.dataset.tab);
  if (b.dataset.tab === 'feed') loadFeed(false);
}));
$('feedRefresh').addEventListener('click', () => loadFeed(true));
$('feedLogin').addEventListener('click', () => {
  login().then(() => loadFeed(true)).catch((e) => setStatus('feed', e.message, true));
});

// ---------- 表示 ----------
function renderItem(v, container) {
  const row = document.createElement('article');
  row.className = 'item';
  row.dataset.channel = v.channelId;

  const thumb = document.createElement('button');
  thumb.className = 'thumb';
  thumb.setAttribute('aria-label', '再生');
  const img = document.createElement('img');
  img.src = v.thumb; img.alt = ''; img.loading = 'lazy';
  const dur = document.createElement('span');
  dur.className = 'dur';
  dur.textContent = v.live === 'live' ? 'ライブ' : v.live === 'upcoming' ? '予定' : fmtDuration(v.sec);
  thumb.append(img, dur);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const title = document.createElement('button');
  title.className = 'title';
  title.textContent = decode(v.title);
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `${decode(v.channel)} ・ ${fmtViews(v.views)} ・ ${fmtAgo(v.published)}`;
  const block = document.createElement('button');
  block.className = 'block';
  block.textContent = 'このチャンネルを除外';
  block.addEventListener('click', () => blockChannel(v.channelId, decode(v.channel)));
  meta.append(title, sub, block);

  const play = () => openPlayer(v);
  thumb.addEventListener('click', play);
  title.addEventListener('click', play);

  row.append(thumb, meta);
  container.append(row);
}

function blockChannel(id, name) {
  if (!settings.blocked.some((b) => b.id === id)) { settings.blocked.push({ id, name }); persist(); }
  document.querySelectorAll(`.item[data-channel="${CSS.escape(id)}"]`).forEach((n) => n.remove());
  setStatus(state.tab, `「${name}」を除外しました。設定からいつでも戻せます。`);
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
  els.chips.replaceChildren(...CHIPS.map((c) => {
    const b = document.createElement('button');
    b.className = 'chip'; b.type = 'button'; b.textContent = c.label;
    b.setAttribute('aria-pressed', String(c.on()));
    b.addEventListener('click', () => { c.toggle(); persist(); renderChips(); if (state.query) runSearch(true); });
    return b;
  }));
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
  $('accountMsg').textContent = '';
  renderBlocked();
  renderAccount();
  $('quota').textContent = `約 ${quotaUsed().toLocaleString('ja-JP')} / 10,000 ユニット（検索1ページ = 100、新着の更新 ≒ 登録チャンネル数、高評価・保存 = 各50）`;
  els.dialog.showModal();
}
function renderBlocked() {
  const ul = $('blockedList');
  ul.replaceChildren(...settings.blocked.map((b) => {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.textContent = b.name;
    const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = '戻す';
    rm.addEventListener('click', () => { settings.blocked = settings.blocked.filter((x) => x.id !== b.id); persist(); renderBlocked(); });
    li.append(name, rm);
    return li;
  }));
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
  persist();
  if (settings.clientId) loadGis().then(initTokenClient).catch(() => {});
}
$('account').addEventListener('click', () => {
  if (isLoggedIn() || !settings.clientId) { openSettings(); return; }
  login().catch((e) => setStatus(state.tab, e.message, true));
});
$('openSettings').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => els.dialog.close());
els.dialog.addEventListener('click', (e) => { if (e.target === els.dialog) els.dialog.close(); });
$('saveSettings').addEventListener('click', () => {
  readSettingsForm(); renderChips(); els.dialog.close();
  if (state.tab === 'search' && state.query) runSearch(true);
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

// ---------- プレーヤー ----------
let current = null;
let liked = false;
function setPlayerMsg(text, isError) {
  $('pMsg').textContent = text || '';
  $('pMsg').classList.toggle('error', !!isError);
}
function setLiked(on) {
  liked = on;
  $('pLike').setAttribute('aria-pressed', String(on));
  $('pLike').textContent = on ? '高評価済み' : '高評価';
}
function openPlayer(v) {
  current = v;
  const f = document.createElement('iframe');
  f.src = `https://www.youtube.com/embed/${encodeURIComponent(v.id)}?autoplay=1&playsinline=1&rel=0`;
  f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  f.allowFullscreen = true;
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  f.title = decode(v.title);
  $('frame').replaceChildren(f);
  $('pTitle').textContent = decode(v.title);
  $('pSub').textContent = `${decode(v.channel)} ・ ${fmtViews(v.views)} ・ ${fmtAgo(v.published)}`;
  $('pOpen').href = `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`;
  setLiked(false); setPlayerMsg('');
  $('player').hidden = false;
  history.pushState({ player: true }, '');
  if (isLoggedIn() && tokenValid()) {
    apiAuth('GET', 'videos/getRating', { id: v.id }, null, 1)
      .then((r) => { if (current === v) setLiked(r.items?.[0]?.rating === 'like'); })
      .catch(() => {});
  }
}
function closePlayer(fromPop) {
  if ($('player').hidden) return;
  $('frame').replaceChildren();
  $('player').hidden = true;
  if ($('plDialog').open) $('plDialog').close();
  if (!fromPop && history.state?.player) history.back();
}

async function withLogin(fn) {
  if (!isLoggedIn()) await login(); else await ensureToken();
  return fn();
}

$('pLike').addEventListener('click', () => {
  const v = current; if (!v) return;
  const next = !liked;
  withLogin(() => apiAuth('POST', 'videos/rate', { id: v.id, rating: next ? 'like' : 'none' }, null, 50))
    .then(() => { setLiked(next); setPlayerMsg(next ? '高評価しました。' : '高評価を取り消しました。'); })
    .catch((e) => setPlayerMsg(e.message, true));
});

$('pSave').addEventListener('click', () => {
  const v = current; if (!v) return;
  setPlayerMsg('再生リストを読み込んでいます…');
  withLogin(() => apiAuth('GET', 'playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: 50 }, null, 1))
    .then((res) => {
      setPlayerMsg('');
      const ul = $('plList');
      const lists = res.items || [];
      ul.replaceChildren(...lists.map((p) => {
        const li = document.createElement('li');
        const b = document.createElement('button'); b.type = 'button';
        b.textContent = `${p.snippet.title}（${p.contentDetails?.itemCount ?? 0}本）`;
        b.addEventListener('click', () => {
          $('plDialog').close();
          setPlayerMsg('保存しています…');
          apiAuth('POST', 'playlistItems', { part: 'snippet' },
            { snippet: { playlistId: p.id, resourceId: { kind: 'youtube#video', videoId: v.id } } }, 50)
            .then(() => setPlayerMsg(`「${p.snippet.title}」に保存しました。`))
            .catch((e) => setPlayerMsg(e.message, true));
        });
        li.append(b);
        return li;
      }));
      $('plEmpty').hidden = lists.length > 0;
      $('plDialog').showModal();
    })
    .catch((e) => setPlayerMsg(e.message, true));
});
$('plClose').addEventListener('click', () => $('plDialog').close());
$('plDialog').addEventListener('click', (e) => { if (e.target === $('plDialog')) $('plDialog').close(); });

$('pClose').addEventListener('click', () => closePlayer(false));
$('pBlock').addEventListener('click', () => { if (current) { blockChannel(current.channelId, decode(current.channel)); closePlayer(false); } });
window.addEventListener('popstate', () => closePlayer(true)); // スマホの「戻る」でプレーヤーを閉じる

// ---------- 起動 ----------
els.form.addEventListener('submit', (e) => { e.preventDefault(); els.q.blur(); runSearch(true); });
els.search.more.addEventListener('click', () => runSearch(false));
renderChips();
renderAccount();
setTab('search');
if (settings.clientId) loadGis().then(initTokenClient).catch(() => {}); // 先に読み込んでおくとログインのポップアップが止められにくい
if (!settings.apiKey) setStatus('search', '最初に右上の設定ボタンからAPIキーを入れてください。');
