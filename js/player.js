// MyTube — player.js（index.html から順番に読み込む。前のファイルで定義したものを使う）
// ---------- プレーヤー ----------
let ytPlayer = null;
let ytCc = null;
let ytApiPromise = null;
let playerMode = 'closed'; // 'full' | 'mini' | 'closed'
let current = null;
let queue = [];
let rating = 'none';
let likeCount = null;
let detailToken = 0;
let commentsFor = null;
const sleep = { timer: null, tick: null, endAt: 0, endOfVideo: false };
const playerReport = (t, err) => setMsg($('pMsg'), t, err);

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { ytApiPromise = null; reject(new Error('プレーヤーを読み込めませんでした。通信状況を確認してください。')); };
      document.head.append(s);
    });
  }
  return ytApiPromise;
}

// fresh: true … プレーヤーを作り直す（一時停止後の暗い表示を消すため）。字幕の状態はそのまま引き継ぐ
async function loadIntoPlayer(id, start = 0, { fresh = false } = {}) {
  await loadYouTubeApi();
  if (!fresh && ytPlayer && ytCc === settings.cc && typeof ytPlayer.loadVideoById === 'function') {
    ytPlayer.loadVideoById({ videoId: id, startSeconds: start });
    return;
  }
  const keepCc = fresh && ytPlayer ? ccOn : settings.cc;
  if (ytPlayer) { try { ytPlayer.destroy(); } catch { /* noop */ } }
  const host = h('div');
  $('frame').replaceChildren(host);
  ytCc = settings.cc;
  setCcUi(keepCc);
  ccAppliedFor = null;
  ytPlayer = new YT.Player(host, {
    width: '100%', height: '100%', videoId: id,
    // controls: 0 … YouTube 側の操作ボタンを消し、MyTube の操作バー（動画の下）で操作する
    playerVars: { autoplay: 1, playsinline: 1, controls: 0, fs: 0, rel: 0, iv_load_policy: 3, hl: 'ja', cc_lang_pref: 'ja', cc_load_policy: keepCc ? 1 : 0, start: Math.floor(start) },
    events: {
      onReady: (e) => { try { e.target.setPlaybackRate(settings.speed); e.target.playVideo(); } catch { /* noop */ } },
      onStateChange: onYtState,
    },
  });
}

// 再生中は3秒ごとに位置を記録
let progressTimer = null;
function saveCurrentProgress(ended) {
  if (!current || !ytPlayer) return;
  try {
    const pos = ended ? 0 : ytPlayer.getCurrentTime();
    if (!ended && ytPlayer.getVideoData?.().video_id && ytPlayer.getVideoData().video_id !== current.id) return; // まだ前の動画
    recordProgress(current, pos, ended, ytPlayer.getDuration?.());
  } catch { /* noop */ }
}
function stopProgressTimer() { clearInterval(progressTimer); progressTimer = null; }
function setMiniPlaying(playing) {
  for (const id of ['miniPlay', 'playBtn']) {
    $(id).replaceChildren(icon(playing ? 'pause' : 'play'));
    $(id).setAttribute('aria-label', playing ? '一時停止' : '再生');
  }
}

// ---------- 操作バー（動画の下） ----------
let seeking = false;
function updateTimeUi() {
  if (!ytPlayer?.getDuration || seeking) return;
  try {
    const dur = ytPlayer.getDuration() || 0; const cur = ytPlayer.getCurrentTime() || 0;
    $('ptime').textContent = `${fmtDuration(Math.floor(cur))} / ${fmtDuration(Math.floor(dur))}`;
    const p = dur ? (cur / dur) * 1000 : 0;
    $('seek').value = String(Math.round(p));
    $('seek').style.setProperty('--p', `${p / 10}%`);
    showChapterAt(cur);
    if (curChapters.length && !$('chapMarks').childElementCount) drawChapterMarks(); // 長さが分かってから印を描く
  } catch { /* noop */ }
}
setInterval(() => { if (playerMode === 'full') updateTimeUi(); }, 500);

