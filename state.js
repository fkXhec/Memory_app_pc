// state.js — StateManager: state, session/buffer, CRUD, F3, routing
import { TOOL, REQUIRED, DEFAULTS, SESSION_TIMEOUT, BUFFER_WINDOW, RELANCE_SOFT, RELANCE_HARD, WAKE_RE, STOP_RE } from "./config.js";
import { P } from "./prompts.js";
import { T, gid, iso, fmtTime, fmtDateShort, load, saveAll } from "./templates.js";
import { callTool } from "./llm.js";

// ──── State ────
export const S = {
  mode: "IDLE", apiKey: "", collected: {}, missing: [], targetId: null,
  plan: null, planCtx: {}, f3turns: 0,
  isListening: false, isSpeaking: false, isProcessing: false, ttsCooldown: false,
  currentSession: null,
  daySessions: load("am_days", []),
  memories: load("am_mem", []),
  alarms: load("am_alarms", []),
  objects: load("am_objects", []),
};

// Restore plan
try { S.plan = JSON.parse(localStorage.getItem("am_plan")) || null; } catch { S.plan = null; }

function save() { saveAll(S); }

// ──── Callbacks (set by ui.js) ────
let _say = () => {};
let _setProcessing = () => {};
let _renderInspector = () => {};
let _updateModeUI = () => {};
let _logBuffer = () => {};
let _logUser = () => {};

export function bindUI(callbacks) {
  _say = callbacks.say;
  _setProcessing = callbacks.setProcessing;
  _renderInspector = callbacks.renderInspector;
  _updateModeUI = callbacks.updateModeUI;
  _logBuffer = callbacks.logBuffer;
  _logUser = callbacks.logUser;
}

function say(text, feature) { _say(text, feature); }

// ──── Session & Buffer ────
let bufferSegments = [];
let bufferSummary = "";
let lastSummarySegCount = 0;

export function getBufferSegments() { return bufferSegments; }

function ensureSession() {
  const now = Date.now();
  if (S.currentSession) {
    const segs = S.currentSession.segments;
    const last = segs.length ? new Date(segs[segs.length - 1].ts).getTime() : new Date(S.currentSession.started_at).getTime();
    if (now - last > SESSION_TIMEOUT) closeSession();
  }
  if (!S.currentSession) {
    S.currentSession = { id: gid("sess"), started_at: iso(), ended_at: null, segments: [], summary: "" };
  }
}

function closeSession() {
  if (!S.currentSession) return;
  S.currentSession.ended_at = iso();
  if (S.currentSession.segments.length > 0) S.daySessions.push({ ...S.currentSession });
  S.currentSession = null;
  save();
}

export function addSegment(text, passive = true) {
  ensureSession();
  S.currentSession.segments.push({ text, ts: iso(), passive });
  const cutoff = Date.now() - BUFFER_WINDOW;
  bufferSegments.push({ text, ts: Date.now(), passive });
  bufferSegments = bufferSegments.filter(s => s.ts > cutoff);
  _renderInspector();
}

function getBufferText() {
  return bufferSegments.filter(s => s.passive).map(s => s.text).join("\n");
}

function getSessionsSummary() {
  const parts = [];
  for (const sess of S.daySessions) {
    const t = fmtTime(sess.started_at);
    const text = sess.summary || sess.segments?.map(s => s.text).join(" ").substring(0, 300) || "";
    if (text) parts.push(`[${t}] ${text}`);
  }
  if (S.currentSession?.segments?.length) {
    const t = fmtTime(S.currentSession.started_at);
    const text = S.currentSession.segments.filter(s => s.passive).map(s => s.text).join(" ").substring(0, 300);
    if (text) parts.push(`[${t}] ${text}`);
  }
  return parts.join("\n") || "(aucune session)";
}

