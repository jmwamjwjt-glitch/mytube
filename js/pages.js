// MyTube — pages.js（index.html から順番に読み込む。前のファイルで定義したものを使う）
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

// ---------- タブ（下のメニュー）・検索モード・詳細ページ ----------
const detailStack = [];
let lastTab = 'home';
function showTabView() {
  const t = state.tab;
  $('homeView').hidden = t !== 'home';
  els.search.view.hidden = t !== 'search';
  els.feed.view.hidden = t !== 'feed';
  els.library.view.hidden = t !== 'library';
  els.chips.hidden = t !== 'search';
  $('topMain').hidden = t === 'search';
  $('topSearch').hidden = t !== 'search';
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
}
function setTab(tab) {
  if (tab !== 'search') lastTab = tab;
  state.tab = tab;
  detailStack.length = 0;
  $('detailView').hidden = true;
  showTabView();
}
function loadTab(tab) {
  if (tab === 'home') loadHome(false);
  if (tab === 'feed') loadFeed(false);
  if (tab === 'library') loadLibrary();
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  const same = state.tab === b.dataset.tab && !detailStack.length;
  setTab(b.dataset.tab);
  if (same) window.scrollTo({ top: 0, behavior: 'smooth' });
  loadTab(b.dataset.tab);
}));
$('openSearch').addEventListener('click', () => { setTab('search'); els.q.focus(); });
$('searchBack').addEventListener('click', () => { setTab(lastTab); loadTab(lastTab); });

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
  els.search.view.hidden = els.feed.view.hidden = els.library.view.hidden = $('homeView').hidden = true;
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

// ---------- マイページ ----------
function myPageHeader() {
  const msg = h('p', { class: 'hint' });
  const head = h('div', { class: 'me-head' },
    isLoggedIn() && auth.avatar ? h('img', { class: 'me-av', src: auth.avatar, alt: '', referrerpolicy: 'no-referrer' }) : h('span', { class: 'me-av' }, icon('you')),
    h('div', { class: 'me-text' },
      h('div', { class: 'n', text: isLoggedIn() ? auth.name : 'ログインしていません' }),
      isLoggedIn()
        ? h('button', { class: 'link', type: 'button', text: 'ログアウト', onclick: () => { logout(); toast('ログアウトしました。'); } })
        : h('button', { class: 'primary-btn', type: 'button', text: 'Googleでログイン', onclick: () => login().catch((e) => setMsg(msg, e.message, true)) })),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'テーマ（ライト・ダーク）', onclick: openThemeMenu }, icon('moon')),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': '設定', onclick: openSettings }, icon('settings')));
  return h('div', {}, head, msg);
}

function historyShelf() {
  const items = watchHistory.slice(0, 12);
  const all = h('button', { class: 'small', type: 'button', text: 'すべて表示', onclick: openHistory });
  if (!items.length) {
    return h('section', { class: 'home-sec' }, h('div', { class: 'section-head' }, h('h2', { text: '履歴' })),
      h('p', { class: 'hint', text: 'まだ再生履歴はありません。1秒以上再生した動画がここに並びます。' }));
  }
  return shelf('履歴', items, (v, row, removeRow) => [{ label: '履歴から削除', onclick: () => {
    watchHistory = watchHistory.filter((x) => x.id !== v.id); saveHistory(); removeRow();
  } }], all);
}

async function loadLibrary() {
  const box = $('libContent');
  const base = () => [myPageHeader(), historyShelf()];
  if (!isLoggedIn()) {
    box.replaceChildren(...base(), h('p', { class: 'hint', text: 'ログインすると、再生リストや高評価した動画もここに表示されます。' }));
    return;
  }
  box.replaceChildren(...base(), h('div', { class: 'status', text: '読み込んでいます…' }));
  try {
    await ensureToken();
    const res = await apiAuth('GET', 'playlists', { part: 'snippet,contentDetails,status', mine: 'true', maxResults: 50 }, null, 1);
    const lists = res.items || [];
    const form = createPlaylistForm();
    box.replaceChildren(...base(),
      h('div', { class: 'section-head' },
        h('h2', { text: '再生リスト' }),
        h('button', { class: 'small', type: 'button', text: '＋ 新規作成', onclick: () => { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('input').focus(); } })),
      form,
      h('div', { class: 'lib-rows' },
        h('button', { class: 'lib-row', type: 'button', onclick: openLiked },
          h('span', { class: 'ph' }, icon('like')), h('span', {}, h('span', { class: 't', text: '高評価した動画' }))),
        lists.map((p) => playlistRow(p, true))));
  } catch (e) {
    box.replaceChildren(...base(), h('div', { class: 'status error', text: e.message }));
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
  const thumb = p.snippet.thumbnails?.high?.url || p.snippet.thumbnails?.medium?.url;
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
      const r = await apiAuth('GET', 'videos', { part: 'snippet,contentDetails,statistics,player', maxWidth: 240, myRating: 'like', maxResults: 50, pageToken: token }, null, 1);
      return { items: (r.items || []).map((v) => toItem(v, { filter: false })), next: r.nextPageToken };
    }, { compact: true, summary: (n) => `${n}件`, emptyText: '高評価した動画はまだありません。' });
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

    const menu = own ? (v, row, removeRow) => [
      { label: '上へ移動', onclick: () => movePlaylistItem(p, v, row, -1, msg) },
      { label: '下へ移動', onclick: () => movePlaylistItem(p, v, row, 1, msg) },
      { label: 'リストから外す', onclick: () => {
        withLogin(() => apiAuth('DELETE', 'playlistItems', { id: v.plItemId }, null, 50))
          .then(() => { removeRow(); toast('リストから外しました。'); })
          .catch((err) => setMsg(msg, err.message, true));
      } }] : null;

    listRef = pagedList(box, async (token) => {
      const params = { part: 'snippet,contentDetails', playlistId: p.id, maxResults: 50, pageToken: token };
      const r = own ? (await ensureToken(), await apiAuth('GET', 'playlistItems', params, null, 1)) : await api('playlistItems', params, 1);
      const meta = new Map((r.items || []).map((it) => [it.contentDetails.videoId, { plItemId: it.id, position: it.snippet.position }]));
      const items = await fetchVideoItems([...meta.keys()], { filter: false });
      for (const it of items) Object.assign(it, meta.get(it.id));
      return { items, next: r.nextPageToken };
    }, { menu, compact: true, summary: (n) => `${n}本（削除・非公開の動画は表示されません）` });
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
      remove('mytube.feed'); remove('mytube.subs'); // 新着一覧と登録一覧を作り直す
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
