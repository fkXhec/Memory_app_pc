// templates.js — Deterministic responses, formatting, persistence, utils

// ──── Formatting ────
export function fmtDate(iso) {
  if (!iso) return "date inconnue";
  try { return new Date(iso).toLocaleString("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}
export function fmtDateShort(iso) {
  try { return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }); }
  catch { return iso; }
}
export function fmtTime(ts) { return new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); }
export const gid = (p) => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const iso = () => new Date().toISOString();
export const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };

// ──── Templates (0 LLM calls) ────
export const T = {
  validate: {
    f4: (o) => `Je crée un rappel : ${o.motif}, le ${fmtDate(o.datetime)}${o.recurrence && o.recurrence !== "none" ? `, récurrent : ${o.recurrence}` : ""}. C'est correct ?`,
    f5: (o) => `J'enregistre que votre ${o.object_name} est ${o.location}. C'est correct ?`,
    f2: (o) => `Voici votre souvenir : ${o.title}. ${o.summary}. Voulez-vous le garder, le modifier, ou l'abandonner ?`,
  },
  askMissing: {
    f4: (field) => field === "datetime" ? "À quelle date et heure souhaitez-vous ce rappel ?" : "Quel est le motif du rappel ?",
    f5: (field) => field === "location" ? "Où se trouve cet objet ?" : "Quel objet voulez-vous enregistrer ?",
    f2: () => "Pouvez-vous me donner plus de détails pour le souvenir ?",
  },
  inserted: "C'est enregistré.",
  deleted: "Supprimé.",
  cancelled: "Annulé.",
  dupFound: (desc) => `Vous avez déjà un élément similaire : ${desc}. Voulez-vous le remplacer ou en créer un nouveau ?`,
  noItems: (label) => `Vous n'avez aucun ${label} enregistré.`,
  notFound: (label) => `Je n'ai pas de ${label} correspondant.`,
  objNotFound: (name) => `Je n'ai pas d'emplacement enregistré pour ${name}. Voulez-vous en déclarer un ?`,
  f3step: (n, total, text) => `Étape ${n} sur ${total} : ${text}`,
  f3status: (n, total, step, done) => `Vous êtes à l'étape ${n} sur ${total} : ${step}.${done ? ` Déjà fait : ${done}.` : ""}`,
  f3complete: (task) => `Vous avez terminé : ${task}. Bravo !`,
  f3paused: "Plan mis en pause. Dites Memory on reprend quand vous voulez.",
  error: "Un problème technique est survenu. Vos informations sont conservées.",
  welcome: "Oui, que puis-je faire pour vous ?",
  stopped: "D'accord, on arrête.",
  alarmList: (alarms) => {
    if (!alarms.length) return "Vous n'avez aucune alarme.";
    const sorted = [...alarms].sort((a, b) => (a.datetime || "").localeCompare(b.datetime || ""));
    return `Vous avez ${alarms.length} alarme${alarms.length > 1 ? "s" : ""}. ` +
      sorted.map(a => `${a.motif}, le ${fmtDate(a.datetime)}`).join(". ") + ".";
  },
  objRead: (o) => `Votre ${o.name} est ${o.location}, mis à jour ${fmtDateShort(o.updated_at)}.`,
};

// ──── Persistence ────
export function load(k, def) { try { return JSON.parse(localStorage.getItem(k)) || def; } catch { return def; } }
export function saveAll(S) {
  try {
    localStorage.setItem("am_days", JSON.stringify(S.daySessions));
    localStorage.setItem("am_mem", JSON.stringify(S.memories));
    localStorage.setItem("am_alarms", JSON.stringify(S.alarms));
    localStorage.setItem("am_objects", JSON.stringify(S.objects));
    if (S.plan) localStorage.setItem("am_plan", JSON.stringify(S.plan));
  } catch (e) { console.warn("save:", e); }
}