export async function bgSummary() {
  const passiveSegs = bufferSegments.filter(s => s.passive);
  if (passiveSegs.length < 3 || passiveSegs.length === lastSummarySegCount) return;
  if (S.isProcessing) return;
  lastSummarySegCount = passiveSegs.length;
  const txt = passiveSegs.map(s => s.text).join("\n");
  const r = await callTool(TOOL.speak, P.summary(), `Transcription :\n${txt}`, S.apiKey);
  if (r.ok) bufferSummary = r.data.speech;
}

export function getBufferSummary() { return bufferSummary; }

// ──── CRUD Helpers ────
function featureOf(mode) {
  if (mode === "SUMMARY") return "f1";
  const m = mode.match(/^F(\d)/);
  return m ? "f" + m[1] : null;
}
function featureLabel(f) { return { f2: "souvenir", f4: "alarme", f5: "objet" }[f] || "élément"; }
function getMissing(f, obj) {
  return (REQUIRED[f] || []).filter(k => !obj[k] || (typeof obj[k] === "string" && !obj[k].trim()));
}
function completeObj(f, obj) {
  const full = { ...obj };
  for (const [k, v] of Object.entries(DEFAULTS[f] || {})) {
    if (full[k] === undefined) full[k] = Array.isArray(v) ? [...v] : v;
  }
  return full;
}
function itemsFor(f) {
  if (f === "f2") return S.memories;
  if (f === "f4") return S.alarms;
  if (f === "f5") return S.objects;
  return [];
}
function insertObj(f, obj) {
  const t = iso();
  if (f === "f2") S.memories.push({ id: gid("mem"), date: new Date().toLocaleDateString("fr-FR"), title: obj.title || "", summary: obj.summary || "", people: obj.people || [], places: obj.places || [], keywords: obj.keywords || [], created_at: t, edited: false });
  else if (f === "f4") S.alarms.push({ id: gid("alarm"), motif: obj.motif || "", datetime: obj.datetime || "", recurrence: obj.recurrence || "none", created_at: t });
  else if (f === "f5") S.objects.push({ id: gid("obj"), name: obj.object_name || "", aliases: obj.aliases || [], location: obj.location || "", updated_at: t });
  save(); _renderInspector();
}
function updateObj(f, id, updates) {
  if (f === "f2") S.memories = S.memories.map(m => m.id === id ? { ...m, ...updates, edited: true } : m);
  else if (f === "f4") S.alarms = S.alarms.map(a => a.id === id ? { ...a, ...updates } : a);
  else if (f === "f5") {
    const upd = { ...updates, updated_at: iso() };
    if (updates.object_name) upd.name = updates.object_name;
    S.objects = S.objects.map(o => o.id === id ? { ...o, ...upd } : o);
  }
  save(); _renderInspector();
}
function deleteObj(f, id) {
  if (f === "f2") S.memories = S.memories.filter(m => m.id !== id);
  else if (f === "f4") S.alarms = S.alarms.filter(a => a.id !== id);
  else if (f === "f5") S.objects = S.objects.filter(o => o.id !== id);
  save(); _renderInspector();
}

// ──── Mode & Relance ────
let relanceTimer = null;

export function setMode(m) {
  S.mode = m;
  if (m === "IDLE") { S.collected = {}; S.missing = []; S.targetId = null; stopRelance(); }
  else startRelance();
  _updateModeUI();
  _renderInspector();
}

function startRelance() {
  stopRelance();
  if (S.mode === "IDLE") return;
  relanceTimer = setTimeout(() => {
    if (S.isSpeaking || S.isProcessing || S.mode === "IDLE") return;
    say("Êtes-vous toujours là ?", featureOf(S.mode));
    relanceTimer = setTimeout(() => {
      if (S.isSpeaking || S.isProcessing || S.mode === "IDLE") return;
      if (S.mode.startsWith("F3") && S.plan) { S.plan.status = "paused"; save(); setMode("F3_PAUSED"); }
      else setMode("IDLE");
    }, RELANCE_HARD - RELANCE_SOFT);
  }, RELANCE_SOFT);
}

