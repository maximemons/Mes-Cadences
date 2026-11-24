// Rappels personnalisables : logique commune à l'appli (module), au service worker (importScripts)
// et à la fonction planifiée (require). Une copie est placée dans functions/ au déploiement.
//
// Un rappel (users/{uid}/profile/main → reminders[]) :
//   id           identifiant
//   time         "HH:MM", heure locale de l'appareil
//   daysBefore   0 = le jour même, 1 = la veille, 2 = deux jours avant…
//   onlyPending  le jour même seulement : n'envoyer que si une séance prévue n'est pas encore faite
//                (les séances facultatives ne sont jamais relancées)
//   sportId      null = tous les sports, sinon un seul sport
//   note         message libre ajouté à la notification (ex. « Prépare ton sac »)
//   enabled      actif ou non

(function (root) {
  const MAX_DAYS_BEFORE = 6;
  const MAX_REMINDERS = 30;

  // Comportement historique : 6 h et 17 h (ids conservés pour les messages push déjà en route)
  const DEFAULT_REMINDERS = [
    { id: "morning", time: "06:00", daysBefore: 0, onlyPending: false, sportId: null, note: "", enabled: true },
    { id: "evening", time: "17:00", daysBefore: 0, onlyPending: true, sportId: null, note: "", enabled: true }
  ];

  const pad = n => String(n).padStart(2, "0");

  function parseTime(t) {
    const m = String(t || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return { h, m: min, total: h * 60 + min };
  }

  function normalizeOne(r) {
    if (!r || typeof r !== "object") return null;
    const t = parseTime(r.time);
    if (!t) return null;
    const daysBefore = Math.min(MAX_DAYS_BEFORE, Math.max(0, Math.round(Number(r.daysBefore) || 0)));
    return {
      id: String(r.id || "").slice(0, 40) || Math.random().toString(36).slice(2, 12),
      time: `${pad(t.h)}:${pad(t.m)}`,
      daysBefore,
      onlyPending: daysBefore === 0 && !!r.onlyPending,
      sportId: r.sportId ? String(r.sportId) : null,
      note: String(r.note || "").trim().slice(0, 120),
      enabled: r.enabled !== false
    };
  }

  // Ordre chronologique d'envoi : d'abord les rappels les plus en avance (veille…), puis l'heure
  const sortKey = r => -r.daysBefore * 1440 + parseTime(r.time).total;

  // Sans réglage enregistré : 6 h et 17 h. Une liste vide est un choix (aucun rappel).
  function normalizeReminders(list) {
    if (!Array.isArray(list)) return DEFAULT_REMINDERS.map(r => ({ ...r }));
    const seen = new Set();
    return list.map(normalizeOne)
      .filter(r => r && !seen.has(r.id) && seen.add(r.id))
      .slice(0, MAX_REMINDERS)
      .sort((a, b) => sortKey(a) - sortKey(b));
  }

  /* ------------------------------------------------ Dates (clés AAAA-MM-JJ, calendrier local) */

  function addDays(key, n) {
    const [y, m, d] = key.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  }

  // 0 = lundi
  function dayOfKey(key) {
    const [y, m, d] = key.split("-").map(Number);
    return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  }

  /* ------------------------------------------------ Textes */

  function whenWord(n) {
    if (n === 0) return "aujourd’hui";
    if (n === 1) return "demain";
    if (n === 2) return "après-demain";
    return `dans ${n} jours`;
  }

  function whenLabel(n) {
    if (n === 0) return "Le jour même";
    if (n === 1) return "La veille";
    return `${n} jours avant`;
  }

  const fmtTime = t => {
    const p = parseTime(t);
    return p ? `${p.h} h${p.m ? ` ${pad(p.m)}` : ""}` : t;
  };

  // Résumé lisible d'un rappel, ex. « La veille à 20 h 30 · toutes les séances »
  function describe(r, sportName) {
    const what = r.onlyPending ? "si une séance n’est pas faite" : "séances prévues";
    return `${whenLabel(r.daysBefore)} à ${fmtTime(r.time)} · ${what}${sportName ? ` · ${sportName}` : ""}`;
  }

  const capital = s => s.charAt(0).toUpperCase() + s.slice(1);

  const listNames = list => list.map(s =>
    `${s.name}${s.sportName ? ` (${s.sportName}${s.optional ? ", facultative" : ""})` : s.optional ? " (facultative)" : ""}`
  ).join(", ");

  const sessionUrl = list => (list.length === 1 && list[0].sportId ? `#/sport/${list[0].sportId}/session/${list[0].id}` : "#/");

  // Séances prévues le jour cible, avec « optional » ramené à ce jour-là
  function plannedOn(sessions, day, sportId) {
    return (sessions || [])
      .filter(s => (s.days || []).includes(day) && (!sportId || s.sportId === sportId))
      .map(s => ({ ...s, optional: Array.isArray(s.optionalDays) ? s.optionalDays.includes(day) : !!s.optional }));
  }

  // Contenu de la notification, ou null s'il n'y a rien à rappeler
  //   sessions : [{ id, name, sportId, sportName, days, optionalDays }]
  //   targetDate : jour des séances (AAAA-MM-JJ) ; doneIds : séances déjà faites ce jour-là
  function buildReminder(r, sessions, targetDate, doneIds) {
    const planned = plannedOn(sessions, dayOfKey(targetDate), r.sportId);
    if (!planned.length) return null;
    const when = whenWord(r.daysBefore);
    const withNote = body => (r.note ? `${r.note}\n${body}` : body);

    if (r.onlyPending) {
      const done = doneIds instanceof Set ? doneIds : new Set(doneIds || []);
      const pending = planned.filter(s => !s.optional && !done.has(s.id));
      if (!pending.length) return null;
      return {
        title: pending.length === 1 ? `${pending[0].name} n’est pas encore faite` : `${pending.length} séances pas encore faites`,
        body: withNote(pending.length === 1
          ? `${pending[0].sportName ? `Séance de ${pending[0].sportName.toLowerCase()} prévue` : "Prévue"} aujourd’hui. Si c’est fait, marque-la comme effectuée.`
          : `${listNames(pending)}. Si c’est fait, marque-les comme effectuées.`),
        url: sessionUrl(pending),
        ids: pending.map(s => s.id),
        pending: true
      };
    }

    // Les séances facultatives sont proposées, sans être présentées comme obligatoires
    const allOptional = planned.every(s => s.optional);
    const one = planned[0];
    let body;
    if (planned.length > 1) body = `Au programme : ${listNames(planned)}.`;
    else if (allOptional) body = `${one.sportName || "Séance"} en option, si tu en as envie.`;
    else if (r.daysBefore === 0) body = `${one.sportName || "Séance"} au programme. Bonne séance !`;
    else body = `${one.sportName || "Séance"} au programme ${when}.${r.note ? "" : " Pense à préparer tes affaires."}`;
    return {
      title: planned.length === 1
        ? `${allOptional ? `Facultatif ${when}` : capital(when)} : ${one.name}`
        : `${planned.length} séances ${allOptional ? "facultatives " : ""}${when}`,
      body: withNote(body),
      url: sessionUrl(planned),
      ids: planned.map(s => s.id),
      pending: false
    };
  }

  const api = {
    MAX_DAYS_BEFORE, MAX_REMINDERS, DEFAULT_REMINDERS,
    parseTime, normalizeOne, normalizeReminders, addDays, dayOfKey,
    whenLabel, fmtTime, describe, buildReminder
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MCReminders = api;
})(typeof self !== "undefined" ? self : globalThis);
