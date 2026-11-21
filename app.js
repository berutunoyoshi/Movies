'use strict';
/*
 * Video Remote
 * iPad（再生側）と iPhone（リモコン側）を WebRTC のデータチャネルで直接つなぐ。
 * サーバーは使わず、接続情報（SDP）は QR コードで手渡しする。
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ---------------------------------------------------------------- 画面切替
function show(id) {
  $$('.screen').forEach((el) => { el.hidden = el.id !== id; });
  window.scrollTo(0, 0);
}
$$('[data-back]').forEach((b) => b.addEventListener('click', () => show(b.dataset.back)));

// ---------------------------------------------------------------- 共通ユーティリティ
function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = s.toFixed(1).padStart(4, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
function parseTime(str) {
  // "83.5" / "1:23.5" / "1:02:03" を秒に
  const s = String(str).trim().replace(/：/g, ':').replace(/[０-９．]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  if (!s) return NaN;
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !isFinite(n) || n < 0)) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
function setStatus(el, text, kind) {
  el.textContent = text || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (_) { /* 非対応・拒否時は何もしない */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && peer.connected) keepAwake();
});

// ---------------------------------------------------------------- 接続コード（SDP）の圧縮
const PREFIX = 'VR1';
async function streamBytes(bytes, stream) {
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function slimSdp(sdp) {
  // データチャネルだけなので不要な行を落としてQRを小さくする
  return sdp.split('\r\n').filter((l) => l &&
    !l.startsWith('a=extmap-allow-mixed') &&
    !l.startsWith('a=msid-semantic')).join('\r\n') + '\r\n';
}
async function encodeSignal(type, sdp) {
  const raw = new TextEncoder().encode(slimSdp(sdp));
  if ('CompressionStream' in window) {
    try {
      const z = await streamBytes(raw, new CompressionStream('deflate-raw'));
      return `${PREFIX}:${type}:z:${toB64(z)}`;
    } catch (_) { /* 失敗したら非圧縮 */ }
  }
  return `${PREFIX}:${type}:r:${toB64(raw)}`;
}
async function decodeSignal(code, expectType) {
  const m = String(code).trim().match(/^VR1:([oa]):([zr]):([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('format');
  if (m[1] !== expectType) throw new Error('type');
  let bytes = fromB64(m[3]);
  if (m[2] === 'z') bytes = await streamBytes(bytes, new DecompressionStream('deflate-raw'));
  return new TextDecoder().decode(bytes);
}

function renderQR(el, text) {
  const qr = qrcode(0, 'L');
  qr.addData(text, 'Byte');
  qr.make();
  el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
}
async function shareCode(code) {
  try {
    if (navigator.share) { await navigator.share({ text: code }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(code); alert('コードをコピーしました'); }
  catch (_) { prompt('このコードをコピーしてください', code); }
}

// ---------------------------------------------------------------- QR読み取り
const scanner = { stream: null, timer: 0, facing: 'environment', video: null, onCode: null, busy: false };

async function startScanner(videoEl, onCode, facing) {
  stopScanner();
  scanner.facing = facing || scanner.facing;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: scanner.facing, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  Object.assign(scanner, { stream, video: videoEl, onCode, busy: false });
  videoEl.srcObject = stream;
  videoEl.muted = true;
  videoEl.setAttribute('playsinline', '');
  await videoEl.play().catch(() => {});
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tick = async () => {
    if (!scanner.stream) return;
    if (!scanner.busy && videoEl.readyState >= 2 && videoEl.videoWidth) {
      const w = videoEl.videoWidth, h = videoEl.videoHeight;
      const k = Math.min(1, 1000 / Math.max(w, h));
      canvas.width = Math.round(w * k);
      canvas.height = Math.round(h * k);
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (res && res.data && res.data.startsWith(PREFIX + ':')) {
        scanner.busy = true;
        let accepted = false;
        try { accepted = await scanner.onCode(res.data); } catch (_) { accepted = false; }
        scanner.busy = false;
        if (accepted) { stopScanner(); return; }
      }
    }
    scanner.timer = setTimeout(tick, 150);
  };
  tick();
}
function stopScanner() {
  clearTimeout(scanner.timer);
  if (scanner.stream) scanner.stream.getTracks().forEach((t) => t.stop());
  if (scanner.video) scanner.video.srcObject = null;
  scanner.stream = null;
}
async function flipScanner() {
  if (!scanner.stream || !scanner.video) return;
  const next = scanner.facing === 'environment' ? 'user' : 'environment';
  try { await startScanner(scanner.video, scanner.onCode, next); } catch (_) {}
}

// ---------------------------------------------------------------- WebRTC
const peer = { pc: null, dc: null, connected: false, role: null, dropTimer: 0 };

function closePeer() {
  clearTimeout(peer.dropTimer);
  try { peer.dc && peer.dc.close(); } catch (_) {}
  try { peer.pc && peer.pc.close(); } catch (_) {}
  peer.pc = null; peer.dc = null; peer.connected = false;
}
function newPeer(role) {
  closePeer();
  peer.role = role;
  // オフラインで使うため STUN/TURN は使わない（同じネットワーク内の直接接続のみ）
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.addEventListener('connectionstatechange', () => {
    const st = pc.connectionState;
    if (pc !== peer.pc) return;
    clearTimeout(peer.dropTimer);
    if (st === 'failed' || st === 'closed') onLost();
    else if (st === 'disconnected') peer.dropTimer = setTimeout(onLost, 4000);
  });
  peer.pc = pc;
  return pc;
}
function attachChannel(dc) {
  peer.dc = dc;
  dc.addEventListener('open', () => {
    peer.connected = true;
    keepAwake();
    if (peer.role === 'player') playerConnected(); else remoteConnected();
  });
  dc.addEventListener('close', () => { if (dc === peer.dc) onLost(); });
  dc.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (peer.role === 'player') handleCommand(msg); else handleState(msg);
  });
}
function waitIce(pc, ms = 3000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    });
  });
}
function send(msg) {
  if (peer.dc && peer.dc.readyState === 'open') peer.dc.send(JSON.stringify(msg));
}
function onLost() {
  if (!peer.connected) return;
  peer.connected = false;
  if (peer.role === 'player') playerLost(); else remoteLost();
}
function cameraError(el, err) {
  const msg = err && err.name === 'NotAllowedError'
    ? 'カメラの使用が許可されていません。「設定」でカメラを許可するか、「カメラを使わずに接続する」を使ってください。'
    : 'カメラを起動できませんでした。「カメラを使わずに接続する」を使ってください。';
  setStatus(el, msg, 'err');
}