// シークバーを動かしている間は、動画そのものをその位置へ動かして「動かした先の画」を見せる（0.35秒ごと）
let scrubTimer = null; let scrubTarget = null;
$('seek').addEventListener('input', () => {
  seeking = true;
  const p = +$('seek').value / 1000;
  $('seek').style.setProperty('--p', `${p * 100}%`);
  try {
    const dur = ytPlayer.getDuration(); const t = p * dur;
    $('ptime').textContent = `${fmtDuration(Math.floor(t))} / ${fmtDuration(Math.floor(dur))}`;
    showChapterAt(t);
    scrubTarget = t;
    if (!scrubTimer) {
      ytPlayer.seekTo(t, true);
      scrubTimer = setTimeout(() => { scrubTimer = null; if (seeking && scrubTarget != null) try { ytPlayer.seekTo(scrubTarget, true); } catch { /* noop */ } }, 350);
    }
  } catch { /* noop */ }
});
$('seek').addEventListener('change', () => {
  clearTimeout(scrubTimer); scrubTimer = null; scrubTarget = null;
  try { ytPlayer.seekTo((+$('seek').value / 1000) * ytPlayer.getDuration(), true); } catch { /* noop */ }
  seeking = false;
});

// ---------- チャプター ----------
let curChapters = []; // [{ sec, t, label }]
function setChapters(list) {
  curChapters = list || [];
  $('chapMarks').replaceChildren();
  $('chapBtn').hidden = !curChapters.length;
  $('chapIcon').hidden = !curChapters.length;
  if (curChapters.length) { drawChapterMarks(); showChapterAt(0); }
}
// シークバーにチャプターの区切りを描く
function drawChapterMarks() {
  let dur = 0; try { dur = ytPlayer?.getDuration?.() || current?.sec || 0; } catch { /* noop */ }
  if (!dur) return;
  $('chapMarks').replaceChildren(...curChapters.filter((c) => c.sec > 0 && c.sec < dur)
    .map((c) => h('span', { style: `left:${(c.sec / dur) * 100}%` })));
}
function chapterAt(t) {
  let found = null;
  for (const c of curChapters) if (c.sec <= t + 0.5) found = c;
  return found;
}
let shownChapter = null;
function showChapterAt(t) {
  if (!curChapters.length) return;
  const c = chapterAt(t) || curChapters[0];
  if (c === shownChapter) return;
  shownChapter = c;
  $('chapLabel').textContent = c.label;
}
function openChapterList() {
  if (!curChapters.length) return;
  let now = 0; try { now = ytPlayer.getCurrentTime(); } catch { /* noop */ }
  const cur = chapterAt(now);
  openMenu('チャプター', curChapters.map((c) => ({ label: `${c.t}　${c.label}`, selected: c === cur,
    onclick: () => { try { ytPlayer.seekTo(c.sec, true); ytPlayer.playVideo(); } catch { /* noop */ } updateTimeUi(); } })));
}
$('chapBtn').addEventListener('click', openChapterList);
$('chapIcon').addEventListener('click', openChapterList);
const skip = (sec) => {
  try {
    const dur = ytPlayer.getDuration() || Infinity;
    ytPlayer.seekTo(Math.min(Math.max(0, ytPlayer.getCurrentTime() + sec), dur - 1), true);
    updateTimeUi();
  } catch { /* noop */ }
};
$('back10').addEventListener('click', () => skip(-10));
$('fwd10').addEventListener('click', () => skip(10));
// 一時停止すると YouTube が動画の上に暗い表示（タイトル・共有・その他の動画など）を出す。
// スマホでは動画に触れないと消えない（縦向きでは動画へのタップを止めているので消えない）ため、
// 一時停止から再開するときは同じ位置で読み込み直して、表示をきれいにする
const togglePlay = () => {
  try {
    const S = window.YT.PlayerState; const st = ytPlayer.getPlayerState();
    if (st === S.PLAYING || st === S.BUFFERING) { ytPlayer.pauseVideo(); return; }
    if (st === S.PAUSED && current) {
      const t = ytPlayer.getCurrentTime();
      loadIntoPlayer(current.id, t, { fresh: true }).catch(() => {});
      return;
    }
    ytPlayer.playVideo();
  } catch { /* noop */ }
};
$('playBtn').addEventListener('click', togglePlay);

