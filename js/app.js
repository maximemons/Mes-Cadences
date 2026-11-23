import { auth, db, googleProvider } from "./firebase-config.js";
import { TEMPLATES } from "./templates.js";
import { openRestTimer, openTimer } from "./timer.js";
import { mountChart, mountBarChart } from "./charts.js";
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";

/* =========================================================
   Constantes
   ========================================================= */

const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const DAYS_SHORT = ["L", "M", "M", "J", "V", "S", "D"];
const DAYS_ABBR = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

const SPORT_ICONS = [
  { icon: "fa-dumbbell", label: "Musculation" },
  { icon: "fa-person-running", label: "Course" },
  { icon: "fa-person-biking", label: "Vélo" },
  { icon: "fa-person-swimming", label: "Natation" },
  { icon: "fa-person-hiking", label: "Randonnée" },
  { icon: "fa-hand-fist", label: "Sports de combat" },
  { icon: "fa-spa", label: "Yoga, mobilité" },
  { icon: "fa-heart-pulse", label: "Cardio" },
  { icon: "fa-futbol", label: "Football" },
  { icon: "fa-basketball", label: "Basket" },
  { icon: "fa-table-tennis-paddle-ball", label: "Raquette" },
  { icon: "fa-person-skiing", label: "Ski" }
];

const SPORT_COLORS = ["#3B4BDB", "#E0364F", "#12936A", "#D98A00", "#8340D6", "#0B8FAE", "#4B5568"];

const UNIT_SUGGESTIONS = ["kg", "km/h", "bpm", "W", "m", "min"];

const MAX_IMAGE_SIDE = 900;
const IMAGE_QUALITY = 0.72;

/* =========================================================
   État
   ========================================================= */

const state = {
  user: null,
  sports: [],
  sessions: [],
  measures: [],
  maxes: [],
  logs: [],
  profile: {},
  ready: { sports: false, sessions: false },
  unsub: []
};

const imageCache = new Map();
let pendingRender = false;
let lastRouteKey = "";

/* =========================================================
   Utilitaires
   ========================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const todayIdx = () => (new Date().getDay() + 6) % 7;

function localDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toNum(v) {
  if (v === null || v === undefined || v === "") return NaN;
  return parseFloat(String(v).replace(",", ".").replace(/\s/g, ""));
}

function fmtNum(n, digits = 1) {
  return n.toLocaleString("fr-FR", { maximumFractionDigits: digits });
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// "90" → 90 ; "1:30", "1'30", "1m30" → 90 ; "2'" ou "2 min" → 120
function parseDuration(str) {
  if (str === null || str === undefined) return 0;
  const s = String(str).trim().toLowerCase();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(\d+)\s*(?::|'|′|m|min)\s*(\d{1,2})?/);
  if (m) return parseInt(m[1], 10) * 60 + (parseInt(m[2], 10) || 0);
  const sec = s.match(/^(\d+)\s*s/);
  if (sec) return parseInt(sec[1], 10);
  return 0;
}

// Temps de course : 53″, 1′53″, 1 h 05′
function fmtRunTime(sec) {
  sec = Math.round(sec);
  if (sec < 60) return `${sec}″`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")}′`;
  return `${m}′${String(s).padStart(2, "0")}″`;
}

function fmtPace(speedKmh) {
  const secPerKm = Math.round(3600 / speedKmh);
  return `${Math.floor(secPerKm / 60)}′${String(secPerKm % 60).padStart(2, "0")}″/km`;
}

// "400 m" → 0.4 ; "2 km" → 2 ; "10 min" → null
function parseDistanceKm(text) {
  const m = String(text ?? "").match(/(\d+(?:[.,]\d+)?)\s*(km|m)\b/i);
  if (!m) return null;
  const v = toNum(m[1]);
  return m[2].toLowerCase() === "km" ? v : v / 1000;
}

function fmtDistance(km) {
  return km >= 1 ? `${fmtNum(km, 2)} km` : `${fmtNum(km * 1000, 0)} m`;
}

/* Type d'effort d'un exercice : répétitions, distance (km) ou durée */

const EX_MODES = [
  { key: "reps", label: "Répétitions" },
  { key: "distance", label: "Distance" },
  { key: "time", label: "Durée" }
];

// "20" → 20 min ; "2:30" → 2 min 30 ; "1h15" → 1 h 15 (résultat en secondes)
function parseMinutes(str) {
  const s = String(str ?? "").trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^(\d+)\s*h\s*(\d{1,2})?/);
  if (m) return (parseInt(m[1], 10) * 60 + (parseInt(m[2], 10) || 0)) * 60;
  m = s.match(/^(\d+)\s*[:'′]\s*(\d{1,2})/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  m = s.match(/^(\d+(?:[.,]\d+)?)/);
  if (m) return Math.round(toNum(m[1]) * 60);
  return null;
}

function fmtClock(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")}`;
  if (s === 0) return `${m} min`;
  return `${m}′${String(s).padStart(2, "0")}″`;
}

function fmtClockInput(sec) {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m}:${String(s).padStart(2, "0")}` : String(m);
}

// Anciennes données : on déduit le type depuis le texte des répétitions ("400 m", "20 min")
function exMode(ex) {
  if (ex.mode) return ex.mode;
  const r = String(ex.reps || "").trim();
  if (/^\d+(?:[.,]\d+)?\s*(km|m)$/i.test(r)) return "distance";
  if (/^\d+\s*(min|h)\b/i.test(r) || /^\d+\s*h\s*\d+$/i.test(r)) return "time";
  return "reps";
}

function exDistanceKm(ex) {
  if (ex.mode === "distance") return toNum(ex.distance) || null;
  if (ex.mode) return null;
  return parseDistanceKm(ex.reps);
}

function exDurationSec(ex) {
  if (ex.mode === "time") return toNum(ex.duration) || null;
  if (ex.mode) return null;
  return exMode(ex) === "time" ? parseMinutes(String(ex.reps).replace(/\s*min.*/i, "")) : null;
}

function volumeLabel(ex) {
  const sets = setsCount(ex);
  const mode = exMode(ex);
  let unit;
  if (mode === "distance") {
    const d = exDistanceKm(ex);
    unit = d ? fmtDistance(d) : "? km";
  } else if (mode === "time") {
    const t = exDurationSec(ex);
    unit = t ? fmtClock(t) : "? min";
  } else {
    return `${sets} × ${ex.reps || "?"}`;
  }
  return sets > 1 ? `${sets} × ${unit}` : unit;
}

function isPaceRef(ref) {
  return (ref?.unit || "").trim().toLowerCase() === "km/h";
}

function daysLabel(days) {
  const list = [...(days || [])].sort((a, b) => a - b);
  if (!list.length) return "Sans jour fixe";
  return list.map(d => DAYS[d]).join(", ");
}

function setsCount(ex) {
  const n = parseInt(ex.sets, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30) : 1;
}

function sportOf(session) {
  return state.sports.find(s => s.id === session.sportId);
}

function sessionsOf(sportId) {
  return state.sessions.filter(s => s.sportId === sportId);
}

const userCol = name => collection(db, "users", state.user.uid, name);
const userDoc = (name, id) => doc(db, "users", state.user.uid, name, id);

// Les écritures Firestore se résolvent à la synchronisation serveur : on ne les attend pas
// pour garder une interface réactive hors ligne, mais on signale les erreurs.
function persist(promise, okMsg) {
  if (okMsg) toast(okMsg);
  return promise.catch(err => {
    console.error(err);
    toast(errorMessage(err), true);
  });
}

function errorMessage(err) {
  const code = err?.code || "";
  if (code.includes("permission-denied")) return "Accès refusé. Vérifie les règles Firestore du projet.";
  if (code.includes("resource-exhausted")) return "Quota Firebase atteint. Réessaie plus tard.";
  if (code.includes("invalid-argument")) return "Donnée refusée par Firebase (image trop lourde ?).";
  return "L’enregistrement a échoué. Réessaie.";
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("is-error", isError);
  el.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), isError ? 4200 : 2000);
}

/* =========================================================
   Progression du jour (stockée sur l'appareil)
   ========================================================= */

const progressKey = sid => `mc:progress:${sid}:${localDateKey()}`;

function getProgress(sid) {
  try { return JSON.parse(localStorage.getItem(progressKey(sid))) || {}; }
  catch { return {}; }
}

function setProgress(sid, data) {
  try {
    localStorage.setItem(progressKey(sid), JSON.stringify(data));
    // Ménage : on ne garde que les progressions du jour
    const today = localDateKey();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith("mc:progress:") && !k.endsWith(today)) localStorage.removeItem(k);
    }
  } catch { /* stockage indisponible */ }
}

/* =========================================================
   Calcul des intensités (% d'une charge max, d'une VMA…)
   ========================================================= */

function computeTarget(ex, sport) {
  const pct = toNum(ex.pct);
  if (!pct || !ex.refId) return null;
  const ref = (sport?.refs || []).find(r => r.id === ex.refId);
  if (!ref) return null;
  const base = toNum(ref.value);
  if (!base) return { pct, ref, main: null, extra: "" };

  const v = base * pct / 100;
  const unit = (ref.unit || "").trim();
  const u = unit.toLowerCase();
  let main;
  let extra = "";

  if (u === "kg" || u === "lb" || u === "lbs") {
    main = `${fmtNum(Math.round(v * 2) / 2)} ${unit}`; // arrondi au demi-kilo
  } else if (u === "km/h") {
    main = `${fmtNum(v)} km/h`;
    extra = fmtPace(v);
    const d = exDistanceKm(ex);
    const t = exDurationSec(ex);
    if (d) extra += `, soit ${fmtDistance(d)} en ${fmtRunTime(d / v * 3600)}`;
    else if (t) extra += `, soit environ ${fmtDistance(v * t / 3600)}`;
  } else {
    main = `${fmtNum(v)}${unit ? " " + unit : ""}`;
  }
  return { pct, ref, main, extra };
}

/* =========================================================
   Images (compressées puis stockées dans Firestore)
   ========================================================= */

function compressImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error("not-image"));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      let quality = IMAGE_QUALITY;
      let data = canvas.toDataURL("image/jpeg", quality);
      while (data.length > 700000 && quality > 0.3) {
        quality -= 0.12;
        data = canvas.toDataURL("image/jpeg", quality);
      }
      resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("load")); };
    img.src = url;
  });
}

async function loadImage(id) {
  if (!id) return null;
  if (imageCache.has(id)) return imageCache.get(id);
  const p = getDoc(userDoc("images", id))
    .then(snap => (snap.exists() ? snap.data().data : null))
    .catch(() => null);
  imageCache.set(id, p);
  const data = await p;
  if (!data) imageCache.delete(id);
  return data;
}

function hydrateImages(root) {
  $$("img[data-image-id]", root).forEach(async img => {
    const data = await loadImage(img.dataset.imageId);
    if (data) {
      img.src = data;
      img.closest(".is-loading")?.classList.remove("is-loading");
    } else {
      img.closest(".ex-thumb")?.classList.add("is-missing");
    }
  });
}

/* =========================================================
   Boîte de confirmation
   (remplace confirm(), bloqué ou ignoré dans certaines applis installées et navigateurs intégrés)
   ========================================================= */

function confirmDialog(message, { confirmLabel = "Confirmer", danger = false } = {}) {
  return new Promise(resolve => {
    const wrap = document.createElement("div");
    wrap.className = "dialog-backdrop";
    wrap.innerHTML = `
      <div class="dialog" role="alertdialog" aria-modal="true" aria-describedby="dialog-msg">
        <p id="dialog-msg" class="dialog-msg">${esc(message)}</p>
        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" data-no>Annuler</button>
          <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-yes>${esc(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("is-open"));
    const done = value => {
      document.removeEventListener("keydown", onKey, true);
      wrap.classList.remove("is-open");
      setTimeout(() => wrap.remove(), 180);
      resolve(value);
    };
    const onKey = e => {
      if (e.key === "Escape") { e.stopImmediatePropagation(); done(false); }
    };
    document.addEventListener("keydown", onKey, true);
    wrap.addEventListener("click", e => { if (e.target === wrap) done(false); });
    $("[data-no]", wrap).addEventListener("click", () => done(false));
    $("[data-yes]", wrap).addEventListener("click", () => done(true));
    $("[data-yes]", wrap).focus();
  });
}

/* =========================================================
   Panneaux (bottom sheets) avec gestion du bouton retour
   ========================================================= */

const sheetStack = [];

function openSheet({ title, body, footer = "", onMount, isDirty, wide = false }) {
  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop";
  backdrop.innerHTML = `
    <div class="sheet ${wide ? "sheet--wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-grip"></div>
      <header class="sheet-head">
        <h2>${esc(title)}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Fermer"><i class="fa-solid fa-xmark"></i></button>
      </header>
      <div class="sheet-body">${body}</div>
      ${footer ? `<footer class="sheet-foot">${footer}</footer>` : ""}
    </div>`;
  $("#sheet-root").appendChild(backdrop);
  document.body.classList.add("no-scroll");

  const entry = { backdrop, isDirty, force: false, after: null };
  sheetStack.push(entry);
  history.pushState({ mcSheet: sheetStack.length }, "");

  const requestClose = () => history.back();
  backdrop.addEventListener("click", e => { if (e.target === backdrop) requestClose(); });
  $("[data-close]", backdrop).addEventListener("click", requestClose);

  requestAnimationFrame(() => backdrop.classList.add("is-open"));
  const sheetEl = $(".sheet", backdrop);
  entry.close = (after) => { entry.force = true; entry.after = after || null; history.back(); };
  onMount?.(sheetEl, entry);
  return entry;
}

