// MyTube — gestures.js（指の操作：ダブルタップでスキップ・下スワイプで小窓・引っぱって更新）

// ---------- 全画面：左右の空きスペースをダブルタップで ±10秒 ----------
// 左右の空きスペースは MyTube の領域（動画の上ではない）。連続でタップすると10秒ずつ足していく
const dtap = { side: null, at: 0, count: 0, timer: null };
function sideTapFeedback(side, sec) {
  const host = side === 'left' ? document.querySelector('.pc-left') : document.querySelector('.pc-right');
  let el = host.querySelector('.skipfx');
  if (!el) { el = h('div', { class: 'skipfx', 'aria-hidden': 'true' }); host.append(el); }
  el.textContent = side === 'left' ? `« ${sec}秒` : `${sec}秒 »`;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
}
function onSideTap(e, side) {
  if (!isFs() || e.target.closest('button')) return; // ボタン（⌄・CC・全画面など）は普通に押せる
  const now = Date.now();
  if (dtap.side === side && now - dtap.at < 350) {
    dtap.count++;
    skip(side === 'left' ? -10 : 10);
    sideTapFeedback(side, dtap.count * 10);
  } else {
    dtap.count = 0;
  }
  dtap.side = side; dtap.at = now;
  clearTimeout(dtap.timer);
  dtap.timer = setTimeout(() => { dtap.side = null; dtap.count = 0; }, 700);
}
document.querySelector('.pc-left').addEventListener('pointerup', (e) => onSideTap(e, 'left'));
document.querySelector('.pc-right').addEventListener('pointerup', (e) => onSideTap(e, 'right'));

// ---------- 再生画面：操作バーを下へスワイプすると小窓に（動画の上は YouTube がタップを受け取る） ----------
const swipe = { y: 0, x: 0, at: 0, active: false, moved: false };
function swipeStart(e) {
  if (playerMode !== 'full' || isFs() || e.touches.length !== 1) return;
  if (e.target.closest('input, #seek')) return; // シークバーの操作とは区別する
  swipe.y = e.touches[0].clientY; swipe.x = e.touches[0].clientX; swipe.at = Date.now();
  swipe.active = true; swipe.moved = false;
}
function swipeMove(e) {
  if (!swipe.active) return;
  const dy = e.touches[0].clientY - swipe.y; const dx = e.touches[0].clientX - swipe.x;
  if (!swipe.moved && (Math.abs(dx) > Math.abs(dy) || dy < 8)) { if (Math.abs(dx) > 12 || dy < -12) swipe.active = false; return; }
  swipe.moved = true;
  e.preventDefault();
  const p = $('player');
  p.style.transition = 'none';
  p.style.transform = `translateY(${Math.max(0, dy)}px)`;
  p.style.opacity = String(Math.max(0.4, 1 - dy / 600));
}
function swipeEnd(e) {
  if (!swipe.active) return;
  swipe.active = false;
  const p = $('player');
  const dy = (e.changedTouches[0]?.clientY ?? swipe.y) - swipe.y;
  const fast = dy > 40 && Date.now() - swipe.at < 250;
  p.style.transition = 'transform .18s ease, opacity .18s ease';
  if (swipe.moved && (dy > 120 || fast)) {
    p.style.transform = ''; p.style.opacity = '';
    setTimeout(() => { p.style.transition = ''; }, 200);
    minimizePlayer();
  } else {
    p.style.transform = ''; p.style.opacity = '';
    setTimeout(() => { p.style.transition = ''; }, 200);
  }
}
for (const el of [$('pCtrl')]) {
  el.addEventListener('touchstart', swipeStart, { passive: true });
  el.addEventListener('touchmove', swipeMove, { passive: false });
  el.addEventListener('touchend', swipeEnd);
  el.addEventListener('touchcancel', swipeEnd);
}

// ---------- ホーム・登録チャンネル：一番上で下に引っぱると更新 ----------
const ptr = { y: 0, active: false, dist: 0 };
const PTR_GO = 70;
function ptrAllowed() {
  return (state.tab === 'home' || state.tab === 'feed') && !detailStack.length && playerMode !== 'full'
    && window.scrollY <= 0 && !document.querySelector('dialog[open]');
}
document.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1 || !ptrAllowed() || e.target.closest('.player, header, .bottomnav, .carousel, .subrow, .chips')) return;
  ptr.y = e.touches[0].clientY; ptr.active = true; ptr.dist = 0;
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!ptr.active) return;
  const dy = e.touches[0].clientY - ptr.y;
  if (dy <= 0 || window.scrollY > 0) { ptr.active = false; $('ptr').hidden = true; return; }
  ptr.dist = Math.min(dy * 0.5, 110);
  $('ptr').hidden = false;
  $('ptr').style.transform = `translate(-50%, ${ptr.dist}px)`;
  $('ptr').classList.toggle('ready', ptr.dist >= PTR_GO);
  $('ptrText').textContent = ptr.dist >= PTR_GO ? '離すと更新' : '引っぱって更新';
}, { passive: true });
document.addEventListener('touchend', () => {
  if (!ptr.active) return;
  ptr.active = false;
  const go = ptr.dist >= PTR_GO;
  $('ptr').hidden = true; $('ptr').classList.remove('ready');
  if (!go) return;
  if (state.tab === 'home') loadHome(true);
  if (state.tab === 'feed') loadFeed(true);
  toast('更新しています…');
});
