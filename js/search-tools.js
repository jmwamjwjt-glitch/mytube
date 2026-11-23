// MyTube — search-tools.js（検索の履歴・音声で検索）

// ---------- 検索の履歴（このスマホの中だけに保存・最新20件） ----------
const SEARCH_HISTORY_MAX = 20;
const getSearchHistory = () => load('mytube.searchHistory', []);
function addSearchHistory(q) {
  const list = getSearchHistory().filter((x) => x !== q);
  list.unshift(q);
  save('mytube.searchHistory', list.slice(0, SEARCH_HISTORY_MAX));
}
function renderSearchHistory() {
  const box = $('searchHistory');
  const typed = els.q.value.trim().toLowerCase();
  const list = getSearchHistory().filter((q) => !typed || q.toLowerCase().includes(typed));
  if (!list.length) { box.hidden = true; return; }
  box.replaceChildren(
    ...list.map((q) => h('div', { class: 'shist-row' },
      h('button', { class: 'shist-q', type: 'button', onclick: () => { els.q.value = q; runSearch(true); } },
        h('span', { class: 'shist-ic', 'aria-hidden': 'true', text: '🕘' }), h('span', { text: q })),
      h('button', { class: 'shist-fill', type: 'button', 'aria-label': `「${q}」を入力欄に入れる`, text: '↖',
        onclick: () => { els.q.value = q; els.q.focus(); renderSearchHistory(); } }),
      h('button', { class: 'shist-del', type: 'button', 'aria-label': `「${q}」を履歴から削除`, text: '✕',
        onclick: () => { save('mytube.searchHistory', getSearchHistory().filter((x) => x !== q)); renderSearchHistory(); } }))),
    typed ? null : h('button', { class: 'shist-clear', type: 'button', text: '検索履歴をすべて消す',
      onclick: () => { save('mytube.searchHistory', []); renderSearchHistory(); toast('検索履歴を消しました。'); } }));
  box.hidden = false;
}
// 検索欄を開いた・触った・入力したときに履歴を出す（検索結果があるときは、入力を始めたときだけ）
els.q.addEventListener('focus', () => { if (!els.search.list.children.length || els.q.value === '') renderSearchHistory(); });
els.q.addEventListener('input', renderSearchHistory);
$('openSearch').addEventListener('click', () => { if (!els.search.list.children.length) renderSearchHistory(); });

// ---------- 音声で検索（Chrome の音声入力。初回はマイクの許可を聞かれる） ----------
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let speech = null;
if (SpeechRec) {
  $('micBtn').hidden = false;
  $('micBtn').addEventListener('click', () => {
    if (speech) { speech.stop(); return; } // もう一度押すと止める
    speech = new SpeechRec();
    speech.lang = 'ja-JP';
    speech.interimResults = true;
    speech.maxAlternatives = 1;
    $('micBtn').classList.add('listening');
    $('micBtn').setAttribute('aria-label', '音声入力を止める');
    const before = els.q.value;
    let finalText = '';
    speech.onresult = (ev) => {
      let interim = '';
      for (const r of ev.results) { if (r.isFinal) finalText = r[0].transcript; else interim += r[0].transcript; }
      els.q.value = finalText || interim;
    };
    speech.onerror = (ev) => {
      toast(ev.error === 'not-allowed' ? 'マイクの使用が許可されていません。ブラウザの設定で許可してください。'
        : ev.error === 'no-speech' ? '声が聞き取れませんでした。' : '音声入力がうまくいきませんでした。');
    };
    speech.onend = () => {
      $('micBtn').classList.remove('listening');
      $('micBtn').setAttribute('aria-label', '音声で検索');
      speech = null;
      const q = finalText.trim();
      if (q) { els.q.value = q; runSearch(true); } else if (!els.q.value.trim()) els.q.value = before;
    };
    try { speech.start(); toast('話してください…'); } catch { speech = null; $('micBtn').classList.remove('listening'); }
  });
}
