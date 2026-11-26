// MyTube — home.js（index.html から順番に読み込む。前のファイルで定義したものを使う）
// ---------- 再生履歴ページ ----------
function openHistory() {
  openDetail('再生履歴', (box) => {
    const msg = h('p', { class: 'hint', 'aria-live': 'polite' });
    const list = h('div', { class: 'list' });
    let armed = false;
    const clearBtn = h('button', { class: 'small', type: 'button', text: 'すべて消す', onclick: () => {
      if (!armed) { armed = true; clearBtn.textContent = 'もう一度押すと全部消します'; setTimeout(() => { armed = false; clearBtn.textContent = 'すべて消す'; }, 4000); return; }
      watchHistory = []; saveHistory(); list.replaceChildren(); setMsg(msg, '再生履歴を消しました。');
      document.querySelectorAll('main [data-vid]').forEach((row) => row.querySelectorAll('.prog, .wbadge').forEach((n) => n.remove()));
      document.querySelectorAll('main .watched').forEach((row) => row.classList.remove('watched'));
    } });
    box.append(h('div', { class: 'detail-head' },
      h('div', { class: 'sub', text: `${watchHistory.length}本（最新${HISTORY_MAX}本まで・このスマホの中だけに保存）${settings.historyOn ? '' : ' ・ 記録は停止中'}` }),
      h('div', { class: 'acts' }, clearBtn), msg), list);
    if (!watchHistory.length) { setMsg(msg, 'まだ再生履歴はありません。動画を1秒以上再生すると、ここに記録されます。'); return; }
    renderVideos(list, watchHistory.slice(), { compact: true,
      extra: (v) => `視聴：${fmtAgo(v.at)}${v.done ? '（最後まで）' : v.pos ? `（${fmtDuration(v.pos)}まで）` : ''}`,
      menu: (v, row, removeRow) => [{ label: '履歴から削除', onclick: () => {
        watchHistory = watchHistory.filter((x) => x.id !== v.id); saveHistory(); removeRow();
        document.querySelectorAll(`main [data-vid="${CSS.escape(v.id)}"]`).forEach((r) => decorateRow(r, v));
      } }] });
  });
}

// ---------- おすすめ（ホーム） ----------
// 公式のおすすめはAPIで取得できないため、MyTubeの再生履歴・高評価・登録チャンネルから自前で作る
const REC_TTL = 6 * 3600 * 1000; // 6時間は作り直さない
const CATEGORY_NAMES = { 1: '映画・アニメ', 2: '車・乗り物', 10: '音楽', 15: 'ペット・動物', 17: 'スポーツ', 19: '旅行・イベント',
  20: 'ゲーム', 22: 'ブログ・日常', 23: 'お笑い', 24: 'エンタメ', 25: 'ニュース・政治', 26: 'ハウツー・スタイル',
  27: '教育', 28: '科学・技術', 29: '社会貢献' };
const STOPWORDS = new Set(('向け おすすめ オススメ 人気 話題 動画 公式 解説 実況 生配信 配信 切り抜き 最新 方法 紹介 簡単 完全 初心者 必見 今日 本日 前編 後編 まとめ ' +
  'ショート 公開 ライブ 企画 総集編 第一弾 チャンネル 限定 特集 本編 予告 速報 衝撃 神回 全部 やってみた してみた ' +
  'shorts short official video the and with for live mv music full part vol feat ver hd 4k youtube new from you this that are').split(' '));
const SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;

let hiddenVideos = new Set(load('mytube.hiddenVideos', []));
function hideVideo(id) { hiddenVideos.add(id); save('mytube.hiddenVideos', [...hiddenVideos].slice(-1000)); }
const isWatched = (id) => !!histGet(id)?.done;
const topOf = (map) => [...map].sort((a, b) => b[1] - a[1]);

