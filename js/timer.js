// Minuteur de repos + chronomètre.
// Les deux tournent indépendamment de l'affichage : on peut fermer le panneau,
// une pastille flottante garde le temps visible.

const RING_R = 108;
const RING_C = 2 * Math.PI * RING_R;
const PRESETS = [30, 60, 90, 120, 180];

const rest = { total: 0, endAt: 0, remaining: 0, running: false, done: false, label: "" };
const watch = { startAt: 0, elapsed: 0, running: false, laps: [] };

let mode = "rest";
let isOpen = false;
let tickHandle = null;
let audioCtx = null;
let wakeLock = null;
let root, panel, pill;

/* ---------- Utilitaires ---------- */

function fmt(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtWatch(ms, tenths = true) {
  const total = Math.max(0, ms);
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const d = Math.floor((total % 1000) / 100);
  const base = h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return tenths ? `${base}<small>,${d}</small>` : base;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function restRemaining() {
  if (rest.running) return Math.max(0, (rest.endAt - Date.now()) / 1000);
  return rest.remaining;
}

function watchElapsed() {
  return watch.running ? watch.elapsed + (Date.now() - watch.startAt) : watch.elapsed;
}

/* ---------- Son, vibration, écran allumé ---------- */

function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch { /* son indisponible */ }
}

function beep(count = 3) {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  for (let i = 0; i < count; i++) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const t = now + i * 0.32;
    osc.type = "sine";
    osc.frequency.value = i === count - 1 ? 1175 : 880;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (i === count - 1 ? 0.45 : 0.18));
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.5);
  }
}

async function syncWakeLock() {
  const needed = rest.running || watch.running;
  try {
    if (needed && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!needed && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* non supporté ou refusé */ }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    wakeLock = null;
    syncWakeLock();
    tick();
  }
});

/* ---------- Boucle ---------- */

function ensureTicking() {
  const needed = rest.running || watch.running;
  if (needed && !tickHandle) tickHandle = setInterval(tick, 100);
  if (!needed && tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  syncWakeLock();
}

function tick() {
  if (rest.running && Date.now() >= rest.endAt) finishRest();
  updateDisplay();
  ensureTicking();
}

function finishRest() {
  rest.running = false;
  rest.remaining = 0;
  rest.done = true;
  beep(3);
  try { navigator.vibrate?.([300, 120, 300, 120, 500]); } catch { /* ignore */ }
  render();
}

/* ---------- Actions repos ---------- */

function startRest(seconds, label = "") {
  unlockAudio();
  rest.total = seconds;
  rest.remaining = seconds;
  rest.endAt = Date.now() + seconds * 1000;
  rest.running = seconds > 0;
  rest.done = false;
  rest.label = label;
  ensureTicking();
}

function toggleRest() {
  unlockAudio();
  if (rest.done || rest.total === 0) return;
  if (rest.running) {
    rest.remaining = restRemaining();
    rest.running = false;
  } else {
    rest.endAt = Date.now() + rest.remaining * 1000;
    rest.running = true;
  }
  ensureTicking();
  render();
}

function adjustRest(delta) {
  if (rest.total === 0 && !rest.done) return;
  const next = Math.max(0, restRemaining() + delta);
  if (rest.done) {
    if (delta <= 0) return;
    startRest(delta, rest.label);
    render();
    return;
  }
  rest.total = Math.max(rest.total + delta, next, 1);
  if (rest.running) rest.endAt = Date.now() + next * 1000;
  else rest.remaining = next;
  if (next === 0) finishRest();
  updateDisplay();
}

function clearRest() {
  rest.total = 0;
  rest.remaining = 0;
  rest.running = false;
  rest.done = false;
  rest.label = "";
  ensureTicking();
  render();
}

/* ---------- Actions chrono ---------- */

function toggleWatch() {
  if (watch.running) {
    watch.elapsed = watchElapsed();
    watch.running = false;
  } else {
    watch.startAt = Date.now();
    watch.running = true;
  }
  ensureTicking();
  render();
}

function lapWatch() {
  if (!watch.running && watch.elapsed === 0) return;
  watch.laps.unshift(watchElapsed());
  render();
}

function resetWatch() {
  watch.running = false;
  watch.elapsed = 0;
  watch.laps = [];
  ensureTicking();
  render();
}

/* ---------- Rendu ---------- */

function mount() {
  if (root) return;
  root = document.getElementById("timer-root");
  root.innerHTML = `
    <div class="timer-backdrop" data-t="backdrop"></div>
    <section class="timer-panel" role="dialog" aria-modal="true" aria-label="Chrono et minuteur"></section>
    <button class="timer-pill" type="button" aria-label="Ouvrir le chrono"></button>
  `;
  panel = root.querySelector(".timer-panel");
  pill = root.querySelector(".timer-pill");
  root.querySelector('[data-t="backdrop"]').addEventListener("click", close);
  pill.addEventListener("click", () => {
    if (rest.done && !watch.running) mode = "rest";
    open();
  });
  panel.addEventListener("click", onPanelClick);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && isOpen) { e.stopImmediatePropagation(); close(); }
  }, true);
}