// 字幕のオン・オフ（日本語を優先）
let ccOn = false;
function setCcUi(on) { ccOn = on; $('ccBtn').setAttribute('aria-pressed', String(on)); }
// YouTube のプレーヤーは「前に字幕をオンにした」ことを覚えていて、次の動画でも勝手に字幕を出すことがある。
// そのため、動画が始まるたびに CC ボタンの状態（ccOn）に合わせ直す
let ccAppliedFor = null;
function applyCc() {
  if (!ytPlayer) return;
  try {
    if (ccOn) {
      ytPlayer.loadModule('captions');
      setTimeout(() => { try { ytPlayer.setOption('captions', 'track', { languageCode: 'ja' }); } catch { /* noop */ } }, 500);
    } else {
      try { ytPlayer.setOption('captions', 'track', {}); } catch { /* noop */ }
      ytPlayer.unloadModule('captions');
    }
  } catch { /* 字幕のない動画など */ }
}
$('ccBtn').addEventListener('click', () => {
  if (!ytPlayer) return;
  setCcUi(!ccOn);
  applyCc();
  toast(ccOn ? '字幕：オン（字幕がない動画では表示されません）' : '字幕：オフ');
});

// ---------- 全画面 ----------
// ・スマホを横向きにすると、アプリの中で全画面になる（Chrome の「全画面を終了するには…」の案内は出ない）
// ・設定で「Chrome の全画面」を選ぶと、上下のバーも消えて画面いっぱいになる（その代わり案内が出る）
// ・全画面中は、再生しているあいだ操作バーを隠して動画を最大にする。一時停止（動画をタップ）するとバーが出る
const landscapeMq = matchMedia('(orientation: landscape) and (max-height: 600px)');
let fsHideTimer = null;
const isFs = () => $('player').classList.contains('fs') || !!document.fullscreenElement;
function updateFsMode() {
  const on = playerMode === 'full' && (landscapeMq.matches || !!document.fullscreenElement);
  $('player').classList.toggle('fs', on);
  $('fsBtn').setAttribute('aria-label', on ? '全画面を終了' : '全画面');
  if (on) bumpFsBar(); else { clearTimeout(fsHideTimer); $('pCtrl').classList.remove('hide'); }
}
// 操作バーを出して、再生中なら3秒後に隠す
function bumpFsBar() {
  $('pCtrl').classList.remove('hide');
  clearTimeout(fsHideTimer);
  if (!isFs()) return;
  fsHideTimer = setTimeout(() => {
    try { if (isFs() && !seeking && ytPlayer.getPlayerState() === window.YT.PlayerState.PLAYING) $('pCtrl').classList.add('hide'); } catch { /* noop */ }
  }, 3000);
}
landscapeMq.addEventListener('change', updateFsMode);
$('pCtrl').addEventListener('pointerdown', bumpFsBar);
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) { try { screen.orientation?.unlock?.(); } catch { /* noop */ } }
  updateFsMode();
});
// 全画面をやめるとき：横向きの固定を外して縦に戻す（固定したままだと、小さくした後もずっと横向きになる）
let orientLocked = false;
async function leaveFullscreen({ quiet = false } = {}) {
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  if (orientLocked || landscapeMq.matches) {
    try {
      await screen.orientation.lock('portrait');
      setTimeout(() => { try { screen.orientation.unlock(); } catch { /* noop */ } }, 1500);
    } catch {
      try { screen.orientation?.unlock?.(); } catch { /* noop */ }
      if (!quiet && landscapeMq.matches) toast('スマホを縦向きに戻すと、全画面が終わります。');
    }
  }
  orientLocked = false;
}
$('fsBtn').addEventListener('click', async () => {
  if (isFs()) { await leaveFullscreen(); return; } // 終了
  if (settings.fsChrome) { // Chrome の全画面（画面いっぱい・案内が出る）
    try {
      await $('player').requestFullscreen({ navigationUI: 'hide' });
      try { await screen.orientation?.lock?.('landscape'); orientLocked = true; } catch { /* 向きを固定できない端末もある */ }
    } catch { toast('全画面にできませんでした。'); }
    return;
  }
  try { await screen.orientation.lock('landscape'); orientLocked = true; }
  catch { toast('スマホを横向きにすると全画面になります（画面の自動回転をオンにしてください）。'); }
});

