// MyTube — sync.js（スマホとタブレットで同期：Google ドライブの「アプリ専用の見えない保存場所」を使う）
// ・ドライブの appDataFolder は MyTube だけが読み書きでき、ドライブのファイル一覧には出ない
// ・同期するもの：設定（APIキーを含む）・再生履歴・「興味なし」・検索履歴・登録チャンネルの既読位置
// ・ぶつかったときは、項目ごとに新しく変更したほうを使う。再生履歴は動画ごとに新しいほうを残して合わせる
const SYNC_FILE = 'mytube-sync.json';
const SYNC_KEYS = ['mytube.settings', 'mytube.history', 'mytube.hiddenVideos', 'mytube.searchHistory', 'mytube.feedSeen'];
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UP = 'https://www.googleapis.com/upload/drive/v3/files';
const TOMB_KEEP = 90 * 24 * 3600 * 1000; // 消した履歴の記録は90日でおしまい

const syncMeta = () => load('mytube.syncMeta', { on: false, at: {}, tomb: {} });
const putMeta = (m) => save('mytube.syncMeta', m);
let syncApplying = false;
let syncRunning = null;
let syncTimer = null;

// save() から呼ばれる：同期する項目が実際に変わったら、変更した時刻を覚えて少しあとに同期する
function noteLocalChange(key, value) {
  if (syncApplying || !SYNC_KEYS.includes(key)) return;
  const m = syncMeta();
  if (!m.on) return;
  let prevRaw = null; try { prevRaw = localStorage.getItem(key); } catch { /* noop */ }
  const nextRaw = JSON.stringify(value);
  if (prevRaw === nextRaw) return;
  const now = Date.now();
  if (key === 'mytube.history') { // 消した動画を覚えておく（もう一方の端末から復活しないように）
    let prev = []; try { prev = JSON.parse(prevRaw) || []; } catch { /* noop */ }
    const keep = new Set((value || []).map((e) => e.id));
    m.tomb = m.tomb || {};
    for (const e of prev) if (!keep.has(e.id)) m.tomb[e.id] = now;
  }
  m.at = m.at || {}; m.at[key] = now;
  putMeta(m);
  scheduleSync(20000);
}

function scheduleSync(ms = 20000) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync().catch(() => {}), ms);
}

