// MyTube — comments-chat.js（index.html から順番に読み込む。前のファイルで定義したものを使う）
// ---------- コメント（下から出るシート） ----------
// ---------- 生放送のチャット／アーカイブのチャットのリプレイ ----------
// YouTube 公式の埋め込みチャット（API の使用量はかからない）。動画の下、説明やコメントの代わりに表示する
let chatInfo = null;     // { id, replay }
let chatSyncTimer = null;
function setupChat(v, d) {
  const ls = d.liveStreamingDetails;
  if (!ls) return; // 生放送ではない普通の動画
  const live = d.snippet.liveBroadcastContent === 'live';
  const upcoming = d.snippet.liveBroadcastContent === 'upcoming';
  // アーカイブの「チャットのリプレイ」は、YouTube の視聴ページだけが持つ鍵が必要で、外部のページからは表示できないため出さない
  const archive = false;
  if (!live && !upcoming) return;
  chatInfo = { id: v.id, replay: archive };
  $('chatTeaser').hidden = false;
  $('chatTeaser').dataset.replay = archive ? '1' : '';
  $('chatTeaserTitle').textContent = archive ? 'チャットのリプレイ' : 'ライブチャット';
  $('chatTeaserSub').textContent = live && ls.concurrentViewers ? `${fmtCount(ls.concurrentViewers)}人が視聴中` : upcoming ? '配信開始前' : '';
}
function openChat() {
  if (!chatInfo) return;
  const dark = document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const page = chatInfo.replay ? 'live_chat_replay' : 'live_chat';
  const f = h('iframe', { title: chatInfo.replay ? 'チャットのリプレイ' : 'ライブチャット', allow: 'clipboard-write',
    src: `https://www.youtube.com/${page}?v=${encodeURIComponent(chatInfo.id)}&embed_domain=${encodeURIComponent(location.hostname)}${dark ? '&dark_theme=1' : ''}` });
  $('chatBody').replaceChildren(f);
  $('chatTitle').textContent = chatInfo.replay ? 'チャットのリプレイ' : 'ライブチャット';
  $('chatPanel').hidden = false;
  $('player').classList.add('chat-open');
  // リプレイは動画の再生位置をチャットに伝えて、その時点のコメントを流す
  clearInterval(chatSyncTimer);
  if (chatInfo.replay) {
    chatSyncTimer = setInterval(() => {
      try { f.contentWindow?.postMessage({ 'yt-player-video-progress': ytPlayer.getCurrentTime() }, 'https://www.youtube.com'); } catch { /* noop */ }
    }, 1000);
  }
}
function closeChat() {
  clearInterval(chatSyncTimer); chatSyncTimer = null;
  $('chatBody').replaceChildren();
  $('chatPanel').hidden = true;
  $('player').classList.remove('chat-open');
}
$('chatTeaser').addEventListener('click', openChat);
$('chatClose').addEventListener('click', closeChat);

$('cTeaser').addEventListener('click', () => {
  const v = current; if (!v) return;
  $('cTitle').textContent = $('cCount').textContent ? `コメント ${$('cCount').textContent}` : 'コメント';
  if (commentsFor !== v.id) { commentsFor = v.id; startComments(v, $('cArea')); }
  $('commentsDialog').showModal();
});
$('cClose').addEventListener('click', () => $('commentsDialog').close());
$('commentsDialog').addEventListener('click', (e) => { if (e.target === $('commentsDialog')) $('commentsDialog').close(); });

