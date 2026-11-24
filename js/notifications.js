// Rappels de séance : notification à 6 h s'il y a une séance prévue dans la journée,
// puis à 17 h pour chaque séance du jour qui n'est pas encore marquée comme faite.
//
// Trois mécanismes se complètent, sans doublon (le service worker note ce qu'il a déjà affiché) :
//  1. Push (Firebase Cloud Messaging + fonction planifiée) : fonctionne appli fermée.
//     Nécessite la clé VAPID (firebase-config.js) et le déploiement de functions/.
//  2. Synchronisation périodique en arrière-plan (Chrome/Android, appli installée).
//  3. Minuteurs locaux tant que l'appli est ouverte, et rattrapage à l'ouverture.

import { app, db, vapidKey } from "./firebase-config.js";
import { doc, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";

export const MORNING_HOUR = 6;
export const EVENING_HOUR = 17;

const PREF_KEY = "mc:notif";
const DEVICE_KEY = "mc:device-id";
const SYNC_TAG = "mc-reminders";

let uid = null;
let timer = null;
let lastSnapshot = null;
let messagingApi = null;

const supported = () =>
  "Notification" in window && "serviceWorker" in navigator && window.isSecureContext;

export function notifStatus() {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "granted" && localStorage.getItem(PREF_KEY) === "on") return "on";
  return "off";
}

export const pushConfigured = () => !!vapidKey;

function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, "").slice(0, 20);
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

let regPromise = null;
function registration() {
  if (!supported()) return Promise.resolve(null);
  if (!regPromise) {
    regPromise = navigator.serviceWorker.register("./sw.js", { scope: "./" })
      .then(() => navigator.serviceWorker.ready)
      .catch(err => { console.error("Service worker", err); regPromise = null; return null; });
  }
  return regPromise;
}

async function post(message) {
  const reg = await registration();
  reg?.active?.postMessage(message);
}

async function loadMessaging() {
  if (messagingApi || !vapidKey) return messagingApi;
  try {
    const mod = await import("https://www.gstatic.com/firebasejs/11.0.0/firebase-messaging.js");
    if (!(await mod.isSupported())) return null;
    messagingApi = { mod, messaging: mod.getMessaging(app) };
    // Appli au premier plan : FCM remet le message à la page, on le confie au service worker
    mod.onMessage(messagingApi.messaging, payload => post({ type: "push", data: payload.data || {} }));
  } catch (err) {
    console.error("Firebase Messaging", err);
    messagingApi = null;
  }
  return messagingApi;
}

// Enregistre (ou rafraîchit) le jeton push de cet appareil dans le compte
async function registerPush() {
  if (!uid) return false;
  const api = await loadMessaging();
  const reg = await registration();
  if (!api || !reg) return false;
  try {
    const token = await api.mod.getToken(api.messaging, { vapidKey, serviceWorkerRegistration: reg });
    if (!token) return false;
    await setDoc(doc(db, "users", uid, "devices", deviceId()), {
      token,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Paris",
      morningHour: MORNING_HOUR,
      eveningHour: EVENING_HOUR,
      updatedAt: serverTimestamp()
    });
    return true;
  } catch (err) {
    console.error("Jeton push", err);
    return false;
  }
}

async function unregisterPush(userId = uid) {
  if (!userId) return;
  try {
    const api = await loadMessaging();
    if (api) await api.mod.deleteToken(api.messaging).catch(() => {});
  } catch { /* rien à faire */ }
  await deleteDoc(doc(db, "users", userId, "devices", deviceId())).catch(() => {});
}

async function registerPeriodicSync(reg) {
  if (!reg || !("periodicSync" in reg)) return;
  try {
    const perm = await navigator.permissions.query({ name: "periodic-background-sync" });
    if (perm.state === "granted") await reg.periodicSync.register(SYNC_TAG, { minInterval: 60 * 60 * 1000 });
  } catch { /* non pris en charge */ }
}

// Prochain passage à 6 h ou 17 h (quelques secondes après l'heure pile)
function scheduleLocalChecks() {
  clearTimeout(timer);
  if (notifStatus() !== "on") return;
  const now = new Date();
  const candidates = [MORNING_HOUR, EVENING_HOUR, MORNING_HOUR + 24].map(h => {
    const d = new Date(now);
    d.setHours(h, 0, 5, 0);
    return d;
  }).filter(d => d > now);
  const delay = Math.min(candidates[0] - now, 2 ** 31 - 1);
  timer = setTimeout(() => { post({ type: "check" }); scheduleLocalChecks(); }, delay);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && notifStatus() === "on") {
    post({ type: "check" });
    scheduleLocalChecks();
  }
});

// Clic sur une notification alors que l'appli est déjà ouverte
if (supported()) {
  navigator.serviceWorker.addEventListener("message", e => {
    if (e.data?.type === "navigate" && e.data.hash) location.hash = e.data.hash;
  });
}

/* ------------------------------------------------------------------ API */

// À la connexion : remet en route les rappels si cet appareil les a activés
export async function initNotifications(userId) {
  uid = userId;
  if (!supported()) return;
  const reg = await registration();
  if (notifStatus() !== "on") {
    if (lastSnapshot) post({ type: "snapshot", snapshot: { ...lastSnapshot, enabled: false } });
    return;
  }
  registerPeriodicSync(reg);
  scheduleLocalChecks();
  if (vapidKey) registerPush();
}

export async function enableNotifications() {
  if (!supported()) throw new Error("unsupported");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, permission: perm };
  localStorage.setItem(PREF_KEY, "on");
  const reg = await registration();
  if (lastSnapshot) post({ type: "snapshot", snapshot: { ...lastSnapshot, enabled: true } });
  registerPeriodicSync(reg);
  scheduleLocalChecks();
  const push = vapidKey ? await registerPush() : false;
  return { ok: true, push };
}

export async function disableNotifications(userId = uid) {
  localStorage.removeItem(PREF_KEY);
  clearTimeout(timer);
  const reg = await registration();
  if (lastSnapshot) post({ type: "snapshot", snapshot: { ...lastSnapshot, enabled: false } });
  try { await reg?.periodicSync?.unregister(SYNC_TAG); } catch { /* rien */ }
  await unregisterPush(userId);
}

// Déconnexion : on arrête les rappels du compte sur cet appareil
export async function stopNotificationsForLogout() {
  const wasOn = notifStatus() === "on";
  await Promise.race([disableNotifications(uid), new Promise(r => setTimeout(r, 2000))]);
  uid = null;
  lastSnapshot = null;
  return wasOn;
}

export async function testNotification() {
  post({ type: "test" });
}

// Le service worker a besoin du programme et des séances faites pour décider seul
export function syncSnapshot(snapshot) {
  const json = JSON.stringify(snapshot);
  if (lastSnapshot && JSON.stringify(lastSnapshot) === json) return;
  lastSnapshot = snapshot;
  post({ type: "snapshot", snapshot: { ...snapshot, enabled: notifStatus() === "on" } });
}
