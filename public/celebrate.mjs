// Feiring når noen krysser av: en liten fest for hvert punkt, og full fest når hele lista (uka) er i boks.
// Ingen eksterne biblioteker: egen konfettimotor på canvas og egne lyder med WebAudio. Ligger i nettleserens «top layer»
// (popover), så den vises også over åpne dialoger. Respekterer «reduser bevegelse».

const FESTIVE = ['#ff5d73', '#ffb627', '#2ec4b6', '#5b8def', '#9b5de5', '#f15bb5', '#00bb7f', '#ffe14d'];
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const fill = (text, name) => text.replaceAll('{navn}', name || 'dere');

const STYLE = `
.cel-layer{position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;overflow:hidden;pointer-events:none;z-index:2147483000;color:#fff}
.cel-layer canvas{position:absolute;inset:0;width:100%;height:100%;z-index:2;pointer-events:none}
.cel-bubble{position:absolute;z-index:3;transform:translate(-50%,-100%);display:flex;align-items:baseline;gap:10px;padding:12px 22px;border-radius:999px;background:var(--cel-color,#2b7a4b);color:#fff;font:800 30px/1 system-ui,sans-serif;box-shadow:0 10px 30px #0005;white-space:nowrap;animation:cel-float 1.6s cubic-bezier(.2,.9,.3,1.2) forwards}
.cel-bubble span{font-size:20px;font-weight:700;opacity:.85}
.cel-finale{position:absolute;inset:0;z-index:1;display:grid;place-items:center;overflow:hidden;pointer-events:auto;cursor:pointer;background:radial-gradient(circle at 50% 45%,color-mix(in srgb,var(--cel-color) 60%,#000) 0%,rgba(8,10,20,.9) 72%);animation:cel-fade .35s ease-out}
.cel-finale.is-leaving{animation:cel-out .45s ease-in forwards}
.cel-rays{position:absolute;width:220vmax;height:220vmax;left:50%;top:45%;transform:translate(-50%,-50%);background:repeating-conic-gradient(from 0deg,rgba(255,255,255,.1) 0deg 9deg,transparent 9deg 18deg);-webkit-mask-image:radial-gradient(circle,#000 0 25%,transparent 55%);mask-image:radial-gradient(circle,#000 0 25%,transparent 55%);animation:cel-spin 16s linear infinite}
.cel-card{position:relative;text-align:center;padding:20px 40px;animation:cel-zoom .75s cubic-bezier(.2,1.5,.4,1) both}
.cel-trophy{font-size:min(28vh,240px);line-height:1;filter:drop-shadow(0 18px 40px rgba(0,0,0,.45));animation:cel-bounce 1.2s ease-in-out .7s infinite}
.cel-card h2{margin:14px 0 8px;font:900 min(9vw,100px)/1.02 system-ui,sans-serif;letter-spacing:-.02em;color:#fff7ad;background:linear-gradient(90deg,#fff7ad,#ffa9f9,#9bf6ff,#b9fbc0,#fff7ad);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:cel-shine 3s linear infinite}
.cel-sub{margin:0;font:800 min(4.5vw,42px)/1.2 system-ui,sans-serif}
.cel-hype{margin:14px 0 0;font:500 min(3.6vw,30px)/1.3 system-ui,sans-serif;opacity:.92}
.cel-hint{margin:30px 0 0;font:500 18px system-ui,sans-serif;opacity:.5}
.cel-pop{animation:cel-pop .55s cubic-bezier(.2,1.6,.4,1)}
@keyframes cel-float{0%{opacity:0;transform:translate(-50%,-60%) scale(.4)}15%{opacity:1;transform:translate(-50%,-115%) scale(1.18)}30%{transform:translate(-50%,-125%) scale(1)}80%{opacity:1}100%{opacity:0;transform:translate(-50%,-230%) scale(.95)}}
@keyframes cel-fade{from{opacity:0}}
@keyframes cel-out{to{opacity:0;transform:scale(1.04)}}
@keyframes cel-spin{to{transform:translate(-50%,-50%) rotate(360deg)}}
@keyframes cel-zoom{0%{opacity:0;transform:scale(.3) rotate(-8deg)}60%{opacity:1;transform:scale(1.08) rotate(2deg)}100%{transform:none}}
@keyframes cel-bounce{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-18px) rotate(4deg)}}
@keyframes cel-shine{to{background-position:300% 0}}
@keyframes cel-pop{0%{transform:scale(1)}35%{transform:scale(1.06);background:color-mix(in srgb,#00bb7f 22%,transparent)}100%{transform:scale(1)}}
@media (prefers-reduced-motion:reduce){.cel-finale,.cel-card,.cel-trophy,.cel-rays,.cel-card h2,.cel-pop{animation:none!important}}
`;
function ensureStyles() {
  if (document.getElementById('cel-style')) return;
  const style = document.createElement('style'); style.id = 'cel-style'; style.textContent = STYLE; document.head.append(style);
}