function startComments(v, area) {
  const text = h('textarea', { placeholder: 'コメントを追加…（公開されます）', 'aria-label': 'コメントを書く', maxlength: '10000' });
  const msg = h('p', { class: 'hint', 'aria-live': 'polite' });
  const list = h('div', { class: 'comments' });
  const more = h('button', { class: 'more', type: 'button', text: 'さらに読み込む', hidden: true });
  const compose = h('form', { class: 'compose' }, text,
    h('div', { class: 'acts' }, h('button', { class: 'primary-btn', type: 'submit', text: 'コメント' })), msg);
  compose.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = text.value.trim(); if (!body) return;
    setMsg(msg, '投稿しています…');
    withLogin(() => apiAuth('POST', 'commentThreads', { part: 'snippet' },
      { snippet: { videoId: v.id, topLevelComment: { snippet: { textOriginal: body } } } }, 50))
      .then((t) => { text.value = ''; setMsg(msg, '投稿しました。'); list.prepend(renderThread(t)); })
      .catch((err) => setMsg(msg, err.message, true));
  });
  const status = h('div', { class: 'status' });
  area.replaceChildren(compose, status, list, more);

  let token = '';
  const loadMore = async () => {
    more.hidden = true; setMsg(status, '読み込んでいます…');
    try {
      const r = await api('commentThreads', { part: 'snippet,replies', videoId: v.id, maxResults: 20, order: 'relevance', textFormat: 'plainText', pageToken: token }, 1);
      if (current !== v) return;
      token = r.nextPageToken || '';
      for (const t of r.items || []) list.append(renderThread(t));
      setMsg(status, list.children.length ? '' : 'まだコメントはありません。');
      more.hidden = !token;
    } catch (e) { setMsg(status, e.message, true); if (/コメントがオフ/.test(e.message)) compose.remove(); }
  };
  more.addEventListener('click', loadMore);
  loadMore();
}

function commentNode(c) {
  const s = c.snippet;
  return h('div', { class: 'cmt' },
    h('div', { class: 'who' }, h('b', { text: s.authorDisplayName || '' }), ` ・ ${fmtAgo(s.publishedAt)}`),
    h('div', { class: 'txt' }, ...textWithTimes(decode(s.textDisplay || s.textOriginal || '')))); // 時刻はタップでその位置へ
}

function renderThread(t) {
  const top = t.snippet.topLevelComment;
  const node = commentNode(top);
  const count = t.snippet.totalReplyCount || 0;
  const replies = h('div', { class: 'replies', hidden: true });
  const acts = h('div', { class: 'cacts' }, `高評価 ${fmtCount(top.snippet.likeCount)}`);
  if (count) {
    const btn = h('button', { type: 'button', text: `返信 ${count}件` });
    btn.addEventListener('click', async () => {
      if (!replies.hidden) { replies.hidden = true; btn.textContent = `返信 ${count}件`; return; }
      replies.hidden = false; btn.textContent = '返信を隠す';
      if (replies.dataset.loaded) return;
      replies.replaceChildren(h('div', { class: 'status', text: '読み込んでいます…' }));
      try {
        const r = await api('comments', { part: 'snippet', parentId: t.id, maxResults: 50, textFormat: 'plainText' }, 1);
        replies.dataset.loaded = '1';
        replies.replaceChildren(...(r.items || []).map(commentNode));
      } catch (e) { replies.replaceChildren(h('div', { class: 'status error', text: e.message })); }
    });
    acts.append(btn);
  }
  acts.append(h('button', { type: 'button', text: '返信', onclick: () => {
    if (node.querySelector('form')) return;
    const text = h('textarea', { placeholder: `${top.snippet.authorDisplayName} さんに返信（公開されます）`, 'aria-label': '返信を書く' });
    const msg = h('p', { class: 'hint' });
    const f = h('form', { class: 'compose' }, text, h('div', { class: 'acts' },
      h('button', { class: 'small', type: 'button', text: 'キャンセル', onclick: () => f.remove() }),
      h('button', { class: 'primary-btn', type: 'submit', text: '返信' })), msg);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = text.value.trim(); if (!body) return;
      setMsg(msg, '送信しています…');
      withLogin(() => apiAuth('POST', 'comments', { part: 'snippet' }, { snippet: { parentId: t.id, textOriginal: body } }, 50))
        .then((c) => { f.remove(); replies.hidden = false; replies.append(commentNode(c)); toast('返信しました。'); })
        .catch((err) => setMsg(msg, err.message, true));
    });
    node.append(f); text.focus();
  } }));
  node.append(acts, replies);
  return node;
}

// アプリを閉じる・切り替えるときも位置を保存
document.addEventListener('visibilitychange', () => { if (document.hidden && playerMode !== 'closed') saveCurrentProgress(false); });
window.addEventListener('pagehide', () => { if (playerMode !== 'closed') saveCurrentProgress(false); });