function onYtState(e) {
  const S = window.YT.PlayerState;
  if (e.data === S.PLAYING) {
    if (!progressTimer) progressTimer = setInterval(() => saveCurrentProgress(false), 3000);
    setTimeout(() => saveCurrentProgress(false), 1200); // 1秒再生した時点で記録
    try { if (ytPlayer.getPlaybackRate() !== settings.speed) ytPlayer.setPlaybackRate(settings.speed); } catch { /* noop */ }
    try { const vid = ytPlayer.getVideoData?.().video_id; if (vid && vid !== ccAppliedFor) { ccAppliedFor = vid; applyCc(); } } catch { /* noop */ }
    setMiniPlaying(true);
  } else {
    stopProgressTimer();
    if (e.data === S.PAUSED) saveCurrentProgress(false);
    if (e.data === S.ENDED) saveCurrentProgress(true);
    if (e.data === S.PAUSED || e.data === S.ENDED) setMiniPlaying(false);
  }
  if (isFs()) { if (e.data === S.PLAYING) bumpFsBar(); else if (e.data === S.PAUSED || e.data === S.ENDED) { clearTimeout(fsHideTimer); $('pCtrl').classList.remove('hide'); } }
  if (e.data === S.ENDED) {
    if (sleep.endOfVideo) { clearSleep(); toast('タイマーで停止しました。'); return; }
    if (settings.autoNext) playNext();
  }
}

function nextItem() {
  const i = queue.indexOf(current);
  for (let j = i + 1; j < queue.length; j++) if (!isBlocked(queue[j].channelId)) return queue[j];
  return null;
}
function playNext() { const n = nextItem(); if (n) openPlayer(n, queue, { keepMode: true }); }

function openPlayer(v, list, { keepMode = false } = {}) {
  if (playerMode !== 'closed' && current && current.id !== v.id) saveCurrentProgress(false); // 前の動画の位置を保存
  stopProgressTimer();
  current = v;
  queue = Array.isArray(list) && list.includes(v) ? list : [v];
  if (!keepMode || playerMode === 'closed') showFullPlayer();
  $('player').hidden = false;
  $('player').dataset.short = isShort(v) ? '1' : ''; // ショートは縦長に表示
  if (playerMode === 'mini') placeMini(); // 小窓のまま次の動画へ進んだとき、縦長／横長に合わせ直す
  renderPlayerInfo(v);
  const e = histGet(v.id);
  const start = settings.historyOn && e && !e.done && e.pos >= RESUME_MIN ? e.pos : 0;
  if (start) {
    $('pMsg').classList.remove('error');
    $('pMsg').replaceChildren(`前回の続き（${fmtDuration(start)}）から再生しています。 `,
      h('button', { class: 'link', type: 'button', text: '最初から見る', onclick: () => {
        try { ytPlayer.seekTo(0, true); ytPlayer.playVideo(); } catch { /* noop */ }
        $('pMsg').textContent = '';
      } }));
    const shownFor = v.id;
    setTimeout(() => { if (current?.id === shownFor && /前回の続き/.test($('pMsg').textContent)) $('pMsg').textContent = ''; }, 10000);
  }
  loadIntoPlayer(v.id, start).catch((err) => playerReport(err.message, true));
}

function showFullPlayer() {
  const wasFull = playerMode === 'full';
  playerMode = 'full';
  $('player').style.cssText = '';
  $('player').className = 'player full';
  $('player').hidden = false;
  document.body.classList.remove('has-mini');
  if (!wasFull) navPush('player');
  updateFsMode();
}
function minimizePlayer() {
  if (playerMode !== 'full') return;
  if (isFs() || orientLocked) leaveFullscreen({ quiet: true }); // 全画面から小さくしたら縦に戻す
  playerMode = 'mini';
  $('player').className = 'player mini';
  document.body.classList.add('has-mini');
  placeMini();
}
function closePlayer() {
  if (isFs() || orientLocked) leaveFullscreen({ quiet: true });
  saveCurrentProgress(false);
  stopProgressTimer();
  playerMode = 'closed';
  try { ytPlayer?.stopVideo(); } catch { /* noop */ }
  $('player').hidden = true;
  $('player').style.cssText = '';
  document.body.classList.remove('has-mini');
  clearSleep();
  if ($('menuDialog').open) $('menuDialog').close();
  if ($('commentsDialog').open) $('commentsDialog').close();
}

function setRating(r) {
  rating = r;
  $('pLike').setAttribute('aria-pressed', String(r === 'like'));
  $('pDislike').setAttribute('aria-pressed', String(r === 'dislike'));
  $('pLikeCount').textContent = likeCount == null ? '高評価' : fmtCount(likeCount);
}