function stopRelance() { if (relanceTimer) { clearTimeout(relanceTimer); relanceTimer = null; } }

// ──── Input Queue ────
const queue = [];
let queueRunning = false;

export function enqueueInput(text) {
  if (!text?.trim()) return;
  queue.push(text.trim());
  if (!queueRunning) drainQueue();
}

async function drainQueue() {
  queueRunning = true;
  while (queue.length) {
    const text = queue.shift();
    try { await processInput(text); } catch (e) { console.error("processInput:", e); }
    _setProcessing(false);
  }
  queueRunning = false;
}

export function isIdle() { return !S.isProcessing && !queueRunning && !S.isSpeaking; }

// ──── Main State Machine ────
async function processInput(text) {
  if (!text) return;
  const hasWake = WAKE_RE.test(text);
  const clean = text.replace(WAKE_RE, "").trim();

  addSegment(text, !hasWake);

  // IDLE
  if (S.mode === "IDLE") {
    if (!hasWake) { _logBuffer(text); return; }
    _logUser(text);
    if (!clean || clean.length < 2) { say(T.welcome, null); setMode("ROUTING"); return; }
    setMode("ROUTING");
    return handleRouting(clean);
  }

  // ACTIVE MODE
  _logUser(text);

  // Stop
  if (hasWake && STOP_RE.test(text)) {
    if (S.mode.startsWith("F3") && S.plan) { S.plan.status = "paused"; save(); }
    say(T.stopped, featureOf(S.mode));
    setMode("IDLE");
    return;
  }

  // Feature switch
  if (hasWake && clean.length > 3 && S.mode !== "ROUTING") {
    if (S.mode.startsWith("F3") && S.plan) { S.plan.status = "paused"; save(); }
    setMode("ROUTING");
    return handleRouting(clean);
  }

  // Dispatch
  startRelance();
  const input = hasWake ? clean : text;
  return dispatch(input);
}

async function dispatch(text) {
  _setProcessing(true);
  try {
    const m = S.mode;
    if (m === "ROUTING") return handleRouting(text);
    if (m === "SUMMARY") return handleSummary();
    if (m === "F3_COLLECTING") return handleF3Collecting(text);
    if (m === "F3_VALIDATING") return handleF3Validating(text);
    if (m === "F3_EXECUTING") return handleF3Executing(text);
    if (m === "F3_PAUSED") return handleF3Paused(text);
    if (m.includes("BUILDING")) return handleCrudBuilding(text);
    if (m.includes("VALIDATING")) return handleCrudValidating(text);
    if (m.includes("DEDUP")) return handleCrudDedup(text);
    if (m.includes("READ")) return handleCrudRead(text);
    if (m.includes("UPDATE_FINDING") || m.includes("DELETE_FINDING")) return handleCrudFinding(text);
    if (m.includes("DELETE_CONFIRMING")) return handleCrudDeleteConfirm(text);
    say("Dites Memory suivi de votre demande.", null);
    setMode("IDLE");
  } finally {
    _setProcessing(false);
  }
}

