'use strict';

const API = 'https://www.googleapis.com/youtube/v3/';
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube';
const SCOPE = YT_SCOPE + ' email'; // email はアカウント選択を省くためだけに使う
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'; // 同期用（ドライブの MyTube 専用の見えない保存場所だけ）
const PAGE_TARGET = 15;   // 1回の読み込みで表示したい件数
const MAX_PAGES = 3;      // 1回の読み込みで叩く検索ページ数の上限（1ページ = 100ユニット）
const FEED_PER_CHANNEL = 5;
const FEED_MAX = 150;
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
  if (typeof noteLocalChange === 'function') noteLocalChange(key, value); // 同期（sync.js）
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