function tokenize(text) {
  const out = new Set();
  const clean = (text || '').replace(/[【】「」『』［］[\]()（）#＃!！?？|｜:：、。・,./"'~〜\-–—_＿&＆+＋*＊]/g, ' ');
  const words = SEG ? [...SEG.segment(clean)].filter((s) => s.isWordLike).map((s) => s.segment)
    : (clean.match(/[゠-ヿー]{2,}|[一-鿿々]{2,}|[A-Za-z][A-Za-z0-9]{2,}/g) || []);
  for (let w of words) {
    w = w.trim().toLowerCase();
    if (w.length < 2) continue;
    if (/^[\d０-９.,:年月日時分秒回話本]+$/.test(w)) continue;
    if (/^[぀-ゟ]+$/.test(w) && w.length < 4) continue; // 助詞などの短いひらがな
    if (/^[一-鿿][぀-ゟ]{1,2}$/.test(w)) continue; // 「張り」「選び」など動詞の切れ端
    if (/^[a-z]{1,2}$/.test(w) || STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return [...out];
}

// 視聴の傾向を数値にする（最近見たものほど重く、最後まで見た・高評価したものはさらに重く）
function buildSignals(liked) {
  const ch = new Map(); const kw = new Map(); const cat = new Map(); const chNames = new Map();
  const add = (map, k, w) => map.set(k, (map.get(k) || 0) + w);
  const use = (v, w) => {
    if (v.channelId) { add(ch, v.channelId, w); chNames.set(v.channelId, decode(v.channel)); }
    for (const t of tokenize(decode(v.title))) add(kw, t, w);
    for (const tag of (v.tags || []).slice(0, 8)) for (const t of tokenize(tag)) add(kw, t, w * 0.5);
    if (v.cat) add(cat, String(v.cat), w);
  };
  const now = Date.now();
  for (const e of watchHistory) use(e, (e.done ? 1.5 : 1) * Math.exp(-(now - (e.at || now)) / 86400000 / 30));
  for (const v of liked) use(v, 1.5);
  const nameWords = new Set([...chNames.values()].map((n) => n.toLowerCase()));
  return { ch, kw, cat, chNames, nameWords };
}

// ---------- 更新のたびに顔ぶれを変える工夫 ----------
const DAY_MS = 86400000;
const daysAgo = (d) => new Date(Date.now() - d * DAY_MS).toISOString();
// ワードの検索は、更新のたびに並び順と期間を変える（同じワードでも違う動画が出る）
const SEARCH_VARIANTS = [
  () => ({}),                                                // 関連度順
  () => ({ order: 'date', publishedAfter: daysAgo(30) }),    // 最近1か月の新しい順
  () => ({ order: 'viewCount', publishedAfter: daysAgo(90) }), // 最近3か月の再生回数順
  () => ({ publishedAfter: daysAgo(180) }),                  // 最近半年の関連度順
  () => ({ order: 'rating', publishedAfter: daysAgo(365) }), // 最近1年の評価順
];
const randomOf = (arr) => arr[Math.floor(Math.random() * arr.length)];
// 点数の高いものほど選ばれやすい「くじ引き」で n 個選ぶ
function pickWeighted(cands, n) {
  const pool = cands.slice(); const out = [];
  while (out.length < n && pool.length) {
    let r = Math.random() * pool.reduce((a, [, s]) => a + s, 0);
    let i = 0;
    for (; i < pool.length - 1; i++) { r -= pool[i][1]; if (r <= 0) break; }
    out.push(pool.splice(i, 1)[0][0]);
  }
  return out;
}
// おすすめに出した回数（見ないまま3回出た動画は、しばらく出さない）
const REC_SEEN_MAX = 3;
const REC_SEEN_KEEP = 14 * DAY_MS;
function loadRecSeen() {
  const m = load('mytube.recSeen', {}); const now = Date.now();
  for (const [id, [, at]] of Object.entries(m)) if (now - at > REC_SEEN_KEEP) delete m[id];
  return m;
}

async function buildRecommendations(progress, { fresh = false } = {}) {
  // 高評価と登録チャンネルを同時に読む（ここではログイン画面は出さない。期限切れなら履歴だけで作る）
  let liked = []; let subs = new Set();
  if (isLoggedIn() && tokenValid()) {
    progress('あなたの好みを確認しています…');
    const [lk, sb] = await Promise.all([
      apiAuth('GET', 'videos', { part: 'snippet', myRating: 'like', maxResults: 50 }, null, 1).catch(() => null),
      getSubscriptionIds().catch(() => null),
    ]);
    liked = (lk?.items || []).map((v) => ({ channelId: v.snippet.channelId, channel: v.snippet.channelTitle,
      title: v.snippet.title, cat: v.snippet.categoryId, tags: v.snippet.tags || [] }));
    if (sb) subs = sb;
  }
  const sig = buildSignals(liked);
  const used = new Set();
  const recSeen = loadRecSeen();
  const seenN = (id) => recSeen[id]?.[0] || 0;
  const keep = (items, n = 20) => items.filter((v) => !isShort(v) && !used.has(v.id) && !hiddenVideos.has(v.id) && !isWatched(v.id) && seenN(v.id) < REC_SEEN_MAX)
    .map((v, i) => [v, i]).sort((a, b) => seenN(a[0].id) - seenN(b[0].id) || a[1] - b[1]).map(([v]) => v) // まだ出していない動画を先に
    .slice(0, n).map((v) => { used.add(v.id); return v; });
  const quotaOut = (e) => { if (/上限/.test(e?.message || '')) throw e; return null; };
  const searchParams = (q, extra = {}) => {
    const p = { part: 'snippet', type: 'video', q, ...extra };
    if (settings.jaOnly) { p.relevanceLanguage = 'ja'; p.regionCode = 'JP'; }
    if (settings.minMin >= 20) p.videoDuration = 'long';
    return p;
  };

  // それぞれの欄の材料を「同時に」集める（並び順は最後にそろえる）
  const chans = topOf(sig.ch).filter(([id, s]) => s >= 1.5 && !subs.has(id) && !isBlocked(id)).slice(0, 8);
  const hiddenKw = new Set(settings.hiddenKeywords || []);
  const custom = (settings.customKeywords || []).filter((w) => !hiddenKw.has(w));
  const autoCands = topOf(sig.kw).filter(([w, s]) => s >= 1 && !hiddenKw.has(w) && !sig.nameWords.has(w) && !custom.includes(w));
  // 自動のワードは、上位10語から毎回くじ引きで選ぶ（点数の高いワードほど選ばれやすい）
  const autoKws = pickWeighted(autoCands.filter(([, s]) => s >= 1.5).slice(0, 10), settings.autoKwCount ?? 2);
  const kwList = [...custom.map((w) => ({ w, mine: true })), ...autoKws.map((w) => ({ w, mine: false }))];
  const kwCandidates = autoCands.map(([w]) => w).filter((w) => !autoKws.includes(w)).slice(0, 12);
  const gemWords = pickWeighted([...new Set([...custom, ...autoCands.slice(0, 12).map(([w]) => w)])].map((w, i) => [w, 12 - Math.min(i, 11)]), 4);
  const cats = topOf(sig.cat).filter(([c, s]) => s >= 1 && c !== '22').slice(0, 3);
  progress('おすすめを集めています…');

  // 1. よく見るのに未登録のチャンネルの新着
  const chanTask = chans.length ? (async () => {
    const lists = await pool(chans, 8, async ([id]) =>
      (await api('playlistItems', { part: 'contentDetails', playlistId: 'UU' + id.slice(2), maxResults: 4 }, 1)).items || []);
    const ids = lists.filter(Boolean).flat().map((it) => it.contentDetails.videoId);
    return (await fetchVideoItems(ids, {})).sort((a, b) => (b.published > a.published ? 1 : -1));
  })().catch(quotaOut) : null;

  // 2. ワードで検索（1語100ユニット）
  const kwTasks = kwList.map(({ w }) => (async () => {
    const r = await api('search', searchParams(w, { maxResults: 25, ...randomOf(SEARCH_VARIANTS)() }), 100, { fresh });
    const ids = (r.items || []).filter((it) => it.id?.videoId && !isBlocked(it.snippet?.channelId)).map((it) => it.id.videoId);
    return fetchVideoItems(ids, { lang: true });
  })().catch(quotaOut));

  // 3. 掘り出し物：登録者が少ないのに再生や評価が伸びている、まだ見たことのないチャンネルの過去1週間の動画
  const gemTask = gemWords.length ? (async () => {
    const seenCh = new Set(watchHistory.map((e) => e.channelId));
    const r = await api('search', searchParams(gemWords.join('|'), { maxResults: 50, // | は「どれか」
      publishedAfter: new Date(Date.now() - 7 * 86400000).toISOString() }), 100, { fresh });
    const ids = (r.items || []).filter((it) => it.id?.videoId && !subs.has(it.snippet.channelId) && !seenCh.has(it.snippet.channelId) && !isBlocked(it.snippet.channelId))
      .map((it) => it.id.videoId);
    if (!ids.length) return [];
    const det = await api('videos', { part: 'snippet,contentDetails,statistics,liveStreamingDetails,player', maxWidth: 240, id: ids.join(',') }, 1);
    const chIds = [...new Set((det.items || []).map((v) => v.snippet.channelId))];
    const chs = await api('channels', { part: 'statistics', id: chIds.join(','), maxResults: 50 }, 1);
    const subsOf = new Map((chs.items || []).map((c) => [c.id, c.statistics?.hiddenSubscriberCount ? null : +c.statistics?.subscriberCount]));
    const gems = [];
    for (const v of det.items || []) {
      const item = toItem(v, { lang: true });
      if (!item || isShort(item)) continue;
      const views = +v.statistics?.viewCount || 0; const likes = +v.statistics?.likeCount || 0;
      const subsN = subsOf.get(v.snippet.channelId);
      if (subsN == null || subsN > 50000) continue;      // 登録者5万人以下の小さめのチャンネル
      if (views < 300) continue;                          // ある程度は見られている（1週間なので低め）
      const likeRate = likes / views;
      if (likeRate < 0.02) continue;                      // 高評価率2%以上
      const reach = Math.min(views / Math.max(subsN, 100), 20); // 登録者数の何倍見られたか
      if (reach < 0.5) continue;
      item.gemScore = likeRate * Math.log10(views) * Math.sqrt(reach);
      gems.push(item);
    }
    gems.sort((a, b) => b.gemScore - a.gemScore);
    const perCh = new Map();
    return gems.filter((g) => { const n = perCh.get(g.channelId) || 0; perCh.set(g.channelId, n + 1); return n < 2; }); // 1チャンネル2本まで
  })().catch(quotaOut) : null;

  // 4. よく見るジャンルの人気動画（「ブログ・日常」は既定のジャンルで好みを表さないので使わない）
  const catTasks = cats.map(([c]) => api('videos', { part: 'snippet,contentDetails,statistics,liveStreamingDetails,player', maxWidth: 240,
    chart: 'mostPopular', regionCode: 'JP', videoCategoryId: c, maxResults: 25 }, 1)
    .then((r) => (r.items || []).map((v) => toItem(v, {})).filter(Boolean)).catch(() => null));

  const [chanItems, kwItems, gemItems, catItems] = await Promise.all([chanTask, Promise.all(kwTasks), gemTask, Promise.all(catTasks)]);

  // いつもと同じ順番で欄を組み立てる（同じ動画が2つの欄に出ないように）
  const sections = [];
  if (chanItems) {
    const k = keep(chanItems);
    if (k.length) sections.push({ title: 'よく見るチャンネルの新着', items: k,
      reason: chans.slice(0, 3).map(([id]) => sig.chNames.get(id)).filter(Boolean).join('、') + ' など、よく見ているチャンネル' });
  }
  kwList.forEach(({ w, mine }, i) => {
    const k = kwItems[i] ? keep(kwItems[i]) : [];
    if (k.length) sections.push({ title: `「${w}」のおすすめ`, keyword: w, custom: mine, items: k,
      reason: mine ? `あなたが追加したワード「${w}」` : `「${w}」が入った動画をよく見ているため` });
  });
  if (gemItems) {
    const k = keep(gemItems);
    if (k.length) sections.push({ title: '掘り出し物', items: k, gem: true,
      reason: `「${gemWords.join('」「')}」の動画から、登録者が少ないのに評価が高いチャンネルを選んでいます（まだ見たことのないチャンネルだけ）` });
  }
  cats.forEach(([c], i) => {
    const k = catItems[i] ? keep(catItems[i]) : [];
    if (k.length) sections.push({ title: `${CATEGORY_NAMES[c] || '好きなジャンル'}の人気動画`, items: k, reason: `${CATEGORY_NAMES[c] || 'このジャンル'}の動画をよく見ているため` });
  });

  // 材料が足りないときは日本の人気動画
  if (!sections.length) {
    progress('人気の動画を集めています…');
    const r = await api('videos', { part: 'snippet,contentDetails,statistics,liveStreamingDetails,player', maxWidth: 240, chart: 'mostPopular', regionCode: 'JP', maxResults: 30 }, 1);
    const k = keep((r.items || []).map((v) => toItem(v, {})).filter(Boolean));
    if (k.length) sections.push({ title: '日本の人気動画', items: k, reason: '視聴データがまだ少ないため、人気の動画を表示しています。見るほど、あなた向けに変わっていきます。' });
  }
  const now = Date.now(); // 今回出した動画を数えておく
  for (const sec of sections) for (const v of sec.items) recSeen[v.id] = [seenN(v.id) + 1, now];
  save('mytube.recSeen', recSeen);
  return { at: Date.now(), basis: watchHistory.length + liked.length, sections, kwCandidates };
}

// 横スクロールの棚（続きから見る・履歴）用の小さいカード
function renderCard(v, queue, { menu = null } = {}) {
  const play = () => openPlayer(v, queue);
  const card = h('article', { class: 'card', 'data-vid': v.id, 'data-channel': v.channelId },
    h('button', { class: 'thumb', type: 'button', 'aria-label': '再生', onclick: play },
      thumbImg(v, 'card'), h('span', { class: 'dur', text: durText(v) })),
    h('div', { class: 'card-meta' },
      h('div', { class: 'mtext' },
        h('button', { class: 'title', type: 'button', text: decode(v.title), onclick: play }),
        h('div', { class: 'sub', text: decode(v.channel) })),
      h('button', { class: 'kebab', type: 'button', 'aria-label': 'メニュー', onclick: () => openVideoMenu(v, card, queue, menu) }, icon('vdots'))));
  decorateRow(card, v);
  return card;
}

function shelf(title, items, menu, action) {
  const q = items.slice();
  return h('section', { class: 'home-sec' },
    h('div', { class: 'section-head' }, h('h2', { text: title }), action || null),
    h('div', { class: 'carousel' }, q.map((v) => renderCard(v, q, { menu }))));
}

let homeFilter = 'all';
function secLabel(s) {
  if (s.keyword) return s.keyword;
  if (s.title === 'よく見るチャンネルの新着') return 'よく見るチャンネル';
  return s.title.replace(/の人気動画$/, '');
}
function interleave(lists) {
  const out = []; const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}
function hideKeyword(keyword) {
  const mine = (settings.customKeywords || []).includes(keyword);
  if (mine) settings.customKeywords = settings.customKeywords.filter((w) => w !== keyword);
  else settings.hiddenKeywords = [...new Set([...(settings.hiddenKeywords || []), keyword])];
  persist();
  const c = load('mytube.rec', null);
  if (c) { c.sections = c.sections.filter((s) => s.keyword !== keyword); save('mytube.rec', c); }
  if (homeFilter === keyword) homeFilter = 'all';
  renderHome(c);
  toast(mine ? `「${keyword}」をおすすめのワードから外しました。` : `「${keyword}」の動画はおすすめに出さないようにしました。`);
}

// ---------- おすすめのワードの編集 ----------
const KW_MAX = 8;
let kwDirty = false;
function kwCostText() {
  const n = (settings.customKeywords || []).length + (settings.autoKwCount ?? 2);
  const per = n * 100 + 120; // ＋掘り出し物の検索100
  return `いまの設定：ワード${n}個＋掘り出し物 → おすすめを1回作るごとに約${per}ユニット（6時間ごとに作り直すので、1日最大 約${per * 4}／10,000）`;
}
function renderKwEditor() {
  const custom = settings.customKeywords || [];
  const hidden = settings.hiddenKeywords || [];
  const rec = load('mytube.rec', null);
  const used = new Set([...custom, ...hidden]);
  const autoNow = (rec?.sections || []).filter((s) => s.keyword && !s.custom).map((s) => s.keyword);
  const cands = [...new Set([...autoNow, ...(rec?.kwCandidates || [])])].filter((w) => !used.has(w));
  const row = (w, label, fn) => h('li', {}, h('span', { text: w }), h('button', { type: 'button', text: label, onclick: fn }));
  $('kwCustom').replaceChildren(...custom.map((w) => row(w, '外す', () => {
    settings.customKeywords = custom.filter((x) => x !== w); persist(); kwDirty = true; renderKwEditor();
  })));
  $('kwCustomEmpty').hidden = custom.length > 0;
  $('kwAutoCount').value = String(settings.autoKwCount ?? 2);
  $('kwCands').replaceChildren(...cands.map((w) => h('button', { class: 'chip', type: 'button', text: (autoNow.includes(w) ? '● ' : '') + w, onclick: () => {
    openMenu(`「${w}」`, [
      { label: '自分のワードに追加（必ず表示する）', onclick: () => addKeyword(w) },
      { label: 'このワードを表示しない', onclick: () => { settings.hiddenKeywords = [...new Set([...hidden, w])]; persist(); kwDirty = true; renderKwEditor(); } },
    ]);
  } })));
  $('kwCandsEmpty').hidden = cands.length > 0;
  $('kwHidden').replaceChildren(...hidden.map((w) => row(w, '戻す', () => {
    settings.hiddenKeywords = hidden.filter((x) => x !== w); persist(); kwDirty = true; renderKwEditor();
  })));
  $('kwHiddenEmpty').hidden = hidden.length > 0;
  $('kwCost').textContent = kwCostText();
}
function addKeyword(raw) {
  const w = raw.trim().replace(/\s+/g, ' ');
  if (!w) return;
  const custom = settings.customKeywords || [];
  if (custom.includes(w)) { setMsg($('kwMsg'), `「${w}」はもう追加されています。`, true); return; }
  if (custom.length >= KW_MAX) { setMsg($('kwMsg'), `自分のワードは${KW_MAX}個までです（使用量が増えすぎないように）。`, true); return; }
  settings.customKeywords = [...custom, w];
  settings.hiddenKeywords = (settings.hiddenKeywords || []).filter((x) => x !== w);
  persist(); kwDirty = true;
  setMsg($('kwMsg'), `「${w}」を追加しました。`);
  renderKwEditor();
}
function openKwEditor() {
  kwDirty = false;
  setMsg($('kwMsg'), '');
  $('kwInput').value = '';
  renderKwEditor();
  $('kwDialog').showModal();
}
$('kwForm').addEventListener('submit', (e) => { e.preventDefault(); addKeyword($('kwInput').value); $('kwInput').value = ''; });
$('kwAutoCount').addEventListener('change', () => { settings.autoKwCount = +$('kwAutoCount').value; persist(); kwDirty = true; $('kwCost').textContent = kwCostText(); });
$('kwClose').addEventListener('click', () => { $('kwDialog').close(); if (kwDirty) toast('変更は次におすすめを作り直したときに反映されます（「更新」ですぐ反映）。'); });
$('kwApply').addEventListener('click', () => { $('kwDialog').close(); setTab('home'); loadHome(true); });
$('kwDialog').addEventListener('click', (e) => { if (e.target === $('kwDialog')) $('kwDialog').close(); });

function renderHome(rec) {
  const box = $('homeContent');
  box.replaceChildren();
  const ok = (v) => !isShort(v) && !hiddenVideos.has(v.id) && !isWatched(v.id) && !isBlocked(v.channelId);
  const secs = (rec?.sections || []).map((s) => ({ ...s, label: secLabel(s), items: s.items.filter(ok) })).filter((s) => s.items.length);
  if (homeFilter !== 'all' && !secs.some((s) => s.label === homeFilter)) homeFilter = 'all';

  // 上のチップ（すべて / 話題 / ジャンル…）
  $('homeChips').replaceChildren(...[['all', 'すべて'], ...secs.map((s) => [s.label, s.label])].map(([key, label]) =>
    h('button', { class: 'chip', type: 'button', text: label, 'aria-pressed': String(homeFilter === key),
      onclick: () => { homeFilter = key; renderHome(load('mytube.rec', null)); window.scrollTo({ top: 0 }); } })),
    h('button', { class: 'chip chip-edit', type: 'button', text: '✎ ワードを編集', onclick: openKwEditor }));
  $('homeChips').hidden = false;

  if (homeFilter === 'all') {
    const cont = watchHistory.filter((e) => !isShort(e) && !e.done && !e.dismissed && e.pos >= RESUME_MIN && !isBlocked(e.channelId)).slice(0, 15);
    if (cont.length) box.append(shelf('続きから見る', cont, (v, row, removeRow) => [{ label: '「続きから見る」から外す', onclick: () => {
      const e = histGet(v.id); if (e) { e.dismissed = true; saveHistory(); }
      removeRow();
    } }]));
  }
  const sel = homeFilter === 'all' ? null : secs.find((s) => s.label === homeFilter);
  if (sel?.reason) box.append(h('p', { class: 'hint', text: sel.reason }));
  const list = sel ? sel.items : interleave(secs.map((s) => s.items));
  const secOf = new Map();
  for (const s of secs) for (const v of s.items) secOf.set(v.id, s);
  if (list.length) {
    const feed = h('div', { class: 'list' });
    box.append(feed);
    renderVideos(feed, list, { menu: (v, row, removeRow) => {
      const s = secOf.get(v.id);
      const o = [{ label: '興味なし', onclick: () => { hideVideo(v.id); removeRow(); toast('この動画はおすすめに表示しません。'); } }];
      if (s?.keyword) o.push({ label: s.custom ? `「${s.keyword}」をおすすめのワードから外す` : `「${s.keyword}」の動画を表示しない`, onclick: () => hideKeyword(s.keyword) });
      return o;
    } });
  }
  if (!box.children.length) box.append(h('div', { class: 'empty', text: 'おすすめにできる動画が見つかりませんでした。「更新」で作り直せます。' }));
  if (rec) setMsg($('homeStatus'), `作成：${fmtAgo(rec.at)}（MyTubeの再生履歴${watchHistory.length}本などから）`);
}

let homeLoading = false;
async function loadHome(force) {
  const status = $('homeStatus');
  if (!settings.apiKey) {
    $('homeChips').hidden = true;
    $('homeContent').replaceChildren(h('div', { class: 'empty', text: '最初に右上の設定ボタンからAPIキーを入れてください。' }));
    setMsg(status, ''); return;
  }
  const cache = load('mytube.rec', null);
  if (!force && cache && Date.now() - cache.at < REC_TTL) { renderHome(cache); return; }
  if (homeLoading) return;
  homeLoading = true; $('homeRefresh').hidden = true;
  if (cache) renderHome(cache);
  setMsg(status, 'おすすめを作っています…');
  try {
    const rec = await buildRecommendations((t) => setMsg(status, t), { fresh: !!force });
    save('mytube.rec', rec);
    renderHome(rec);
  } catch (e) {
    if (!cache) renderHome(null);
    setMsg(status, e.message, true);
  } finally { homeLoading = false; $('homeRefresh').hidden = false; }
}
$('homeRefresh').addEventListener('click', () => loadHome(true));
$('resetRec').addEventListener('click', () => {
  hiddenVideos = new Set(); save('mytube.hiddenVideos', []);
  settings.hiddenKeywords = []; persist();
  watchHistory.forEach((e) => { e.dismissed = false; }); saveHistory();
  remove('mytube.rec'); remove('mytube.recSeen');
  $('recMsg').textContent = 'リセットしました。次にホームを開いたときに作り直します。';
});
