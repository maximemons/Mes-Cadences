// Rappels de séance : toutes les heures, on regarde l'heure locale de chaque appareil inscrit.
//  - à 6 h : rappel des séances prévues dans la journée ;
//  - à 17 h : rappel des séances du jour qui ne sont pas encore dans l'historique.
// Les appareils s'inscrivent depuis « Mon compte » (users/{uid}/devices/{deviceId}).

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

const WEEKDAYS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

// Date, heure et jour (0 = lundi) dans le fuseau de l'appareil
function localParts(now, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hourCycle: "h23", weekday: "short"
    }).formatToParts(now);
  } catch {
    return localParts(now, "Europe/Paris");
  }
  const get = type => parts.find(p => p.type === type)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    day: WEEKDAYS[get("weekday")]
  };
}

const listNames = list => list.map(s => `${s.name} (${s.sportName})`).join(", ");
const sessionUrl = list => (list.length === 1 ? `#/sport/${list[0].sportId}/session/${list[0].id}` : "#/");

function buildMessage(kind, planned, doneIds) {
  if (kind === "morning") {
    return {
      title: planned.length === 1 ? `Aujourd’hui : ${planned[0].name}` : `${planned.length} séances aujourd’hui`,
      body: planned.length === 1 ? `${planned[0].sportName} au programme. Bonne séance !` : `Au programme : ${listNames(planned)}.`,
      url: sessionUrl(planned),
      ids: planned.map(s => s.id)
    };
  }
  const pending = planned.filter(s => !doneIds.has(s.id));
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

// Programme d'un compte (mis en cache le temps d'un passage)
async function loadProgram(uid, cache) {
  if (cache.has(uid)) return cache.get(uid);
  const user = db.collection("users").doc(uid);
  const [sportsSnap, sessionsSnap] = await Promise.all([user.collection("sports").get(), user.collection("sessions").get()]);
  const sports = new Map(sportsSnap.docs.map(d => [d.id, d.data()]));
  const sessions = sessionsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => sports.has(s.sportId) && Array.isArray(s.days) && s.days.length)
    .map(s => ({ id: s.id, name: s.name || "Séance", sportId: s.sportId, sportName: sports.get(s.sportId).name || "", days: s.days }));
  cache.set(uid, sessions);
  return sessions;
}

async function doneOn(uid, date) {
  const snap = await db.collection("users").doc(uid).collection("logs").where("date", "==", date).get();
  return new Set(snap.docs.map(d => d.data().sessionId));
}

exports.sessionReminders = onSchedule(
  { schedule: "0 * * * *", timeZone: "Etc/UTC", region: "europe-west1", retryCount: 0 },
  async () => {
    const now = new Date();
    const devices = await db.collectionGroup("devices").get();
    const cache = new Map();
    let sent = 0;

    for (const device of devices.docs) {
      const data = device.data();
      const uid = device.ref.parent.parent?.id;
      if (!uid || !data.token) continue;

      const local = localParts(now, data.tz || "Europe/Paris");
      const kind = local.hour === (data.morningHour ?? 6) ? "morning"
        : local.hour === (data.eveningHour ?? 17) ? "evening" : null;
      if (!kind) continue;

      try {
        const planned = (await loadProgram(uid, cache)).filter(s => s.days.includes(local.day));
        if (!planned.length) continue;
        const done = kind === "evening" ? await doneOn(uid, local.date) : new Set();
        const msg = buildMessage(kind, planned, done);
        if (!msg) continue;

        await getMessaging().send({
          token: data.token,
          data: { kind, date: local.date, title: msg.title, body: msg.body, url: msg.url, ids: msg.ids.join(",") },
          webpush: { headers: { Urgency: "high", TTL: String(4 * 3600) } }
        });
        sent++;
      } catch (err) {
        const code = err?.errorInfo?.code || err?.code || "";
        if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token") || code.includes("invalid-argument")) {
          await device.ref.delete(); // jeton expiré : l'appareil se réinscrira à la prochaine ouverture
        } else {
          logger.error("Rappel non envoyé", { code, message: err?.message });
        }
      }
    }
    logger.info(`Rappels envoyés : ${sent}`);
  }
);