// ================================================================ 再生側
const pv = $('#pv');
let fileName = '';
let objectUrl = null;
let stateTimer = 0;
let needsTap = false;
let pairTimeout = 0;

$('#go-player').addEventListener('click', () => show('player-setup'));

$('#file-input').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(f);
  fileName = f.name;
  pv.src = objectUrl;
  pv.load();
  $('#file-label').textContent = f.name;
  $('.file-pick').classList.add('has-file');
  $('#player-next').disabled = false;
});

$('#player-next').addEventListener('click', () => {
  // ユーザー操作の中で一度再生しておくと、後からリモコンで play() できるようになる
  pv.muted = false;
  const p = pv.play();
  if (p) p.then(() => { pv.pause(); pv.currentTime = 0; }).catch(() => {});
  startPlayerPairing();
});

async function startPlayerPairing() {
  show('pair-player');
  const st = $('#pp-status');
  setStatus(st, '');
  $('#pp-qr').innerHTML = '<p class="hint">コードを作成しています…</p>';
  $('#pp-paste').value = '';

  // カメラを先に起動（許可を得てから接続情報を作ると、ローカル接続が安定しやすい）
  try { await startScanner($('#pp-cam'), acceptAnswer, 'environment'); }
  catch (err) { cameraError(st, err); }

  const pc = newPeer('player');
  attachChannel(pc.createDataChannel('ctl', { ordered: true }));
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await waitIce(pc);
    const code = await encodeSignal('o', pc.localDescription.sdp);
    renderQR($('#pp-qr'), code);
    $('#pp-share').onclick = () => shareCode(code);
  } catch (err) {
    setStatus(st, 'コードを作成できませんでした。ページを再読み込みしてください。', 'err');
  }
}

