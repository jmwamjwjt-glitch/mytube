// MyTube — auth-api.js（index.html から順番に読み込む。前のファイルで定義したものを使う）
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

// 同期をオンにしている端末では、ドライブ（MyTube 専用の保存場所）の許可も一緒にもらう
const tokenScope = () => SCOPE + (load('mytube.syncMeta', {}).on ? ' ' + DRIVE_SCOPE : '');
function initTokenClient() {
  const hint = auth?.email || '';
  const scope = tokenScope();
  if (tokenClient && tokenClientHint === hint + '|' + scope) return;
  if (!settings.clientId || !window.google?.accounts?.oauth2) return;
  tokenClientHint = hint + '|' + scope;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: settings.clientId,
    scope,
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
      auth.drive = !!google.accounts.oauth2.hasGrantedAllScopes?.(resp, DRIVE_SCOPE);
      save('mytube.auth', auth);
      if (typeof scheduleSync === 'function') scheduleSync(1500);
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
  auth = null; remove('mytube.auth'); remove('mytube.feed'); remove('mytube.subs');
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
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
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

// 検索（1回100ユニット）の結果は1時間とっておき、同じ条件の検索ではそれを使う（使用量の節約）
const SEARCH_CACHE_TTL = 60 * 60 * 1000;
const SEARCH_CACHE_MAX = 40;
function searchCacheGet(key) {
  const c = load('mytube.searchCache', {});
  const e = c[key];
  return e && Date.now() - e.at < SEARCH_CACHE_TTL ? e.data : null;
}
function searchCachePut(key, data) {
  const c = load('mytube.searchCache', {});
  c[key] = { at: Date.now(), data };
  const keys = Object.keys(c).filter((k) => Date.now() - c[k].at < SEARCH_CACHE_TTL).sort((a, b) => c[b].at - c[a].at);
  const out = {}; for (const k of keys.slice(0, SEARCH_CACHE_MAX)) out[k] = c[k];
  save('mytube.searchCache', out);
}

// fresh: true … とっておいた検索結果を使わずに検索し直す（ホームの「更新」ボタンなど）
async function api(path, params, cost, { fresh = false } = {}) {
  if (!settings.apiKey) throw new Error('先に設定からAPIキーを入れてください。');
  const url = buildUrl(path, params);
  const cacheKey = path === 'search' ? url.search : null; // キーを入れる前の条件で覚える
  if (cacheKey && !fresh) { const hit = searchCacheGet(cacheKey); if (hit) return hit; }
  url.searchParams.set('key', settings.apiKey);
  const res = await fetch(url);
  addQuota(cost);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, data, false);
  if (cacheKey) searchCachePut(cacheKey, data);
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
