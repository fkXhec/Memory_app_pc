// ============================================================
// TEST RUNNER v2 — Tests exhaustifs Assistant Mémoire Vocal
// 16 phases, ~130 étapes
// Couvre: F1 résumé multi-contexte, F2 CRUD complet + édition + recherche,
// F3 planification multi-scénario + limites, F4 CRUD complet + doublon + update + delete,
// F5 CRUD complet + alias + fusion + update + delete, switches inter-features, robustesse
// ============================================================
(function () {
  "use strict";

  const STEP_TIMEOUT = 25000;
  const PASSIVE_DELAY = 600;
  const INTER_STEP_DELAY = 900;

  const PHASES = [

    // ================================================================
    // PHASE 1 — F1 : Conversation passive + résumé
    // ================================================================
    {
      name: "1 — F1 conversation médecin + restaurant",
      steps: [
        { input: "Alors Christine tu as eu des nouvelles du docteur Martin pour les résultats ?", passive: true },
        { input: "Oui il m'a appelée ce matin, il dit que tout est normal, le bilan sanguin est bon, par contre il veut te revoir dans trois mois pour le suivi neurologique.", passive: true },
        { input: "Ah d'accord trois mois, c'est en juin alors.", passive: true },
        { input: "Au fait pour samedi, j'ai réservé au restaurant Le Panorama pour 20 heures, on sera six normalement, il y aura Martine et Jacques aussi.", passive: true },
        { input: "Moi je vais apporter un gâteau au citron, Paul tu peux t'occuper du vin ?", passive: true },
        { input: "Pas de problème je prends deux bouteilles de blanc, un Riesling et un Chablis.", passive: true },
        {
          input: "Memory résume",
          assert: {
            modeAfter: "IDLE",
            responseContainsAny: ["Martin", "Panorama", "restaurant", "samedi", "bilan"],
            responseNotContains: ["résumé", "vous m'avez demandé"],
            description: "Résumé contient sujets clés sans méta-commentary"
          }
        },
      ]
    },

    // ================================================================
    // PHASE 2 — F4 CREATE : alarmes avec dates relatives + récurrence
    // ================================================================
    {
      name: "2 — F4 CREATE alarmes",
      steps: [
        {
          input: "Memory rappelle-moi de confirmer la réservation du restaurant avant jeudi",
          assert: { responseContainsAny: ["rappel", "restaurant", "confirmer", "heure", "date", "correct", "quand"] }
        },
        {
          input: "Mercredi matin à 10 heures",
          assert: { responseContainsAny: ["mercredi", "10", "correct", "rappel", "confirmer"] }
        },
        { input: "Oui c'est bon", assert: { modeAfter: "IDLE", alarmsCountMin: 1 } },
        {
          input: "Memory rappelle-moi d'appeler le docteur Martin le 15 juin à 9 heures du matin",
          assert: { responseContainsAny: ["Martin", "juin", "9", "correct", "rappel"] }
        },
        { input: "Oui", assert: { modeAfter: "IDLE", alarmsCountMin: 2 } },
        {
          input: "Memory rappelle-moi de prendre mes médicaments tous les matins à 8 heures",
          assert: { responseContainsAny: ["médicament", "8", "correct", "rappel", "matin"], description: "Alarme récurrente" }
        },
        { input: "Oui", assert: { modeAfter: "IDLE", alarmsCountMin: 3 } },
      ]
    },

    // ================================================================
    // PHASE 3 — F4 DOUBLON
    // ================================================================
    {
      name: "3 — F4 doublon détection",
      steps: [
        {
          input: "Memory rappelle-moi de confirmer le restaurant",
          assert: {
            responseContainsAny: ["déjà", "similaire", "existant", "remplacer", "même", "restaurant"],
            description: "Doublon détecté immédiatement"
          }
        },
        { input: "Non c'est la même laisse tomber", assert: { modeAfter: ["IDLE", "ROUTING", "F4_CREATE_DEDUP"], alarmsCountMin: 3 } },
      ]
    },

    // ================================================================
    // PHASE 4 — F4 READ + UPDATE + DELETE
    // ================================================================
    {
      name: "4 — F4 READ, UPDATE, DELETE",
      steps: [
        {
          input: "Memory quelles sont mes alarmes",
          assert: { modeAfter: "IDLE", responseContainsAny: ["alarme", "restaurant", "Martin", "médicament"], description: "Liste les 3 alarmes" }
        },
        {
          input: "Memory décale l'alarme du restaurant à mardi à 14 heures",
          assert: { responseContainsAny: ["restaurant", "mardi", "14", "modif", "décal", "trouv"] }
        },
        { input: "Oui", assert: { modeAfter: ["IDLE", "F4_UPDATE_VALIDATING"] } },
        {
          input: "Memory supprime l'alarme du docteur Martin",
          assert: { responseContainsAny: ["Martin", "suppr", "confirm", "trouv"] }
        },
        { input: "Oui", assert: { modeAfter: "IDLE" } },
        {
          input: "Memory supprime le rappel des médicaments",
          assert: { responseContainsAny: ["médicament", "suppr", "confirm", "trouv"] }
        },
        { input: "Oui", assert: { modeAfter: "IDLE", alarmsCountMin: 1 } },
      ]
    },

    // ================================================================
    // PHASE 5 — F5 CREATE : 4 objets
    // ================================================================
    {
      name: "5 — F5 CREATE objets",
      steps: [
        { input: "Memory j'ai posé mon portefeuille sur la commode de l'entrée", assert: { responseContainsAny: ["portefeuille", "commode", "correct", "enregistre"] } },
        { input: "Oui", assert: { modeAfter: "IDLE", objectsCountMin: 1 } },
        { input: "Memory mes lunettes de soleil sont dans la boîte à gants de la voiture", assert: { responseContainsAny: ["lunettes", "boîte à gants", "correct", "enregistre"] } },
        { input: "Oui", assert: { objectsCountMin: 2 } },
        { input: "Memory le passeport est dans le tiroir du bureau", assert: { responseContainsAny: ["passeport", "tiroir", "correct", "enregistre"] } },
        { input: "Oui", assert: { objectsCountMin: 3 } },
        { input: "Memory j'ai mis les clés de la maison sur le crochet de l'entrée", assert: { responseContainsAny: ["clé", "crochet", "correct", "enregistre"] } },
        { input: "Oui", assert: { objectsCountMin: 4 } },
      ]
    },

    // ================================================================
    // PHASE 6 — F5 READ
    // ================================================================
    {
      name: "6 — F5 READ objets",
      steps: [
        { input: "Memory où est mon portefeuille ?", assert: { modeAfter: "IDLE", responseContainsAny: ["portefeuille", "commode"], description: "Lecture directe" } },
        { input: "Memory où sont mes lunettes de soleil ?", assert: { modeAfter: "IDLE", responseContainsAny: ["lunettes", "boîte à gants"] } },
        { input: "Memory où est mon téléphone ?", assert: { modeAfter: "IDLE", responseContainsAny: ["pas d'emplacement", "enregistré", "pas", "déclarer"], description: "Objet inconnu" } },
      ]
    },

    // ================================================================
    // PHASE 7 — F5 ALIAS : fusion papiers↔passeport
    // ================================================================
    {
      name: "7 — F5 alias fusion sémantique",
      steps: [
        {
          input: "Memory j'ai mis mes papiers dans le sac à dos",
          assert: { responseContainsAny: ["papiers", "sac", "correct", "enregistre", "passeport", "même", "déjà"], description: "Détection alias ou validation" }
        },
        { input: "Oui c'est la même chose", assert: { modeAfter: "IDLE" } },
        {
          input: "Memory où est mon passeport ?",
          assert: { modeAfter: "IDLE", responseContainsAny: ["sac à dos", "sac"], responseNotContains: ["tiroir"], description: "NOUVEL emplacement" }
        },
      ]
    },

    // ================================================================
    // PHASE 8 — F5 UPDATE + DELETE
    // ================================================================
    {
      name: "8 — F5 UPDATE et DELETE",
      steps: [
        {
          input: "Memory en fait mon portefeuille est dans la voiture",
          assert: { responseContainsAny: ["portefeuille", "voiture", "correct", "enregistre", "modif", "même", "déjà"], description: "Update ou dedup portefeuille" }
        },
        { input: "Oui", assert: { modeAfter: ["IDLE", "F5_CREATE_DEDUP", "F5_UPDATE_VALIDATING"] } },
        {
          input: "Memory où est mon portefeuille ?",
          assert: { modeAfter: "IDLE", responseContainsAny: ["voiture"], responseNotContains: ["commode"], description: "Emplacement mis à jour" }
        },
        { input: "Memory supprime les clés de la maison", assert: { responseContainsAny: ["clé", "suppr", "confirm", "trouv"] } },
        { input: "Oui", assert: { modeAfter: "IDLE" } },
      ]
    },

    // ================================================================
    // PHASE 9 — F2 CREATE souvenir + édition
    // ================================================================
    {
      name: "9 — F2 CREATE souvenir avec édition",
      steps: [
        { input: "Il fait vraiment beau aujourd'hui, regarde les montagnes au fond on voit la neige.", passive: true },
        { input: "C'est magnifique, le reflet sur le lac est incroyable avec cette lumière dorée.", passive: true },
        { input: "La voisine Martine est passée, elle nous invite à prendre le café demain vers 15 heures.", passive: true },
        { input: "On a aussi croisé le facteur qui a apporté un colis de tante Marie.", passive: true },
        {
          input: "Memory crée un souvenir de ma journée",
          assert: { modeAfter: ["F2_CREATE_VALIDATING", "F2_CREATE_BUILDING"], responseContainsAny: ["souvenir", "Martin", "lac", "montagne", "Martine", "journée"] }
        },
        {
          input: "Enlève le passage sur le restaurant c'est pour samedi. Rajoute que la lumière dorée sur le lac m'a particulièrement ému.",
          assert: { responseContainsAny: ["lumière", "ému", "lac", "souvenir", "modif", "garder", "correct"] }
        },
        { input: "Oui c'est parfait garde ça", assert: { modeAfter: "IDLE", memoriesCountMin: 1 } },
      ]
    },

    // ================================================================
    // PHASE 10 — F2 READ : recherche sémantique
    // ================================================================
    {
      name: "10 — F2 READ recherche sémantique",
      steps: [
        {
          input: "Memory c'était quoi le jour où j'ai vu le lac avec la belle lumière ?",
          assert: { modeAfter: "IDLE", responseContainsAny: ["lac", "lumière", "montagne", "souvenir"], description: "Retrouve par indice vague" }
        },
        {
          input: "Memory est-ce que j'ai un souvenir avec Martine ?",
          assert: { modeAfter: "IDLE", responseContainsAny: ["Martine", "café", "voisine", "souvenir"], description: "Retrouve par nom" }
        },
      ]
    },

    // ================================================================
    // PHASE 11 — F3 planification : lettre
    // ================================================================
    {
      name: "11 — F3 planification lettre",
      steps: [
        { input: "Memory je veux écrire une lettre de remerciement au docteur Martin pour son suivi", assert: { modeAfter: "F3_COLLECTING" } },
        { input: "C'est pour le remercier de sa patience et de la qualité du suivi depuis l'opération", assert: { modeAfter: ["F3_COLLECTING", "F3_VALIDATING"] } },
        { input: "C'est le docteur Philippe Martin au centre hospitalier de Grenoble, ton personnel et respectueux", assert: { modeAfter: ["F3_COLLECTING", "F3_VALIDATING"] } },
        {
          input: "Oui c'est tout ce qu'il faut",
          assert: { modeAfter: ["F3_VALIDATING", "F3_EXECUTING"], responseContainsAny: ["plan", "étape", "convient", "1."], description: "Plan forcé au tour 4" }
        },
        { input: "Oui ça me va", assert: { modeAfter: "F3_EXECUTING", planStatus: "in_progress" } },
        { input: "Qu'est-ce que je pourrais mettre comme points clés ?", assert: { modeAfter: "F3_EXECUTING", description: "Aide sans avancer" } },
        { input: "C'est fait", assert: { modeAfter: "F3_EXECUTING", responseContainsAny: ["étape", "2"] } },
        { input: "Où j'en suis ?", assert: { modeAfter: "F3_EXECUTING", responseContainsAny: ["étape", "sur"] } },
        { input: "C'est fait", assert: { modeAfter: "F3_EXECUTING" } },
        { input: "Pause", assert: { modeAfter: "F3_PAUSED", planStatus: "paused" } },
      ]
    },

    // ================================================================
    // PHASE 12 — Switch inter-features depuis F3 pausé
    // ================================================================
    {
      name: "12 — Switch inter-features",
      steps: [
        { input: "Memory quelles sont mes alarmes", assert: { modeAfter: "IDLE", responseContainsAny: ["alarme"], description: "F3→F4 read" } },
        { input: "Memory où est mon passeport ?", assert: { modeAfter: "IDLE", responseContainsAny: ["sac"], description: "→F5 read" } },
        { input: "Memory résume", assert: { modeAfter: "IDLE", description: "→F1 résumé" } },
      ]
    },

    // ================================================================
    // PHASE 13 — Reprise F3 + complétion
    // ================================================================
    {
      name: "13 — Reprise F3 et complétion",
      steps: [
        { input: "Memory on reprend le plan de la lettre", assert: { modeAfter: "F3_EXECUTING", responseContainsAny: ["reprend", "étape", "lettre"] } },
        { input: "C'est fait", assert: { modeAfter: ["F3_EXECUTING", "IDLE"] } },
        { input: "C'est fait", assert: { modeAfter: ["F3_EXECUTING", "IDLE"] } },
        { input: "C'est fait", assert: { modeAfter: ["F3_EXECUTING", "IDLE"] } },
        { input: "C'est fait", assert: { modeAfter: ["F3_EXECUTING", "IDLE"] } },
        { input: "C'est fait", assert: { modeAfter: ["F3_EXECUTING", "IDLE"] } },
      ]
    },

    // ================================================================
    // PHASE 14 — F3 scénario 2 : tâche administrative + stop brutal
    // ================================================================
    {
      name: "14 — F3 tâche administrative + stop",
      steps: [
        { input: "Memory aide-moi à renouveler ma carte d'identité", assert: { modeAfter: "F3_COLLECTING" } },
        { input: "J'habite à Grenoble et ma carte a expiré le mois dernier", assert: { modeAfter: ["F3_COLLECTING", "F3_VALIDATING"] } },
        { input: "Je veux la faire à la mairie de Grenoble", assert: { modeAfter: ["F3_COLLECTING", "F3_VALIDATING"] } },
        {
          input: "C'est tout ce qu'il faut je pense",
          assert: { modeAfter: ["F3_VALIDATING", "F3_EXECUTING"], responseContainsAny: ["plan", "étape", "convient", "1."] }
        },
        { input: "Memory stop", assert: { modeAfter: "IDLE", description: "Stop en plein F3" } },
      ]
    },

    // ================================================================
    // PHASE 15 — F1 nouveau résumé (contexte Thomas)
    // ================================================================
    {
      name: "15 — F1 deuxième résumé",
      steps: [
        { input: "Tu sais que le petit Thomas a eu ses résultats du bac ?", passive: true },
        { input: "Oui il a eu mention très bien, toute la famille est très fière.", passive: true },
        { input: "On va organiser une fête pour lui le week-end prochain.", passive: true },
        { input: "Il faudra penser à acheter un cadeau, peut-être un livre sur l'astronomie.", passive: true },
        {
          input: "Memory résume",
          assert: { modeAfter: "IDLE", responseContainsAny: ["Thomas", "bac", "mention", "fête", "cadeau"], responseNotContains: ["résumé"] }
        },
      ]
    },

    // ================================================================
    // PHASE 16 — Robustesse et edge cases
    // ================================================================
    {
      name: "16 — Robustesse et edge cases",
      steps: [
        {
          input: "Memory euh je sais plus comment dire le truc là de la dernière fois",
          assert: { responseContainsAny: ["précis", "clarif", "voulez", "quel", "compris", "souhaitez", "rappelle", "aide"], description: "Phrase vague → clarification" }
        },
        { input: "Non laisse tomber", assert: { modeAfter: ["IDLE", "ROUTING"] } },
        {
          input: "Memory où sont mes clés de voiture ?",
          assert: { modeAfter: "IDLE", responseContainsAny: ["pas d'emplacement", "enregistré", "déclarer", "pas"], description: "Objet inconnu" }
        },
        {
          input: "Memory aide-moi à faire les courses",
          assert: { modeAfter: "F3_COLLECTING", description: "Nouvelle tâche F3" }
        },
        { input: "Memory stop", assert: { modeAfter: "IDLE" } },
        {
          input: "Memory",
          assert: { modeAfter: "ROUTING", responseContainsAny: ["puis-je", "faire", "aide", "oui"], description: "Wake word seul" }
        },
        { input: "Non rien", assert: { modeAfter: ["IDLE", "ROUTING"] } },
        {
          input: "Bonjour il fait beau aujourd'hui",
          assert: { modeAfter: ["IDLE", "ROUTING"], description: "Sans wake word → passif" }
        },
        {
          input: "Memory crée un souvenir de ma journée",
          assert: { modeAfter: ["F2_CREATE_VALIDATING", "F2_CREATE_BUILDING"], memoriesCountMin: 1, description: "Second souvenir" }
        },
        { input: "Non merci pas aujourd'hui", assert: { modeAfter: "IDLE", description: "Refus souvenir" } },
        {
          input: "Memory rappelle-moi de quelque chose",
          assert: { responseContainsAny: ["motif", "quoi", "rappeler", "quel", "heure", "date"], description: "Alarme sans motif" }
        },
        { input: "Memory stop", assert: { modeAfter: "IDLE" } },
      ]
    },
  ];

  // ──────────────── RUNNER ENGINE ────────────────
  let log = [];
  let results = { total: 0, passed: 0, failed: 0, errors: [], phases: [] };

  function record(type, data) { log.push({ type, time: new Date().toISOString(), ...data }); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitForIdle(timeout = STEP_TIMEOUT) {
    const start = Date.now();
    while (Date.now() - start < timeout) { await sleep(200); if (window._am.isIdle()) return true; }
    return false;
  }

  async function sendAndWait(text, passive = false) {
    window._amLastResponse = null;
    record("input", { text, passive });
    window._am.enqueue(text);
    if (passive) { await sleep(PASSIVE_DELAY); record("passive_done", { text: text.substring(0, 50) }); return null; }
    const ok = await waitForIdle();
    const resp = window._amLastResponse;
    const state = window._am.state();
    record("response", { text: resp?.text || "(aucune réponse)", feature: resp?.feature, mode: state.mode, timedOut: !ok });
    record("state", { mode: state.mode, alarms: state.alarms.length, objects: state.objects.length, memories: state.memories.length, plan: state.plan?.status || null, planStep: state.plan?.current_step || null, collected: Object.keys(state.collected) });
    return { resp, state, timedOut: !ok };
  }

  function checkAssert(assert, resp, state, timedOut) {
    const fails = [];
    if (timedOut) fails.push("⏱ Timeout");
    if (assert.modeAfter) {
      const ex = Array.isArray(assert.modeAfter) ? assert.modeAfter : [assert.modeAfter];
      if (!ex.includes(state.mode)) fails.push(`Mode: attendu ${ex.join("|")}, obtenu ${state.mode}`);
    }
    const text = (resp?.text || "").toLowerCase();
    if (assert.responseContainsAny) {
      if (!assert.responseContainsAny.some(w => text.includes(w.toLowerCase())))
        fails.push(`Réponse ne contient aucun de: [${assert.responseContainsAny.join(", ")}]\nRéponse: "${resp?.text?.substring(0, 150) || "(vide)"}"`);
    }
    if (assert.responseNotContains) {
      for (const w of assert.responseNotContains) if (text.includes(w.toLowerCase())) fails.push(`Réponse contient "${w}" (interdit)`);
    }
    for (const [k, v] of Object.entries(assert)) {
      if (k === "alarmsCount" && state.alarms.length !== v) fails.push(`Alarmes: attendu ${v}, obtenu ${state.alarms.length}`);
      if (k === "alarmsCountMin" && state.alarms.length < v) fails.push(`Alarmes: attendu ≥${v}, obtenu ${state.alarms.length}`);
      if (k === "objectsCount" && state.objects.length !== v) fails.push(`Objets: attendu ${v}, obtenu ${state.objects.length}`);
      if (k === "objectsCountMin" && state.objects.length < v) fails.push(`Objets: attendu ≥${v}, obtenu ${state.objects.length}`);
      if (k === "memoriesCount" && state.memories.length !== v) fails.push(`Souvenirs: attendu ${v}, obtenu ${state.memories.length}`);
      if (k === "memoriesCountMin" && state.memories.length < v) fails.push(`Souvenirs: attendu ≥${v}, obtenu ${state.memories.length}`);
      if (k === "planStatus" && state.plan?.status !== v) fails.push(`Plan: attendu ${v}, obtenu ${state.plan?.status || "null"}`);
    }
    return fails;
  }

  // ──────────────── UI ────────────────
  function createTestUI() {
    const panel = document.createElement("div");
    panel.id = "test-panel";
    panel.innerHTML = `<style>
#test-panel{position:fixed;top:0;right:0;width:420px;height:100vh;background:#111;border-left:2px solid #333;z-index:9999;display:flex;flex-direction:column;font-family:"DM Sans",sans-serif;font-size:13px;color:#ddd}
#test-header{padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center}
#test-header h3{font-size:14px;margin:0}
#test-progress{padding:8px 16px;background:#1a1a1a;border-bottom:1px solid #333;font-size:12px;color:#888}
.test-stats{display:flex;gap:12px;padding:6px 16px;background:#0d0d0d;border-bottom:1px solid #222;font-size:11px}
.test-stats .pass{color:#4caf50}.test-stats .fail{color:#f44336}.test-stats .total{color:#888}
#test-results{flex:1;overflow-y:auto;padding:12px 16px}
.test-phase{margin-bottom:14px}
.test-phase-name{font-weight:600;font-size:13px;margin-bottom:6px;color:#aaa;cursor:pointer}
.test-phase.collapsed .test-steps{display:none}
.test-step{padding:4px 8px;margin:2px 0;border-radius:4px;font-size:12px;line-height:1.4}
.test-step.pass{background:#1a2e1a;color:#4caf50;border-left:3px solid #4caf50}
.test-step.fail{background:#2e1a1a;color:#f44336;border-left:3px solid #f44336}
.test-step.skip{background:#1a1a1a;color:#666;border-left:3px solid #444}
.test-fail-detail{font-size:11px;color:#e88;margin-top:2px;white-space:pre-wrap}
.test-input{color:#888;font-size:11px}.test-response{color:#666;font-size:11px;font-style:italic;max-height:40px;overflow:hidden}
#test-actions{padding:12px 16px;border-top:1px solid #333;display:flex;gap:8px;flex-wrap:wrap}
#test-actions button{padding:6px 14px;border-radius:5px;border:1px solid #444;background:#222;color:#ddd;cursor:pointer;font-size:12px}
#test-actions button:hover{background:#333}
#test-actions button.primary{background:#2a4a7a;border-color:#4a7abc}
</style>
<div id="test-header"><h3>Test Runner v2</h3><button onclick="document.getElementById('test-panel').remove()" style="background:none;border:none;color:#888;font-size:18px;cursor:pointer">✕</button></div>
<div id="test-progress">Prêt — ${PHASES.length} phases, ~${PHASES.reduce((a,p)=>a+p.steps.length,0)} étapes</div>
<div class="test-stats"><span class="total" id="ts-total">0</span><span class="pass" id="ts-pass">✓ 0</span><span class="fail" id="ts-fail">✗ 0</span></div>
<div id="test-results"></div>
<div id="test-actions">
  <button class="primary" onclick="window._runTests()">▶ Lancer</button>
  <button onclick="window._downloadTestLog()">↓ Log JSON</button>
  <button onclick="window._downloadTestReport()">↓ Rapport</button>
</div>`;
    document.body.appendChild(panel);
  }

  function updateProgress(t) { const e = document.getElementById("test-progress"); if (e) e.textContent = t; }
  function updateStats() {
    const t = document.getElementById("ts-total"); if (t) t.textContent = `${results.total} testés`;
    const p = document.getElementById("ts-pass"); if (p) p.textContent = `✓ ${results.passed}`;
    const f = document.getElementById("ts-fail"); if (f) f.textContent = `✗ ${results.failed}`;
  }

  function addPhaseResult(name, steps) {
    const c = document.getElementById("test-results"); if (!c) return;
    const allPass = steps.every(s => s.status !== "fail");
    const d = document.createElement("div"); d.className = `test-phase${allPass ? " collapsed" : ""}`;
    let h = `<div class="test-phase-name" onclick="this.parentElement.classList.toggle('collapsed')">${allPass ? "✅" : "❌"} ${name}</div><div class="test-steps">`;
    for (const s of steps) {
      h += `<div class="test-step ${s.status}"><div>${s.status === "pass" ? "✓" : s.status === "fail" ? "✗" : "…"} ${s.label}</div>`;
      h += `<div class="test-input">${s.input.substring(0, 90)}</div>`;
      if (s.response) h += `<div class="test-response">${s.response.substring(0, 120)}</div>`;
      if (s.fails?.length) h += `<div class="test-fail-detail">${s.fails.join("\n")}</div>`;
      h += `</div>`;
    }
    d.innerHTML = h + `</div>`; c.appendChild(d); c.scrollTop = c.scrollHeight;
  }

  // ──────────────── MAIN ────────────────
  async function runTests() {
    log = []; results = { total: 0, passed: 0, failed: 0, errors: [], phases: [], startTime: new Date().toISOString() };
    window._amTestMode = true; window._amLog = log; window._amLastResponse = null;
    if (confirm("Réinitialiser toutes les données ?")) { window._am.reset(); await sleep(500); }
    const c = document.getElementById("test-results"); if (c) c.innerHTML = "";
    record("test_start", { phases: PHASES.length });

    for (let pi = 0; pi < PHASES.length; pi++) {
      const phase = PHASES[pi]; updateProgress(`Phase ${pi+1}/${PHASES.length} : ${phase.name}`);
      record("phase_start", { name: phase.name });
      const sr = [];
      for (let si = 0; si < phase.steps.length; si++) {
        const step = phase.steps[si];
        updateProgress(`${pi+1}/${PHASES.length} — étape ${si+1}/${phase.steps.length}`);
        const r = await sendAndWait(step.input, step.passive); results.total++;
        if (step.passive) { sr.push({ status: "skip", label: "Passif", input: step.input, response: null, fails: [] }); await sleep(300); continue; }
        if (!step.assert) { sr.push({ status: "pass", label: "Sans assertion", input: step.input, response: r?.resp?.text || "", fails: [] }); results.passed++; await sleep(INTER_STEP_DELAY); continue; }
        const fails = checkAssert(step.assert, r?.resp, r?.state, r?.timedOut);
        const passed = !fails.length;
        if (passed) results.passed++; else { results.failed++; results.errors.push({ phase: phase.name, step: si+1, input: step.input, description: step.assert.description, got: { mode: r?.state?.mode, response: r?.resp?.text?.substring(0,200) }, fails }); }
        record("assert", { phase: phase.name, step: si+1, input: step.input.substring(0,70), passed, fails });
        sr.push({ status: passed ? "pass" : "fail", label: step.assert.description || `Étape ${si+1}`, input: step.input, response: r?.resp?.text || "(aucune)", fails });
        updateStats(); await sleep(INTER_STEP_DELAY);
      }
      results.phases.push({ name: phase.name, steps: sr }); addPhaseResult(phase.name, sr);
    }
    results.endTime = new Date().toISOString();
    record("test_end", { total: results.total, passed: results.passed, failed: results.failed });
    updateProgress(`Terminé : ${results.passed}/${results.total} passés, ${results.failed} échoués`);
    updateStats(); window._amTestMode = false;
  }

  function downloadTestLog() {
    const b = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" }); const u = URL.createObjectURL(b);
    const a = document.createElement("a"); a.href = u; a.download = `test-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; a.click(); URL.revokeObjectURL(u);
  }
  function downloadTestReport() {
    const l = [`# Test Report v2 — ${new Date().toLocaleString("fr-FR")}`, ``, `**Total: ${results.total} | ✓ ${results.passed} | ✗ ${results.failed}**`, ``];
    for (const p of results.phases) {
      const ok = p.steps.every(s => s.status !== "fail");
      l.push(`## ${ok ? "✅" : "❌"} ${p.name}`);
      for (const s of p.steps) {
        l.push(`${s.status === "pass" ? "✅" : s.status === "fail" ? "❌" : "⏭"} **${s.label}**`);
        l.push(`  Input: ${s.input.substring(0, 90)}`);
        if (s.response) l.push(`  Response: ${s.response.substring(0, 120)}`);
        if (s.fails?.length) for (const f of s.fails) l.push(`  ⚠ ${f}`);
        l.push(``);
      }
    }
    if (results.errors.length) { l.push(`## Erreurs`); for (const e of results.errors) { l.push(`- **${e.phase}** #${e.step}: ${e.input.substring(0,70)}`); if (e.description) l.push(`  📝 ${e.description}`); for (const f of e.fails) l.push(`  - ${f}`); } }
    const b = new Blob([l.join("\n")], { type: "text/markdown" }); const u = URL.createObjectURL(b);
    const a = document.createElement("a"); a.href = u; a.download = `test-report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`; a.click(); URL.revokeObjectURL(u);
  }

  window._runTests = runTests; window._downloadTestLog = downloadTestLog; window._downloadTestReport = downloadTestReport;

  document.addEventListener("DOMContentLoaded", () => {
    const s = document.createElement("section"); s.className = "panel-section";
    s.innerHTML = `<h3>Tests automatisés</h3><button class="btn-sm" style="width:100%;padding:8px" onclick="if(!document.getElementById('test-panel')){(${createTestUI.toString()})();}">🧪 Test Runner v2</button><p style="font-size:11px;color:var(--text-faint);margin-top:6px">${PHASES.length} phases, ~${PHASES.reduce((a,p)=>a+p.steps.length,0)} étapes</p>`;
    const lp = document.getElementById("panel-left"); if (lp) lp.appendChild(s);
  });
})();