// MyTube — feed.js（index.html から順番に読み込む。前のファイルで定義したものを使う）
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
    addSearchHistory(state.query);
    $('searchHistory').hidden = true;
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

// 速く更新するための工夫
// ・通信を最大20本同時に行う
// ・登録チャンネルの一覧は前回のものですぐに始め、裏で最新の一覧も取り直して差分だけ追加で読む
// ・1週間以上投稿していないチャンネルは、6時間に1回だけ確認する
// ・前回読み込んだ動画の詳細は使い回す（投稿から1日以内の動画だけ、再生回数を取り直す）
const FEED_CONCURRENCY = 20;
const DORMANT_DAYS = 7;
const DORMANT_RECHECK = 6 * 3600 * 1000;
const SUBS_TTL = 60 * 60 * 1000;

async function fetchSubscriptionList() {
  const channels = [];
  let pageToken = '';
  do {
    const res = await apiAuth('GET', 'subscriptions', { part: 'snippet', mine: 'true', maxResults: 50, pageToken }, null, 1);
    for (const s of res.items || []) {
      channels.push({ id: s.snippet.resourceId.channelId, title: s.snippet.title, thumb: s.snippet.thumbnails?.default?.url || '' });
    }
    pageToken = res.nextPageToken || '';
  } while (pageToken);
  save('mytube.subs', { at: Date.now(), channels });
  for (const c of channels) if (c.thumb) avatarCache[c.id] = c.thumb;
  save('mytube.avatars', avatarCache);
  return channels;
}
// おすすめ作りでも使う（1時間以内なら保存済みの一覧を使う）
async function getSubscriptionIds() {
  const c = load('mytube.subs', null);
  if (c && Date.now() - c.at < SUBS_TTL) return new Set(c.channels.map((x) => x.id));
  return new Set((await fetchSubscriptionList()).map((x) => x.id));
}

// 長さ・ライブの条件をもう一度当てる（使い回した動画にも、今の設定を反映するため）
function passesLength(v) {
  if (settings.noLive && v.live && v.live !== 'none') return false;
  if (v.live && v.live !== 'none') return true;
  if (settings.minMin > 0 && (v.sec || 0) < settings.minMin * 60) return false;
  if (settings.maxMin > 0 && (v.sec || 0) > settings.maxMin * 60) return false;
  return true;
}

async function fetchFeed(prev) {
  const cachedSubs = load('mytube.subs', null)?.channels;
  const subsPromise = fetchSubscriptionList();
  subsPromise.catch(() => {});
  let channels = cachedSubs?.length ? cachedSubs : await subsPromise;
  if (!channels.length) return { items: [], channels: 0, channelList: [], chState: {} };

  const prevState = prev?.chState || {};
  const chState = {};
  let done = 0; let total = channels.length;
  const fetchChannel = async (c) => {
    const p = prevState[c.id];
    const dormant = p && (!p.latest || Date.now() - new Date(p.latest).getTime() > DORMANT_DAYS * 86400000) && Date.now() - p.checked < DORMANT_RECHECK;
    if (dormant) { chState[c.id] = p; return; }
    const res = await apiAuth('GET', 'playlistItems', { part: 'contentDetails', playlistId: 'UU' + c.id.slice(2), maxResults: FEED_PER_CHANNEL }, null, 1);
    const list = (res.items || []).map((it) => ({ id: it.contentDetails.videoId, at: it.contentDetails.videoPublishedAt || '' }));
    chState[c.id] = { latest: list.reduce((m, x) => (x.at > m ? x.at : m), ''), checked: Date.now(), list };
  };
  const tick = () => { done++; if (done % 20 === 0) setMsg(els.feed.status, `新着を集めています…（${done}/${total}チャンネル）`); };
  await pool(channels, FEED_CONCURRENCY, async (c) => { await fetchChannel(c); tick(); });

  // 最新の登録一覧と照らし合わせる（新しく登録したチャンネルだけ追加で読む・解除したチャンネルは外す）
  try {
    const fresh = await subsPromise;
    const added = fresh.filter((c) => !chState[c.id]);
    if (added.length) { total += added.length; await pool(added, FEED_CONCURRENCY, async (c) => { await fetchChannel(c); tick(); }); }
    channels = fresh;
  } catch { /* 取り直せなければ前回の一覧のまま */ }

  const channelList = channels.map((c) => ({ ...c, latest: chState[c.id]?.latest || '' }))
    .sort((a, b) => (b.latest > a.latest ? 1 : -1));
  const seen = new Set();
  const recent = channels.flatMap((c) => chState[c.id]?.list || []).filter((x) => x.id && !seen.has(x.id) && seen.add(x.id))
    .sort((a, b) => (b.at > a.at ? 1 : -1)).slice(0, FEED_MAX);

  const prevItems = new Map((prev?.items || []).map((v) => [v.id, v]));
  const need = new Set(recent.filter((x) => !prevItems.has(x.id) || Date.now() - new Date(x.at).getTime() < 86400000).map((x) => x.id));
  const fetched = new Map((await fetchVideoItems([...need], {})).map((v) => [v.id, v]));
  const items = recent.map((x) => (need.has(x.id) ? fetched.get(x.id) : prevItems.get(x.id)))
    .filter((v) => v && passesLength(v));
  items.sort((a, b) => (b.published > a.published ? 1 : -1));
  return { items, channels: channels.length, channelList, chState };
}