// ──── Routing ────
async function handleRouting(text) {
  _setProcessing(true);
  // Include item names so the LLM can disambiguate ("supprime les clés" → F5 if "clés" is an object)
  const objNames = S.objects.map(o => o.name).join(", ") || "aucun";
  const alarmMotifs = S.alarms.map(a => a.motif).join(", ") || "aucune";
  const memTitles = S.memories.map(m => m.title).join(", ") || "aucun";
  const r = await callTool(TOOL.route, P.route(),
    `Patient dit : "${text}"\nObjets enregistrés: [${objNames}]\nAlarmes: [${alarmMotifs}]\nSouvenirs: [${memTitles}]${S.plan?.status === "paused" ? "\nPlan en pause: " + S.plan.task : ""}`,
    S.apiKey);
  _setProcessing(false);

  if (!r.ok || r.data.confidence === "low") {
    say(r.data?.clarification || "Je n'ai pas compris. Que voulez-vous faire ?", null);
    // Return to IDLE — don't stay in ROUTING, otherwise next input
    // (like "Oui" or a passive segment) gets misrouted
    setMode("IDLE");
    return;
  }

  const { feature: f, crud: c, extracted_fields: ef } = r.data;

  // Reset collected for new feature
  S.collected = {};
  if (ef && typeof ef === "object") S.collected = { ...ef };

  if (f === "f1") { setMode("SUMMARY"); return handleSummary(); }

  if (f === "f3") {
    if (S.plan?.status === "paused" && /\b(reprend|continu|plan)\b/i.test(text)) return handleF3Paused(text);
    S.planCtx = {}; S.f3turns = 0;
    if (ef?.task) S.planCtx.task = ef.task;
    setMode("F3_COLLECTING");
    return handleF3Collecting(text);
  }

  const prefix = f.toUpperCase();
  if (c === "create") { setMode(`${prefix}_CREATE_BUILDING`); return handleCrudBuilding(text); }
  if (c === "read") { setMode(`${prefix}_READ`); return handleCrudRead(text); }
  if (c === "update") { setMode(`${prefix}_UPDATE_FINDING`); return handleCrudFinding(text); }
  if (c === "delete") { setMode(`${prefix}_DELETE_FINDING`); return handleCrudFinding(text); }

  say("Que voulez-vous faire ?", f);
}

// ──── F1 Summary ────
async function handleSummary() {
  // Use ONLY buffer (last 10 min), NOT entire day sessions
  const passive = bufferSegments.filter(s => s.passive);
  if (passive.length < 2) {
    say("Il n'y a pas assez de conversation à résumer.", "f1");
    setMode("IDLE"); return;
  }
  if (bufferSummary && passive.length - lastSummarySegCount < 3) {
    say(bufferSummary, "f1"); setMode("IDLE"); return;
  }
  _setProcessing(true);
  const txt = passive.map(s => s.text).join("\n");
  const r = await callTool(TOOL.speak, P.summary(), `Transcription des 10 dernières minutes :\n${txt}`, S.apiKey);
  _setProcessing(false);
  say(r.ok ? r.data.speech : "Je n'ai pas pu produire de résumé.", "f1");
  setMode("IDLE");
}

// ──── CRUD: Building ────
async function handleCrudBuilding(text) {
  const f = featureOf(S.mode);
  if (!f) { setMode("IDLE"); return; }

  // Early dedup for CREATE: check before extraction when motif/name already known
  if (S.mode.includes("CREATE")) {
    if (f === "f4" && S.collected.motif) {
      const candidates = S.alarms.filter(a => a.id !== S.targetId);
      if (candidates.length > 0) {
        _setProcessing(true);
        const dup = await callTool(TOOL.compare, P.compare(f, S.collected, candidates), "Doublon ?", S.apiKey);
        _setProcessing(false);
        if (dup.ok && dup.data.is_same && dup.data.duplicate_id) {
          S.targetId = dup.data.duplicate_id;
          setMode(S.mode.replace("BUILDING", "DEDUP"));
          say(T.dupFound(candidates.find(a => a.id === dup.data.duplicate_id)?.motif || "cette alarme"), f);
          return;
        }
      }
    }
    if (f === "f5" && S.collected.object_name) {
      const candidates = S.objects.filter(o => o.id !== S.targetId);
      if (candidates.length > 0) {
        _setProcessing(true);
        const dup = await callTool(TOOL.compare, P.compare(f, S.collected, candidates), "Doublon ?", S.apiKey);
        _setProcessing(false);
        if (dup.ok && dup.data.is_same && dup.data.duplicate_id) {
          S.targetId = dup.data.duplicate_id;
          setMode(S.mode.replace("BUILDING", "DEDUP"));
          say(`Vous avez déjà un objet "${candidates.find(o => o.id === dup.data.duplicate_id)?.name}". C'est le même que "${S.collected.object_name}" ?`, f);
          return;
        }
      }
    }
  }

  // Extraction
  _setProcessing(true);
  let tool, prompt;
  const missing = getMissing(f, S.collected);
  if (f === "f4") { tool = TOOL.alarm; prompt = P.alarmExtract(S.collected, missing); }
  else if (f === "f5") { tool = TOOL.object; prompt = P.objectExtract(S.collected, missing); }
  else if (f === "f2") { tool = TOOL.memory; prompt = P.memoryExtract(getSessionsSummary(), S.collected); }
  else { _setProcessing(false); setMode("IDLE"); return; }

  const r = await callTool(tool, prompt, `Patient dit : "${text}"`, S.apiKey);
  _setProcessing(false);

  if (r.ok) {
    for (const [k, v] of Object.entries(r.data)) {
      if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)) {
        if (k === "datetime" && typeof v === "string" && isNaN(Date.parse(v))) continue;
        S.collected[k] = v;
      }
    }
  }

  const stillMissing = getMissing(f, S.collected);
  if (stillMissing.length === 0) {
    S.collected = completeObj(f, S.collected);
    setMode(S.mode.replace("BUILDING", "VALIDATING"));
    say(T.validate[f](S.collected), f);
  } else {
    S.missing = stillMissing;
    say(T.askMissing[f](stillMissing[0]), f);
  }
}