async function acceptAnswer(code) {
  const st = $('#pp-status');
  let sdp;
  try { sdp = await decodeSignal(code, 'a'); }
  catch (e) {
    if (e.message === 'type') setStatus(st, 'これはiPad側のコードです。iPhoneに表示されたコードを映してください。', 'err');
    return false;
  }
  if (!peer.pc || peer.pc.signalingState !== 'have-local-offer') return false;
  try {
    await peer.pc.setRemoteDescription({ type: 'answer', sdp });
  } catch (_) {
    setStatus(st, 'コードを読み取れませんでした。iPhone側で接続をやり直してください。', 'err');
    return false;
  }
  setStatus(st, '接続しています…');
  clearTimeout(pairTimeout);
  pairTimeout = setTimeout(() => {
    if (!peer.connected) setStatus(st, '接続できませんでした。2台が同じネットワーク（インターネット共有など）につながっているか確認して、やり直してください。', 'err');
  }, 15000);
  return true;
}
$('#pp-paste-go').addEventListener('click', async () => {
  if (await acceptAnswer($('#pp-paste').value)) stopScanner();
  else if (!$('#pp-status').textContent) setStatus($('#pp-status'), 'コードの形式が正しくありません。', 'err');
});
$('#pp-flip').addEventListener('click', flipScanner);
$('#pp-back').addEventListener('click', () => {
  stopScanner();
  closePeer();
  show(pv.src ? 'player-setup' : 'home');
});

function playerConnected() {
  clearTimeout(pairTimeout);
  stopScanner();
  show('player-stage');
  closeStageMenu();
  clearInterval(stateTimer);
  stateTimer = setInterval(sendState, 250);
  sendState();
}
function playerLost() {
  clearInterval(stateTimer);
  // 観客に見える画面には何も出さない。長押しメニューから接続し直す。
}

function sendState() {
  send({
    t: 'state',
    cur: pv.currentTime || 0,
    dur: isFinite(pv.duration) ? pv.duration : 0,
    paused: pv.paused,
    ended: pv.ended,
    rate: pv.playbackRate,
    muted: pv.muted,
    loop: pv.loop,
    black: $('#blackout').classList.contains('on'),
    name: fileName,
    needsTap,
  });
}
['play', 'pause', 'seeked', 'ratechange', 'loadedmetadata', 'ended', 'volumechange'].forEach((ev) =>
  pv.addEventListener(ev, () => { if (peer.connected && peer.role === 'player') sendState(); }));

function playVideo() {
  const p = pv.play();
  if (p) p.then(() => { needsTap = false; sendState(); }).catch((err) => {
    if (err && err.name === 'NotAllowedError') { needsTap = true; sendState(); }
  });
}
function seekTo(t, fast) {
  const dur = isFinite(pv.duration) ? pv.duration : Infinity;
  t = Math.max(0, Math.min(t, dur));
  if (fast && typeof pv.fastSeek === 'function') pv.fastSeek(t);
  else pv.currentTime = t;
}
function handleCommand(m) {
  switch (m.t) {
    case 'play': playVideo(); break;
    case 'pause': pv.pause(); break;
    case 'seek': seekTo(Number(m.time) || 0, !!m.fast); break;
    case 'step': seekTo(pv.currentTime + (Number(m.d) || 0), false); break;
    case 'rate': pv.playbackRate = Number(m.v) || 1; break;
    case 'black': $('#blackout').classList.toggle('on', !!m.on); sendState(); break;
    case 'mute': pv.muted = !!m.on; break;
    case 'loop': pv.loop = !!m.on; sendState(); break;
    case 'hello': sendState(); break;
  }
}