function destroySheet(entry) {
  const i = sheetStack.indexOf(entry);
  if (i >= 0) sheetStack.splice(i, 1);
  entry.backdrop.classList.remove("is-open");
  setTimeout(() => entry.backdrop.remove(), 220);
  if (!sheetStack.length) document.body.classList.remove("no-scroll");
  if (entry.after) setTimeout(entry.after, 0);
}

window.addEventListener("popstate", () => {
  const top = sheetStack[sheetStack.length - 1];
  if (!top) return;
  if (!top.force && top.isDirty && top.isDirty()) {
    // On remet l'entrée d'historique du panneau, puis on demande confirmation
    history.pushState({ mcSheet: sheetStack.length }, "");
    confirmDialog("Fermer sans enregistrer les modifications ?", { confirmLabel: "Fermer", danger: true })
      .then(ok => { if (ok) top.close(); });
    return;
  }
  destroySheet(top);
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && sheetStack.length && !document.querySelector(".dialog-backdrop")) history.back();
});

/* =========================================================
   En-tête et bouton flottant
   ========================================================= */

function setHeader({ title, kicker = "", back = null, actions = [] }) {
  $("#topbar-title").textContent = title;
  $("#topbar-kicker").textContent = kicker;
  $("#topbar-kicker").classList.toggle("hidden", !kicker);
  const backBtn = $("#btn-back");
  backBtn.classList.toggle("hidden", !back);
  $("#btn-home").classList.toggle("hidden", !!back);
  backBtn.onclick = back ? () => goBack(back) : null;
  document.title = title === "Mes cadences" ? "Mes cadences" : `${title} · Mes cadences`;

  const wrap = $("#topbar-actions");
  wrap.innerHTML = actions.map((a, i) =>
    `<button type="button" class="icon-btn" data-action-idx="${i}" aria-label="${esc(a.label)}" title="${esc(a.label)}"><i class="fa-solid ${a.icon}"></i></button>`
  ).join("");
  $$("[data-action-idx]", wrap).forEach(btn => {
    btn.addEventListener("click", () => actions[+btn.dataset.actionIdx].onClick());
  });
}

function setFab(config) {
  const fab = $("#fab");
  if (!config) { fab.classList.add("hidden"); fab.onclick = null; return; }
  fab.classList.toggle("fab--round", !!config.iconOnly);
  fab.setAttribute("aria-label", config.label);
  fab.title = config.label;
  fab.innerHTML = config.iconOnly
    ? `<i class="fa-solid ${config.icon || "fa-plus"}" aria-hidden="true"></i>`
    : `<i class="fa-solid ${config.icon || "fa-plus"}" aria-hidden="true"></i><span>${esc(config.label)}</span>`;
  fab.classList.remove("hidden");
  fab.onclick = config.onClick;
}

/* =========================================================
   Routage (#/, #/sport/:id, #/sport/:id/session/:sid)
   ========================================================= */

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  return {
    page: ["history", "body"].includes(parts[0]) ? parts[0] : null,
    sportId: parts[0] === "sport" ? parts[1] : null,
    sessionId: parts[2] === "session" ? parts[3] : null,
    progress: parts[0] === "sport" && parts[2] === "progress"
  };
}