// ──── CRUD: Validating ────
async function handleCrudValidating(text) {
  const f = featureOf(S.mode);
  const lc = text.toLowerCase();

  // F4: date/time pattern in response = implicit edit
  if (f === "f4" && /\b(\d{1,2}\s*(h|heures?|[:.])\s*\d{0,2}|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|demain|après-demain|matin|soir|midi)\b/i.test(text)) {
    delete S.collected.datetime;
    setMode(S.mode.replace("VALIDATING", "BUILDING"));
    await handleCrudBuilding(text);
    return;
  }

  _setProcessing(true);
  const r = await callTool(TOOL.classify, P.classify(), `Patient dit : "${text}"`, S.apiKey);
  _setProcessing(false);

  if (!r.ok) { say(T.error, f); return; }

  if (r.data.intent === "yes") {
    // For UPDATE flows: skip dedup (we're updating an existing item, not creating)
    if (S.mode.includes("UPDATE")) {
      if (S.targetId) { updateObj(f, S.targetId, S.collected); say(T.inserted, f); }
      else { insertObj(f, S.collected); say(T.inserted, f); }
      setMode("IDLE");
      return;
    }

    // For CREATE flows: check dedup before inserting
    // Auto-resolve if patient said "même chose"
    if (/\b(m[eê]me|pareil|identique)\b/i.test(lc)) {
      const candidates = f === "f5" ? S.objects : f === "f4" ? S.alarms : [];
      _setProcessing(true);
      const d = await callTool(TOOL.compare, P.compare(f, S.collected, candidates), "Doublon ?", S.apiKey);
      _setProcessing(false);
      if (d.ok && d.data.is_same && d.data.duplicate_id) {
        const existing = candidates.find(c => c.id === d.data.duplicate_id);
        if (f === "f5" && existing) {
          const aliases = [...new Set([...(existing.aliases || []), ...(S.collected.aliases || []), S.collected.object_name])];
          updateObj(f, d.data.duplicate_id, { location: S.collected.location, aliases });
        } else {
          updateObj(f, d.data.duplicate_id, S.collected);
        }
        say("Mis à jour.", f); setMode("IDLE"); return;
      }
    }

    // Regular dedup check
    const candidates = f === "f5" ? S.objects : f === "f4" ? S.alarms : f === "f2" ? S.memories.filter(m => m.date === new Date().toLocaleDateString("fr-FR")) : [];
    if (candidates.length > 0) {
      _setProcessing(true);
      const d = await callTool(TOOL.compare, P.compare(f, S.collected, candidates), "Doublon ?", S.apiKey);
      _setProcessing(false);
      if (d.ok && d.data.is_same && d.data.duplicate_id) {
        S.targetId = d.data.duplicate_id;
        setMode(S.mode.replace("VALIDATING", "DEDUP"));
        say(T.dupFound(candidates.find(c => c.id === d.data.duplicate_id)?.motif || candidates.find(c => c.id === d.data.duplicate_id)?.name || candidates.find(c => c.id === d.data.duplicate_id)?.title || "cet élément"), f);
        return;
      }
    }

    insertObj(f, S.collected);
    say(T.inserted, f);
    setMode("IDLE");
  } else if (r.data.intent === "edit") {
    const detail = (r.data.edit_detail || text).toLowerCase();
    if (f === "f4") {
      if (/\b(\d{1,2}[h:]|\bheure|matin|soir|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/.test(detail)) delete S.collected.datetime;
      if (/\b(motif|raison|pour)\b/.test(detail)) delete S.collected.motif;
    }
    if (f === "f2") { delete S.collected.summary; delete S.collected.title; }
    setMode(S.mode.replace("VALIDATING", "BUILDING"));
    await handleCrudBuilding(text);
  } else {
    say(T.cancelled, f);
    setMode("IDLE");
  }
}

// ──── CRUD: Dedup ────
async function handleCrudDedup(text) {
  const f = featureOf(S.mode);
  _setProcessing(true);
  const r = await callTool(TOOL.classify, P.classify(), `Patient dit : "${text}"`, S.apiKey);
  _setProcessing(false);

  if (r.ok && (r.data.intent === "yes" || /\b(rempla|m[eê]me|mets? [àa] jour)\b/i.test(text))) {
    if (S.targetId) {
      if (f === "f5") {
        const existing = S.objects.find(o => o.id === S.targetId);
        const aliases = [...new Set([...(existing?.aliases || []), ...(S.collected.aliases || [])])];
        updateObj(f, S.targetId, { location: S.collected.location, aliases, object_name: existing?.name || S.collected.object_name });
      } else {
        updateObj(f, S.targetId, S.collected);
      }
      say("Mis à jour.", f);
    } else {
      insertObj(f, S.collected);
      say(T.inserted, f);
    }
  } else if (r.data?.intent === "cancel" || /\b(laisse|annule|non)\b/i.test(text)) {
    say(T.cancelled, f);
  } else {
    insertObj(f, S.collected);
    say("Les deux sont conservés.", f);
  }
  setMode("IDLE");
}

// ──── CRUD: Read ────
async function handleCrudRead(text) {
  const f = featureOf(S.mode);
  const items = itemsFor(f);

  if (f === "f4") { say(T.alarmList(items), f); setMode("IDLE"); return; }

  if (f === "f5") {
    if (!S.objects.length) {
      const name = (S.collected.object_name || text).toLowerCase().replace(/\b(mon|ma|mes|le|la|les|où|est|sont|memory)\b/gi, "").trim();
      say(T.objNotFound(name || "cet objet"), f); setMode("IDLE"); return;
    }
    // Use LLM to match semantically — substring is too loose
    // ("clés de voiture" ≠ "clés de la maison")
    _setProcessing(true);
    const r = await callTool(TOOL.findItem, P.findItem(f, S.objects, "retrouver"), `Patient dit : "${text}"`, S.apiKey);
    _setProcessing(false);
    if (r.ok && r.data.found && r.data.item_id) {
      const obj = S.objects.find(o => o.id === r.data.item_id);
      say(obj ? T.objRead(obj) : r.data.speech, f);
    } else {
      const name = (S.collected.object_name || text).toLowerCase().replace(/\b(mon|ma|mes|le|la|les|où|est|sont|memory)\b/gi, "").trim();
      say(T.objNotFound(name || "cet objet"), f);
    }
    setMode("IDLE"); return;
  }

  if (f === "f2") {
    if (!items.length) { say(T.noItems("souvenir"), f); setMode("IDLE"); return; }
    _setProcessing(true);
    const r = await callTool(TOOL.speak, P.f2read(items), `Patient dit : "${text}"`, S.apiKey);
    _setProcessing(false);
    say(r.ok ? r.data.speech : T.notFound("souvenir"), f);
    setMode("IDLE"); return;
  }
  setMode("IDLE");
}

// ──── CRUD: Finding (update/delete) ────
async function handleCrudFinding(text) {
  const f = featureOf(S.mode);
  const purpose = S.mode.includes("UPDATE") ? "modifier" : "supprimer";
  const items = itemsFor(f);
  if (!items.length) { say(T.noItems(featureLabel(f)), f); setMode("IDLE"); return; }

  _setProcessing(true);
  const r = await callTool(TOOL.findItem, P.findItem(f, items, purpose), `Patient dit : "${text}"`, S.apiKey);
  _setProcessing(false);

  if (r.ok && r.data.found && r.data.item_id) {
    S.targetId = r.data.item_id;
    const item = items.find(i => i.id === r.data.item_id);
    if (S.mode.includes("UPDATE")) {
      S.collected = item ? { ...item } : {};
      // Clear field being modified
      if (f === "f4" && /\b(\d{1,2}\s*(h|heures?|[:.])|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|matin|soir|midi|d[eé]cale)\b/i.test(text)) delete S.collected.datetime;
      if (f === "f5" && /\b(dans|sur|sous|derrière|devant|à côté)\b/i.test(text.toLowerCase())) delete S.collected.location;
      setMode(S.mode.replace("FINDING", "BUILDING"));
      await handleCrudBuilding(text);
    } else {
      setMode(S.mode.replace("FINDING", "CONFIRMING"));
      say(r.data.speech || "Voulez-vous confirmer la suppression ?", f);
    }
  } else {
    say(r.data?.speech || T.notFound(featureLabel(f)), f);
  }
}

// ──── CRUD: Delete Confirm ────
async function handleCrudDeleteConfirm(text) {
  const f = featureOf(S.mode);
  _setProcessing(true);
  const r = await callTool(TOOL.classify, P.classify(), `Patient dit : "${text}"`, S.apiKey);
  _setProcessing(false);
  if (r.ok && r.data.intent === "yes") { deleteObj(f, S.targetId); say(T.deleted, f); }
  else say(T.cancelled, f);
  setMode("IDLE");
}

// ──── F3: Collecting ────
async function handleF3Collecting(text) {
  S.f3turns++;
  _setProcessing(true);
  if (!S.planCtx.task) S.planCtx.task = text;
  const r = await callTool(TOOL.f3collect, P.f3collect(S.planCtx, S.planCtx), `Patient dit : "${text}"`, S.apiKey);
  _setProcessing(false);
  if (!r.ok) { say(T.error, "f3"); return; }
  if (r.data.new_fields) S.planCtx = { ...S.planCtx, ...r.data.new_fields };

  if (r.data.ready_for_plan || S.f3turns >= 4) {
    _setProcessing(true);
    const p = await callTool(TOOL.f3plan, P.f3plan(S.planCtx), "Produis le plan d'action.", S.apiKey);
    _setProcessing(false);
    if (p.ok && p.data.steps?.length) {
      S.plan = {
        id: gid("plan"), task: p.data.task || S.planCtx.task || "",
        status: "validating", steps: p.data.steps.map((t, i) => ({ index: i + 1, text: typeof t === "string" ? t : String(t), status: "pending" })),
        current_step: 1, created_at: iso(),
      };
      save(); _renderInspector();
      const stepList = S.plan.steps.map((s, i) => `${i + 1}. ${s.text}`).join(". ");
      say(`Voici le plan en ${S.plan.steps.length} étapes. ${stepList}. Ça vous convient ?`, "f3");
      setMode("F3_VALIDATING");
    } else {
      say(r.data.next_question || "Pouvez-vous préciser ?", "f3");
    }
  } else {
    say(r.data.next_question || "Pouvez-vous me donner plus de détails ?", "f3");
  }
}

// ──── F3: Validating ────
async function handleF3Validating(text) {
  _setProcessing(true);
  const r = await callTool(TOOL.classify, P.f3validate(S.plan), `Patient dit : "${text}"`, S.apiKey);
  _setProcessing(false);

  if (r.ok && r.data.intent === "yes") {
    S.plan.status = "in_progress";
    S.plan.steps[0].status = "current";
    save(); _renderInspector();
    setMode("F3_EXECUTING");
    say(T.f3step(1, S.plan.steps.length, S.plan.steps[0].text), "f3");
  } else if (r.data?.intent === "edit") {
    S.f3turns = Math.max(0, S.f3turns - 2);
    setMode("F3_COLLECTING");
    say("Que voulez-vous modifier dans le plan ?", "f3");
  } else if (r.data?.intent === "cancel") {
    S.plan = null; save();
    say(T.cancelled, "f3");
    setMode("IDLE");
  } else {
    const stepList = S.plan.steps.map((s, i) => `${i + 1}. ${s.text}`).join(". ");
    say(`Le plan comporte ${S.plan.steps.length} étapes : ${stepList}. On commence ?`, "f3");
  }
}

// ──── F3: Executing ────
async function handleF3Executing(text) {
  _setProcessing(true);
  const r = await callTool(TOOL.f3intent, P.f3execute(S.plan), `Patient dit : "${text}"`, S.apiKey);
  _setProcessing(false);
  if (!r.ok) { say(T.error, "f3"); return; }

  switch (r.data.intent) {
    case "step_done": {
      const cs = S.plan.current_step - 1;
      if (cs >= 0 && cs < S.plan.steps.length) S.plan.steps[cs].status = "done";
      if (S.plan.current_step >= S.plan.steps.length) {
        S.plan.status = "completed"; save(); _renderInspector();
        say(T.f3complete(S.plan.task), "f3"); setMode("IDLE");
      } else {
        S.plan.current_step++;
        S.plan.steps[S.plan.current_step - 1].status = "current";
        save(); _renderInspector();
        say(T.f3step(S.plan.current_step, S.plan.steps.length, S.plan.steps[S.plan.current_step - 1].text), "f3");
      }
      break;
    }
    case "status_request": {
      const done = S.plan.steps.filter(s => s.status === "done").map(s => s.text).join(", ");
      say(T.f3status(S.plan.current_step, S.plan.steps.length, S.plan.steps[S.plan.current_step - 1]?.text, done), "f3");
      break;
    }
    case "pause":
      S.plan.status = "paused"; save(); _renderInspector();
      say(T.f3paused, "f3"); setMode("F3_PAUSED");
      break;
    default:
      say(r.data.help_response || "Je suis là pour vous aider avec cette étape.", "f3");
      break;
  }
}

// ──── F3: Paused ────
async function handleF3Paused(text) {
  if (!S.plan?.steps?.length) { say("Je n'ai pas de plan en mémoire.", "f3"); setMode("IDLE"); return; }
  S.plan.status = "in_progress"; save(); _renderInspector();
  setMode("F3_EXECUTING");
  say(`On reprend. ${T.f3step(S.plan.current_step, S.plan.steps.length, S.plan.steps[S.plan.current_step - 1]?.text)}`, "f3");
}

// ──── Reset ────
export function resetAll() {
  S.currentSession = null; S.daySessions = []; S.memories = []; S.alarms = []; S.objects = [];
  S.plan = null; S.collected = {}; S.missing = []; S.targetId = null; S.planCtx = {};
  S.isSpeaking = false; S.ttsCooldown = false; S.isProcessing = false;
  bufferSegments = []; bufferSummary = "";
  ["am_days", "am_mem", "am_plan", "am_alarms", "am_objects"].forEach(k => localStorage.removeItem(k));
  setMode("IDLE");
}

export { featureOf };