// 長押しでメニュー（観客側には普段なにも表示しない）
const stage = $('#player-stage');
let pressTimer = 0, pressX = 0, pressY = 0;
stage.addEventListener('pointerdown', (e) => {
  if (!$('#stage-menu').hidden) return;
  // 自動再生がブロックされた場合、画面を1回タップすれば再生できる
  if (needsTap) playVideo();
  pressX = e.clientX; pressY = e.clientY;
  clearTimeout(pressTimer);
  pressTimer = setTimeout(openStageMenu, 1500);
});
stage.addEventListener('pointermove', (e) => {
  if (Math.hypot(e.clientX - pressX, e.clientY - pressY) > 12) clearTimeout(pressTimer);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
  stage.addEventListener(ev, () => clearTimeout(pressTimer)));
stage.addEventListener('contextmenu', (e) => e.preventDefault());

function openStageMenu() {
  $('#menu-status').textContent = peer.connected ? 'iPhoneと接続中' : 'iPhoneとの接続が切れています';
  $('#stage-menu').hidden = false;
}
function closeStageMenu() { $('#stage-menu').hidden = true; }
$('#m-close').addEventListener('click', closeStageMenu);
$('#m-reconnect').addEventListener('click', () => { closeStageMenu(); pv.pause(); startPlayerPairing(); });
$('#m-change').addEventListener('click', () => {
  closeStageMenu(); pv.pause(); closePeer(); clearInterval(stateTimer);
  $('#file-input').value = '';
  show('player-setup');
});
$('#m-home').addEventListener('click', () => {
  closeStageMenu(); pv.pause(); closePeer(); clearInterval(stateTimer);
  show('home');
});

// ================================================================ リモコン側
let dragging = false;
let lastState = null;
let lastFastSeek = 0;

$('#go-remote').addEventListener('click', startRemotePairing);

async function startRemotePairing() {
  closePeer();
  show('remote-pair');
  $('#rp-step1').hidden = false;
  $('#rp-step2').hidden = true;
  $('#rp-paste').value = '';
  const st = $('#rp-status');
  setStatus(st, '');
  try { await startScanner($('#rp-cam'), acceptOffer, 'environment'); }
  catch (err) { cameraError(st, err); }
}

async function acceptOffer(code) {
  const st = $('#rp-status');
  let sdp;
  try { sdp = await decodeSignal(code, 'o'); }
  catch (e) {
    if (e.message === 'type') setStatus(st, 'これはiPhone側のコードです。iPadに表示されたコードを読み取ってください。', 'err');
    return false;
  }
  const pc = newPeer('remote');
  pc.addEventListener('datachannel', (e) => attachChannel(e.channel));
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIce(pc);
    const answer = await encodeSignal('a', pc.localDescription.sdp);
    stopScanner();
    renderQR($('#rp-qr'), answer);
    $('#rp-share').onclick = () => shareCode(answer);
    $('#rp-step1').hidden = true;
    $('#rp-step2').hidden = false;
    setStatus(st, 'iPadが読み取ると自動で接続します');
    return true;
  } catch (_) {
    setStatus(st, 'コードを読み取れませんでした。iPad側で接続をやり直してください。', 'err');
    return false;
  }
}
$('#rp-paste-go').addEventListener('click', async () => {
  if (!(await acceptOffer($('#rp-paste').value)) && !$('#rp-status').textContent)
    setStatus($('#rp-status'), 'コードの形式が正しくありません。', 'err');
});
$('#rp-flip').addEventListener('click', flipScanner);
$('#rp-back').addEventListener('click', () => { stopScanner(); closePeer(); show('home'); });

function remoteConnected() {
  show('remote-ui');
  $('#remote-menu').hidden = true;
  $('#r-tally').className = 'tally live';
  $('#r-warn').hidden = true;
  send({ t: 'hello' });
}
function remoteLost() {
  $('#r-tally').className = 'tally lost';
  const w = $('#r-warn');
  w.textContent = 'iPadとの接続が切れました。右上の「接続」から接続し直してください（iPad側は画面を長押し）。';
  w.hidden = false;
}

