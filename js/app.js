import { auth, db, googleProvider } from "./firebase-config.js";
import { TEMPLATES } from "./templates.js";
import { openRestTimer, openTimer } from "./timer.js";
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
    const d = parseDistanceKm(ex.reps);
    if (d) extra += `, soit ${fmtDistance(d)} en ${fmtRunTime(d / v * 3600)}`;
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
  if (!top.force && top.isDirty && top.isDirty() && !confirm("Fermer sans enregistrer les modifications ?")) {
    history.pushState({ mcSheet: sheetStack.length }, "");
    return;
  }
  destroySheet(top);
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && sheetStack.length) history.back();
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
  fab.innerHTML = `<i class="fa-solid ${config.icon || "fa-plus"}"></i><span>${esc(config.label)}</span>`;
  fab.classList.remove("hidden");
  fab.onclick = config.onClick;
}

/* =========================================================
   Routage (#/, #/sport/:id, #/sport/:id/session/:sid)
   ========================================================= */

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  return { sportId: parts[0] === "sport" ? parts[1] : null, sessionId: parts[2] === "session" ? parts[3] : null };
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
  const { sportId, sessionId } = parseRoute();
  const routeKey = `${sportId}/${sessionId}`;
  const routeChanged = routeKey !== lastRouteKey;
  lastRouteKey = routeKey;

  if (!state.ready.sports || !state.ready.sessions) {
    renderLoading();
    return;
  }

  if (sportId) {
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
      ${todays.length ? `
        <div class="today-list">
          ${todays.map(s => {
            const sp = sportOf(s);
            const prog = getProgress(s.id);
            const total = (s.exercises || []).reduce((n, ex) => n + setsCount(ex), 0);
            const done = (s.exercises || []).reduce((n, ex) => n + Math.min(prog[ex.id] || 0, setsCount(ex)), 0);
            return `
              <a class="today-card" href="#/sport/${sp.id}/session/${s.id}" style="--sport:${sp.color}">
                <span class="sport-badge"><i class="fa-solid ${sp.icon}"></i></span>
                <span class="today-card-text">
                  <strong>${esc(s.name)}</strong>
                  <span>${esc(sp.name)}, ${(s.exercises || []).length} exercice${(s.exercises || []).length > 1 ? "s" : ""}</span>
                </span>
                ${total ? `<span class="mini-progress" aria-label="${done} séries sur ${total}"><span style="width:${Math.round(done / total * 100)}%"></span></span>` : ""}
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
    actions: [{ icon: "fa-pen", label: "Modifier le sport", onClick: () => openSportEditor(sport) }]
  });
  setFab({ label: "Nouvelle séance", onClick: () => openSessionEditor(sport) });

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
          <button type="button" class="btn btn-small btn-ghost" data-edit-refs><i class="fa-solid fa-pen"></i> ${refs.length ? "Modifier" : "Ajouter"}</button>
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

      ${!list.length ? `<p class="empty-hint">Ajoute ta première séance avec le bouton « Nouvelle séance ».</p>` : ""}
    </div>`;

  $("[data-edit-refs]").addEventListener("click", () => openRefsEditor(sport));
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

      ${done > 0 ? `<button type="button" class="btn btn-ghost btn-block" data-reset><i class="fa-solid fa-rotate-left"></i> Remettre la séance à zéro</button>` : ""}
    </div>`;

  const view = $("#view");
  hydrateImages(view);
  $("[data-edit-session]", view)?.addEventListener("click", () => openSessionEditor(sport, session));
  $("[data-reset]", view)?.addEventListener("click", () => {
    if (!confirm("Effacer les séries validées aujourd’hui pour cette séance ?")) return;
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
          <p class="ex-volume">${sets} × ${esc(ex.reps || "?")}</p>
          ${intensity}
        </div>
        ${ex.imageId ? `
          <button type="button" class="ex-thumb is-loading" aria-label="Agrandir l’image de ${esc(ex.name)}">
            <img data-image-id="${esc(ex.imageId)}" alt="">
          </button>` : ""}
      </div>

      <label class="ex-load">
        <span>Ma charge</span>
        <input type="text" data-load value="${esc(ex.load || "")}" placeholder="ex. 82,5 kg ou 4′30″/km" enterkeyhint="done" autocomplete="off">
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
      if (all) toast("Séance terminée, bravo !");
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
        reps: ex.reps,
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

      $("[data-delete]", el)?.addEventListener("click", () => {
        const msg = count
          ? `Supprimer « ${sport.name} » et ses ${count} séance${count > 1 ? "s" : ""} ? Cette action est définitive.`
          : `Supprimer « ${sport.name} » ? Cette action est définitive.`;
        if (!confirm(msg)) return;
        deleteSport(sport);
        entry.close(() => { location.hash = "#/"; });
      });
    }
  });
}