// ---- Lyd ----
let audio = null;
export function soundOn() { try { return localStorage.getItem('familien-lyd') !== 'av'; } catch { return true; } }
export function setSound(on) { try { localStorage.setItem('familien-lyd', on ? 'på' : 'av'); } catch {} }
function context() {
  if (!soundOn()) return null;
  try { audio ??= new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); return audio; } catch { return null; }
}
function note(ctx, frequency, start, length, { type = 'triangle', volume = 0.18 } = {}) {
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = type; osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start); osc.stop(start + length + 0.05);
}
// Pentatonisk trapp: hvert nytt punkt klinger litt høyere, så man hører at man nærmer seg mål.
const SCALE = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98, 1760];
function tickSound(done, total) {
  const ctx = context(); if (!ctx) return;
  const step = Math.min(SCALE.length - 2, Math.round((done / Math.max(1, total)) * (SCALE.length - 2)));
  const t = ctx.currentTime;
  note(ctx, SCALE[step], t, 0.18);
  note(ctx, SCALE[step + 1], t + 0.08, 0.32);
  note(ctx, SCALE[step + 1] * 2, t + 0.08, 0.25, { type: 'sine', volume: 0.05 });
}
function fanfare() {
  const ctx = context(); if (!ctx) return;
  const t = ctx.currentTime;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(ctx, f, t + i * 0.11, 0.35, { type: 'square', volume: 0.07 }));
  [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((f) => note(ctx, f, t + 0.5, 1.6, { type: 'triangle', volume: 0.09 }));
  for (let i = 0; i < 14; i++) note(ctx, 1800 + Math.random() * 2400, t + 0.6 + Math.random() * 2.2, 0.12, { type: 'sine', volume: 0.04 });
}