function showFeedEmpty() {
  els.feed.list.replaceChildren();
  $('subRow').replaceChildren(); $('subRow').hidden = true;
  setMsg(els.feed.status, '');
  els.feed.empty.hidden = false;
  $('feedRefresh').hidden = true;
}

// ---------- 登録チャンネルの丸いアイコンの列 ----------
let feedFilter = null;      // 選んでいるチャンネルID（null＝すべて）
let feedSeenBase = null;    // 前回このタブを見た時刻（青い点＝それ以降に投稿があったチャンネル）
function renderSubRow(cache) {
  const row = $('subRow');
  const list = (cache.channelList || []).filter((c) => !isBlocked(c.id));
  row.hidden = !list.length;
  if (!list.length) return;
  const base = feedSeenBase || 0;
  row.replaceChildren(
    ...list.slice(0, 30).map((c) => h('button', { class: 'subch', type: 'button', 'aria-pressed': String(feedFilter === c.id),
      'data-dim': feedFilter && feedFilter !== c.id ? '1' : null,
      onclick: () => { feedFilter = feedFilter === c.id ? null : c.id; renderFeed(load('mytube.feed', null)); } },
      h('span', { class: 'subav' },
        c.thumb ? h('img', { src: c.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
        base && c.latest && new Date(c.latest).getTime() > base ? h('span', { class: 'newdot', 'aria-label': '新しい動画あり' }) : null),
      h('span', { class: 'subname', text: decode(c.title) }))),
    h('button', { class: 'suball', type: 'button', text: 'すべて', onclick: () => openSubscriptionList(cache) }));
}

function openSubscriptionList(cache) {
  const list = (cache.channelList || []).slice().sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  openDetail(`登録チャンネル（${list.length}）`, (box) => {
    const sortBtn = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': '並び順', style: 'margin-bottom:12px' });
    const rows = h('div', { class: 'lib-rows' });
    const draw = (mode) => {
      const arr = mode === 'new' ? (cache.channelList || []).slice() : list;
      sortBtn.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
      rows.replaceChildren(...arr.map((c) => h('button', { class: 'lib-row ch-row', type: 'button', onclick: () => openChannel(c.id, decode(c.title)) },
        c.thumb ? h('img', { class: 'chav', src: c.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'chav' }),
        h('span', {}, h('span', { class: 't', text: decode(c.title) }), h('br'),
          h('span', { class: 'sub', text: c.latest ? `最新の投稿：${fmtAgo(c.latest)}` : '最近の投稿なし' })))));
    };
    sortBtn.append(
      h('button', { type: 'button', role: 'radio', 'data-mode': 'name', text: '名前順', onclick: () => draw('name') }),
      h('button', { type: 'button', role: 'radio', 'data-mode': 'new', text: '最近投稿した順', onclick: () => draw('new') }));
    box.append(sortBtn, rows);
    draw('name');
  });
}

function renderFeed(cache) {
  if (!cache) return;
  els.feed.empty.hidden = true;
  renderSubRow(cache);
  const ch = feedFilter && (cache.channelList || []).find((c) => c.id === feedFilter);
  if (feedFilter && !ch) feedFilter = null;
  const items = cache.items.filter((v) => !isBlocked(v.channelId) && (!feedFilter || v.channelId === feedFilter));
  renderVideos(els.feed.list, items);
  const t = new Date(cache.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  if (ch) {
    els.feed.status.replaceChildren(`${decode(ch.title)} の新着 ${items.length}件 ・ `,
      h('button', { class: 'link', type: 'button', text: 'チャンネルを開く', onclick: () => openChannel(ch.id, decode(ch.title)) }));
    els.feed.status.classList.remove('error');
  } else {
    setMsg(els.feed.status, cache.items.length
      ? `${cache.channels}チャンネルの新着 ${els.feed.list.querySelectorAll('[data-vid]').length}件（${t} 更新）`
      : '新着が見つかりませんでした。');
  }
  $('feedRefresh').hidden = false;
}

const feedTtl = () => (settings.feedTtlMin || 10) * 60 * 1000;
async function loadFeed(force, { quiet = false } = {}) {
  if (state.feedLoading) return;
  if (!isLoggedIn()) { showFeedEmpty(); return; }
  if (feedSeenBase == null) { feedSeenBase = load('mytube.feedSeen', 0); save('mytube.feedSeen', Date.now()); }
  const cache = load('mytube.feed', null);
  const stale = !cache || !cache.channelList || Date.now() - cache.at >= feedTtl();
  if (!force && !stale) { renderFeed(cache); return; }
  if (quiet && !tokenValid()) { if (cache) renderFeed(cache); return; } // 自動更新ではログイン画面を出さない
  state.feedLoading = true;
  els.feed.empty.hidden = true;
  if (cache?.channelList) renderFeed(cache);
  setMsg(els.feed.status, '新着を読み込んでいます…');
  try {
    await ensureToken();
    const res = await fetchFeed(cache);
    const fresh = { at: Date.now(), items: res.items, channels: res.channels, channelList: res.channelList, chState: res.chState };
    save('mytube.feed', fresh);
    renderFeed(fresh);
  } catch (e) {
    setMsg(els.feed.status, e.message, true);
    $('feedRefresh').hidden = false;
  } finally {
    state.feedLoading = false;
  }
}
// アプリに戻ってきたとき、登録チャンネルを見ていて古くなっていれば自動で更新
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.tab === 'feed' && !detailStack.length) loadFeed(false, { quiet: true });
});