function deleteSport(sport) {
  const batch = writeBatch(db);
  sessionsOf(sport.id).forEach(s => {
    (s.exercises || []).forEach(ex => { if (ex.imageId) batch.delete(userDoc("images", ex.imageId)); });
    batch.delete(userDoc("sessions", s.id));
  });
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
    <p class="muted">Un repère est une valeur de référence : ta charge maximale sur un mouvement, ta VMA, ta FTP… Dans tes séances, une intensité de 80 % sera calculée à partir de ce repère.</p>
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
      const bindRemove = row => $("[data-remove]", row).addEventListener("click", () => {
        if (used.has(row.dataset.refId) && !confirm("Ce repère est utilisé dans tes séances. Le supprimer quand même ?")) return;
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
        persist(updateDoc(userDoc("sports", sport.id), { refs, updatedAt: serverTimestamp() }), "Repères enregistrés");
        entry.close();
      });
    }
  });
}

/* =========================================================
   Éditeur : séance et exercices
   ========================================================= */

function exerciseBlock(ex, refs) {
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

      <div class="exb-grid">
        <label class="field field--compact">
          <span class="field-label">Séries</span>
          <input type="number" data-f="sets" value="${esc(ex.sets)}" min="1" max="30" inputmode="numeric" placeholder="3">
        </label>
        <label class="field field--compact">
          <span class="field-label">Répétitions</span>
          <input type="text" data-f="reps" value="${esc(ex.reps)}" placeholder="10, 400 m, 30 s">
        </label>
        <label class="field field--compact">
          <span class="field-label">Intensité (%)</span>
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
          <span class="field-label">Ma charge</span>
          <input type="text" data-f="load" value="${esc(ex.load)}" placeholder="80 kg">
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

function blankExercise() {
  return { id: newId(), name: "", sets: 3, reps: "10", pct: "", refId: "", rest: 90, load: "", notes: "", imageId: null };
}

function openSessionEditor(sport, session = null) {
  const isNew = !session;
  const refs = sport.refs || [];
  const original = session ? JSON.parse(JSON.stringify(session)) : null;
  const startExercises = session?.exercises?.length ? session.exercises : [blankExercise()];

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
        return {
          id: block.dataset.exId,
          name: f("name"),
          sets: Number.isFinite(sets) && sets > 0 ? sets : 1,
          reps: f("reps"),
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

        $("[data-remove]", block).addEventListener("click", () => {
          const name = $('[data-f="name"]', block).value.trim();
          if (name && !confirm(`Supprimer « ${name} » ?`)) return;
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
        const ex = blankExercise();
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

      $("[data-delete]", el)?.addEventListener("click", () => {
        if (!confirm(`Supprimer la séance « ${session.name} » ? Cette action est définitive.`)) return;
        const batch = writeBatch(db);
        (session.exercises || []).forEach(ex => { if (ex.imageId) batch.delete(userDoc("images", ex.imageId)); });
        batch.delete(userDoc("sessions", session.id));
        persist(batch.commit(), "Séance supprimée");
        entry.close(() => { location.hash = `#/sport/${sport.id}`; });
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
    imageCache.clear();
    showScreen("login");
  }
});
