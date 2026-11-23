// MyTube — main.js（index.html から順番に読み込む。前のファイルで定義したものを使う）
// ---------- 更新の確認 ----------
// スマホは index.html を最大10分とっておくため、更新直後は古い画面が出ることがある。
// 開いたとき（とアプリに戻ったとき）に最新の版を確かめ、古ければ新しい版を読み込み直す
const APP_VERSION = (document.querySelector('script[src*="js/main.js"]')?.getAttribute('src').match(/v=(\d+)/) || [])[1] || '';
async function checkForUpdate() {
  if (!APP_VERSION || playerMode === 'full') return; // 動画を見ている最中は邪魔しない
  try {
    const html = await fetch(`index.html?check=${Date.now()}`, { cache: 'no-store' }).then((r) => r.text());
    const latest = (html.match(/js\/main\.js\?v=(\d+)/) || [])[1];
    let tried = null; try { tried = sessionStorage.getItem('mytube.reloadedFor'); } catch { /* noop */ }
    if (latest && latest !== APP_VERSION && tried !== latest) {
      try { sessionStorage.setItem('mytube.reloadedFor', latest); } catch { /* noop */ }
      location.replace(`${location.pathname}?v=${latest}`); // URL を変えて、とっておいた古い画面を使わせない
    }
  } catch { /* 圏外など。次の機会に確かめる */ }
}
checkForUpdate();
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });

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