function onPanelClick(e) {
  const btn = e.target.closest("[data-t]");
  if (!btn) return;
  const a = btn.dataset.t;
  if (a === "close") close();
  else if (a === "mode") { mode = btn.dataset.mode; render(); }
  else if (a === "preset") { startRest(+btn.dataset.sec, ""); render(); }
  else if (a === "rest-toggle") toggleRest();
  else if (a === "rest-minus") adjustRest(-15);
  else if (a === "rest-plus") adjustRest(15);
  else if (a === "rest-clear") clearRest();
  else if (a === "watch-toggle") toggleWatch();
  else if (a === "watch-lap") lapWatch();
  else if (a === "watch-reset") resetWatch();
}

function render() {
  mount();
  root.classList.toggle("is-open", isOpen);
  document.body.classList.toggle("timer-open", isOpen);

  const restActive = rest.total > 0 || rest.done;
  const tabs = `
    <div class="timer-tabs" role="tablist">
      <button type="button" role="tab" data-t="mode" data-mode="rest" aria-selected="${mode === "rest"}">Repos</button>
      <button type="button" role="tab" data-t="mode" data-mode="watch" aria-selected="${mode === "watch"}">Chrono</button>
    </div>`;

  let body = "";
  if (mode === "rest") {
    if (!restActive) {
      body = `
        <div class="timer-empty">
          <p class="timer-hint">Lance un temps de repos</p>
          <div class="preset-grid">
            ${PRESETS.map(s => `<button type="button" class="preset" data-t="preset" data-sec="${s}">${fmt(s)}</button>`).join("")}
          </div>
          <p class="timer-sub">Dans une séance, valide une série pour lancer automatiquement le repos prévu.</p>
        </div>`;
    } else {
      body = `
        <div class="ring-wrap ${rest.done ? "is-done" : ""}">
          <svg class="ring" viewBox="0 0 240 240" aria-hidden="true">
            <circle class="ring-track" cx="120" cy="120" r="${RING_R}"></circle>
            <circle class="ring-bar" cx="120" cy="120" r="${RING_R}" stroke-dasharray="${RING_C}" stroke-dashoffset="0"></circle>
          </svg>
          <div class="ring-center">
            <div class="ring-time" data-el="rest-time">${rest.done ? "Go" : fmt(restRemaining())}</div>
            <div class="ring-label">${rest.done ? "C’est reparti" : (escapeHtml(rest.label) || "Repos")}</div>
          </div>
        </div>
        <div class="timer-controls">
          <button type="button" class="ctrl" data-t="rest-minus" aria-label="Retirer 15 secondes">−15 s</button>
          <button type="button" class="ctrl ctrl-main" data-t="${rest.done ? "rest-clear" : "rest-toggle"}" aria-label="${rest.done ? "Terminer" : rest.running ? "Pause" : "Reprendre"}">
            <i class="fa-solid ${rest.done ? "fa-check" : rest.running ? "fa-pause" : "fa-play"}"></i>
          </button>
          <button type="button" class="ctrl" data-t="rest-plus" aria-label="Ajouter 15 secondes">+15 s</button>
        </div>
        ${rest.done ? "" : `<button type="button" class="link-btn" data-t="rest-clear">Passer le repos</button>`}`;
    }
  } else {
    body = `
      <div class="watch-display" data-el="watch-time">${fmtWatch(watchElapsed())}</div>
      <div class="timer-controls">
        <button type="button" class="ctrl" data-t="watch-reset" ${watch.running || watch.elapsed === 0 ? "disabled" : ""}>Remettre à zéro</button>
        <button type="button" class="ctrl ctrl-main" data-t="watch-toggle" aria-label="${watch.running ? "Pause" : "Démarrer"}">
          <i class="fa-solid ${watch.running ? "fa-pause" : "fa-play"}"></i>
        </button>
        <button type="button" class="ctrl" data-t="watch-lap" ${watch.running ? "" : "disabled"}>Tour</button>
      </div>
      ${watch.laps.length ? `
        <ol class="laps" reversed>
          ${watch.laps.map((t, i) => {
            const prev = watch.laps[i + 1] ?? 0;
            return `<li><span>Tour ${watch.laps.length - i}</span><span>${fmtWatch(t - prev, true)}</span><span class="lap-total">${fmtWatch(t, false)}</span></li>`;
          }).join("")}
        </ol>` : ""}`;
  }

  panel.innerHTML = `
    <div class="sheet-grip"></div>
    <header class="timer-head">
      ${tabs}
      <button type="button" class="icon-btn" data-t="close" aria-label="Fermer"><i class="fa-solid fa-chevron-down"></i></button>
    </header>
    <div class="timer-body">${body}</div>`;

  updateDisplay();
}

