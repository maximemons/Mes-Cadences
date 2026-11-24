// Rappels de séance : toutes les 5 minutes, on regarde l'heure locale de chaque appareil inscrit
// et les rappels réglés dans le compte (users/{uid}/profile/main → reminders ; par défaut 6 h et 17 h).
// Chaque rappel vise les séances du jour même ou d'un jour suivant (la veille, deux jours avant…) ;
// un rappel « seulement si pas faite » ne relance que les séances du jour absentes de l'historique
// (jamais les séances facultatives).
// Les appareils s'inscrivent depuis « Mon compte » (users/{uid}/devices/{deviceId}).
//
// reminders-core.js est une copie de js/reminders-core.js (recopiée au déploiement, voir firebase.json).

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const R = require("./reminders-core.js");

initializeApp();
const db = getFirestore();

const STEP_MIN = 5; // doit correspondre à la planification ci-dessous

// Date et minute de la journée dans le fuseau de l'appareil
function localParts(when, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(when);
  } catch {
    return localParts(when, "Europe/Paris");
  }
  const get = type => parts.find(p => p.type === type)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute"))
  };
}

// Rappels dont l'heure tombe dans le créneau qui vient de s'écouler (]t − 5 min ; t]),
// avec la date locale à laquelle ils devaient partir (utile autour de minuit)
function dueReminders(reminders, slot, tz) {
  const local = localParts(slot, tz);
  const due = [];
  for (const r of reminders) {
    if (!r.enabled) continue;
    const diff = (((local.minutes - R.parseTime(r.time).total) % 1440) + 1440) % 1440;
    if (diff >= STEP_MIN) continue;
    const fireDate = diff ? localParts(new Date(slot.getTime() - diff * 60000), tz).date : local.date;
    due.push({ r, fireDate, targetDate: R.addDays(fireDate, r.daysBefore) });
  }
  return due;
}

// Rappels d'un compte (mis en cache le temps d'un passage)
async function loadReminders(uid, cache) {
  if (cache.has(uid)) return cache.get(uid);
  const snap = await db.collection("users").doc(uid).collection("profile").doc("main").get();
  const list = R.normalizeReminders(snap.exists ? snap.data().reminders : undefined);
  cache.set(uid, list);
  return list;
}

// Programme d'un compte (mis en cache le temps d'un passage)
async function loadProgram(uid, cache) {
  if (cache.has(uid)) return cache.get(uid);
  const user = db.collection("users").doc(uid);
  const [sportsSnap, sessionsSnap] = await Promise.all([user.collection("sports").get(), user.collection("sessions").get()]);
  const sports = new Map(sportsSnap.docs.map(d => [d.id, d.data()]));
  const sessions = sessionsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => sports.has(s.sportId) && Array.isArray(s.days) && s.days.length)
    .map(s => ({
      id: s.id, name: s.name || "Séance", sportId: s.sportId, sportName: sports.get(s.sportId).name || "", days: s.days,
      // Jours où la séance est facultative (sans optionalDays : tous ses jours si elle est marquée facultative)
      optionalDays: !s.optional ? [] : Array.isArray(s.optionalDays) ? s.days.filter(d => s.optionalDays.includes(d)) : [...s.days]
    }));
  cache.set(uid, sessions);
  return sessions;
}

async function doneOn(uid, date, cache) {
  const key = `${uid}|${date}`;
  if (cache.has(key)) return cache.get(key);
  const snap = await db.collection("users").doc(uid).collection("logs").where("date", "==", date).get();
  const set = new Set(snap.docs.map(d => d.data().sessionId));
  cache.set(key, set);
  return set;
}

exports.sessionReminders = onSchedule(
  { schedule: `*/${STEP_MIN} * * * *`, timeZone: "Etc/UTC", region: "europe-west1", retryCount: 0 },
  async event => {
    // Heure prévue du passage (et non l'heure réelle, qui peut avoir quelques secondes de retard)
    const planned = new Date(event?.scheduleTime || Date.now());
    const slot = new Date(Math.floor(planned.getTime() / (STEP_MIN * 60000)) * STEP_MIN * 60000);
    const devices = await db.collectionGroup("devices").get();
    const caches = { reminders: new Map(), program: new Map(), done: new Map() };
    let sent = 0;

    for (const device of devices.docs) {
      const data = device.data();
      const uid = device.ref.parent.parent?.id;
      if (!uid || !data.token) continue;
      const tz = data.tz || "Europe/Paris";

      try {
        const due = dueReminders(await loadReminders(uid, caches.reminders), slot, tz);
        if (!due.length) continue;
        const sessions = await loadProgram(uid, caches.program);

        for (const { r, targetDate } of due) {
          const done = r.onlyPending ? await doneOn(uid, targetDate, caches.done) : new Set();
          const msg = R.buildReminder(r, sessions, targetDate, done);
          if (!msg) continue;
          await getMessaging().send({
            token: data.token,
            data: {
              rid: r.id, date: targetDate, pending: msg.pending ? "1" : "0",
              title: msg.title, body: msg.body, url: msg.url, ids: msg.ids.join(",")
            },
            webpush: { headers: { Urgency: "high", TTL: String(4 * 3600) } }
          });
          sent++;
        }
      } catch (err) {
        const code = err?.errorInfo?.code || err?.code || "";
        if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token") || code.includes("invalid-argument")) {
          await device.ref.delete(); // jeton expiré : l'appareil se réinscrira à la prochaine ouverture
        } else {
          logger.error("Rappel non envoyé", { code, message: err?.message });
        }
      }
    }
    if (sent) logger.info(`Rappels envoyés : ${sent}`);
  }
);
