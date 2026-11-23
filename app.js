'use strict';

const API = 'https://www.googleapis.com/youtube/v3/';
const PAGE_TARGET = 15;   // 1回の読み込みで表示したい件数
const MAX_PAGES = 3;      // 1回の読み込みで叩く検索ページ数の上限（1ページ = 100ユニット）

const DEFAULTS = { apiKey: '', minMin: 4, maxMin: 0, order: 'relevance', period: '',
  minViews: 0, jaOnly: true, noLive: false, blocked: [] };

// ---------- 保存 ----------
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できない環境 */ }
}
let settings = Object.assign({}, DEFAULTS, load('mytube.settings', {}));
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
const els = { form: $('searchForm'), q: $('q'), list: $('list'), status: $('status'), more: $('more'),
  empty: $('empty'), chips: $('chips'), dialog: $('settings') };

// ---------- 状態 ----------
let state = { query: '', pageToken: null, shown: new Set(), loading: false };

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

function setStatus(text, isError) {
  els.status.textContent = text || '';
  els.status.classList.toggle('error', !!isError);
}

async function api(path, params, cost) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) url.searchParams.set(k, v);
  url.searchParams.set('key', settings.apiKey);
  const res = await fetch(url);
  addQuota(cost);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data.error?.errors?.[0]?.reason || '';
    if (reason === 'quotaExceeded') throw new Error('今日のAPI使用量の上限に達しました。日本時間の夕方（午後4〜5時ごろ）にリセットされます。');
    if (reason === 'keyInvalid' || res.status === 400) throw new Error('APIキーが正しくないようです。設定を確認してください。');
    if (res.status === 403) throw new Error('APIキーがこのサイトで使えません。Google Cloud でキーの制限（ウェブサイト）を確認してください。');
    throw new Error(data.error?.message || `通信エラー（${res.status}）`);
  }
  return data;
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
        if (!v) continue;
        const sec = parseDuration(v.contentDetails.duration);
        const isLive = v.snippet.liveBroadcastContent !== 'none' || !!v.liveStreamingDetails;
        if (settings.noLive && isLive) continue;
        if (!isLive || v.snippet.liveBroadcastContent === 'none') {
          if (settings.minMin > 0 && sec < settings.minMin * 60) continue;
          if (settings.maxMin > 0 && sec > settings.maxMin * 60) continue;
        }
        if (settings.minViews > 0 && (+v.statistics?.viewCount || 0) < settings.minViews) continue;
        if (settings.jaOnly && !hasKana(v.snippet.title) && !hasKana(v.snippet.description) &&
            !(v.snippet.defaultAudioLanguage || v.snippet.defaultLanguage || '').startsWith('ja')) continue;
        state.shown.add(id);
        kept.push({ id, sec, live: v.snippet.liveBroadcastContent, title: v.snippet.title,
          channel: v.snippet.channelTitle, channelId: v.snippet.channelId,
          published: v.snippet.publishedAt, views: v.statistics?.viewCount,
          thumb: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url });
      }
    }
    if (!state.pageToken) break;
  }
  return kept;
}

async function runSearch(reset) {
  if (state.loading) return;
  if (!settings.apiKey) { setStatus('先に設定からAPIキーを入れてください。', true); openSettings(); return; }
  if (reset) {
    state.query = els.q.value.trim();
    if (!state.query) return;
    state.pageToken = null; state.shown = new Set();
    els.list.replaceChildren();
    window.scrollTo({ top: 0 });
  }
  state.loading = true;
  els.empty.hidden = true; els.more.hidden = true;
  setStatus('検索しています…');
  try {
    const items = await fetchBatch();
    items.forEach(renderItem);
    const total = els.list.children.length;
    setStatus(total ? `${total}件表示中（条件に合わない動画は除外済み）` : '条件に合う動画が見つかりませんでした。条件をゆるめてみてください。');
    els.more.hidden = !state.pageToken;
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    state.loading = false;
  }
}

// ---------- 表示 ----------
function renderItem(v) {
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
  els.list.append(row);
}

function blockChannel(id, name) {
  if (!settings.blocked.some((b) => b.id === id)) { settings.blocked.push({ id, name }); persist(); }
  els.list.querySelectorAll(`[data-channel="${CSS.escape(id)}"]`).forEach((n) => n.remove());
  setStatus(`「${name}」を除外しました。設定からいつでも戻せます。`);
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
  $('minMin').value = settings.minMin;
  $('maxMin').value = settings.maxMin;
  $('order').value = settings.order;
  $('period').value = settings.period;
  $('minViews').value = settings.minViews;
  $('jaOnly').checked = settings.jaOnly;
  $('noLive').checked = settings.noLive;
  renderBlocked();
  $('quota').textContent = `約 ${quotaUsed().toLocaleString('ja-JP')} / 10,000 ユニット（検索1ページ = 100、だいたい1日100回まで）`;
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
$('openSettings').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => els.dialog.close());
els.dialog.addEventListener('click', (e) => { if (e.target === els.dialog) els.dialog.close(); });
$('saveSettings').addEventListener('click', () => {
  const num = (id) => Math.max(0, parseInt($(id).value, 10) || 0);
  settings.apiKey = $('apiKey').value.trim();
  settings.minMin = num('minMin');
  settings.maxMin = num('maxMin');
  settings.order = $('order').value;
  settings.period = $('period').value;
  settings.minViews = num('minViews');
  settings.jaOnly = $('jaOnly').checked;
  settings.noLive = $('noLive').checked;
  persist(); renderChips(); els.dialog.close();
  if (state.query) runSearch(true);
});

// ---------- プレーヤー ----------
let current = null;
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
  $('player').hidden = false;
  history.pushState({ player: true }, '');
}
function closePlayer(fromPop) {
  if ($('player').hidden) return;
  $('frame').replaceChildren();
  $('player').hidden = true;
  if (!fromPop && history.state?.player) history.back();
}
$('pClose').addEventListener('click', () => closePlayer(false));
$('pBlock').addEventListener('click', () => { if (current) { blockChannel(current.channelId, decode(current.channel)); closePlayer(false); } });
window.addEventListener('popstate', () => closePlayer(true)); // スマホの「戻る」でプレーヤーを閉じる

// ---------- 起動 ----------
els.form.addEventListener('submit', (e) => { e.preventDefault(); els.q.blur(); runSearch(true); });
els.more.addEventListener('click', () => runSearch(false));
renderChips();
if (!settings.apiKey) setStatus('最初に右上の設定ボタンからAPIキーを入れてください。');