function setActiveTab(page) {
  $$(".tabbar a").forEach(a => {
    const active = a.dataset.tab === page;
    a.classList.toggle("is-active", active);
    if (active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
}

function scheduleRender() {
  const active = document.activeElement;
  if (active && $("#view").contains(active) && active.matches("input, textarea, select")) {
    pendingRender = true;
    return;
  }
  render();
}

$("#view").addEventListener("focusout", () => {
  if (!pendingRender) return;
  setTimeout(() => {
    const active = document.activeElement;
    if (active && $("#view").contains(active) && active.matches("input, textarea, select")) return;
    pendingRender = false;
    render();
  }, 0);
});

// Historique interne : le bouton retour de l'en-tête revient en arrière dans l'historique
// du navigateur au lieu d'empiler les pages (le retour Android reste cohérent).
const currentHash = () => (location.hash && location.hash !== "#" ? location.hash : "#/");
const navHistory = [currentHash()];
let replacingHash = false;

function replaceHash(h) {
  replacingHash = true;
  navHistory[navHistory.length - 1] = h;
  location.replace(h);
}

function goBack(target) {
  if (navHistory.length > 1 && navHistory[navHistory.length - 2] === target) history.back();
  else location.hash = target;
}

window.addEventListener("hashchange", () => {
  const h = currentHash();
  if (replacingHash) {
    replacingHash = false;
  } else if (navHistory.length > 1 && navHistory[navHistory.length - 2] === h) {
    navHistory.pop();
  } else if (navHistory[navHistory.length - 1] !== h) {
    navHistory.push(h);
  }
  render();
});

// Identifiants tout juste créés : on attend leur arrivée dans le cache avant de conclure qu'ils n'existent pas.
const awaiting = new Set();

function render() {
  if (!state.user) return;
  pendingRender = false;
  const { page, sportId, sessionId, progress } = parseRoute();
  const routeKey = `${page}/${sportId}/${sessionId}/${progress}`;
  const routeChanged = routeKey !== lastRouteKey;
  lastRouteKey = routeKey;

  if (!state.ready.sports || !state.ready.sessions) {
    renderLoading();
    return;
  }

  setActiveTab(page || "home");

  if (page === "body") {
    renderBody();
  } else if (page === "history") {
    renderHistory();
  } else if (sportId) {
    const sport = state.sports.find(s => s.id === sportId);
    if (!sport) {
      if (awaiting.has(sportId)) { renderLoading(); return; }
      replaceHash("#/");
      return;
    }
    awaiting.delete(sportId);
    if (sessionId) {
      const session = state.sessions.find(s => s.id === sessionId && s.sportId === sportId);
      if (!session) {
        if (awaiting.has(sessionId)) { renderLoading(); return; }
        replaceHash(`#/sport/${sportId}`);
        return;
      }
      awaiting.delete(sessionId);
      renderSession(sport, session);
    } else if (progress) {
      renderProgress(sport);
    } else {
      renderSport(sport);
    }
  } else {
    renderHome();
  }

  if (routeChanged) {
    window.scrollTo(0, 0);
    $("#view").focus({ preventScroll: true });
  }
}

function renderLoading() {
  setHeader({ title: "Mes cadences" });
  setFab(null);
  $("#view").innerHTML = `<div class="loading"><div class="brand-mark brand-mark--lg"><span></span><span></span><span></span></div></div>`;
}

/* =========================================================
   Vue : accueil (aujourd'hui + liste des sports)
   ========================================================= */

function weekSummary() {
  const planned = state.sessions.filter(s => sportOf(s)).reduce((n, s) => n + (s.days || []).length, 0);
  const start = weekStart(Date.now());
  const done = state.logs.filter(l => weekStart(dateKeyToTime(l.date)) === start).length;
  if (!planned && !done) return "";
  return `<a class="week-summary" href="#/history">Cette semaine : <strong>${done}</strong> séance${done > 1 ? "s" : ""} effectuée${done > 1 ? "s" : ""}${planned ? ` sur ${planned} prévue${planned > 1 ? "s" : ""}` : ""}</a>`;
}

function renderHome() {
  setHeader({ title: "Mes cadences" });
  const t = todayIdx();
  const view = $("#view");

  if (!state.sports.length) {
    setFab(null);
    view.innerHTML = `
      <section class="onboarding">
        <h2 class="display">Choisis ton premier sport</h2>
        <p class="lead">Pars d’un programme d’exemple que tu adapteras, ou crée le tien de zéro.</p>
        <div class="template-list">
          ${TEMPLATES.map(tp => `
            <button type="button" class="template-card" data-template="${tp.key}" style="--sport:${tp.color}">
              <span class="sport-badge"><i class="fa-solid ${tp.icon}"></i></span>
              <span class="template-text">
                <strong>${esc(tp.name)}</strong>
                <span>${esc(tp.summary)}</span>
              </span>
              <i class="fa-solid fa-chevron-right chevron"></i>
            </button>`).join("")}
        </div>
        <button type="button" class="btn btn-ghost btn-block" data-new-sport>
          <i class="fa-solid fa-plus"></i> Créer un sport vide
        </button>
      </section>`;
    $$("[data-template]", view).forEach(b => b.addEventListener("click", () => createFromTemplate(b.dataset.template)));
    $("[data-new-sport]", view).addEventListener("click", () => openSportEditor());
    return;
  }

  setFab({ label: "Nouveau sport", onClick: () => openSportEditor() });

  const todays = state.sessions
    .filter(s => (s.days || []).includes(t) && sportOf(s))
    .sort((a, b) => (sportOf(a).order || 0) - (sportOf(b).order || 0));

  let nextHtml = "";
  if (!todays.length) {
    for (let i = 1; i <= 7; i++) {
      const d = (t + i) % 7;
      const list = state.sessions.filter(s => (s.days || []).includes(d) && sportOf(s));
      if (list.length) {
        const when = i === 1 ? "Demain" : DAYS[d];
        nextHtml = `<p class="next-up">Prochaine séance : <strong>${when}</strong>, ${list.map(s => esc(s.name)).join(" et ")}</p>`;
        break;
      }
    }
  }

  const dateLabel = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });

  view.innerHTML = `
    <section class="today">
      <p class="today-date">${esc(dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1))}</p>
      <h2 class="display">${todays.length ? "Au programme aujourd’hui" : "Pas de séance prévue aujourd’hui"}</h2>
      ${weekSummary()}
      ${todays.length ? `
        <div class="today-list">
          ${todays.map(s => {
            const sp = sportOf(s);
            const prog = getProgress(s.id);
            const total = (s.exercises || []).reduce((n, ex) => n + setsCount(ex), 0);
            const done = (s.exercises || []).reduce((n, ex) => n + Math.min(prog[ex.id] || 0, setsCount(ex)), 0);
            const isDone = logsToday(s.id).length > 0;
            return `
              <a class="today-card ${isDone ? "is-done" : ""}" href="#/sport/${sp.id}/session/${s.id}" style="--sport:${sp.color}">
                <span class="sport-badge"><i class="fa-solid ${sp.icon}"></i></span>
                <span class="today-card-text">
                  <strong>${esc(s.name)}</strong>
                  <span>${esc(sp.name)}, ${(s.exercises || []).length} exercice${(s.exercises || []).length > 1 ? "s" : ""}</span>
                </span>
                ${isDone ? `<span class="done-tag"><i class="fa-solid fa-check"></i> Faite</span>` : ""}
                ${total && !isDone ? `<span class="mini-progress" aria-label="${done} séries sur ${total}"><span style="width:${Math.round(done / total * 100)}%"></span></span>` : ""}
              </a>`;
          }).join("")}
        </div>` : nextHtml}
    </section>

    <section class="block">
      <h3 class="block-title">Mes sports</h3>
      <div class="sport-grid">
        ${state.sports.map(sp => {
          const list = sessionsOf(sp.id);
          const busy = new Set(list.flatMap(s => s.days || []));
          return `
            <a class="sport-card" href="#/sport/${sp.id}" style="--sport:${sp.color}">
              <span class="sport-badge"><i class="fa-solid ${sp.icon}"></i></span>
              <span class="sport-card-text">
                <strong>${esc(sp.name)}</strong>
                <span>${list.length} séance${list.length > 1 ? "s" : ""}</span>
              </span>
              <span class="week-dots" aria-label="Jours d’entraînement : ${esc([...busy].sort().map(d => DAYS[d]).join(", ") || "aucun")}">
                ${DAYS_SHORT.map((d, i) => `<span class="${busy.has(i) ? "on" : ""} ${i === t ? "today" : ""}">${d}</span>`).join("")}
              </span>
            </a>`;
        }).join("")}
      </div>
    </section>`;
}

/* =========================================================
   Vue : un sport (semaine + repères)
   ========================================================= */

function renderSport(sport) {
  setHeader({
    title: sport.name,
    back: "#/",
    actions: [
      { icon: "fa-chart-line", label: "Évolution des max", onClick: () => { location.hash = `#/sport/${sport.id}/progress`; } },
      { icon: "fa-pen", label: "Modifier le sport", onClick: () => openSportEditor(sport) }
    ]
  });
  setFab({ label: "Nouvelle séance", iconOnly: true, onClick: () => openSessionEditor(sport) });

  const t = todayIdx();
  const list = sessionsOf(sport.id).sort((a, b) => (a.order || 0) - (b.order || 0));
  const byDay = DAYS.map((_, d) => list.filter(s => (s.days || []).includes(d)));
  const floating = list.filter(s => !(s.days || []).length);
  const refs = sport.refs || [];

  const sessionCard = s => {
    const n = (s.exercises || []).length;
    return `
      <a class="session-card" href="#/sport/${sport.id}/session/${s.id}">
        <span class="session-card-text">
          <strong>${esc(s.name)}</strong>
          <span>${n ? `${n} exercice${n > 1 ? "s" : ""}` : "Aucun exercice"}</span>
        </span>
        <i class="fa-solid fa-chevron-right chevron"></i>
      </a>`;
  };

  $("#view").innerHTML = `
    <div class="sport-page" style="--sport:${sport.color}">
      <nav class="cadence" aria-label="Semaine">
        ${DAYS.map((d, i) => {
          const count = byDay[i].length;
          return `
            <a class="cadence-day ${count ? "on" : ""} ${i === t ? "today" : ""}" href="#day-${i}" data-day="${i}" aria-label="${d} : ${count ? byDay[i].map(s => esc(s.name)).join(", ") : "repos"}">
              <span class="cadence-bar"><span style="height:${count ? Math.min(100, 55 + count * 22) : 14}%"></span></span>
              <span class="cadence-letter">${DAYS_ABBR[i]}</span>
            </a>`;
        }).join("")}
      </nav>

      <section class="refs-card">
        <div class="refs-head">
          <h3 class="block-title">Mes repères</h3>
          <div class="refs-actions">
            ${refs.length ? `<a class="btn btn-small btn-ghost" href="#/sport/${sport.id}/progress"><i class="fa-solid fa-chart-line"></i> Évolution</a>` : ""}
            <button type="button" class="btn btn-small btn-ghost" data-edit-refs><i class="fa-solid fa-pen"></i> ${refs.length ? "Modifier" : "Ajouter"}</button>
          </div>
        </div>
        ${refs.length ? `
          <div class="refs-list">
            ${refs.map(r => `
              <div class="ref-chip">
                <span>${esc(r.label)}</span>
                <strong>${toNum(r.value) ? fmtNum(toNum(r.value), 2) : "?"} ${esc(r.unit || "")}</strong>
              </div>`).join("")}
          </div>` : `<p class="muted">Renseigne ta charge max ou ta VMA : les pourcentages de tes séances seront convertis en kilos ou en allure.</p>`}
      </section>

      <section class="week">
        ${DAYS.map((d, i) => `
          <div class="day-row ${byDay[i].length ? "" : "is-rest"} ${i === t ? "is-today" : ""}" id="day-${i}">
            <div class="day-label">
              <span>${d}</span>
              ${i === t ? `<span class="today-tag">Aujourd’hui</span>` : ""}
            </div>
            <div class="day-sessions">
              ${byDay[i].length ? byDay[i].map(sessionCard).join("") : `<span class="rest-label">Repos</span>`}
            </div>
          </div>`).join("")}
        ${floating.length ? `
          <div class="day-row" id="day-none">
            <div class="day-label"><span>Sans jour fixe</span></div>
            <div class="day-sessions">${floating.map(sessionCard).join("")}</div>
          </div>` : ""}
      </section>

      ${!list.length ? `<p class="empty-hint">Ajoute ta première séance avec le bouton +.</p>` : ""}

      <button type="button" class="btn btn-danger-ghost btn-block sport-delete" data-delete-sport>
        <i class="fa-solid fa-trash"></i> Supprimer ce sport
      </button>
    </div>`;

  $("[data-edit-refs]").addEventListener("click", () => openRefsEditor(sport));
  $("[data-delete-sport]").addEventListener("click", async () => {
    if (await confirmSportDeletion(sport)) leaveSportThenDelete(sport);
  });
  $$(".cadence-day").forEach(a => a.addEventListener("click", e => {
    e.preventDefault();
    const target = document.getElementById(`day-${a.dataset.day}`);
    target?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    target?.classList.add("flash");
    setTimeout(() => target?.classList.remove("flash"), 900);
  }));
}

/* =========================================================
   Vue : une séance
   ========================================================= */

function renderSession(sport, session) {
  setHeader({
    title: session.name,
    kicker: sport.name,
    back: `#/sport/${sport.id}`,
    actions: [{ icon: "fa-pen", label: "Modifier la séance", onClick: () => openSessionEditor(sport, session) }]
  });
  setFab(null);

  const exercises = session.exercises || [];
  const prog = getProgress(session.id);
  const total = exercises.reduce((n, ex) => n + setsCount(ex), 0);
  const done = exercises.reduce((n, ex) => n + Math.min(prog[ex.id] || 0, setsCount(ex)), 0);

  $("#view").innerHTML = `
    <div class="session-page" style="--sport:${sport.color}">
      <section class="session-meta">
        <p class="session-days"><i class="fa-regular fa-calendar"></i> ${esc(daysLabel(session.days))}</p>
        ${session.notes ? `<p class="session-notes">${esc(session.notes)}</p>` : ""}
        ${total ? `
          <div class="progress" data-progress>
            <div class="progress-bar"><span style="width:${Math.round(done / total * 100)}%"></span></div>
            <span class="progress-text">${done} / ${total} séries</span>
          </div>` : ""}
      </section>

      ${exercises.length ? `<div class="ex-list">${exercises.map((ex, i) => exerciseCard(ex, i, sport, prog)).join("")}</div>` : `
        <div class="empty-state">
          <p>Cette séance n’a pas encore d’exercice.</p>
          <button type="button" class="btn btn-primary" data-edit-session><i class="fa-solid fa-plus"></i> Ajouter des exercices</button>
        </div>`}

      ${exercises.length ? (() => {
        const todayLogs = logsToday(session.id);
        return `
          <div class="complete-zone">
            ${todayLogs.length ? `
              <a class="done-banner" href="#/history">
                <i class="fa-solid fa-circle-check"></i>
                <span><strong>Séance effectuée aujourd’hui</strong><span>Voir l’historique</span></span>
              </a>` : ""}
            <button type="button" class="btn ${todayLogs.length ? "btn-ghost" : "btn-primary btn-complete"} btn-block" data-complete>
              <i class="fa-solid fa-flag-checkered"></i> ${todayLogs.length ? "Enregistrer une autre séance" : "Séance effectuée"}
            </button>
            ${done > 0 ? `<button type="button" class="btn btn-ghost btn-block" data-reset><i class="fa-solid fa-rotate-left"></i> Remettre la séance à zéro</button>` : ""}
          </div>`;
      })() : ""}
    </div>`;

  const view = $("#view");
  hydrateImages(view);
  $("[data-edit-session]", view)?.addEventListener("click", () => openSessionEditor(sport, session));
  $("[data-complete]", view)?.addEventListener("click", () => openCompleteSession(sport, session));
  $("[data-reset]", view)?.addEventListener("click", async () => {
    if (!await confirmDialog("Effacer les séries validées aujourd’hui pour cette séance ?", { confirmLabel: "Remettre à zéro" })) return;
    setProgress(session.id, {});
    render();
  });

  $$(".ex", view).forEach(card => {
    const exId = card.dataset.ex;
    const ex = exercises.find(e => e.id === exId);
    if (!ex) return;

    $$(".set-dot", card).forEach(dot => dot.addEventListener("click", () => onSetTap(session, ex, +dot.dataset.set, card)));

    $(".rest-btn", card)?.addEventListener("click", () => openRestTimer(parseDuration(ex.rest), ex.name));

    $(".ex-thumb", card)?.addEventListener("click", async () => {
      const data = await loadImage(ex.imageId);
      if (data) openLightbox(data, ex.name);
    });

    const loadInput = $("[data-load]", card);
    loadInput?.addEventListener("change", () => saveLoad(session, ex.id, loadInput.value.trim()));
    loadInput?.addEventListener("keydown", e => { if (e.key === "Enter") loadInput.blur(); });
  });
}

function exerciseCard(ex, index, sport, prog) {
  const sets = setsCount(ex);
  const done = Math.min(prog[ex.id] || 0, sets);
  const target = computeTarget(ex, sport);
  const restSec = parseDuration(ex.rest);
  const pct = toNum(ex.pct);

  let intensity = "";
  if (target) {
    intensity = `
      <p class="ex-target">
        <span class="pct">${fmtNum(target.pct)} %</span>
        <span>de ${esc(target.ref.label)}</span>
        ${target.main ? `<strong>${esc(target.main)}</strong>` : `<em>repère à renseigner</em>`}
      </p>
      ${target.extra ? `<p class="ex-extra">${esc(target.extra)}</p>` : ""}`;
  } else if (pct) {
    intensity = `<p class="ex-target"><span class="pct">${fmtNum(pct)} %</span></p>`;
  }

  return `
    <article class="ex ${done >= sets ? "is-complete" : ""}" data-ex="${ex.id}">
      <div class="ex-head">
        <span class="ex-index" aria-hidden="true">${index + 1}</span>
        <div class="ex-main">
          <h3>${esc(ex.name || "Exercice")}</h3>
          <p class="ex-volume">${esc(volumeLabel(ex))}</p>
          ${intensity}
        </div>
        ${ex.imageId ? `
          <button type="button" class="ex-thumb is-loading" aria-label="Agrandir l’image de ${esc(ex.name)}">
            <img data-image-id="${esc(ex.imageId)}" alt="">
          </button>` : ""}
      </div>

      <label class="ex-load">
        <span>${exMode(ex) === "reps" ? "Ma charge" : "Mon temps"}</span>
        <input type="text" data-load value="${esc(ex.load || "")}" placeholder="${exMode(ex) === "reps" ? "ex. 82,5 kg" : "ex. 24′30″ ou 4′50″/km"}" enterkeyhint="done" autocomplete="off">
      </label>

      <div class="ex-sets">
        <div class="set-dots" role="group" aria-label="Séries réalisées">
          ${Array.from({ length: sets }, (_, i) => `
            <button type="button" class="set-dot ${i < done ? "done" : ""}" data-set="${i}" aria-pressed="${i < done}" aria-label="Série ${i + 1}">${i + 1}</button>`).join("")}
        </div>
        ${restSec ? `<button type="button" class="rest-btn"><i class="fa-solid fa-hourglass-half"></i> ${fmtDuration(restSec)}</button>` : ""}
      </div>

      ${ex.notes ? `<p class="ex-notes">${esc(ex.notes)}</p>` : ""}
    </article>`;
}

function onSetTap(session, ex, index, card) {
  const prog = getProgress(session.id);
  const sets = setsCount(ex);
  const current = Math.min(prog[ex.id] || 0, sets);
  const next = index < current ? index : index + 1;
  prog[ex.id] = next;
  setProgress(session.id, prog);

  $$(".set-dot", card).forEach((dot, i) => {
    dot.classList.toggle("done", i < next);
    dot.setAttribute("aria-pressed", String(i < next));
  });
  card.classList.toggle("is-complete", next >= sets);
  updateSessionProgress(session);

  if (next > current) {
    try { navigator.vibrate?.(30); } catch { /* ignore */ }
    const restSec = parseDuration(ex.rest);
    if (restSec && next < sets) {
      openRestTimer(restSec, `Avant la série ${next + 1} sur ${sets}`);
    } else if (next >= sets) {
      const all = (session.exercises || []).every(e => Math.min(prog[e.id] || 0, setsCount(e)) >= setsCount(e));
      if (all) {
        toast("Toutes les séries sont faites !");
        setTimeout(() => $("[data-complete]")?.scrollIntoView({ behavior: "smooth", block: "center" }), 400);
      }
      else if (restSec) openRestTimer(restSec, "Avant l’exercice suivant");
    }
  }
}

function updateSessionProgress(session) {
  const box = $("[data-progress]");
  if (!box) return;
  const prog = getProgress(session.id);
  const exercises = session.exercises || [];
  const total = exercises.reduce((n, ex) => n + setsCount(ex), 0);
  const done = exercises.reduce((n, ex) => n + Math.min(prog[ex.id] || 0, setsCount(ex)), 0);
  $(".progress-bar span", box).style.width = `${Math.round(done / total * 100)}%`;
  $(".progress-text", box).textContent = `${done} / ${total} séries`;
  const resetBtn = $("[data-reset]");
  if (!resetBtn && done > 0) scheduleRender();
}

function saveLoad(session, exId, value) {
  const exercises = (session.exercises || []).map(e => (e.id === exId ? { ...e, load: value } : e));
  persist(updateDoc(userDoc("sessions", session.id), { exercises, updatedAt: serverTimestamp() }), "Charge enregistrée");
}

function openLightbox(src, title) {
  openSheet({
    title: title || "Image",
    wide: true,
    body: `<img class="lightbox-img" src="${src}" alt="${esc(title)}">`
  });
}

/* =========================================================
   Création depuis un programme d'exemple
   ========================================================= */

function createFromTemplate(key) {
  const tp = TEMPLATES.find(t => t.key === key);
  if (!tp) return;
  const batch = writeBatch(db);
  const sportRef = doc(userCol("sports"));
  const refIds = {};
  const refs = tp.refs.map(r => {
    const id = newId();
    refIds[r.key] = id;
    return { id, label: r.label, value: r.value, unit: r.unit };
  });
  batch.set(sportRef, {
    name: tp.name, icon: tp.icon, color: tp.color, refs,
    order: Date.now(), createdAt: serverTimestamp()
  });
  tp.sessions.forEach((s, i) => {
    const ref = doc(userCol("sessions"));
    batch.set(ref, {
      sportId: sportRef.id,
      name: s.name,
      days: s.days,
      notes: s.notes || "",
      order: i,
      exercises: s.exercises.map(ex => ({
        id: newId(),
        name: ex.name,
        sets: ex.sets,
        mode: ex.mode || "reps",
        reps: ex.reps || "",
        distance: ex.distance ?? "",
        duration: ex.duration ?? "",
        pct: ex.pct ?? "",
        refId: ex.ref ? refIds[ex.ref] : "",
        rest: ex.rest ?? "",
        load: "",
        notes: ex.notes || "",
        imageId: null
      })),
      createdAt: serverTimestamp()
    });
  });
  awaiting.add(sportRef.id);
  persist(batch.commit(), `${tp.name} ajouté`);
  location.hash = `#/sport/${sportRef.id}`;
}

/* =========================================================
   Éditeur : sport
   ========================================================= */

function openSportEditor(sport = null) {
  const isNew = !sport;
  const initial = {
    name: sport?.name || "",
    icon: sport?.icon || SPORT_ICONS[0].icon,
    color: sport?.color || SPORT_COLORS[state.sports.length % SPORT_COLORS.length]
  };
  const count = sport ? sessionsOf(sport.id).length : 0;

  const body = `
    <form class="form" data-form novalidate>
      <label class="field">
        <span class="field-label">Nom du sport</span>
        <input type="text" name="name" value="${esc(initial.name)}" placeholder="ex. Musculation, Course à pied" maxlength="40" required autocomplete="off">
      </label>

      <fieldset class="field">
        <legend class="field-label">Icône</legend>
        <div class="icon-grid">
          ${SPORT_ICONS.map(ic => `
            <label class="icon-choice" title="${esc(ic.label)}">
              <input type="radio" name="icon" value="${ic.icon}" ${ic.icon === initial.icon ? "checked" : ""}>
              <span><i class="fa-solid ${ic.icon}"></i><span class="sr-only">${esc(ic.label)}</span></span>
            </label>`).join("")}
        </div>
      </fieldset>

      <fieldset class="field">
        <legend class="field-label">Couleur</legend>
        <div class="color-row">
          ${SPORT_COLORS.map(c => `
            <label class="color-choice" style="--c:${c}">
              <input type="radio" name="color" value="${c}" ${c === initial.color ? "checked" : ""}>
              <span><span class="sr-only">${c}</span></span>
            </label>`).join("")}
        </div>
      </fieldset>

      ${!isNew ? `
        <button type="button" class="btn btn-danger-ghost btn-block" data-delete>
          <i class="fa-solid fa-trash"></i> Supprimer ce sport
        </button>` : ""}
    </form>`;

  const footer = `<button type="button" class="btn btn-primary btn-block" data-save>${isNew ? "Créer le sport" : "Enregistrer"}</button>`;

  let form;
  const read = () => {
    const fd = new FormData(form);
    return { name: String(fd.get("name") || "").trim(), icon: fd.get("icon"), color: fd.get("color") };
  };

  openSheet({
    title: isNew ? "Nouveau sport" : "Modifier le sport",
    body, footer,
    isDirty: () => JSON.stringify(read()) !== JSON.stringify(initial),
    onMount(el, entry) {
      form = $("[data-form]", el);
      if (isNew) setTimeout(() => $("input[name=name]", el).focus(), 250);
      form.addEventListener("submit", e => { e.preventDefault(); $("[data-save]", el).click(); });

      $("[data-save]", el).addEventListener("click", () => {
        const data = read();
        if (!data.name) {
          toast("Donne un nom à ce sport.", true);
          $("input[name=name]", el).focus();
          return;
        }
        if (isNew) {
          const ref = doc(userCol("sports"));
          awaiting.add(ref.id);
          persist(setDoc(ref, { ...data, refs: [], order: Date.now(), createdAt: serverTimestamp() }), "Sport créé");
          entry.close(() => { location.hash = `#/sport/${ref.id}`; });
        } else {
          persist(updateDoc(userDoc("sports", sport.id), { ...data, updatedAt: serverTimestamp() }), "Sport enregistré");
          entry.close();
        }
      });

      $("[data-delete]", el)?.addEventListener("click", async () => {
        if (!await confirmSportDeletion(sport)) return;
        // On ferme le panneau et on quitte la page du sport AVANT de supprimer,
        // pour que l'historique et l'affichage restent cohérents.
        entry.close(() => {
          leaveSportThenDelete(sport);
        });
      });
    }
  });
}

function confirmSportDeletion(sport) {
  const count = sessionsOf(sport.id).length;
  const msg = count
    ? `Supprimer « ${sport.name} » et ses ${count} séance${count > 1 ? "s" : ""} ? Cette action est définitive.`
    : `Supprimer « ${sport.name} » ? Cette action est définitive.`;
  return confirmDialog(msg, { confirmLabel: "Supprimer", danger: true });
}

function leaveSportThenDelete(sport) {
  const { sportId } = parseRoute();
  if (sportId === sport.id) replaceHash("#/");
  setTimeout(() => deleteSport(sport), 0);
}

function deleteSport(sport) {
  const batch = writeBatch(db);
  sessionsOf(sport.id).forEach(s => {
    (s.exercises || []).forEach(ex => { if (ex.imageId) batch.delete(userDoc("images", ex.imageId)); });
    batch.delete(userDoc("sessions", s.id));
  });
  state.maxes.filter(m => m.sportId === sport.id).forEach(m => batch.delete(userDoc("maxes", m.id)));
  batch.delete(userDoc("sports", sport.id));
  persist(batch.commit(), "Sport supprimé");
}

/* =========================================================
   Éditeur : repères (charge max, VMA…)
   ========================================================= */

function refRow(r) {
  return `
    <div class="ref-row" data-ref-id="${esc(r.id)}">
      <input type="text" data-f="label" value="${esc(r.label)}" placeholder="ex. Max squat, VMA" aria-label="Nom du repère" maxlength="40">
      <input type="text" data-f="value" value="${esc(r.value)}" placeholder="120" inputmode="decimal" aria-label="Valeur">
      <input type="text" data-f="unit" value="${esc(r.unit)}" placeholder="kg" list="unit-list" aria-label="Unité" maxlength="10">
      <button type="button" class="icon-btn icon-btn--danger" data-remove aria-label="Supprimer ce repère"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
}

function openRefsEditor(sport) {
  const initial = (sport.refs || []).map(r => ({ id: r.id, label: r.label || "", value: String(r.value ?? ""), unit: r.unit || "" }));
  const used = new Set(sessionsOf(sport.id).flatMap(s => (s.exercises || []).map(e => e.refId)).filter(Boolean));

  const body = `
    <p class="muted">Un repère est une valeur de référence : ta charge maximale sur un mouvement, ta VMA, ta FTP… Dans tes séances, une intensité de 80 % sera calculée à partir de ce repère. Chaque nouvelle valeur est ajoutée à l’évolution de tes max.</p>
    <div class="ref-rows" data-rows>
      <div class="ref-row ref-row--head" aria-hidden="true"><span>Nom</span><span>Valeur</span><span>Unité</span><span></span></div>
      ${initial.map(refRow).join("")}
    </div>
    <datalist id="unit-list">${UNIT_SUGGESTIONS.map(u => `<option value="${u}">`).join("")}</datalist>
    <button type="button" class="btn btn-ghost btn-block" data-add><i class="fa-solid fa-plus"></i> Ajouter un repère</button>`;

  let rowsEl;
  const read = () => $$(".ref-row[data-ref-id]", rowsEl).map(row => ({
    id: row.dataset.refId,
    label: $('[data-f="label"]', row).value.trim(),
    value: $('[data-f="value"]', row).value.trim(),
    unit: $('[data-f="unit"]', row).value.trim()
  }));

  openSheet({
    title: "Mes repères",
    body,
    footer: `<button type="button" class="btn btn-primary btn-block" data-save>Enregistrer</button>`,
    isDirty: () => JSON.stringify(read()) !== JSON.stringify(initial),
    onMount(el, entry) {
      rowsEl = $("[data-rows]", el);
      const bindRemove = row => $("[data-remove]", row).addEventListener("click", async () => {
        if (used.has(row.dataset.refId) && !await confirmDialog("Ce repère est utilisé dans tes séances. Le supprimer quand même ?", { confirmLabel: "Supprimer", danger: true })) return;
        row.remove();
      });
      $$(".ref-row[data-ref-id]", rowsEl).forEach(bindRemove);

      $("[data-add]", el).addEventListener("click", () => {
        rowsEl.insertAdjacentHTML("beforeend", refRow({ id: newId(), label: "", value: "", unit: "" }));
        const row = rowsEl.lastElementChild;
        bindRemove(row);
        $('[data-f="label"]', row).focus();
      });
      if (!initial.length) $("[data-add]", el).click();

      $("[data-save]", el).addEventListener("click", () => {
        const refs = read()
          .filter(r => r.label)
          .map(r => ({ ...r, value: Number.isFinite(toNum(r.value)) ? toNum(r.value) : r.value }));
        const batch = writeBatch(db);
        batch.update(userDoc("sports", sport.id), { refs, updatedAt: serverTimestamp() });
        // Historique : une nouvelle valeur est datée d'aujourd'hui
        const today = localDateKey();
        refs.forEach(r => {
          const before = initial.find(i => i.id === r.id);
          const v = toNum(r.value);
          if (!Number.isFinite(v) || v <= 0) return;
          if (before && toNum(before.value) === v) return;
          batch.set(userDoc("maxes", maxDocId(r.id, today)), {
            sportId: sport.id, refId: r.id, date: today, value: v, updatedAt: serverTimestamp()
          });
        });
        // Repères supprimés : on retire leur historique
        const keptIds = new Set(refs.map(r => r.id));
        state.maxes.filter(m => m.sportId === sport.id && !keptIds.has(m.refId)).forEach(m => batch.delete(userDoc("maxes", m.id)));
        persist(batch.commit(), "Repères enregistrés");
        entry.close();
      });
    }
  });
}

/* =========================================================
   Éditeur : séance et exercices
   ========================================================= */

function exerciseBlock(ex, refs) {
  const mode = exMode(ex);
  const dist = exDistanceKm(ex);
  const dur = exDurationSec(ex);
  const ref = refs.find(r => r.id === ex.refId);
  return `
    <div class="exb" data-ex-id="${esc(ex.id)}">
      <div class="exb-head">
        <input type="text" class="exb-name" data-f="name" value="${esc(ex.name)}" placeholder="Nom de l’exercice" aria-label="Nom de l’exercice" maxlength="60">
        <div class="exb-tools">
          <button type="button" class="icon-btn" data-move="-1" aria-label="Monter"><i class="fa-solid fa-arrow-up"></i></button>
          <button type="button" class="icon-btn" data-move="1" aria-label="Descendre"><i class="fa-solid fa-arrow-down"></i></button>
          <button type="button" class="icon-btn icon-btn--danger" data-remove aria-label="Supprimer l’exercice"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>

      <div class="mode-switch" role="radiogroup" aria-label="Type d’effort">
        ${EX_MODES.map(m => `
          <label>
            <input type="radio" name="mode-${esc(ex.id)}" value="${m.key}" data-mode ${m.key === mode ? "checked" : ""}>
            <span>${m.label}</span>
          </label>`).join("")}
      </div>

      <div class="exb-grid">
        <label class="field field--compact">
          <span class="field-label">Séries</span>
          <input type="number" data-f="sets" value="${esc(ex.sets)}" min="1" max="30" inputmode="numeric" placeholder="3">
        </label>
        <label class="field field--compact ${mode === "reps" ? "" : "hidden"}" data-mode-field="reps">
          <span class="field-label">Répétitions</span>
          <input type="text" data-f="reps" value="${mode === "reps" ? esc(ex.reps) : ""}" placeholder="10, 8-12">
        </label>
        <label class="field field--compact ${mode === "distance" ? "" : "hidden"}" data-mode-field="distance">
          <span class="field-label">Distance (km)</span>
          <input type="text" data-f="distance" value="${dist ? String(dist).replace(".", ",") : ""}" inputmode="decimal" placeholder="5 ou 0,4">
        </label>
        <label class="field field--compact ${mode === "time" ? "" : "hidden"}" data-mode-field="time">
          <span class="field-label">Durée (min)</span>
          <input type="text" data-f="duration" value="${fmtClockInput(dur)}" inputmode="decimal" placeholder="20 ou 2:30">
        </label>
        <label class="field field--compact">
          <span class="field-label" data-pct-label>${ref ? `% de ${esc(ref.label)}` : "Intensité (%)"}</span>
          <input type="text" data-f="pct" value="${esc(ex.pct)}" inputmode="decimal" placeholder="80">
        </label>
        <label class="field field--compact">
          <span class="field-label">Calculée sur</span>
          <select data-f="refId">
            <option value="">Aucun repère</option>
            ${refs.map(r => `<option value="${esc(r.id)}" ${r.id === ex.refId ? "selected" : ""}>${esc(r.label)}${r.unit ? ` (${esc(r.unit)})` : ""}</option>`).join("")}
          </select>
        </label>
        <label class="field field--compact">
          <span class="field-label">Repos</span>
          <input type="text" data-f="rest" value="${ex.rest ? fmtDuration(parseDuration(ex.rest)) : ""}" placeholder="1:30" inputmode="numeric">
        </label>
        <label class="field field--compact">
          <span class="field-label" data-load-label>${mode === "reps" ? "Ma charge" : "Mon temps"}</span>
          <input type="text" data-f="load" value="${esc(ex.load)}" placeholder="${mode === "reps" ? "80 kg" : "24′30″"}">
        </label>
      </div>

      <label class="field field--compact">
        <span class="field-label">Consignes</span>
        <textarea data-f="notes" rows="2" placeholder="Tempo, placement, variante…">${esc(ex.notes)}</textarea>
      </label>

      <div class="exb-image" data-image>
        <div class="exb-image-preview ${ex.imageId ? "" : "hidden"}">
          <img ${ex.imageId ? `data-image-id="${esc(ex.imageId)}"` : ""} alt="">
        </div>
        <div class="exb-image-actions">
          <label class="btn btn-small btn-ghost">
            <i class="fa-regular fa-image"></i> <span data-image-label>${ex.imageId ? "Changer l’image" : "Ajouter une image"}</span>
            <input type="file" accept="image/*" class="sr-only" data-image-input>
          </label>
          <button type="button" class="btn btn-small btn-danger-ghost ${ex.imageId ? "" : "hidden"}" data-image-remove>Retirer</button>
        </div>
      </div>
    </div>`;
}

function blankExercise(sport) {
  const paceRef = (sport?.refs || []).find(isPaceRef);
  if (paceRef) {
    return { id: newId(), name: "", sets: 1, mode: "distance", reps: "", distance: "", duration: "", pct: "", refId: paceRef.id, rest: "", load: "", notes: "", imageId: null };
  }
  return { id: newId(), name: "", sets: 3, mode: "reps", reps: "10", distance: "", duration: "", pct: "", refId: "", rest: 90, load: "", notes: "", imageId: null };
}

function openSessionEditor(sport, session = null) {
  const isNew = !session;
  const refs = sport.refs || [];
  const original = session ? JSON.parse(JSON.stringify(session)) : null;
  const startExercises = session?.exercises?.length ? session.exercises : [blankExercise(sport)];

  // État des images par exercice : { imageId (existant), data (nouvelle), removed }
  const images = new Map();
  startExercises.forEach(ex => images.set(ex.id, { imageId: ex.imageId || null, data: null, removed: false }));

  const body = `
    <form class="form" data-form novalidate>
      <label class="field">
        <span class="field-label">Nom de la séance</span>
        <input type="text" name="name" value="${esc(session?.name || "")}" placeholder="ex. Push, Fractionné" maxlength="50" autocomplete="off">
      </label>

      <fieldset class="field">
        <legend class="field-label">Jours</legend>
        <div class="day-chips">
          ${DAYS.map((d, i) => `
            <label class="day-chip" title="${d}">
              <input type="checkbox" name="days" value="${i}" ${(session?.days || []).includes(i) ? "checked" : ""}>
              <span aria-hidden="true">${DAYS_ABBR[i]}</span><span class="sr-only">${d}</span>
            </label>`).join("")}
        </div>
      </fieldset>

      <label class="field">
        <span class="field-label">Notes</span>
        <textarea name="notes" rows="2" placeholder="Objectif, échauffement…">${esc(session?.notes || "")}</textarea>
      </label>

      <div class="field">
        <span class="field-label">Exercices</span>
        ${!refs.length ? `<p class="hint">Astuce : ajoute des repères (charge max, VMA) depuis la page du sport pour convertir les pourcentages.</p>` : ""}
        <div class="exb-list" data-exercises>
          ${startExercises.map(ex => exerciseBlock(ex, refs)).join("")}
        </div>
        <button type="button" class="btn btn-ghost btn-block" data-add-ex><i class="fa-solid fa-plus"></i> Ajouter un exercice</button>
      </div>

      ${!isNew ? `
        <button type="button" class="btn btn-danger-ghost btn-block" data-delete>
          <i class="fa-solid fa-trash"></i> Supprimer cette séance
        </button>` : ""}
    </form>`;

  let form, listEl;

  const read = () => {
    const fd = new FormData(form);
    return {
      name: String(fd.get("name") || "").trim(),
      days: fd.getAll("days").map(Number).sort((a, b) => a - b),
      notes: String(fd.get("notes") || "").trim(),
      exercises: $$(".exb", listEl).map(block => {
        const f = name => $(`[data-f="${name}"]`, block).value.trim();
        const sets = parseInt(f("sets"), 10);
        const pct = toNum(f("pct"));
        const restSec = parseDuration(f("rest"));
        const mode = $("[data-mode]:checked", block)?.value || "reps";
        const distance = toNum(f("distance"));
        const duration = parseMinutes(f("duration"));
        return {
          id: block.dataset.exId,
          name: f("name"),
          sets: Number.isFinite(sets) && sets > 0 ? sets : 1,
          mode,
          reps: mode === "reps" ? f("reps") : "",
          distance: mode === "distance" && distance > 0 ? distance : "",
          duration: mode === "time" && duration > 0 ? duration : "",
          pct: Number.isFinite(pct) ? pct : "",
          refId: f("refId"),
          rest: restSec || "",
          load: f("load"),
          notes: f("notes")
        };
      })
    };
  };

  let initialSnapshot = "";
  const snapshot = () => JSON.stringify(read()) + JSON.stringify([...images.values()].map(i => [i.imageId, !!i.data, i.removed]));

  openSheet({
    title: isNew ? "Nouvelle séance" : "Modifier la séance",
    body,
    footer: `<button type="button" class="btn btn-primary btn-block" data-save>${isNew ? "Créer la séance" : "Enregistrer"}</button>`,
    isDirty: () => snapshot() !== initialSnapshot,
    onMount(el, entry) {
      form = $("[data-form]", el);
      listEl = $("[data-exercises]", el);
      hydrateImages(el);
      if (isNew) setTimeout(() => $("input[name=name]", el).focus(), 250);

      const bindBlock = block => {
        const id = block.dataset.exId;
        if (!images.has(id)) images.set(id, { imageId: null, data: null, removed: false });

        const syncMode = (fromUser = false) => {
          const mode = $("[data-mode]:checked", block)?.value || "reps";
          $$("[data-mode-field]", block).forEach(f => f.classList.toggle("hidden", f.dataset.modeField !== mode));
          $("[data-load-label]", block).textContent = mode === "reps" ? "Ma charge" : "Mon temps";
          $('[data-f="load"]', block).placeholder = mode === "reps" ? "80 kg" : "24′30″";
          const sel = $('[data-f="refId"]', block);
          if (fromUser && mode !== "reps" && !sel.value) {
            const paceRef = refs.find(isPaceRef);
            if (paceRef) { sel.value = paceRef.id; sel.dispatchEvent(new Event("change")); }
          }
          if (fromUser) $(`[data-mode-field="${mode}"] input`, block)?.focus();
        };
        $$("[data-mode]", block).forEach(r => r.addEventListener("change", () => syncMode(true)));
        $('[data-f="refId"]', block).addEventListener("change", e => {
          const r = refs.find(x => x.id === e.target.value);
          $("[data-pct-label]", block).textContent = r ? `% de ${r.label}` : "Intensité (%)";
        });

        $("[data-remove]", block).addEventListener("click", async () => {
          const name = $('[data-f="name"]', block).value.trim();
          if (name && !await confirmDialog(`Supprimer l’exercice « ${name} » ?`, { confirmLabel: "Supprimer", danger: true })) return;
          block.remove();
        });
        $$("[data-move]", block).forEach(btn => btn.addEventListener("click", () => {
          const dir = +btn.dataset.move;
          const sibling = dir < 0 ? block.previousElementSibling : block.nextElementSibling;
          if (!sibling) return;
          if (dir < 0) listEl.insertBefore(block, sibling);
          else listEl.insertBefore(sibling, block);
          btn.focus();
        }));

        const input = $("[data-image-input]", block);
        const preview = $(".exb-image-preview", block);
        const img = $("img", preview);
        const removeBtn = $("[data-image-remove]", block);
        const label = $("[data-image-label]", block);

        input.addEventListener("change", async () => {
          const file = input.files?.[0];
          input.value = "";
          if (!file) return;
          try {
            label.textContent = "Préparation…";
            const data = await compressImage(file);
            const st = images.get(id);
            st.data = data;
            st.removed = false;
            img.src = data;
            preview.classList.remove("hidden");
            removeBtn.classList.remove("hidden");
            label.textContent = "Changer l’image";
          } catch {
            label.textContent = "Ajouter une image";
            toast("Impossible de lire cette image.", true);
          }
        });

        removeBtn.addEventListener("click", () => {
          const st = images.get(id);
          st.data = null;
          st.removed = true;
          img.removeAttribute("src");
          preview.classList.add("hidden");
          removeBtn.classList.add("hidden");
          label.textContent = "Ajouter une image";
        });
      };

      $$(".exb", listEl).forEach(bindBlock);

      $("[data-add-ex]", el).addEventListener("click", () => {
        const ex = blankExercise(sport);
        images.set(ex.id, { imageId: null, data: null, removed: false });
        listEl.insertAdjacentHTML("beforeend", exerciseBlock(ex, refs));
        const block = listEl.lastElementChild;
        bindBlock(block);
        block.scrollIntoView({ behavior: "smooth", block: "nearest" });
        $('[data-f="name"]', block).focus({ preventScroll: true });
      });

      initialSnapshot = snapshot();

      $("[data-save]", el).addEventListener("click", () => {
        const data = read();
        if (!data.name) {
          toast("Donne un nom à cette séance.", true);
          $("input[name=name]", el).focus();
          return;
        }
        data.exercises = data.exercises.filter(ex => ex.name);

        // Images : nouvelles à écrire, anciennes à supprimer
        const toDelete = new Set();
        const batch = writeBatch(db);
        data.exercises.forEach(ex => {
          const st = images.get(ex.id) || { imageId: null, data: null, removed: false };
          ex.imageId = st.imageId;
          if (st.data) {
            const imgId = newId();
            batch.set(userDoc("images", imgId), { data: st.data, createdAt: serverTimestamp() });
            imageCache.set(imgId, Promise.resolve(st.data));
            if (st.imageId) toDelete.add(st.imageId);
            ex.imageId = imgId;
          } else if (st.removed && st.imageId) {
            toDelete.add(st.imageId);
            ex.imageId = null;
          }
        });
        // Images des exercices supprimés
        const kept = new Set(data.exercises.map(e => e.imageId).filter(Boolean));
        (original?.exercises || []).forEach(e => { if (e.imageId && !kept.has(e.imageId)) toDelete.add(e.imageId); });
        toDelete.forEach(id => { batch.delete(userDoc("images", id)); imageCache.delete(id); });

        if (isNew) {
          const ref = doc(userCol("sessions"));
          awaiting.add(ref.id);
          batch.set(ref, {
            ...data, sportId: sport.id,
            order: sessionsOf(sport.id).length,
            createdAt: serverTimestamp()
          });
          persist(batch.commit(), "Séance créée");
          entry.close(() => { location.hash = `#/sport/${sport.id}/session/${ref.id}`; });
        } else {
          batch.update(userDoc("sessions", session.id), { ...data, updatedAt: serverTimestamp() });
          persist(batch.commit(), "Séance enregistrée");
          entry.close();
        }
      });

      $("[data-delete]", el)?.addEventListener("click", async () => {
        if (!await confirmDialog(`Supprimer la séance « ${session.name} » ? Cette action est définitive.`, { confirmLabel: "Supprimer", danger: true })) return;
        entry.close(() => {
          replaceHash(`#/sport/${sport.id}`);
          setTimeout(() => {
            const batch = writeBatch(db);
            (session.exercises || []).forEach(ex => { if (ex.imageId) batch.delete(userDoc("images", ex.imageId)); });
            batch.delete(userDoc("sessions", session.id));
            persist(batch.commit(), "Séance supprimée");
          }, 0);
        });
      });
    }
  });
}