// ---- Konfetti ----
let layer = null, canvas = null, ctx2d = null, particles = [], running = false;
function ensureLayer() {
  ensureStyles();
  if (layer?.isConnected) return;
  layer = document.createElement('div');
  layer.className = 'cel-layer';
  layer.setAttribute('popover', 'manual');
  canvas = document.createElement('canvas');
  layer.append(canvas);
  document.body.append(layer);
  ctx2d = canvas.getContext('2d');
}
function show(el) { try { if (el.matches(':popover-open')) el.hidePopover(); el.showPopover(); } catch { /* eldre nettleser: vises som vanlig fast element */ } }
function resize() { canvas.width = innerWidth; canvas.height = innerHeight; }
function spawn({ x, y, count, spread = Math.PI / 2.2, angle = -Math.PI / 2, speed = [7, 16], colors = FESTIVE, size = [7, 14], gravity = 0.35, emoji = null }) {
  for (let i = 0; i < count; i++) {
    const a = angle + (Math.random() - 0.5) * spread, v = speed[0] + Math.random() * (speed[1] - speed[0]);
    particles.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, gravity,
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
      size: size[0] + Math.random() * (size[1] - size[0]), color: pick(colors),
      shape: emoji ? 'emoji' : pick(['rect', 'rect', 'circle', 'ribbon']), emoji, life: 1, decay: 0.004 + Math.random() * 0.006, wobble: Math.random() * 10
    });
  }
  if (!running) { running = true; requestAnimationFrame(frame); }
}
function frame() {
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  particles = particles.filter((p) => p.life > 0 && p.y < canvas.height + 60);
  for (const p of particles) {
    p.vx *= 0.985; p.vy = p.vy * 0.985 + p.gravity; p.x += p.vx + Math.sin((p.wobble += 0.1)) * 0.6; p.y += p.vy; p.rot += p.vr; p.life -= p.decay;
    ctx2d.save(); ctx2d.globalAlpha = Math.max(0, Math.min(1, p.life * 1.6)); ctx2d.translate(p.x, p.y); ctx2d.rotate(p.rot);
    if (p.shape === 'emoji') { ctx2d.font = `${p.size * 2.4}px system-ui, "Noto Color Emoji", sans-serif`; ctx2d.fillText(p.emoji, -p.size, p.size); }
    else { ctx2d.fillStyle = p.color;
      if (p.shape === 'circle') { ctx2d.beginPath(); ctx2d.arc(0, 0, p.size / 2.2, 0, Math.PI * 2); ctx2d.fill(); }
      else if (p.shape === 'ribbon') ctx2d.fillRect(-p.size, -p.size / 6, p.size * 2, p.size / 3);
      else ctx2d.fillRect(-p.size / 2, -p.size / 3, p.size, p.size / 1.5 * Math.abs(Math.cos(p.rot * 2)) + 2); }
    ctx2d.restore();
  }
  if (particles.length) requestAnimationFrame(frame);
  else { running = false; ctx2d.clearRect(0, 0, canvas.width, canvas.height); try { if (!document.querySelector('.cel-finale')) layer.hidePopover(); } catch {} }
}
function firework(x, y, colors) {
  spawn({ x, y, count: 70, spread: Math.PI * 2, angle: 0, speed: [3, 11], colors, size: [5, 9], gravity: 0.12 });
}

// ---- Liten fest: ett punkt krysset av ----
const TICK_LINES = ['Yes!', 'Boom! 💥', 'Én mindre!', 'Rått, {navn}!', 'Sånn ja!', 'Kjempebra!', 'Pang! ⚡', 'Du er i siget!', 'Lekseløve 🦁', 'Nice! 😎', 'Fy søren!', 'Rakett 🚀'];
const TICK_EMOJI = ['⭐', '🌟', '✨', '💪', '🔥', '🎯', '⚡', '🙌'];
export function celebrateTick({ x = innerWidth / 2, y = innerHeight / 2, done, total, name = '', color } = {}) {
  tickSound(done, total);
  if (reduced()) return;
  ensureLayer(); resize(); show(layer);
  const colors = color ? [color, ...FESTIVE] : FESTIVE;
  spawn({ x, y, count: 55, speed: [6, 15], colors });
  spawn({ x, y, count: 3, speed: [5, 10], emoji: pick(TICK_EMOJI), size: [10, 14], gravity: 0.25 });
  const left = total - done;
  const text = left === 0 ? 'Ferdig! ✅' : left === 1 ? 'Bare én igjen! 🔥' : done === Math.ceil(total / 2) && total > 3 ? 'Halvveis! 🚀' : fill(pick(TICK_LINES), name);
  const bubble = document.createElement('div');
  bubble.className = 'cel-bubble';
  bubble.style.left = `${Math.min(innerWidth - 160, Math.max(160, x))}px`; bubble.style.top = `${Math.max(90, y - 30)}px`;
  if (color) bubble.style.setProperty('--cel-color', color);
  bubble.append(Object.assign(document.createElement('strong'), { textContent: text }), Object.assign(document.createElement('span'), { textContent: `${done}/${total}` }));
  layer.append(bubble);
  setTimeout(() => bubble.remove(), 1600);
}