function updateDisplay() {
  if (!root) return;
  const r = restRemaining();

  if (panel && isOpen) {
    const restEl = panel.querySelector('[data-el="rest-time"]');
    if (restEl && !rest.done) restEl.textContent = fmt(r);
    const bar = panel.querySelector(".ring-bar");
    if (bar) {
      const ratio = rest.done ? 0 : (rest.total ? r / rest.total : 0);
      bar.style.strokeDashoffset = String(RING_C * (1 - ratio));
    }
    const wEl = panel.querySelector('[data-el="watch-time"]');
    if (wEl) wEl.innerHTML = fmtWatch(watchElapsed());
  }

  // Pastille flottante quand le panneau est fermé
  const showPill = !isOpen && (rest.running || rest.done || (rest.total > 0) || watch.running);
  pill.classList.toggle("is-visible", showPill);
  pill.classList.toggle("is-done", rest.done);
  if (showPill) {
    let html = "";
    if (rest.done) html = `<i class="fa-solid fa-bell"></i><span>Repos terminé</span>`;
    else if (rest.total > 0) html = `<i class="fa-solid fa-hourglass-half"></i><span>${fmt(r)}</span>`;
    if (watch.running) html += `<i class="fa-solid fa-stopwatch"></i><span>${fmtWatch(watchElapsed(), false)}</span>`;
    pill.innerHTML = html;
  }
}

/* ---------- API publique ---------- */

export function open(nextMode) {
  mount();
  if (nextMode) mode = nextMode;
  isOpen = true;
  render();
  panel.querySelector('[data-t="close"]')?.focus({ preventScroll: true });
}

export function close() {
  isOpen = false;
  if (rest.done) clearRest();
  render();
}

export function openRestTimer(seconds, label = "") {
  mode = "rest";
  startRest(seconds, label);
  open();
}

export function openTimer() {
  mode = (rest.total > 0 || rest.done) ? "rest" : (watch.running ? "watch" : mode);
  open();
}

export function isTimerOpen() { return isOpen; }