// ---------- ドライブとのやりとり ----------
async function drive(url, opts = {}) {
  const res = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + auth.token }, opts.headers || {}) }));
  if (res.ok) return res;
  const data = await res.json().catch(() => ({}));
  const reason = data.error?.errors?.[0]?.reason || data.error?.status || '';
  if (res.status === 401) { auth.token = ''; auth.exp = 0; save('mytube.auth', auth); throw new Error('ログインの有効期限が切れました。画面をタップすると取り直します。'); }
  if (/accessNotConfigured|SERVICE_DISABLED/i.test(reason + (data.error?.message || ''))) {
    throw new Error('Google Drive API が有効になっていません。Google Cloud で「Google Drive API」を有効にしてください。');
  }
  if (res.status === 403) { auth.drive = false; save('mytube.auth', auth); throw new Error('ドライブを使う許可がありません。もう一度「同期をオンにする」を押してください。'); }
  throw new Error(`同期できませんでした（${res.status}）`);
}
async function findSyncFile(m) {
  if (m.fileId) return m.fileId;
  const q = encodeURIComponent(`name='${SYNC_FILE}'`);
  const r = await (await drive(`${DRIVE}?spaces=appDataFolder&q=${q}&orderBy=modifiedTime desc&fields=files(id)`)).json();
  return r.files?.[0]?.id || null;
}
async function downloadSync(id) {
  try { return await (await drive(`${DRIVE}/${id}?alt=media`)).json(); }
  catch (e) { if (/（404）/.test(e.message)) return null; throw e; }
}
async function uploadSync(id, data) {
  const body = JSON.stringify(data);
  if (id) {
    await drive(`${DRIVE_UP}/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    return id;
  }
  const b = 'mytube' + Date.now();
  const multipart = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: SYNC_FILE, parents: ['appDataFolder'] })}\r\n`
    + `--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`;
  const r = await (await drive(`${DRIVE_UP}?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body: multipart })).json();
  return r.id;
}

// ---------- 合わせ方 ----------
// local / remote：{ at: {キー: 変更時刻}, tomb: {動画ID: 消した時刻}, data: {キー: 値} }
// first：この端末で初めて同期するとき（ドライブにあるほうを優先する）
function mergeSync(local, remote, first) {
  const out = { v: 1, at: {}, tomb: {}, data: {} };
  const now = Date.now();
  for (const src of [local.tomb, remote.tomb]) {
    for (const [id, t] of Object.entries(src || {})) if (now - t < TOMB_KEEP && t > (out.tomb[id] || 0)) out.tomb[id] = t;
  }
  for (const k of SYNC_KEYS) {
    const la = local.at?.[k] || 0; const ra = remote.at?.[k] || 0;
    const lv = local.data[k]; const rv = remote.data?.[k];
    if (k === 'mytube.history') {
      const byId = new Map();
      for (const e of [...(lv || []), ...(rv || [])]) {
        const cur = byId.get(e.id);
        if (!cur || (e.at || 0) > (cur.at || 0)) byId.set(e.id, e);
      }
      out.data[k] = [...byId.values()].filter((e) => !(out.tomb[e.id] >= (e.at || 0)))
        .sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, HISTORY_MAX);
      out.at[k] = Math.max(la, ra);
    } else if (k === 'mytube.feedSeen') {
      out.data[k] = Math.max(+lv || 0, +rv || 0) || undefined;
      out.at[k] = Math.max(la, ra);
    } else {
      const useRemote = rv !== undefined && (lv === undefined || (first ? true : ra > la));
      out.data[k] = useRemote ? rv : lv;
      out.at[k] = useRemote ? ra : la;
      if (k === 'mytube.settings' && out.data[k]) { // 空のAPIキーで、入っているキーを消さない
        const other = useRemote ? lv : rv;
        if (!out.data[k].apiKey && other?.apiKey) out.data[k] = Object.assign({}, out.data[k], { apiKey: other.apiKey });
      }
    }
  }
  return out;
}

// ---------- 同期の本体 ----------
const syncReady = () => syncMeta().on && isLoggedIn() && auth.drive && tokenValid();
function runSync({ force = false } = {}) {
  if (syncRunning) return syncRunning;
  if (!syncReady()) return Promise.resolve(false);
  if (!force && playerMode !== 'closed') { scheduleSync(60000); return Promise.resolve(false); } // 見ている最中は邪魔しない
  clearTimeout(syncTimer);
  syncRunning = (async () => {
    const m = syncMeta();
    const first = !m.lastSync;
    let id = await findSyncFile(m);
    let remote = id ? await downloadSync(id) : null;
    if (id && !remote) id = null; // 消されていた
    const local = { at: m.at || {}, tomb: m.tomb || {}, data: {} };
    for (const k of SYNC_KEYS) local.data[k] = load(k, undefined);
    const merged = mergeSync(local, remote || { at: {}, tomb: {}, data: {} }, first && !!remote);
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const localChanged = SYNC_KEYS.some((k) => !same(merged.data[k], local.data[k]));
    const remoteChanged = !remote || SYNC_KEYS.some((k) => !same(merged.data[k], remote.data?.[k])) || !same(merged.tomb, remote.tomb);
    if (remoteChanged) id = await uploadSync(id, merged);
    const m2 = syncMeta(); // 同期中に変わったかもしれないので読み直す
    m2.fileId = id; m2.lastSync = Date.now(); m2.at = merged.at; m2.tomb = merged.tomb;
    putMeta(m2);
    if (localChanged) {
      syncApplying = true;
      for (const k of SYNC_KEYS) {
        if (same(merged.data[k], local.data[k])) continue;
        if (merged.data[k] === undefined) remove(k); else save(k, merged.data[k]);
      }
      syncApplying = false;
      // 動画を見ている最中などで読み込み直せないときに備え、使っている値も新しくしておく
      settings = Object.assign({}, DEFAULTS, load('mytube.settings', {}));
      if (!settings.clientId) settings.clientId = BUILTIN_CLIENT_ID;
      watchHistory = load('mytube.history', []);
      hiddenVideos = new Set(load('mytube.hiddenVideos', []));
      // 画面に反映するため読み込み直す（動画を見ていないときだけ。続けて何度も読み込み直さない）
      let n = 0; try { n = +sessionStorage.getItem('mytube.syncReloads') || 0; } catch { /* noop */ }
      if (n < 3 && playerMode === 'closed') {
        try { sessionStorage.setItem('mytube.syncReloads', String(n + 1)); sessionStorage.setItem('mytube.syncToast', '1'); } catch { /* noop */ }
        location.reload();
      }
    }
    renderSyncStatus();
    return true;
  })().catch((e) => { renderSyncStatus(e.message); throw e; }).finally(() => { syncRunning = null; });
  return syncRunning;
}

// ---------- 設定画面 ----------
function renderSyncStatus(err) {
  const m = syncMeta();
  const on = m.on && isLoggedIn() && auth.drive;
  $('syncBtn').hidden = on;
  $('syncNow').hidden = !on;
  $('syncOff').hidden = !on;
  $('syncStatus').textContent = err ? err
    : on ? `同期：オン${m.lastSync ? `（最後に同期：${new Date(m.lastSync).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）` : ''}`
    : '同期：オフ（スマホとタブレットで、設定・再生履歴などを同じにできます）';
}
$('syncBtn').addEventListener('click', async () => {
  const m = syncMeta(); m.on = true; putMeta(m);
  try {
    if (!isLoggedIn()) await login(); else await requestToken(); // ドライブ用の許可をもらう
    if (!auth.drive) throw new Error('ドライブの許可にチェックが入っていませんでした。もう一度押して、「Google ドライブのアプリデータ」にチェックしてください。');
    renderSyncStatus();
    toast('同期しています…');
    await runSync({ force: true });
    toast('同期しました。');
  } catch (e) {
    if (!auth?.drive) { const m2 = syncMeta(); m2.on = false; putMeta(m2); }
    renderSyncStatus(e.message);
  }
});
$('syncNow').addEventListener('click', async () => {
  try { await ensureToken(); toast('同期しています…'); await runSync({ force: true }); toast('同期しました。'); }
  catch (e) { renderSyncStatus(e.message); }
});
$('syncOff').addEventListener('click', () => {
  const m = syncMeta(); m.on = false; m.lastSync = 0; putMeta(m);
  renderSyncStatus();
  toast('同期をオフにしました（この端末のデータはそのまま残ります）。');
});

// ---------- いつ同期するか ----------
// 開いたとき・アプリに戻ったとき・アプリから離れるとき・変更してから20秒後
try {
  if (sessionStorage.getItem('mytube.syncToast')) { sessionStorage.removeItem('mytube.syncToast'); setTimeout(() => toast('ほかの端末の変更を取り込みました。'), 600); }
} catch { /* noop */ }
setTimeout(() => runSync().catch(() => {}), 1500);
setTimeout(() => { try { sessionStorage.removeItem('mytube.syncReloads'); } catch { /* noop */ } }, 60000);
document.addEventListener('visibilitychange', () => { if (syncMeta().on) runSync().catch(() => {}); });