function renderUpNext() {
  const box = $('upNext');
  box.replaceChildren();
  const i = queue.indexOf(current);
  const rest = queue.slice(i + 1).filter((v) => !isBlocked(v.channelId)).slice(0, 20);
  if (rest.length && isShort(current)) box.append(shortsShelf(rest)); // ショートの続きは縦長の棚で
  else for (const v of rest) box.append(renderRow(v, queue));
  $('upNextEmpty').hidden = rest.length > 0;
  fillAvatars();
}

function renderPlayerInfo(v) {
  const token = ++detailToken;
  likeCount = null; commentsFor = null;
  $('pTitle').textContent = decode(v.title);
  $('miniT').textContent = decode(v.title);
  setChapters([]); shownChapter = null;
  $('miniSub').textContent = decode(v.channel);
  $('pStats').textContent = `${fmtCount(v.views)} 回視聴 ${fmtAgo(v.published)}`;
  $('pTitleBtn').setAttribute('aria-expanded', 'false');
  $('pDescBox').hidden = true;
  $('pDesc').textContent = '';
  $('chapters').replaceChildren(); $('chapters').hidden = true;
  $('pChName').textContent = decode(v.channel);
  $('pChSubs').textContent = '';
  if (avatarCache[v.channelId]) $('pChAv').src = avatarCache[v.channelId]; else $('pChAv').removeAttribute('src');
  $('pSubWrap').replaceChildren(subscribeButton(v.channelId));
  setRating('none'); setMsg($('pMsg'), '');
  $('cCount').textContent = '';
  $('cPreview').textContent = 'タップしてコメントを表示';
  closeChat();
  $('chatTeaser').hidden = true; chatInfo = null;
  $('autoNextToggle').checked = settings.autoNext;
  renderUpNext();
  $('pInfo').scrollTop = 0;

  if (isLoggedIn() && tokenValid()) {
    apiAuth('GET', 'videos/getRating', { id: v.id }, null, 1)
      .then((r) => { if (token === detailToken) setRating(r.items?.[0]?.rating || 'none'); }).catch(() => {});
  }
  api('videos', { part: 'snippet,statistics,liveStreamingDetails', id: v.id }, 1).then((r) => {
    const d = r.items?.[0];
    if (!d || token !== detailToken) return;
    const st = d.statistics || {};
    setupChat(v, d);
    $('pStats').textContent = `${fmtCount(st.viewCount)} 回視聴 ${fmtAgo(d.snippet.publishedAt)}`;
    likeCount = st.likeCount != null ? +st.likeCount : null;
    setRating(rating);
    $('pDesc').textContent = d.snippet.description || '（説明はありません）';
    $('cCount').textContent = st.commentCount != null ? fmtCount(st.commentCount) : '';
    const chapters = parseChapters(d.snippet.description);
    setChapters(chapters);
    if (chapters.length) {
      $('chapters').replaceChildren(...chapters.map((c) => h('button', { type: 'button', onclick: () => { try { ytPlayer.seekTo(c.sec, true); ytPlayer.playVideo(); } catch { /* noop */ } } },
        h('span', { class: 'ts', text: c.t }), h('span', { text: c.label }))));
      $('chapters').hidden = false;
    }
  }).catch(() => {});
  api('channels', { part: 'snippet,statistics', id: v.channelId }, 1).then((r) => {
    const c = r.items?.[0];
    if (!c || token !== detailToken) return;
    const url = c.snippet.thumbnails?.default?.url;
    if (url) { $('pChAv').src = url; avatarCache[v.channelId] = url; save('mytube.avatars', avatarCache); }
    if (!c.statistics?.hiddenSubscriberCount) $('pChSubs').textContent = `チャンネル登録者数 ${fmtCount(c.statistics?.subscriberCount)}人`;
  }).catch(() => {});
  api('commentThreads', { part: 'snippet', videoId: v.id, maxResults: 1, order: 'relevance', textFormat: 'plainText' }, 1).then((r) => {
    if (token !== detailToken) return;
    const t = r.items?.[0]?.snippet?.topLevelComment?.snippet;
    $('cPreview').textContent = t ? `${t.authorDisplayName}：${decode(t.textDisplay)}` : 'まだコメントはありません。最初のコメントを書いてみましょう。';
  }).catch((e) => { if (token === detailToken && /コメントがオフ/.test(e.message)) $('cPreview').textContent = 'この動画はコメントがオフになっています。'; });
}

