// Service worker de Mes cadences : rappels de séance (6 h et 17 h).
// Reçoit le programme depuis la page, décide seul lors d'une synchronisation périodique,
// et affiche les messages push envoyés par la fonction planifiée (functions/).

const MORNING_HOUR = 6;
const EVENING_HOUR = 17;
const ICON = "icons/icon-192.png";

// Firebase Cloud Messaging (messages push quand l'appli est fermée)
try {
  importScripts(
    "https://www.gstatic.com/firebasejs/11.0.0/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/11.0.0/firebase-messaging-compat.js"
  );
  firebase.initializeApp({
    apiKey: "AIzaSyDN4cCG7XqM6IKIsiII0L9B-wXNzryvHvI",
    authDomain: "mes-cadences.firebaseapp.com",
    projectId: "mes-cadences",
    storageBucket: "mes-cadences.firebasestorage.app",
    messagingSenderId: "434791599036",
    appId: "1:434791599036:web:28430979745b74a645f9b9"
  });
  firebase.messaging().onBackgroundMessage(payload => handlePush(payload.data || {}));
} catch (err) {
  // Hors ligne au premier chargement : les rappels locaux fonctionnent quand même
  console.warn("FCM indisponible", err);
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

/* ---------------------------------------------------- Petit stockage IndexedDB */

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("mes-cadences-sw", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("kv").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------------------------------------------- Dates */

function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const dayIdx = (d = new Date()) => (d.getDay() + 6) % 7; // 0 = lundi

/* ---------------------------------------------------- Contenu des rappels */

const listNames = list => list.map(s => `${s.name}${s.sportName ? ` (${s.sportName}${s.optional ? ", facultative" : ""})` : s.optional ? " (facultative)" : ""}`).join(", ");

const sessionUrl = list => (list.length === 1 && list[0].sportId ? `#/sport/${list[0].sportId}/session/${list[0].id}` : "#/");

function buildReminder(kind, snapshot, now = new Date()) {
  if (!snapshot?.enabled) return null;
  const today = dateKey(now);
  const day = dayIdx(now);
  // « optional » est ramené au jour même : une séance peut n'être facultative que certains jours
  const planned = (snapshot.sessions || [])
    .filter(s => (s.days || []).includes(day))
    .map(s => ({ ...s, optional: Array.isArray(s.optionalDays) ? s.optionalDays.includes(day) : !!s.optional }));
  if (!planned.length) return null;
  const done = new Set((snapshot.done || {})[today] || []);

  if (kind === "morning") {
    // Les séances facultatives sont proposées le matin, sans être présentées comme obligatoires
    const allOptional = planned.every(s => s.optional);
    return {
      title: planned.length === 1
        ? `${allOptional ? "Facultatif aujourd’hui" : "Aujourd’hui"} : ${planned[0].name}`
        : `${planned.length} séances ${allOptional ? "facultatives " : ""}aujourd’hui`,
      body: planned.length === 1
        ? (allOptional ? `${planned[0].sportName || "Séance"} en option, si tu en as envie.` : `${planned[0].sportName || "Séance"} au programme. Bonne séance !`)
        : `Au programme : ${listNames(planned)}.`,
      url: sessionUrl(planned),
      ids: planned.map(s => s.id)
    };
  }
  // Pas de relance pour une séance facultative non faite
  const pending = planned.filter(s => !s.optional && !done.has(s.id));
  if (!pending.length) return null;
  return {
    title: pending.length === 1 ? `${pending[0].name} n’est pas encore faite` : `${pending.length} séances pas encore faites`,
    body: pending.length === 1
      ? `${pending[0].sportName ? `Séance de ${pending[0].sportName.toLowerCase()} prévue` : "Prévue"} aujourd’hui. Si c’est fait, marque-la comme effectuée.`
      : `${listNames(pending)}. Si c’est fait, marque-les comme effectuées.`,
    url: sessionUrl(pending),
    ids: pending.map(s => s.id)
  };
}

async function show(kind, date, content) {
  const flag = `shown:${kind}:${date}`;
  if (await kvGet(flag)) return;
  await kvSet(flag, true);
  await self.registration.showNotification(content.title, {
    body: content.body,
    icon: ICON,
    badge: ICON,
    tag: `mc-${kind}-${date}`,
    renotify: false,
    data: { url: content.url, kind, date }
  });
}

// Décision locale : fenêtre du matin (6 h – 11 h) et du soir (17 h – 22 h)
async function check(now = new Date()) {
  const snapshot = await kvGet("snapshot");
  if (!snapshot?.enabled) return;
  const h = now.getHours();
  const today = dateKey(now);
  if (h >= MORNING_HOUR && h < 12) {
    const r = buildReminder("morning", snapshot, now);
    if (r) await show("morning", today, r);
  }
  if (h >= EVENING_HOUR && h < 23) {
    const r = buildReminder("evening", snapshot, now);
    if (r) await show("evening", today, r);
  }
}

// Message de la fonction planifiée : on évite les doublons et les séances validées entre-temps
async function handlePush(data) {
  const kind = data.kind === "evening" ? "evening" : data.kind === "morning" ? "morning" : null;
  if (!kind) return;
  const date = data.date || dateKey();
  const snapshot = await kvGet("snapshot");
  if (snapshot && snapshot.enabled === false) return;
  if (kind === "evening" && snapshot) {
    const done = new Set((snapshot.done || {})[date] || []);
    const ids = String(data.ids || "").split(",").filter(Boolean);
    if (ids.length && ids.every(id => done.has(id))) return;
  }
  await show(kind, date, { title: data.title || "Mes cadences", body: data.body || "", url: data.url || "#/" });
}

// Séance validée après le rappel du soir : on retire la notification devenue inutile
async function closeObsolete(snapshot) {
  const today = dateKey();
  if (buildReminder("evening", snapshot)) return;
  const list = await self.registration.getNotifications({ tag: `mc-evening-${today}` });
  list.forEach(n => n.close());
}

/* ---------------------------------------------------- Événements */

self.addEventListener("message", event => {
  const msg = event.data || {};
  if (msg.type === "snapshot") {
    event.waitUntil(kvSet("snapshot", msg.snapshot).then(() => closeObsolete(msg.snapshot)));
  } else if (msg.type === "check") {
    event.waitUntil(check());
  } else if (msg.type === "push") {
    event.waitUntil(handlePush(msg.data || {}));
  } else if (msg.type === "test") {
    event.waitUntil(kvGet("snapshot").then(snapshot => {
      const r = buildReminder("morning", { ...snapshot, enabled: true });
      return self.registration.showNotification(r ? r.title : "Rappels activés", {
        body: r ? r.body : `Tu seras prévenu à ${MORNING_HOUR} h les jours de séance, et à ${EVENING_HOUR} h si une séance n’est pas faite.`,
        icon: ICON,
        badge: ICON,
        tag: "mc-test",
        data: { url: r ? r.url : "#/" }
      });
    }));
  }
});

self.addEventListener("periodicsync", event => {
  if (event.tag === "mc-reminders") event.waitUntil(check());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const hash = event.notification.data?.url || "#/";
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find(c => c.url.startsWith(scope));
    if (client) {
      client.postMessage({ type: "navigate", hash });
      return client.focus();
    }
    return self.clients.openWindow(scope + hash);
  })());
});
