// Service worker de Mes cadences : rappels de séance (heures réglées dans « Mon compte »).
// Reçoit le programme depuis la page, décide seul lors d'une synchronisation périodique,
// et affiche les messages push envoyés par la fonction planifiée (functions/).

importScripts("./js/reminders-core.js");

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

/* ---------------------------------------------------- Rappels */

const R = self.MCReminders;
// Rattrapage : un rappel manqué (appli fermée, téléphone en veille) est encore affiché
// pendant ce délai, sans dépasser minuit
const CATCH_UP_MIN = 5 * 60;

const remindersOf = snapshot => R.normalizeReminders(snapshot?.reminders);
const doneOn = (snapshot, date) => new Set((snapshot?.done || {})[date] || []);

function contentFor(r, snapshot, targetDate) {
  return R.buildReminder(r, snapshot?.sessions || [], targetDate, doneOn(snapshot, targetDate));
}

async function show(rid, date, content) {
  const flag = `shown:${rid}:${date}`;
  if (await kvGet(flag)) return;
  await kvSet(flag, true);
  await self.registration.showNotification(content.title, {
    body: content.body,
    icon: ICON,
    badge: ICON,
    tag: `mc-${rid}-${date}`,
    renotify: false,
    data: { url: content.url, rid, date }
  });
}

// Décision locale : chaque rappel dont l'heure est passée aujourd'hui (dans la fenêtre de rattrapage)
async function check(now = new Date()) {
  const snapshot = await kvGet("snapshot");
  if (!snapshot?.enabled) return;
  const today = dateKey(now);
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (const r of remindersOf(snapshot)) {
    if (!r.enabled) continue;
    const at = R.parseTime(r.time).total;
    if (minutes < at || minutes >= at + CATCH_UP_MIN) continue;
    const target = R.addDays(today, r.daysBefore);
    const content = contentFor(r, snapshot, target);
    if (content) await show(r.id, target, content);
  }
}

// Message de la fonction planifiée : on évite les doublons, les rappels supprimés
// et les séances validées entre-temps
async function handlePush(data) {
  const rid = data.rid || data.kind; // « kind » : anciens messages (morning / evening)
  if (!rid) return;
  const date = data.date || dateKey();
  const snapshot = await kvGet("snapshot");
  if (snapshot && snapshot.enabled === false) return;
  if (snapshot) {
    const r = remindersOf(snapshot).find(x => x.id === rid);
    if (snapshot.reminders && (!r || !r.enabled)) return;
    const pending = data.pending === "1" || (!data.rid && data.kind === "evening");
    if (pending) {
      const done = doneOn(snapshot, date);
      const ids = String(data.ids || "").split(",").filter(Boolean);
      if (ids.length && ids.every(id => done.has(id))) return;
    }
  }
  await show(rid, date, { title: data.title || "Mes cadences", body: data.body || "", url: data.url || "#/" });
}

// Séance validée après une relance : on retire la notification devenue inutile
async function closeObsolete(snapshot) {
  const today = dateKey();
  for (const r of remindersOf(snapshot)) {
    if (!r.onlyPending) continue;
    if (r.enabled && snapshot?.enabled && contentFor(r, snapshot, today)) continue;
    const list = await self.registration.getNotifications({ tag: `mc-${r.id}-${today}` });
    list.forEach(n => n.close());
  }
}

/* ---------------------------------------------------- Événements */

self.addEventListener("message", event => {
  const msg = event.data || {};
  if (msg.type === "snapshot") {
    event.waitUntil(kvSet("snapshot", msg.snapshot).then(() => closeObsolete(msg.snapshot)).then(() => check()));
  } else if (msg.type === "check") {
    event.waitUntil(check());
  } else if (msg.type === "push") {
    event.waitUntil(handlePush(msg.data || {}));
  } else if (msg.type === "test") {
    event.waitUntil(kvGet("snapshot").then(snapshot => {
      // Aperçu : le premier rappel actif qui aurait quelque chose à dire, sinon un message générique
      const today = dateKey();
      let r = null;
      for (const rem of remindersOf(snapshot).filter(x => x.enabled)) {
        r = contentFor({ ...rem, onlyPending: false }, snapshot, R.addDays(today, rem.daysBefore));
        if (r) break;
      }
      const count = remindersOf(snapshot).filter(x => x.enabled).length;
      return self.registration.showNotification(r ? r.title : "Rappels activés", {
        body: r ? r.body : count ? `${count} rappel${count > 1 ? "s" : ""} programmé${count > 1 ? "s" : ""}. Tu seras prévenu les jours de séance.` : "Aucun rappel programmé : ajoute-en depuis Mon compte.",
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