/* =========================================================
   Dates
   ========================================================= */

function dateKeyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "2026-11-23" → horodatage à midi (évite les décalages d'heure d'été)
function dateKeyToTime(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12).getTime();
}

function fmtDateKey(key, opts = { day: "numeric", month: "short", year: "numeric" }) {
  return new Date(dateKeyToTime(key)).toLocaleDateString("fr-FR", opts);
}

function fmtDateCompact(key) {
  return fmtDateKey(key, { day: "2-digit", month: "2-digit", year: "2-digit" });
}

// Lundi de la semaine contenant la date
function weekStart(time) {
  const d = new Date(time);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function signed(n, digits = 1) {
  const v = fmtNum(Math.abs(n), digits);
  if (Math.abs(n) < Math.pow(10, -digits) / 2) return "=";
  return `${n > 0 ? "+" : "−"}${v}`;
}

/* =========================================================
   Suivi personnel : poids, taille, IMC, masse grasse, masse musculaire, VMA
   ========================================================= */

const BODY_METRICS = [
  { key: "weight", label: "Poids", short: "Poids", unit: "kg", decimals: 1 },
  { key: "bmi", label: "IMC", short: "IMC", unit: "", decimals: 1 },
  { key: "fat", label: "Masse grasse", short: "MG", unit: "%", decimals: 1 },
  { key: "muscle", label: "Masse musculaire", short: "MM", unit: "%", decimals: 1 },
  { key: "vma", label: "VMA", short: "VMA", unit: "km/h", decimals: 1 }
];

const RANGES = [
  { key: "3m", label: "3 mois", days: 92 },
  { key: "1y", label: "1 an", days: 366 },
  { key: "all", label: "Tout", days: Infinity }
];

const ui = { bodyMetric: "weight", bodyRange: "all", historySport: "all", logsShown: 30 };

function bmiOf(weight, heightCm) {
  const w = toNum(weight);
  const h = toNum(heightCm);
  if (!w || !h) return null;
  return w / Math.pow(h / 100, 2);
}

function bmiCategory(v) {
  if (v === null) return "";
  if (v < 18.5) return "Maigreur";
  if (v < 25) return "Corpulence normale";
  if (v < 30) return "Surpoids";
  return "Obésité";
}

function measureValue(m, key) {
  if (key === "bmi") return bmiOf(m.weight, m.height || state.profile.height);
  const v = toNum(m[key]);
  return Number.isFinite(v) ? v : null;
}

// Repères qui représentent ta VMA (unité km/h, nom contenant « VMA », sinon tout repère en km/h)
function vmaRefs() {
  const all = state.sports.flatMap(sp => (sp.refs || []).filter(isPaceRef).map(r => ({ sport: sp, ref: r })));
  const named = all.filter(x => /vma/i.test(x.ref.label || ""));
  return named.length ? named : all;
}

// VMA par date : mesures du suivi + historique des repères VMA des sports (sans doublon de date)
function vmaByDate() {
  const map = new Map();
  vmaRefs().forEach(({ sport, ref }) => {
    maxesOf(sport.id, ref.id).forEach(e => {
      const v = toNum(e.value);
      if (Number.isFinite(v) && !map.has(e.date)) map.set(e.date, v);
    });
  });
  state.measures.forEach(m => {
    const v = toNum(m.vma);
    if (Number.isFinite(v)) map.set(m.date, v);
  });
  return map;
}

function metricSeries(key) {
  if (key === "vma") {
    return [...vmaByDate().entries()]
      .map(([date, y]) => ({ t: dateKeyToTime(date), y, date }))
      .sort((a, b) => a.t - b.t);
  }
  return state.measures
    .map(m => ({ t: dateKeyToTime(m.date), y: measureValue(m, key), date: m.date }))
    .filter(p => p.y !== null && Number.isFinite(p.y))
    .sort((a, b) => a.t - b.t);
}

function renderBody() {
  setHeader({ title: "Suivi" });
  setFab({ label: "Nouvelle mesure", iconOnly: true, onClick: () => openMeasureEditor() });
  const view = $("#view");
  const height = toNum(state.profile.height);
  // Lignes du tableau : les mesures, plus les dates où seule la VMA a changé (via les repères)
  const vmaMap = vmaByDate();
  const rowsByDate = new Map(state.measures.map(m => [m.date, { ...m }]));
  vmaMap.forEach((v, date) => {
    const row = rowsByDate.get(date) || { date };
    row.vmaShown = v;
    rowsByDate.set(date, row);
  });
  const measures = [...rowsByDate.values()].sort((a, b) => b.date.localeCompare(a.date));

  const tiles = BODY_METRICS.map(mt => {
    const series = metricSeries(mt.key);
    const last = series[series.length - 1];
    const prev = series[series.length - 2];
    let sub = "";
    if (mt.key === "bmi") sub = last ? bmiCategory(last.y) : (height ? "Ajoute ton poids" : "Renseigne ta taille");
    else if (mt.key === "vma" && last && prev) sub = `${signed(last.y - prev.y)} km/h depuis le ${fmtDateKey(prev.date, { day: "numeric", month: "short" })}, allure ${fmtPace(last.y)}`;
    else if (mt.key === "vma" && last) sub = `Allure à 100 % : ${fmtPace(last.y)}`;
    else if (last && prev) sub = `${signed(last.y - prev.y)}${mt.unit ? " " + mt.unit : ""} depuis le ${fmtDateKey(prev.date, { day: "numeric", month: "short" })}`;
    else if (last) sub = fmtDateKey(last.date, { day: "numeric", month: "short" });
    else sub = "Pas encore de mesure";
    return `
      <button type="button" class="metric-tile ${mt.key === "vma" ? "metric-tile--wide" : ""} ${ui.bodyMetric === mt.key ? "is-active" : ""}" data-metric="${mt.key}" aria-pressed="${ui.bodyMetric === mt.key}">
        <span class="metric-label">${mt.label}</span>
        <span class="metric-value">${last ? fmtNum(last.y, mt.decimals) : "–"}<small>${last && mt.unit ? " " + mt.unit : ""}</small></span>
        <span class="metric-sub">${esc(sub)}</span>
      </button>`;
  }).join("");

  const maxRows = state.sports.flatMap(sp => (sp.refs || []).map(r => ({ sp, r })));

  view.innerHTML = `
    <section class="body-page">
      <div class="metric-grid">${tiles}</div>

      <div class="height-line">
        <span>Taille : <strong>${height ? `${fmtNum(height, 0)} cm` : "non renseignée"}</strong></span>
        <button type="button" class="btn btn-small btn-ghost" data-height><i class="fa-solid fa-ruler-vertical"></i> ${height ? "Modifier" : "Renseigner"}</button>
      </div>

      <section class="card chart-card">
        <div class="chart-head">
          <h3 class="block-title">${BODY_METRICS.find(m => m.key === ui.bodyMetric).label}</h3>
          <div class="segmented" role="group" aria-label="Période">
            ${RANGES.map(r => `<button type="button" data-range="${r.key}" aria-pressed="${ui.bodyRange === r.key}">${r.label}</button>`).join("")}
          </div>
        </div>
        <div data-body-chart></div>
      </section>

      <section class="block">
        <h3 class="block-title">Récapitulatif</h3>
        ${measures.length ? `
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th scope="col">Date</th><th scope="col">Poids<br>kg</th><th scope="col">IMC</th><th scope="col">MG<br>%</th><th scope="col">MM<br>%</th><th scope="col">VMA<br>km/h</th></tr></thead>
              <tbody>
                ${measures.map(m => {
                  const b = measureValue(m, "bmi");
                  const cell = (v, unit) => (v === null || v === undefined || v === "" || !Number.isFinite(toNum(v)) ? "–" : `${fmtNum(toNum(v))}${unit}`);
                  return `
                    <tr data-measure="${esc(m.date)}" tabindex="0" role="button" aria-label="Modifier la mesure du ${fmtDateKey(m.date)}">
                      <td>${fmtDateCompact(m.date)}</td>
                      <td>${cell(m.weight, "")}</td>
                      <td>${b === null ? "–" : fmtNum(b)}</td>
                      <td>${cell(m.fat, "")}</td>
                      <td>${cell(m.muscle, "")}</td>
                      <td>${m.vmaShown === undefined ? "–" : fmtNum(m.vmaShown)}</td>
                    </tr>`;
                }).join("")}
              </tbody>
            </table>
          </div>` : `
          <div class="empty-state">
            <p>Note ton poids, ta masse grasse, ta masse musculaire et ta VMA pour suivre leur évolution.</p>
            <button type="button" class="btn btn-primary" data-first-measure><i class="fa-solid fa-plus"></i> Ajouter ma première mesure</button>
          </div>`}
      </section>

      <section class="block">
        <h3 class="block-title">Mes max</h3>
        ${maxRows.length ? `
          <div class="max-overview">
            ${maxRows.map(({ sp, r }) => {
              const entries = maxesOf(sp.id, r.id);
              const first = entries[0];
              const cur = toNum(r.value);
              const delta = first && Number.isFinite(cur) && entries.length > 1 ? cur - toNum(first.value) : null;
              return `
                <a class="max-row" href="#/sport/${sp.id}/progress" style="--sport:${sp.color}">
                  <span class="max-dot"></span>
                  <span class="max-text"><strong>${esc(r.label)}</strong><span>${esc(sp.name)}</span></span>
                  <span class="max-value">${Number.isFinite(cur) ? fmtNum(cur, 2) : "?"} ${esc(r.unit || "")}
                    ${delta !== null ? `<small>${signed(delta)} depuis le début</small>` : ""}</span>
                </a>`;
            }).join("")}
          </div>` : `<p class="muted">Ajoute des repères (charge max, VMA…) dans un sport pour suivre leur évolution ici.</p>`}
      </section>

      ${measures.length ? `
        <button type="button" class="btn btn-danger-ghost btn-block danger-zone" data-wipe-measures>
          <i class="fa-solid fa-trash"></i> Supprimer toutes mes mesures
        </button>` : ""}
    </section>`;

  drawBodyChart();

  $$("[data-metric]", view).forEach(b => b.addEventListener("click", () => {
    ui.bodyMetric = b.dataset.metric;
    $$("[data-metric]", view).forEach(x => {
      x.classList.toggle("is-active", x === b);
      x.setAttribute("aria-pressed", String(x === b));
    });
    $(".chart-card .block-title", view).textContent = BODY_METRICS.find(m => m.key === ui.bodyMetric).label;
    drawBodyChart();
  }));
  $$("[data-range]", view).forEach(b => b.addEventListener("click", () => {
    ui.bodyRange = b.dataset.range;
    $$("[data-range]", view).forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    drawBodyChart();
  }));
  $("[data-height]", view).addEventListener("click", openHeightEditor);
  $("[data-first-measure]", view)?.addEventListener("click", () => openMeasureEditor());
  $$("[data-measure]", view).forEach(row => {
    const open = () => {
      const date = row.dataset.measure;
      const existing = state.measures.find(m => m.date === date);
      openMeasureEditor(existing || null, existing ? null : { date, vma: vmaByDate().get(date) ?? "" });
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
  $("[data-wipe-measures]", view)?.addEventListener("click", async () => {
    if (!await confirmDialog(`Supprimer définitivement tes ${state.measures.length} mesures ?`, { confirmLabel: "Tout supprimer", danger: true })) return;
    const ids = state.measures.map(m => m.date);
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(db);
      ids.slice(i, i + 400).forEach(id => batch.delete(userDoc("measures", id)));
      persist(batch.commit(), i === 0 ? "Mesures supprimées" : null);
    }
  });
}

function drawBodyChart() {
  const host = $("[data-body-chart]");
  if (!host) return;
  const mt = BODY_METRICS.find(m => m.key === ui.bodyMetric);
  const range = RANGES.find(r => r.key === ui.bodyRange);
  const limit = Date.now() - range.days * 86400000;
  const points = metricSeries(mt.key).filter(p => p.t >= limit);
  mountChart(host, {
    points,
    unit: mt.unit,
    decimals: mt.decimals,
    label: `Évolution : ${mt.label}`,
    band: mt.key === "bmi" ? { from: 18.5, to: 25, label: "Normal" } : null,
    emptyText: mt.key === "bmi" && !state.profile.height
      ? "Renseigne ta taille pour calculer ton IMC."
      : mt.key === "vma"
        ? "Ajoute ta VMA dans une mesure ou dans les repères de ton sport de course."
        : "Pas encore de mesure sur cette période."
  });
}

function openHeightEditor() {
  const initial = state.profile.height ? String(state.profile.height) : "";
  openSheet({
    title: "Ma taille",
    body: `
      <label class="field">
        <span class="field-label">Taille (cm)</span>
        <input type="text" name="height" inputmode="decimal" value="${esc(initial)}" placeholder="178">
      </label>
      <p class="muted">Elle sert à calculer ton IMC pour toutes tes mesures.</p>`,
    footer: `<button type="button" class="btn btn-primary btn-block" data-save>Enregistrer</button>`,
    isDirty: () => $("[name=height]").value.trim() !== initial,
    onMount(el, entry) {
      const input = $("[name=height]", el);
      setTimeout(() => input.focus(), 250);
      $("[data-save]", el).addEventListener("click", () => {
        const h = toNum(input.value);
        if (!(h >= 80 && h <= 250)) { toast("Indique une taille entre 80 et 250 cm.", true); input.focus(); return; }
        persist(setDoc(userDoc("profile", "main"), { height: h, updatedAt: serverTimestamp() }, { merge: true }), "Taille enregistrée");
        entry.close();
      });
    }
  });
}

function openMeasureEditor(measure = null, prefill = null) {
  const isNew = !measure;
  const height = state.profile.height || "";
  const src = measure || prefill || {};
  const init = {
    date: src.date || localDateKey(),
    height: String(height),
    weight: src.weight ?? "",
    fat: src.fat ?? "",
    muscle: src.muscle ?? "",
    vma: src.vma ?? (measure ? (vmaByDate().get(measure.date) ?? "") : "")
  };
  const linked = vmaRefs();
  init.vma = String(init.vma).replace(".", ",");
  const initial = JSON.stringify(Object.values(init).map(String));

  const body = `
    <form class="form" data-form novalidate>
      <label class="field">
        <span class="field-label">Date</span>
        <input type="date" name="date" value="${esc(init.date)}" max="${localDateKey()}">
      </label>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">Poids (kg)</span>
          <input type="text" name="weight" inputmode="decimal" value="${esc(init.weight)}" placeholder="78,5">
        </label>
        <label class="field">
          <span class="field-label">Taille (cm)</span>
          <input type="text" name="height" inputmode="decimal" value="${esc(init.height)}" placeholder="178">
        </label>
        <label class="field">
          <span class="field-label">Masse grasse (%)</span>
          <input type="text" name="fat" inputmode="decimal" value="${esc(init.fat)}" placeholder="18">
        </label>
        <label class="field">
          <span class="field-label">Masse musculaire (%)</span>
          <input type="text" name="muscle" inputmode="decimal" value="${esc(init.muscle)}" placeholder="42">
        </label>
        <label class="field">
          <span class="field-label">VMA (km/h)</span>
          <input type="text" name="vma" inputmode="decimal" value="${esc(String(init.vma).replace(".", ","))}" placeholder="15">
        </label>
      </div>
      <p class="hint">${linked.length
        ? `La VMA met aussi à jour le repère ${linked.map(x => `« ${esc(x.ref.label)} » (${esc(x.sport.name)})`).join(", ")} : tes allures de séance suivent.`
        : "Astuce : ajoute un repère « VMA » en km/h dans ton sport de course pour que tes allures de séance suivent cette valeur."}</p>
      <p class="bmi-preview" data-bmi aria-live="polite"></p>
      ${!isNew ? `<button type="button" class="btn btn-danger-ghost btn-block" data-delete><i class="fa-solid fa-trash"></i> Supprimer cette mesure</button>` : ""}
    </form>`;

  let form;
  const read = () => {
    const fd = new FormData(form);
    return {
      date: String(fd.get("date") || ""),
      height: String(fd.get("height") || "").trim(),
      weight: String(fd.get("weight") || "").trim(),
      fat: String(fd.get("fat") || "").trim(),
      muscle: String(fd.get("muscle") || "").trim(),
      vma: String(fd.get("vma") || "").trim()
    };
  };

  openSheet({
    title: isNew ? "Nouvelle mesure" : "Modifier la mesure",
    body,
    footer: `<button type="button" class="btn btn-primary btn-block" data-save>Enregistrer</button>`,
    isDirty: () => JSON.stringify(Object.values(read()).map(String)) !== initial,
    onMount(el, entry) {
      form = $("[data-form]", el);
      const preview = () => {
        const d = read();
        const b = bmiOf(d.weight, d.height);
        $("[data-bmi]", el).textContent = b ? `IMC : ${fmtNum(b)} (${bmiCategory(b).toLowerCase()})` : "";
      };
      form.addEventListener("input", preview);
      preview();
      if (isNew) setTimeout(() => $("[name=weight]", el).focus(), 250);

      $("[data-save]", el).addEventListener("click", async () => {
        const d = read();
        const num = v => (v === "" ? null : toNum(v));
        const data = { weight: num(d.weight), fat: num(d.fat), muscle: num(d.muscle), vma: num(d.vma) };
        const h = num(d.height);

        if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return toast("Choisis une date.", true);
        if (d.date > localDateKey()) return toast("La date ne peut pas être dans le futur.", true);
        if (data.weight === null && data.fat === null && data.muscle === null && data.vma === null) return toast("Renseigne au moins une valeur.", true);
        if (data.vma !== null && !(data.vma >= 5 && data.vma <= 30)) return toast("VMA attendue entre 5 et 30 km/h.", true);
        if (data.weight !== null && !(data.weight >= 20 && data.weight <= 400)) return toast("Poids attendu entre 20 et 400 kg.", true);
        if (data.fat !== null && !(data.fat >= 1 && data.fat <= 80)) return toast("Masse grasse attendue entre 1 et 80 %.", true);
        if (data.muscle !== null && !(data.muscle >= 5 && data.muscle <= 90)) return toast("Masse musculaire attendue entre 5 et 90 %.", true);
        if (h !== null && !(h >= 80 && h <= 250)) return toast("Taille attendue entre 80 et 250 cm.", true);
        if (Object.values(data).some(v => v !== null && !Number.isFinite(v))) return toast("Une valeur n’est pas un nombre.", true);

        const replacing = state.measures.find(m => m.date === d.date);
        if (replacing && (isNew || measure.date !== d.date)) {
          if (!await confirmDialog(`Une mesure existe déjà le ${fmtDateKey(d.date)}. La remplacer ?`, { confirmLabel: "Remplacer" })) return;
        }

        const batch = writeBatch(db);
        batch.set(userDoc("measures", d.date), { date: d.date, ...data, updatedAt: serverTimestamp() });
        if (!isNew && measure.date !== d.date) batch.delete(userDoc("measures", measure.date));
        if (h !== null && h !== toNum(state.profile.height)) {
          batch.set(userDoc("profile", "main"), { height: h, updatedAt: serverTimestamp() }, { merge: true });
        }

        // VMA : on alimente aussi l'historique des repères VMA des sports, et leur valeur courante
        const oldDate = !isNew ? measure.date : null;
        linked.forEach(({ sport, ref }) => {
          let entries = maxesOf(sport.id, ref.id);
          if (oldDate && oldDate !== d.date && toNum(measure.vma)) {
            batch.delete(userDoc("maxes", maxDocId(ref.id, oldDate)));
            entries = entries.filter(e => e.date !== oldDate);
          }
          if (data.vma !== null) {
            batch.set(userDoc("maxes", maxDocId(ref.id, d.date)), {
              sportId: sport.id, refId: ref.id, date: d.date, value: data.vma, updatedAt: serverTimestamp()
            });
            entries = entries.filter(e => e.date !== d.date).concat({ id: maxDocId(ref.id, d.date), date: d.date, value: data.vma });
          }
          syncRefValue(sport, ref.id, entries);
        });

        persist(batch.commit(), "Mesure enregistrée");
        entry.close();
      });

      $("[data-delete]", el)?.addEventListener("click", async () => {
        if (!await confirmDialog(`Supprimer la mesure du ${fmtDateKey(measure.date)} ?`, { confirmLabel: "Supprimer", danger: true })) return;
        const batch = writeBatch(db);
        batch.delete(userDoc("measures", measure.date));
        // La VMA saisie ce jour-là disparaît aussi de l'historique des repères
        if (toNum(measure.vma)) {
          linked.forEach(({ sport, ref }) => {
            const id = maxDocId(ref.id, measure.date);
            if (state.maxes.some(m => m.id === id)) {
              batch.delete(userDoc("maxes", id));
              syncRefValue(sport, ref.id, maxesOf(sport.id, ref.id).filter(e => e.id !== id));
            }
          });
        }
        persist(batch.commit(), "Mesure supprimée");
        entry.close();
      });
    }
  });
}

/* =========================================================
   Évolution des max (historique des repères)
   ========================================================= */

const maxDocId = (refId, date) => `${refId}_${date}`;

function maxesOf(sportId, refId) {
  return state.maxes
    .filter(m => m.sportId === sportId && m.refId === refId)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Remet la valeur courante du repère sur la mesure la plus récente
function syncRefValue(sport, refId, entries) {
  if (!entries.length) return;
  const latest = entries.reduce((a, b) => (a.date >= b.date ? a : b));
  const refs = (sport.refs || []).map(r => (r.id === refId ? { ...r, value: latest.value } : r));
  const current = (sport.refs || []).find(r => r.id === refId);
  if (current && toNum(current.value) === toNum(latest.value)) return;
  persist(updateDoc(userDoc("sports", sport.id), { refs, updatedAt: serverTimestamp() }));
}

function renderProgress(sport) {
  setHeader({
    title: "Évolution des max",
    kicker: sport.name,
    back: `#/sport/${sport.id}`,
    actions: [{ icon: "fa-sliders", label: "Modifier les repères", onClick: () => openRefsEditor(sport) }]
  });
  const refs = sport.refs || [];
  setFab(refs.length ? { label: "Nouveau max", iconOnly: true, onClick: () => openMaxEditor(sport) } : null);
  const view = $("#view");

  if (!refs.length) {
    view.innerHTML = `
      <div class="empty-state" style="--sport:${sport.color}">
        <p>Ajoute d’abord un repère : ta charge max sur un exercice, ta VMA…</p>
        <button type="button" class="btn btn-primary" data-refs><i class="fa-solid fa-plus"></i> Ajouter un repère</button>
      </div>`;
    $("[data-refs]", view).addEventListener("click", () => openRefsEditor(sport));
    return;
  }

  view.innerHTML = `
    <div class="progress-page" style="--sport:${sport.color}">
      ${refs.map(r => {
        const entries = maxesOf(sport.id, r.id);
        const cur = toNum(r.value);
        const first = entries[0];
        const delta = entries.length > 1 ? toNum(entries[entries.length - 1].value) - toNum(first.value) : null;
        return `
          <section class="card max-card" data-ref="${esc(r.id)}">
            <div class="max-card-head">
              <div>
                <h3>${esc(r.label)}</h3>
                ${delta !== null ? `<p class="muted">${signed(delta, 2)} ${esc(r.unit || "")} depuis le ${fmtDateKey(first.date)}</p>` : ""}
              </div>
              <p class="max-current">${Number.isFinite(cur) ? fmtNum(cur, 2) : "?"}<small> ${esc(r.unit || "")}</small></p>
            </div>
            ${entries.length ? `<div data-max-chart></div>` : `
              <p class="muted">Pas encore d’historique pour ce repère.</p>
              ${Number.isFinite(cur) ? `<button type="button" class="btn btn-small btn-ghost" data-seed><i class="fa-solid fa-flag"></i> Enregistrer ${fmtNum(cur, 2)} ${esc(r.unit || "")} comme point de départ</button>` : ""}`}
            <div class="max-actions">
              <button type="button" class="btn btn-small btn-ghost" data-add-max><i class="fa-solid fa-plus"></i> Nouveau max</button>
            </div>
            ${entries.length ? `
              <ol class="max-entries">
                ${[...entries].reverse().map((e, i, arr) => {
                  const prev = arr[i + 1];
                  const d = prev ? toNum(e.value) - toNum(prev.value) : null;
                  return `
                    <li>
                      <button type="button" data-entry="${esc(e.id)}">
                        <span>${fmtDateKey(e.date)}</span>
                        <strong>${fmtNum(toNum(e.value), 2)} ${esc(r.unit || "")}</strong>
                        <span class="entry-delta ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d === null ? "" : signed(d, 2)}</span>
                      </button>
                    </li>`;
                }).join("")}
              </ol>` : ""}
          </section>`;
      }).join("")}
    </div>`;

  $$(".max-card", view).forEach(card => {
    const ref = refs.find(r => r.id === card.dataset.ref);
    const entries = maxesOf(sport.id, ref.id);
    const host = $("[data-max-chart]", card);
    if (host) {
      mountChart(host, {
        points: entries.map(e => ({ t: dateKeyToTime(e.date), y: toNum(e.value) })).filter(p => Number.isFinite(p.y)),
        unit: ref.unit || "",
        decimals: 2,
        label: `Évolution : ${ref.label}`
      });
    }
    $("[data-add-max]", card).addEventListener("click", () => openMaxEditor(sport, ref.id));
    $("[data-seed]", card)?.addEventListener("click", () => {
      const date = localDateKey();
      persist(setDoc(userDoc("maxes", maxDocId(ref.id, date)), {
        sportId: sport.id, refId: ref.id, date, value: toNum(ref.value), createdAt: serverTimestamp()
      }), "Point de départ enregistré");
    });
    $$("[data-entry]", card).forEach(b => b.addEventListener("click", () => {
      openMaxEditor(sport, ref.id, state.maxes.find(m => m.id === b.dataset.entry));
    }));
  });
}

function openMaxEditor(sport, refId = null, entry = null) {
  const refs = sport.refs || [];
  const isNew = !entry;
  const init = {
    refId: entry?.refId || refId || refs[0]?.id || "",
    date: entry?.date || localDateKey(),
    value: entry ? String(entry.value) : ""
  };
  const initial = JSON.stringify(init);
  const unitOf = id => refs.find(r => r.id === id)?.unit || "";

  const body = `
    <form class="form" data-form novalidate>
      <label class="field">
        <span class="field-label">Repère</span>
        <select name="refId" ${!isNew ? "disabled" : ""}>
          ${refs.map(r => `<option value="${esc(r.id)}" ${r.id === init.refId ? "selected" : ""}>${esc(r.label)}</option>`).join("")}
        </select>
      </label>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">Date</span>
          <input type="date" name="date" value="${esc(init.date)}" max="${localDateKey()}">
        </label>
        <label class="field">
          <span class="field-label">Valeur <span data-unit>${esc(unitOf(init.refId) ? `(${unitOf(init.refId)})` : "")}</span></span>
          <input type="text" name="value" inputmode="decimal" value="${esc(init.value)}" placeholder="105">
        </label>
      </div>
      ${!isNew ? `<button type="button" class="btn btn-danger-ghost btn-block" data-delete><i class="fa-solid fa-trash"></i> Supprimer cette valeur</button>` : ""}
    </form>`;

  let form;
  const read = () => {
    const fd = new FormData(form);
    return { refId: isNew ? String(fd.get("refId") || "") : init.refId, date: String(fd.get("date") || ""), value: String(fd.get("value") || "").trim() };
  };

  openSheet({
    title: isNew ? "Nouveau max" : "Modifier la valeur",
    body,
    footer: `<button type="button" class="btn btn-primary btn-block" data-save>Enregistrer</button>`,
    isDirty: () => JSON.stringify(read()) !== initial,
    onMount(el, sheet) {
      form = $("[data-form]", el);
      $("[name=refId]", el).addEventListener("change", e => {
        const u = unitOf(e.target.value);
        $("[data-unit]", el).textContent = u ? `(${u})` : "";
      });
      setTimeout(() => $("[name=value]", el).focus(), 250);

      $("[data-save]", el).addEventListener("click", () => {
        const d = read();
        const value = toNum(d.value);
        if (!d.refId) return toast("Choisis un repère.", true);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return toast("Choisis une date.", true);
        if (d.date > localDateKey()) return toast("La date ne peut pas être dans le futur.", true);
        if (!Number.isFinite(value) || value <= 0) return toast("Indique une valeur positive.", true);

        const id = maxDocId(d.refId, d.date);
        const batch = writeBatch(db);
        batch.set(userDoc("maxes", id), { sportId: sport.id, refId: d.refId, date: d.date, value, updatedAt: serverTimestamp() });
        if (!isNew && entry.id !== id) batch.delete(userDoc("maxes", entry.id));
        persist(batch.commit(), "Max enregistré");

        const after = maxesOf(sport.id, d.refId).filter(m => m.id !== id && (isNew || m.id !== entry.id));
        after.push({ id, date: d.date, value });
        syncRefValue(sport, d.refId, after);
        sheet.close();
      });

      $("[data-delete]", el)?.addEventListener("click", async () => {
        if (!await confirmDialog(`Supprimer la valeur du ${fmtDateKey(entry.date)} ?`, { confirmLabel: "Supprimer", danger: true })) return;
        persist(deleteDoc(userDoc("maxes", entry.id)), "Valeur supprimée");
        syncRefValue(sport, entry.refId, maxesOf(sport.id, entry.refId).filter(m => m.id !== entry.id));
        sheet.close();
      });
    }
  });
}

/* =========================================================
   Séances effectuées et historique
   ========================================================= */

const FEELINGS = [
  { key: "easy", label: "Facile", icon: "fa-face-smile" },
  { key: "ok", label: "Correcte", icon: "fa-face-meh" },
  { key: "hard", label: "Difficile", icon: "fa-face-grimace" },
  { key: "max", label: "Épuisante", icon: "fa-face-tired" }
];

function logsToday(sessionId) {
  const today = localDateKey();
  return state.logs.filter(l => l.sessionId === sessionId && l.date === today);
}

function openCompleteSession(sport, session) {
  const prog = getProgress(session.id);
  const exercises = session.exercises || [];
  const total = exercises.reduce((n, ex) => n + setsCount(ex), 0);
  const done = exercises.reduce((n, ex) => n + Math.min(prog[ex.id] || 0, setsCount(ex)), 0);

  const body = `
    <form class="form" data-form novalidate>
      <div class="complete-summary">
        <span class="complete-count">${done}<small> / ${total}</small></span>
        <span>séries validées${done < total ? ". Les séries non cochées seront notées comme non faites." : ", tout est fait."}</span>
      </div>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">Date</span>
          <input type="date" name="date" value="${localDateKey()}" max="${localDateKey()}">
        </label>
        <label class="field">
          <span class="field-label">Durée (min)</span>
          <input type="text" name="duration" inputmode="numeric" placeholder="60">
        </label>
      </div>
      <fieldset class="field">
        <legend class="field-label">Ressenti</legend>
        <div class="feeling-row">
          ${FEELINGS.map(f => `
            <label class="feeling-choice">
              <input type="radio" name="feeling" value="${f.key}">
              <span><i class="fa-regular ${f.icon}"></i>${f.label}</span>
            </label>`).join("")}
        </div>
      </fieldset>
      <label class="field">
        <span class="field-label">Note</span>
        <textarea name="note" rows="2" placeholder="Sensations, douleurs, records…"></textarea>
      </label>
    </form>`;

  openSheet({
    title: "Séance effectuée",
    body,
    footer: `<button type="button" class="btn btn-primary btn-block" data-save><i class="fa-solid fa-check"></i> Enregistrer la séance</button>`,
    onMount(el, entry) {
      const form = $("[data-form]", el);
      $("[data-save]", el).addEventListener("click", () => {
        const fd = new FormData(form);
        const date = String(fd.get("date") || localDateKey());
        if (date > localDateKey()) return toast("La date ne peut pas être dans le futur.", true);
        const duration = parseInt(fd.get("duration"), 10);
        const log = {
          date,
          sessionId: session.id,
          sportId: sport.id,
          sessionName: session.name,
          sportName: sport.name,
          sportColor: sport.color,
          sportIcon: sport.icon,
          doneSets: done,
          totalSets: total,
          duration: Number.isFinite(duration) && duration > 0 ? duration : null,
          feeling: fd.get("feeling") || null,
          note: String(fd.get("note") || "").trim(),
          exercises: exercises.map(ex => {
            const target = computeTarget(ex, sport);
            return {
              name: ex.name || "Exercice",
              sets: setsCount(ex),
              reps: ex.reps || "",
              volume: volumeLabel(ex),
              doneSets: Math.min(prog[ex.id] || 0, setsCount(ex)),
              load: ex.load || "",
              target: target?.main ? `${fmtNum(target.pct)} % : ${target.main}` : ""
            };
          }),
          createdAt: serverTimestamp()
        };
        persist(setDoc(doc(userCol("logs")), log), "Séance enregistrée, bien joué !");
        setProgress(session.id, {});
        entry.close(() => render());
      });
    }
  });
}

function renderHistory() {
  setHeader({ title: "Historique" });
  setFab(null);
  const view = $("#view");
  const filter = ui.historySport;
  const logs = state.logs.filter(l => filter === "all" || l.sportId === filter);
  const sportsWithLogs = state.sports.filter(sp => state.logs.some(l => l.sportId === sp.id));

  // Statistiques
  const now = Date.now();
  const thisWeek = weekStart(now);
  const today = new Date();
  const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const weekCount = logs.filter(l => weekStart(dateKeyToTime(l.date)) === thisWeek).length;
  const monthCount = logs.filter(l => l.date.startsWith(monthKey)).length;
  const weeksWithLogs = new Set(logs.map(l => weekStart(dateKeyToTime(l.date))));
  let streak = 0;
  let w = weeksWithLogs.has(thisWeek) ? thisWeek : thisWeek - 7 * 86400000;
  while (weeksWithLogs.has(w)) { streak++; w = weekStart(w - 7 * 86400000); }

  const bars = [];
  for (let i = 11; i >= 0; i--) {
    const start = weekStart(thisWeek - i * 7 * 86400000);
    const count = logs.filter(l => weekStart(dateKeyToTime(l.date)) === start).length;
    const d = new Date(start);
    bars.push({
      value: count,
      label: d.toLocaleDateString("fr-FR", { day: "numeric", month: "numeric" }),
      detail: i === 0 ? "cette semaine" : `semaine du ${d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}`,
      highlight: i === 0
    });
  }

  // Liste groupée par mois
  const shown = logs.slice(0, ui.logsShown);
  const groups = [];
  shown.forEach(l => {
    const key = l.date.slice(0, 7);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) { g = { key, items: [] }; groups.push(g); }
    g.items.push(l);
  });

  view.innerHTML = `
    <section class="history-page">
      ${sportsWithLogs.length > 1 ? `
        <div class="filter-chips" role="group" aria-label="Filtrer par sport">
          <button type="button" data-filter="all" aria-pressed="${filter === "all"}">Tous</button>
          ${sportsWithLogs.map(sp => `<button type="button" data-filter="${sp.id}" aria-pressed="${filter === sp.id}" style="--sport:${sp.color}">${esc(sp.name)}</button>`).join("")}
        </div>` : ""}

      <div class="stats-row">
        <div class="stat"><strong>${weekCount}</strong><span>cette semaine</span></div>
        <div class="stat"><strong>${monthCount}</strong><span>ce mois-ci</span></div>
        <div class="stat"><strong>${streak}</strong><span>semaine${streak > 1 ? "s" : ""} d’affilée</span></div>
      </div>

      <section class="card chart-card">
        <h3 class="block-title">Séances par semaine</h3>
        <div data-history-chart></div>
      </section>

      ${logs.length ? groups.map(g => `
        <section class="block">
          <h3 class="block-title">${capitalize(fmtDateKey(g.key + "-01", { month: "long", year: "numeric" }))}</h3>
          <div class="log-list">
            ${g.items.map(l => {
              const feeling = FEELINGS.find(f => f.key === l.feeling);
              const meta = [
                l.totalSets ? `${l.doneSets} / ${l.totalSets} séries` : "",
                l.duration ? `${l.duration} min` : ""
              ].filter(Boolean).join(", ");
              return `
                <button type="button" class="log-row" data-log="${esc(l.id)}" style="--sport:${l.sportColor || "var(--primary)"}">
                  <span class="log-date"><strong>${new Date(dateKeyToTime(l.date)).getDate()}</strong><span>${fmtDateKey(l.date, { weekday: "short" }).replace(".", "")}</span></span>
                  <span class="log-text">
                    <strong>${esc(l.sessionName)}</strong>
                    <span>${esc(l.sportName)}${meta ? `, ${meta}` : ""}</span>
                  </span>
                  ${feeling ? `<i class="fa-regular ${feeling.icon} log-feeling" title="${feeling.label}" aria-label="${feeling.label}"></i>` : ""}
                </button>`;
            }).join("")}
          </div>
        </section>`).join("") : `
        <div class="empty-state">
          <p>Aucune séance enregistrée pour l’instant. À la fin d’une séance, appuie sur « Séance effectuée » pour la retrouver ici.</p>
        </div>`}

      ${logs.length > ui.logsShown ? `<button type="button" class="btn btn-ghost btn-block" data-more>Afficher plus de séances</button>` : ""}
    </section>`;

  mountBarChart($("[data-history-chart]", view), { bars, unitSingular: "séance", unitPlural: "séances", label: "Séances par semaine sur 12 semaines" });

  $$("[data-filter]", view).forEach(b => b.addEventListener("click", () => { ui.historySport = b.dataset.filter; ui.logsShown = 30; render(); }));
  $("[data-more]", view)?.addEventListener("click", () => { ui.logsShown += 30; render(); });
  $$("[data-log]", view).forEach(b => b.addEventListener("click", () => openLogDetail(state.logs.find(l => l.id === b.dataset.log))));
}

function openLogDetail(log) {
  if (!log) return;
  const feeling = FEELINGS.find(f => f.key === log.feeling);
  openSheet({
    title: log.sessionName,
    body: `
      <div class="log-detail" style="--sport:${log.sportColor || "var(--primary)"}">
        <p class="log-detail-date">${capitalize(fmtDateKey(log.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}</p>
        <div class="log-facts">
          <span><i class="fa-solid ${log.sportIcon || "fa-dumbbell"}"></i> ${esc(log.sportName)}</span>
          ${log.totalSets ? `<span><i class="fa-solid fa-list-check"></i> ${log.doneSets} / ${log.totalSets} séries</span>` : ""}
          ${log.duration ? `<span><i class="fa-regular fa-clock"></i> ${log.duration} min</span>` : ""}
          ${feeling ? `<span><i class="fa-regular ${feeling.icon}"></i> ${feeling.label}</span>` : ""}
        </div>
        ${log.note ? `<p class="log-note">${esc(log.note)}</p>` : ""}
        ${(log.exercises || []).length ? `
          <div class="table-wrap">
            <table class="data-table data-table--left">
              <thead><tr><th scope="col">Exercice</th><th scope="col">Séries</th><th scope="col">Charge</th></tr></thead>
              <tbody>
                ${log.exercises.map(ex => `
                  <tr class="${ex.doneSets < ex.sets ? "is-partial" : ""}">
                    <td><strong>${esc(ex.name)}</strong><br><span class="muted">${esc(ex.volume || `${ex.sets} × ${ex.reps}`)}${ex.target ? `, ${esc(ex.target)}` : ""}</span></td>
                    <td>${ex.doneSets} / ${ex.sets}</td>
                    <td>${esc(ex.load) || "–"}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>` : ""}
      </div>`,
    footer: `<button type="button" class="btn btn-danger-ghost btn-block" data-delete><i class="fa-solid fa-trash"></i> Supprimer de l’historique</button>`,
    onMount(el, entry) {
      $("[data-delete]", el).addEventListener("click", async () => {
        if (!await confirmDialog("Supprimer cette séance de l’historique ?", { confirmLabel: "Supprimer", danger: true })) return;
        persist(deleteDoc(userDoc("logs", log.id)), "Séance retirée de l’historique");
        entry.close();
      });
    }
  });
}

/* =========================================================
   Compte
   ========================================================= */

function openAccount() {
  const u = state.user;
  openSheet({
    title: "Mon compte",
    body: `
      <div class="account">
        ${u.photoURL ? `<img class="account-avatar" src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">` : `<span class="account-avatar account-avatar--empty"><i class="fa-solid fa-user"></i></span>`}
        <p class="account-name">${esc(u.displayName || "Connecté avec Google")}</p>
        <p class="muted">Tes programmes sont liés à ton compte et visibles par toi seul.</p>
      </div>`,
    footer: `<button type="button" class="btn btn-ghost btn-block" data-logout><i class="fa-solid fa-right-from-bracket"></i> Se déconnecter</button>`,
    onMount(el, entry) {
      $("[data-logout]", el).addEventListener("click", () => {
        entry.close(() => signOut(auth));
      });
    }
  });
}

/* =========================================================
   Authentification
   ========================================================= */

function authErrorMessage(err) {
  switch (err?.code) {
    case "auth/unauthorized-domain":
      return "Ce domaine n’est pas autorisé. Ajoute-le dans Firebase : Authentication, Paramètres, Domaines autorisés.";
    case "auth/operation-not-allowed":
      return "La connexion Google n’est pas activée dans la console Firebase (Authentication, Méthodes de connexion).";
    case "auth/network-request-failed":
      return "Pas de connexion réseau. Vérifie ta connexion puis réessaie.";
    default:
      return "La connexion a échoué. Réessaie.";
  }
}

function showLoginError(err) {
  const el = $("#login-error");
  el.textContent = authErrorMessage(err);
  el.classList.remove("hidden");
}

async function login() {
  $("#login-error").classList.add("hidden");
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(err.code)) {
      return signInWithRedirect(auth, googleProvider);
    }
    if (["auth/popup-closed-by-user", "auth/cancelled-popup-request"].includes(err.code)) return;
    console.error(err);
    showLoginError(err);
  }
}

function startListeners() {
  stopListeners();
  state.ready = { sports: false, sessions: false };
  const onError = err => {
    console.error(err);
    toast(errorMessage(err), true);
  };
  state.unsub.push(onSnapshot(userCol("sports"), snap => {
    state.sports = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
    state.ready.sports = true;
    scheduleRender();
  }, onError));
  state.unsub.push(onSnapshot(userCol("sessions"), snap => {
    state.sessions = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
    state.ready.sessions = true;
    scheduleRender();
  }, onError));
  state.unsub.push(onSnapshot(userCol("measures"), snap => {
    state.measures = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(m => m.date).sort((a, b) => a.date.localeCompare(b.date));
    scheduleRender();
  }, onError));
  state.unsub.push(onSnapshot(userCol("maxes"), snap => {
    state.maxes = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(m => m.date);
    scheduleRender();
  }, onError));
  state.unsub.push(onSnapshot(userCol("logs"), snap => {
    state.logs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(l => l.date)
      .sort((a, b) => b.date.localeCompare(a.date) || ((b.createdAt?.seconds ?? Infinity) - (a.createdAt?.seconds ?? Infinity)));
    scheduleRender();
  }, onError));
  state.unsub.push(onSnapshot(userDoc("profile", "main"), snap => {
    state.profile = snap.exists() ? snap.data() : {};
    scheduleRender();
  }, onError));
}

function stopListeners() {
  state.unsub.forEach(fn => fn());
  state.unsub = [];
}

function showScreen(name) {
  $("#splash").classList.add("hidden");
  $("#login-screen").classList.toggle("hidden", name !== "login");
  $("#app").classList.toggle("hidden", name !== "app");
}

/* =========================================================
   Démarrage
   ========================================================= */

$("#btn-login").addEventListener("click", login);
$("#btn-account").addEventListener("click", openAccount);
$("#btn-timer").addEventListener("click", () => openTimer());

getRedirectResult(auth).catch(err => { console.error(err); showLoginError(err); });

onAuthStateChanged(auth, user => {
  state.user = user;
  if (user) {
    const avatar = $("#user-avatar");
    if (user.photoURL) {
      avatar.src = user.photoURL;
      $("#btn-account").classList.add("has-photo");
    } else {
      $("#btn-account").classList.remove("has-photo");
    }
    showScreen("app");
    renderLoading();
    startListeners();
  } else {
    stopListeners();
    state.sports = [];
    state.sessions = [];
    state.measures = [];
    state.maxes = [];
    state.logs = [];
    state.profile = {};
    imageCache.clear();
    showScreen("login");
  }
});
