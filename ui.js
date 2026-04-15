// ui.js — TTS/STT, DOM rendering, inspector, initialization
import { TTS_COOLDOWN, STT_DEBOUNCE } from "./config.js";
import { S, bindUI, setMode, enqueueInput, isIdle, resetAll, bgSummary, getBufferSummary, getBufferSegments, featureOf, addSegment } from "./state.js";
import { esc, fmtTime, fmtDate, fmtDateShort } from "./templates.js";

// ──── DOM Cache ────
const D = {};
function cacheDom() {
  ["api-key-input", "btn-api-connect", "api-status", "btn-mic", "mic-state",
    "text-form", "text-input", "btn-reset", "conversation-log", "empty-state",
    "interim-bar", "interim-text", "mode-label", "mode-dot",
    "feature-indicator", "session-count", "session-entries", "day-sessions-count",
    "day-sessions-entries", "memories-count", "memories-entries", "plan-entries",
    "alarms-count", "alarms-entries", "objects-count", "objects-entries"
  ].forEach(id => { D[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.querySelector("#" + id); });
}

// ──── Processing state ────
function setProcessing(v) {
  S.isProcessing = v;
  updateMicUI();
  if (v) addThinking(); else rmThinking();
}

// ──── Say (central output) ────
function say(text, feature) {
  if (!text) return;
  logAssistant(text, feature);
  if (window._amLog) {
    window._amLog.push({ type: "assistant", text, feature, mode: S.mode, time: new Date().toISOString() });
    window._amLastResponse = { text, feature, mode: S.mode };
  }
  speak(text);
}

// ──── TTS ────
let recognition = null, sttAccumulator = "", sttDebounce = null, restartTimeout = null, summaryTimer = null;

function speak(text) {
  if (!text) return;
  if (window._amTestMode) { S.isSpeaking = false; S.ttsCooldown = false; return; }
  window.speechSynthesis.cancel();
  S.isSpeaking = true; S.ttsCooldown = false;
  updateMicUI(); sttPause();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "fr-FR"; u.rate = 0.92; u.pitch = 0.95;
  const voices = window.speechSynthesis.getVoices();
  const v = voices.find(v => v.lang === "fr-FR" && v.name.toLowerCase().includes("google")) || voices.find(v => v.lang.startsWith("fr"));
  if (v) u.voice = v;
  u.onend = u.onerror = () => {
    S.isSpeaking = false; S.ttsCooldown = true; updateMicUI();
    setTimeout(() => { S.ttsCooldown = false; sttResume(); }, TTS_COOLDOWN);
  };
  window.speechSynthesis.speak(u);
}

// ──── STT ────
function sttPause() { if (recognition) { try { recognition.abort(); } catch {} } }
function sttResume() {
  if (S.isListening && recognition && !S.isSpeaking && !S.ttsCooldown) {
    try { recognition.start(); } catch {}
  }
}

function startSTT() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert("Chrome requis pour le micro."); return; }
  recognition = new SR(); recognition.lang = "fr-FR"; recognition.continuous = true; recognition.interimResults = true;
  recognition.onresult = (e) => {
    if (S.isSpeaking || S.ttsCooldown) return;
    let interim = "", final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) final += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    if (interim) showInterim(sttAccumulator ? sttAccumulator + " " + interim : interim);
    if (final.trim()) {
      sttAccumulator += (sttAccumulator ? " " : "") + final.trim();
      showInterim(sttAccumulator + " …");
      if (sttDebounce) clearTimeout(sttDebounce);
      sttDebounce = setTimeout(() => {
        const full = sttAccumulator.trim(); sttAccumulator = ""; hideInterim();
        if (full) enqueueInput(full);
      }, STT_DEBOUNCE);
    }
  };
  recognition.onerror = (e) => { if (e.error === "not-allowed") { S.isListening = false; updateMicUI(); alert("Micro refusé."); } };
  recognition.onend = () => {
    if (S.isListening && !S.isSpeaking && !S.ttsCooldown) {
      restartTimeout = setTimeout(() => { if (S.isListening && !S.isSpeaking && !S.ttsCooldown) try { recognition.start(); } catch {} }, 300);
    }
  };
  recognition.start(); S.isListening = true; updateMicUI();
  summaryTimer = setInterval(() => { if (!S.isProcessing) bgSummary(); }, 90000);
}

function stopSTT() {
  S.isListening = false;
  if (restartTimeout) clearTimeout(restartTimeout);
  if (summaryTimer) clearInterval(summaryTimer);
  if (sttDebounce) clearTimeout(sttDebounce);
  sttAccumulator = "";
  if (recognition) { recognition.onend = null; try { recognition.abort(); } catch {} recognition = null; }
  hideInterim(); updateMicUI();
}