function parseChapters(desc) {
  const out = [];
  for (const line of (desc || '').split('\n')) {
    const m = line.match(/(?:^|[\s(（[【])((?:\d{1,2}:)?\d{1,2}:\d{2})(?=$|[\s)）\]】\-–—:：|・])/);
    if (!m) continue;
    const sec = m[1].split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
    const label = line.replace(m[1], '').replace(/^[\s\-–—:：|・()（）[\]【】]+|[\s\-–—|]+$/g, '').trim();
    out.push({ sec, t: m[1], label: label || m[1] });
  }
  return out.length >= 2 ? out : [];
}

$('pTitleBtn').addEventListener('click', () => {
  const open = $('pTitleBtn').getAttribute('aria-expanded') !== 'true';
  $('pTitleBtn').setAttribute('aria-expanded', String(open));
  $('pDescBox').hidden = !open;
});

function rate(target) {
  const v = current; if (!v) return;
  const next = rating === target ? 'none' : target;
  withLogin(() => apiAuth('POST', 'videos/rate', { id: v.id, rating: next }, null, 50))
    .then(() => {
      if (likeCount != null) { if (rating === 'like') likeCount--; if (next === 'like') likeCount++; }
      setRating(next);
      toast({ like: '高評価しました。', dislike: '低評価しました（数は相手に表示されません）。', none: '評価を取り消しました。' }[next]);
    })
    .catch((e) => playerReport(e.message, true));
}
$('pLike').addEventListener('click', () => rate('like'));
$('pDislike').addEventListener('click', () => rate('dislike'));

