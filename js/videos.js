// MyTube — videos.js（index.html から順番に読み込む。前のファイルで定義したものを使う）
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
  // 50本ずつの取得を同時に行い、元の順番に並べ直す
  const parts = await Promise.all(chunk(ids, 50).map(async (part) => {
    const det = await api('videos', { part: 'snippet,contentDetails,statistics,liveStreamingDetails,player', maxWidth: 240, id: part.join(',') }, 1);
    const byId = new Map((det.items || []).map((v) => [v.id, v]));
    return part.map((id) => { const v = byId.get(id); return v && toItem(v, opts); }).filter(Boolean);
  }));
  return parts.flat();
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