// ──── UI Rendering ────
function updateMicUI() {
  const b = D.btnMic; if (!b) return;
  b.classList.remove("listening", "speaking", "processing");
  if (S.isSpeaking) { b.classList.add("speaking"); D.micState.textContent = "Parle…"; }
  else if (S.isProcessing) { b.classList.add("processing"); D.micState.textContent = "Réfléchit…"; }
  else if (S.isListening) { b.classList.add("listening"); D.micState.textContent = "Écoute…"; }
  else D.micState.textContent = "Inactif";
}

function updateModeUI() {
  if (!D.modeDot) return;
  D.modeDot.className = "mode-dot " + (S.mode === "IDLE" ? "idle" : S.mode === "ROUTING" ? "routing" : "active");
  D.modeLabel.textContent = S.mode;
  const f = featureOf(S.mode);
  const labels = { f1: "F1 — Conversation", f2: "F2 — Souvenirs", f3: "F3 — Action", f4: "F4 — Alarmes", f5: "F5 — Objets" };
  if (f && labels[f]) { D.featureIndicator.textContent = labels[f]; D.featureIndicator.className = "feature-badge " + f; }
  else D.featureIndicator.className = "feature-badge hidden";
}

function featureColor(f) { return { f1: "var(--f1)", f2: "var(--f2)", f3: "var(--f3)", f4: "var(--f4)", f5: "var(--f5)" }[f] || "var(--text-dim)"; }

function addThinking() { rmThinking(); const r = document.createElement("div"); r.className = "msg-row assistant"; r.id = "thinking"; r.innerHTML = '<div class="msg-bubble"><span class="msg-thinking">Réflexion…</span></div>'; D.conversationLog.appendChild(r); scrollLog(); }
function rmThinking() { const e = document.getElementById("thinking"); if (e) e.remove(); }

function logBuffer(text) {
  removeEmpty();
  const r = document.createElement("div"); r.className = "msg-row buffer-passive";
  r.innerHTML = `<div class="msg-buffer-passive"><span class="buffer-dot">●</span>${esc(text.substring(0, 120))}${text.length > 120 ? "…" : ""}<span class="msg-time">${fmtTime(Date.now())}</span></div>`;
  D.conversationLog.appendChild(r); scrollLog();
}

function logUser(text) {
  removeEmpty();
  const r = document.createElement("div"); r.className = "msg-row user";
  r.innerHTML = `<div class="msg-bubble">${esc(text)}<span class="msg-time">${fmtTime(Date.now())}</span></div>`;
  D.conversationLog.appendChild(r); scrollLog();
}

function logAssistant(text, feature) {
  if (!text) return; removeEmpty();
  const r = document.createElement("div"); r.className = "msg-row assistant";
  const labels = { f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5" };
  let tag = feature ? `<span class="msg-feature-tag" style="background:${featureColor(feature)}">${labels[feature] || ""}</span>` : "";
  r.innerHTML = `<div class="msg-bubble">${tag}${esc(text)}<span class="msg-time">${fmtTime(Date.now())}</span></div>`;
  D.conversationLog.appendChild(r); scrollLog();
}

function removeEmpty() { const e = document.getElementById("empty-state"); if (e) e.remove(); }
function scrollLog() { requestAnimationFrame(() => D.conversationLog.scrollTop = D.conversationLog.scrollHeight); }
function showInterim(text) { D.interimBar.classList.remove("hidden"); D.interimText.textContent = text; }
function hideInterim() { D.interimBar.classList.add("hidden"); D.interimText.textContent = ""; }

// ──── Inspector ────
function renderInspector() {
  if (!D.sessionCount) return;
  const sc = S.currentSession?.segments?.length || 0;
  D.sessionCount.textContent = sc;
  const bs = getBufferSummary();
  D.sessionEntries.innerHTML = sc === 0 ? '<p class="inspector-empty">—</p>' :
    (bs ? `<div class="inspector-card" style="border-left-color:var(--f1)"><strong>Résumé auto</strong><div class="detail">${esc(bs)}</div></div>` : "") +
    (S.currentSession?.segments || []).slice(-5).map(s => `<div class="inspector-card"><span class="detail">${fmtTime(new Date(s.ts))}</span> ${esc(s.text.substring(0, 80))}</div>`).join("");

  D.daySessionsCount.textContent = S.daySessions.length;
  D.daySessionsEntries.innerHTML = S.daySessions.length ? S.daySessions.map(s => `<div class="inspector-card"><span class="detail">${fmtTime(s.started_at)}</span> ${esc((s.summary || "…").substring(0, 60))}</div>`).join("") : '<p class="inspector-empty">—</p>';

  D.memoriesCount.textContent = S.memories.length;
  D.memoriesEntries.innerHTML = S.memories.length ? S.memories.slice().reverse().map(m => `<div class="inspector-card" style="border-left-color:var(--f2)"><strong>${esc(m.title)}</strong><div class="detail">${esc(m.date)} · ${esc(m.summary.substring(0, 80))}</div></div>`).join("") : '<p class="inspector-empty">—</p>';

  if (S.plan?.steps?.length) {
    const icons = { planning: "📝", validating: "🔍", in_progress: "▶", paused: "⏸", completed: "✅" };
    D.planEntries.innerHTML = `<div class="inspector-card" style="border-left-color:var(--f3)"><strong>${icons[S.plan.status] || ""} ${esc(S.plan.task)}</strong><div class="detail">Étape ${S.plan.current_step}/${S.plan.steps.length}</div>` +
      S.plan.steps.map(s => `<div class="plan-step ${s.status}">${s.status === "done" ? "✓" : s.status === "current" ? "▸" : "○"} ${esc(s.text)}</div>`).join("") + "</div>";
  } else D.planEntries.innerHTML = '<p class="inspector-empty">—</p>';

  D.alarmsCount.textContent = S.alarms.length;
  D.alarmsEntries.innerHTML = S.alarms.length ? S.alarms.map(a => `<div class="inspector-card" style="border-left-color:var(--f4)"><strong>${esc(a.motif)}</strong><div class="detail">${fmtDate(a.datetime)}${a.recurrence !== "none" ? " · " + a.recurrence : ""}</div></div>`).join("") : '<p class="inspector-empty">—</p>';

  D.objectsCount.textContent = S.objects.length;
  D.objectsEntries.innerHTML = S.objects.length ? S.objects.map(o => `<div class="inspector-card" style="border-left-color:var(--f5)"><strong>${esc(o.name)}</strong>${o.aliases?.length ? `<span class="alias"> ${esc(o.aliases.join(", "))}</span>` : ""}<div class="detail">📍 ${esc(o.location)} · ${fmtTime(o.updated_at)}</div></div>`).join("") : '<p class="inspector-empty">—</p>';
}

// ──── API Key Test ────
async function testKey(k) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json", "x-api-key": k, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 5, messages: [{ role: "user", content: "." }] }),
    });
    return r.ok;
  } catch { return false; }
}