// ---- Stor fest: alt gjort ----
const HYPE = ['Du er en maskin.', 'Legendarisk innsats!', 'Høy fem! ✋', 'Ukas helt!', 'Ingen lekser kan stoppe deg.', 'Det der var proff-nivå.', 'Fortjent pause! 🛋️', 'Hjernen din er på steroider (de lovlige).'];
export function celebrateComplete({ name = '', total = 0, color = '#5b8def', homework = true, title = '' } = {}) {
  fanfare();
  ensureLayer(); resize();
  layer.querySelector('.cel-finale')?.remove();
  const finale = document.createElement('div');
  finale.className = 'cel-finale';
  finale.style.setProperty('--cel-color', color);
  const headline = homework ? (name ? `Uka er i boks, ${name}!` : 'Uka er i boks!') : 'Alt er gjort!';
  const sub = homework ? `Alle ${total} lekser fullført` : `${title}${title ? ' – ' : ''}${total} av ${total} punkter`;
  finale.innerHTML = '<div class="cel-rays"></div><div class="cel-card"><div class="cel-trophy">🏆</div><h2></h2><p class="cel-sub"></p><p class="cel-hype"></p><p class="cel-hint">Trykk for å lukke</p></div>';
  finale.querySelector('h2').textContent = headline;
  finale.querySelector('.cel-sub').textContent = `${sub} 🎉`;
  finale.querySelector('.cel-hype').textContent = pick(HYPE);
  layer.append(finale);
  show(layer);
  let closed = false;
  const close = () => { if (closed) return; closed = true; finale.classList.add('is-leaving'); setTimeout(() => { finale.remove(); if (!particles.length) try { layer.hidePopover(); } catch {} }, 450); };
  finale.addEventListener('pointerdown', close);
  setTimeout(close, reduced() ? 4000 : 9000);
  if (reduced()) return close;
  const colors = [color, ...FESTIVE];
  // Konfettikanoner fra begge hjørner i tre bølger, fyrverkeri på himmelen og et regn av emojier.
  for (const [delay, power] of [[0, 1], [550, 0.85], [1150, 0.7]]) {
    setTimeout(() => {
      spawn({ x: 0, y: innerHeight, count: 140, angle: -Math.PI / 3.2, spread: Math.PI / 4, speed: [16 * power, 30 * power], colors, size: [8, 16] });
      spawn({ x: innerWidth, y: innerHeight, count: 140, angle: -Math.PI + Math.PI / 3.2, spread: Math.PI / 4, speed: [16 * power, 30 * power], colors, size: [8, 16] });
    }, delay);
  }
  for (let i = 0; i < 7; i++) setTimeout(() => firework(innerWidth * (0.15 + Math.random() * 0.7), innerHeight * (0.12 + Math.random() * 0.35), colors), 700 + i * 520);
  for (let i = 0; i < 5; i++) setTimeout(() => spawn({ x: Math.random() * innerWidth, y: -30, count: 4, angle: Math.PI / 2, spread: 0.6, speed: [2, 5], emoji: pick(['🎉', '⭐', '🏆', '🥳', '🎊', '💯']), size: [14, 22], gravity: 0.12 }), 400 + i * 600);
  return close;
}

// Liten sprett på raden som ble krysset av.
export function pop(element) { ensureStyles(); if (!element || reduced()) return; element.classList.remove('cel-pop'); void element.offsetWidth; element.classList.add('cel-pop'); }

// Avgjør hvilken fest en avkryssing skal gi. `items` er punktene før endringen.
export function celebrationFor({ items, key, checked }) {
  if (!checked) return null;
  const total = items.length;
  const done = items.filter((item) => item.key === key || item.doneAt).length;
  return { done, total, complete: total > 0 && done === total };
}
