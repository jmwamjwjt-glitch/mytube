// MyTube — settings.js（index.html から順番に読み込む。前のファイルで定義したものを使う）
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
  $('fsChrome').checked = !!settings.fsChrome;
  $('speed').value = String(settings.speed);
  $('historyOn').checked = settings.historyOn;
  $('feedTtl').value = String(settings.feedTtlMin || 10);
  updateFeedTtlHint();
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
  settings.fsChrome = $('fsChrome').checked;
  settings.speed = parseFloat($('speed').value) || 1;
  settings.historyOn = $('historyOn').checked;
  settings.feedTtlMin = parseInt($('feedTtl').value, 10) || 10;
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
// 新着の更新間隔ごとの使用量の目安（登録チャンネル数から計算）
function updateFeedTtlHint() {
  const n = load('mytube.feed', null)?.channels || 0;
  const min = parseInt($('feedTtl').value, 10) || 10;
  const per = n ? n + Math.ceil(n / 50) * 2 + 2 : 0;
  $('feedTtlHint').textContent = n
    ? `登録${n}チャンネル → 1回の更新で約${per}ユニット。登録チャンネルのタブを1時間開いたままなら最大 約${Math.round(per * 60 / min).toLocaleString('ja-JP')}ユニット。タブを開いた時・アプリに戻った時にだけ更新します。`
    : '1回の更新で「登録チャンネル数」とほぼ同じユニットを使います。タブを開いた時・アプリに戻った時にだけ更新します。';
}
$('feedTtl').addEventListener('change', updateFeedTtlHint);

// ---------- テーマ（端末に合わせる／ライト／ダーク） ----------
const THEME_LABELS = { system: '端末に合わせる', light: 'ライト', dark: 'ダーク' };
function applyTheme(t) {
  const theme = THEME_LABELS[t] ? t : 'system';
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme; else root.dataset.theme = theme;
  // スマホ上部のバーの色も合わせる
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const dark = theme === 'dark' || (theme === 'system' && /dark/.test(m.media));
    m.content = dark ? '#0f0f0f' : '#ffffff';
  });
  document.querySelectorAll('[data-theme-opt]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeOpt === theme)));
}
function setTheme(t) { settings.theme = t; persist(); applyTheme(t); }
function openThemeMenu() {
  const cur = settings.theme || 'system';
  openMenu('テーマ', Object.entries(THEME_LABELS).map(([k, label]) => ({ label, selected: k === cur, onclick: () => setTheme(k) })));
}
document.querySelectorAll('[data-theme-opt]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeOpt)));
applyTheme(settings.theme || 'system');

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