// ──── Init ────
function init() {
  cacheDom();
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();

  // Bind state callbacks
  bindUI({ say, setProcessing, renderInspector, updateModeUI, logBuffer, logUser });

  renderInspector();
  updateModeUI();

  const savedKey = localStorage.getItem("am_api_key") || "";
  if (savedKey) {
    S.apiKey = savedKey; D.apiKeyInput.value = savedKey;
    testKey(savedKey).then(ok => { if (ok) { D.apiStatus.textContent = "✓ Connecté"; D.apiStatus.className = "status-text success"; } });
  }

  D.btnApiConnect.addEventListener("click", async () => {
    const k = D.apiKeyInput.value.trim(); if (!k) return;
    D.apiStatus.textContent = "Vérification…"; D.apiStatus.className = "status-text";
    if (await testKey(k)) { S.apiKey = k; localStorage.setItem("am_api_key", k); D.apiStatus.textContent = "✓ Connecté"; D.apiStatus.className = "status-text success"; }
    else { D.apiStatus.textContent = "✗ Clé invalide"; D.apiStatus.className = "status-text error"; }
  });
  D.apiKeyInput.addEventListener("keydown", e => { if (e.key === "Enter") D.btnApiConnect.click(); });

  D.btnMic.addEventListener("click", () => {
    if (!S.apiKey) { alert("Clé API requise."); return; }
    if (S.isListening) stopSTT(); else startSTT();
  });

  D.textForm.addEventListener("submit", e => {
    e.preventDefault(); const t = D.textInput.value.trim();
    if (t) { enqueueInput(t); D.textInput.value = ""; }
  });

  D.btnReset.addEventListener("click", () => {
    if (!confirm("Tout réinitialiser ?")) return;
    stopSTT(); window.speechSynthesis.cancel();
    resetAll();
    D.conversationLog.innerHTML = `<div id="empty-state" class="empty-state"><p class="empty-title">Prêt</p><p class="empty-text">Connectez l'API, activez le micro.<br>Dites <strong>Memory</strong> pour activer.</p></div>`;
    renderInspector();
  });

  // Test hooks
  window._am = {
    enqueue: enqueueInput,
    state: () => ({ mode: S.mode, collected: { ...S.collected }, missing: [...S.missing], alarms: S.alarms.map(a => ({ ...a })), objects: S.objects.map(o => ({ ...o })), memories: S.memories.map(m => ({ ...m })), plan: S.plan ? { ...S.plan, steps: S.plan.steps?.map(s => ({ ...s })) } : null, daySessions: S.daySessions.length, bufferSegments: getBufferSegments().length }),
    isIdle: isIdle,
    reset: () => D.btnReset?.click(),
  };
}

document.addEventListener("DOMContentLoaded", init);