// 再生リストに保存（再生画面と「︙」メニューの両方から使う）
function saveToPlaylist(v, report = (t, err) => { if (t) toast(t); }) {
  report('再生リストを読み込んでいます…');
  withLogin(() => apiAuth('GET', 'playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: 50 }, null, 1))
    .then((res) => {
      report('');
      const addTo = (p) => {
        report('保存しています…');
        apiAuth('POST', 'playlistItems', { part: 'snippet' },
          { snippet: { playlistId: p.id, resourceId: { kind: 'youtube#video', videoId: v.id } } }, 50)
          .then(() => report(`「${decode(p.snippet.title)}」に保存しました。`))
          .catch((e) => report(e.message, true));
      };
      const options = (res.items || []).map((p) => ({ label: `${decode(p.snippet.title)}（${p.contentDetails?.itemCount ?? 0}本）`, onclick: () => addTo(p) }));
      options.push({ label: '＋ 新しい再生リストを作って保存', onclick: () => {
        $('menuTitle').textContent = '新しい再生リスト';
        const form = createPlaylistForm((p) => { $('menuDialog').close(); addTo(p); });
        form.hidden = false;
        $('menuList').replaceChildren(h('li', {}, form));
        $('menuHint').hidden = true;
        $('menuDialog').showModal();
        form.querySelector('input').focus();
      } });
      openMenu('再生リストに保存', options);
    })
    .catch((e) => report(e.message, true));
}
$('pSave').addEventListener('click', () => { if (current) saveToPlaylist(current, playerReport); });

async function shareVideo(v, report = (t) => toast(t)) {
  const url = `https://youtu.be/${v.id}`;
  if (navigator.share) {
    try { await navigator.share({ title: decode(v.title), url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('リンクをコピーしました。'); }
  catch { report(url); }
}
$('pShare').addEventListener('click', () => { if (current) shareVideo(current, playerReport); });

function updateSpeedLabel() { /* 速度は「その他」メニューに表示 */ }
function openSpeedMenu() {
  openMenu('再生速度', SPEEDS.map((s) => ({ label: s === 1 ? '1倍（標準）' : `${s}倍`, selected: s === settings.speed,
    onclick: () => { settings.speed = s; persist(); try { ytPlayer?.setPlaybackRate(s); } catch { /* noop */ } toast(`再生速度：${s}倍`); } })),
  '選んだ速度は次の動画にも使われます。');
}

function clearSleep() {
  clearTimeout(sleep.timer); clearInterval(sleep.tick);
  sleep.timer = sleep.tick = null; sleep.endAt = 0; sleep.endOfVideo = false;
  $('pTimerLabel').textContent = 'タイマー'; $('pTimer').removeAttribute('aria-pressed');
  $('pTimer').hidden = true; // タイマー中だけ表示する
}
function updateTimerLabel() {
  if (sleep.endOfVideo) { $('pTimerLabel').textContent = 'この動画まで'; return; }
  const left = Math.max(0, Math.ceil((sleep.endAt - Date.now()) / 60000));
  $('pTimerLabel').textContent = `残り${left}分`;
}
function setSleep(min) {
  clearSleep();
  $('pTimer').hidden = false;
  $('pTimer').setAttribute('aria-pressed', 'true');
  if (min === 'end') { sleep.endOfVideo = true; updateTimerLabel(); toast('この動画が終わったら停止します。'); return; }
  sleep.endAt = Date.now() + min * 60000;
  sleep.timer = setTimeout(() => { try { ytPlayer?.pauseVideo(); } catch { /* noop */ } clearSleep(); toast('タイマーで停止しました。'); }, min * 60000);
  sleep.tick = setInterval(updateTimerLabel, 30000);
  updateTimerLabel();
  toast(`${min}分後に停止します。`);
}
function openTimerMenu() {
  const on = sleep.timer || sleep.endOfVideo;
  const opts = [15, 30, 45, 60, 90].map((m) => ({ label: `${m}分後に停止`, onclick: () => setSleep(m) }));
  opts.push({ label: 'この動画が終わったら停止', onclick: () => setSleep('end') });
  if (on) opts.push({ label: 'タイマーを解除', onclick: () => { clearSleep(); toast('タイマーを解除しました。'); } });
  openMenu('スリープタイマー', opts, 'スマホの画面を消すと再生も止まります（ブラウザの仕様です）。');
}
$('pTimer').addEventListener('click', openTimerMenu);

$('pMore').addEventListener('click', () => {
  const v = current; if (!v) return;
  openMenu('その他', [
    { label: `再生速度（いま ${settings.speed}倍）`, onclick: openSpeedMenu },
    { label: sleep.timer || sleep.endOfVideo ? `スリープタイマー（${$('pTimerLabel').textContent}）` : 'スリープタイマー', onclick: openTimerMenu },
    { label: 'YouTubeで開く', onclick: () => window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`, '_blank', 'noopener') },
    { label: 'チャンネルを表示', onclick: () => openChannel(v.channelId, decode(v.channel)) },
    { label: 'このチャンネルを除外（今後表示しない）', onclick: () => { blockChannel(v.channelId, decode(v.channel)); closePlayer(); } },
    { label: 'プレーヤーを閉じる', onclick: closePlayer },
  ]);
});

const goCurrentChannel = () => { if (current) openChannel(current.channelId, decode(current.channel)); };
$('pChannel').addEventListener('click', goCurrentChannel);
$('pChAvBtn').addEventListener('click', goCurrentChannel);
$('autoNextToggle').addEventListener('change', (e) => { settings.autoNext = e.target.checked; persist(); });
$('pMin').addEventListener('click', () => minimizePlayer());
// ---------- 小窓（ミニプレーヤー） ----------
// ・下のバー（タイトル部分）をドラッグ：好きな高さへ動かせる。左右は近い方の端に寄る。画面の外へ払うと閉じる
// ・左端のつまみをドラッグ：大きさを変えられる（画面の内側・上へ引くほど大きく）
// ・ショートは縦長の小窓になる
const MINI_BAR_H = 38;
const curShort = () => isShort(current || {});
function miniLimits() {
  const top = (document.querySelector('header')?.getBoundingClientRect().bottom || 60) + 8;
  const bottom = (document.querySelector('.bottomnav')?.getBoundingClientRect().top || innerHeight) - 8;
  return { top, bottom };
}
function clampMiniWidth(w) {
  const { top, bottom } = miniLimits();
  const maxH = bottom - top - MINI_BAR_H;
  const maxW = curShort() ? Math.min(innerWidth - 16, maxH * 9 / 16) : Math.min(innerWidth - 16, maxH * 16 / 9);
  return Math.round(Math.max(curShort() ? 140 : 160, Math.min(w, maxW)));
}
function miniWidth() {
  const base = settings.miniW || Math.min(innerWidth * 0.58, 300);
  return clampMiniWidth(curShort() ? base * 0.6 : base);
}
const miniHeightFor = (w) => Math.round(curShort() ? w * 16 / 9 : w * 9 / 16) + MINI_BAR_H;
function miniSaveY(topPx, heightPx) {
  const { top, bottom } = miniLimits();
  return Math.min(1, Math.max(0, (topPx - top) / Math.max(1, bottom - top - heightPx)));
}
function placeMini() {
  if (playerMode !== 'mini') return;
  const p = $('player'); const w = miniWidth(); const ht = miniHeightFor(w);
  const pos = settings.miniPos || { side: 'right', y: 1 };
  const { top, bottom } = miniLimits();
  p.style.width = w + 'px';
  p.style.left = (pos.side === 'left' ? 8 : innerWidth - w - 8) + 'px';
  p.style.top = Math.round(top + Math.max(0, bottom - top - ht) * pos.y) + 'px';
}
addEventListener('resize', placeMini);

let miniDrag = null;
let miniJustDragged = false;
const offRatio = (left, w) => 1 - Math.max(0, Math.min(left + w, innerWidth) - Math.max(left, 0)) / w;
function miniPointerDown(e, mode) {
  if (playerMode !== 'mini') return;
  const r = $('player').getBoundingClientRect();
  miniDrag = { mode, id: e.pointerId, x: e.clientX, y: e.clientY, l: r.left, t: r.top, w: r.width, b: r.bottom, moved: false, at: Date.now() };
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 指を追えない環境でも動かせるように */ }
}
function miniPointerMove(e) {
  const d = miniDrag; if (!d || e.pointerId !== d.id) return;
  const dx = e.clientX - d.x; const dy = e.clientY - d.y;
  if (!d.moved && Math.hypot(dx, dy) < 8) return;
  d.moved = true;
  const p = $('player');
  p.classList.add('dragging');
  if (d.mode === 'move') {
    p.style.left = (d.l + dx) + 'px';
    p.style.top = (d.t + dy) + 'px';
    p.style.opacity = offRatio(d.l + dx, d.w) > 0.3 ? '0.45' : ''; // 外へ払いかけると薄くなる＝離すと閉じる
  } else {
    const side = settings.miniPos?.side || 'right';
    const w = clampMiniWidth(d.w + (side === 'right' ? -dx : dx) - dy);
    const ht = miniHeightFor(w);
    p.style.width = w + 'px';
    p.style.left = (side === 'left' ? 8 : innerWidth - w - 8) + 'px';
    p.style.top = Math.max(miniLimits().top, d.b - ht) + 'px'; // 下端をそろえたまま大きさを変える
  }
}
function miniPointerUp(e) {
  const d = miniDrag; if (!d || e.pointerId !== d.id) return;
  miniDrag = null;
  const p = $('player');
  p.classList.remove('dragging'); p.style.opacity = '';
  miniJustDragged = d.moved;
  if (!d.moved) return;
  const r = p.getBoundingClientRect();
  if (d.mode === 'move') {
    // 上へ素早くはじいたら大きく表示（ゆっくり動かしたときは位置の移動）
    const fdx = e.clientX - d.x; const fdy = e.clientY - d.y;
    if (fdy < -50 && Math.abs(fdx) < 50 && Date.now() - d.at < 280) { placeMini(); showFullPlayer(); return; }
    if (offRatio(r.left, r.width) > 0.3) { closePlayer(); toast('プレーヤーを閉じました。'); return; }
    settings.miniPos = { side: r.left + r.width / 2 < innerWidth / 2 ? 'left' : 'right', y: miniSaveY(r.top, r.height) };
  } else {
    settings.miniW = Math.round(curShort() ? r.width / 0.6 : r.width);
    settings.miniPos = { side: settings.miniPos?.side || 'right', y: miniSaveY(r.top, r.height) };
  }
  persist();
  placeMini();
}
for (const [el, mode] of [[$('miniTitle'), 'move'], [$('miniGrip'), 'resize']]) {
  el.addEventListener('pointerdown', (e) => miniPointerDown(e, mode));
  el.addEventListener('pointermove', miniPointerMove);
  el.addEventListener('pointerup', miniPointerUp);
  el.addEventListener('pointercancel', miniPointerUp);
}
$('miniTitle').addEventListener('click', () => { if (miniJustDragged) { miniJustDragged = false; return; } showFullPlayer(); });
$('miniGrip').addEventListener('click', () => { if (miniJustDragged) { miniJustDragged = false; return; } toast('つまみをドラッグすると、小窓の大きさを変えられます。'); });
$('miniExpand').addEventListener('click', showFullPlayer);
$('miniClose').addEventListener('click', closePlayer);
$('miniPlay').addEventListener('click', togglePlay);
setMiniPlaying(true);