const seek = $('#r-seek');
function paintSeek() {
  const max = Number(seek.max) || 0;
  const pct = max ? (Number(seek.value) / max) * 100 : 0;
  seek.style.setProperty('--pct', pct + '%');
}
function handleState(s) {
  if (s.t !== 'state') return;
  lastState = s;
  $('#r-name').textContent = s.name || '再生中の動画';
  $('#r-dur').textContent = fmt(s.dur);
  if (Number(seek.max) !== s.dur) seek.max = s.dur;
  if (!dragging) {
    seek.value = s.cur;
    $('#r-cur').textContent = fmt(s.cur);
    paintSeek();
  }
  const play = $('#r-play');
  play.textContent = s.paused ? '▶' : '❚❚';
  play.setAttribute('aria-label', s.paused ? '再生' : '一時停止');
  $('#r-black').setAttribute('aria-pressed', String(!!s.black));
  $('#r-mute').setAttribute('aria-pressed', String(!!s.muted));
  $('#r-loop').setAttribute('aria-pressed', String(!!s.loop));
  $$('.rates button').forEach((b) =>
    b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === s.rate)));
  const w = $('#r-warn');
  if (s.needsTap) {
    w.textContent = 'iPadが自動再生を止めています。iPadの画面を1回タップしてください。';
    w.hidden = false;
  } else if (peer.connected) {
    w.hidden = true;
  }
}

// スライダー：ドラッグ中は大まかに、離した位置へ正確にシーク
seek.addEventListener('pointerdown', () => { dragging = true; });
seek.addEventListener('input', () => {
  dragging = true;
  const t = Number(seek.value);
  $('#r-cur').textContent = fmt(t);
  paintSeek();
  const now = performance.now();
  if (now - lastFastSeek > 120) { lastFastSeek = now; send({ t: 'seek', time: t, fast: true }); }
});
seek.addEventListener('change', () => {
  send({ t: 'seek', time: Number(seek.value), fast: false });
  setTimeout(() => { dragging = false; }, 400);
});
['pointerup', 'pointercancel'].forEach((ev) => seek.addEventListener(ev, () => {
  setTimeout(() => { dragging = false; }, 400);
}));

$('#r-play').addEventListener('click', () => {
  send({ t: lastState && !lastState.paused ? 'pause' : 'play' });
});
$$('[data-step]').forEach((b) => b.addEventListener('click', () =>
  send({ t: 'step', d: Number(b.dataset.step) })));
$('#r-start').addEventListener('click', () => send({ t: 'seek', time: 0 }));
$('#r-jump-go').addEventListener('click', () => {
  const t = parseTime($('#r-jump').value);
  if (isNaN(t)) { $('#r-jump').focus(); return; }
  send({ t: 'seek', time: t });
  $('#r-jump').blur();
});
$('#r-jump').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#r-jump-go').click(); });
$('#r-black').addEventListener('click', () => send({ t: 'black', on: !(lastState && lastState.black) }));
$('#r-mute').addEventListener('click', () => send({ t: 'mute', on: !(lastState && lastState.muted) }));
$('#r-loop').addEventListener('click', () => send({ t: 'loop', on: !(lastState && lastState.loop) }));
$$('[data-rate]').forEach((b) => b.addEventListener('click', () =>
  send({ t: 'rate', v: Number(b.dataset.rate) })));

$('#r-menu').addEventListener('click', () => {
  $('#rmenu-status').textContent = peer.connected ? 'iPadと接続中' : 'iPadとの接続が切れています';
  $('#remote-menu').hidden = false;
});
$('#rm-close').addEventListener('click', () => { $('#remote-menu').hidden = true; });
$('#rm-reconnect').addEventListener('click', () => { $('#remote-menu').hidden = true; startRemotePairing(); });
$('#rm-home').addEventListener('click', () => { $('#remote-menu').hidden = true; closePeer(); show('home'); });

// ================================================================ オフライン対応
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => {
      $('#offline-status').textContent = 'オフラインでも使える状態になっています。';
    }).catch(() => {});
  });
}
window.addEventListener('pagehide', closePeer);
