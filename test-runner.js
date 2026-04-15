// test-runner.js v3 — No redundancy, exhaustive coverage
// 12 phases: each feature tested for CREATE, READ, UPDATE, DELETE, DEDUP once
(function () {
  "use strict";
  const STEP_TIMEOUT = 25000, PASSIVE_DELAY = 600, INTER_STEP_DELAY = 900;

  const PHASES = [
    // ── 1. F1 résumé (buffer only, not full day) ──
    {
      name: "1 — F1 résumé conversation",
      steps: [
        { input: "Alors Christine tu as eu des nouvelles du docteur Martin ?", passive: true },
        { input: "Oui il m'a appelée, tout est normal, il veut te revoir dans trois mois pour le suivi neurologique.", passive: true },
        { input: "Au fait pour samedi j'ai réservé au Panorama pour 20 heures avec Martine et Jacques.", passive: true },
        { input: "Paul apporte du Riesling et moi un gâteau au citron.", passive: true },
        { input: "Memory résume", assert: {
          modeAfter: "IDLE",
          responseContainsAny: ["Martin", "Panorama", "restaurant", "samedi"],
          responseNotContains: ["résumé", "vous m'avez demandé"],
          description: "Résumé du buffer 10min, pas de toute la journée"
        }},
      ]
    },

    // ── 2. F4 CRUD complet (create, dedup, read, update, delete) ──
    {
      name: "2 — F4 CRUD complet",
      steps: [
        // CREATE 1
        { input: "Memory rappelle-moi de confirmer la réservation du restaurant mercredi à 10 heures",
          assert: { responseContainsAny: ["restaurant", "mercredi", "10", "correct", "rappel"] } },
        { input: "Oui", assert: { modeAfter: "IDLE", alarmsCountMin: 1 } },
        // CREATE 2
        { input: "Memory rappelle-moi d'appeler le docteur Martin le 15 juin à 9 heures",
          assert: { responseContainsAny: ["Martin", "juin", "9", "correct"] } },
        { input: "Oui", assert: { modeAfter: "IDLE", alarmsCountMin: 2 } },
        // DEDUP
        { input: "Memory rappelle-moi de confirmer le restaurant",
          assert: { responseContainsAny: ["déjà", "similaire", "même", "restaurant", "remplacer"], description: "Doublon détecté" } },
        { input: "Non laisse tomber", assert: { modeAfter: ["IDLE", "ROUTING", "F4_CREATE_DEDUP"] } },
        // READ
        { input: "Memory quelles sont mes alarmes",
          assert: { modeAfter: "IDLE", responseContainsAny: ["restaurant", "Martin"], description: "Liste les 2 alarmes" } },
        // UPDATE
        { input: "Memory décale l'alarme du restaurant à mardi à 14 heures",
          assert: { responseContainsAny: ["restaurant", "mardi", "14", "modif", "décal", "trouv", "correct"] } },
        { input: "Oui", assert: { modeAfter: "IDLE" } },
        // DELETE
        { input: "Memory supprime l'alarme du docteur Martin",
          assert: { responseContainsAny: ["Martin", "suppr", "confirm", "trouv"] } },
        { input: "Oui", assert: { modeAfter: "IDLE", alarmsCountMin: 1 } },
      ]
    },

    // ── 3. F5 CRUD complet (create, read, alias/dedup, update, delete) ──
    {
      name: "3 — F5 CRUD complet",
      steps: [
        // CREATE 3 objects
        { input: "Memory j'ai posé mon portefeuille sur la commode de l'entrée", assert: { responseContainsAny: ["portefeuille", "commode", "correct"] } },
        { input: "Oui", assert: { objectsCountMin: 1 } },
        { input: "Memory le passeport est dans le tiroir du bureau", assert: { responseContainsAny: ["passeport", "tiroir", "correct"] } },
        { input: "Oui", assert: { objectsCountMin: 2 } },
        { input: "Memory les clés sont sur le crochet de l'entrée", assert: { responseContainsAny: ["clé", "crochet", "correct"] } },
        { input: "Oui", assert: { objectsCountMin: 3 } },
        // READ
        { input: "Memory où est mon portefeuille ?", assert: { modeAfter: "IDLE", responseContainsAny: ["portefeuille", "commode"] } },
        // READ objet inconnu
        { input: "Memory où est mon téléphone ?", assert: { modeAfter: "IDLE", responseContainsAny: ["pas", "enregistré", "déclarer"], description: "Objet inconnu" } },
        // ALIAS (papiers ≈ passeport)
        { input: "Memory j'ai mis mes papiers dans le sac à dos", assert: { responseContainsAny: ["papiers", "sac", "correct", "passeport", "même", "déjà"] } },
        { input: "Oui c'est la même chose", assert: { modeAfter: "IDLE" } },
        { input: "Memory où est mon passeport ?", assert: { modeAfter: "IDLE", responseContainsAny: ["sac"], responseNotContains: ["tiroir"], description: "Nouvel emplacement après fusion" } },
        // UPDATE
        { input: "Memory en fait mon portefeuille est dans la voiture", assert: { responseContainsAny: ["portefeuille", "voiture", "correct", "même", "déjà"] } },
        { input: "Oui", assert: { modeAfter: ["IDLE", "F5_CREATE_DEDUP"] } },
        // DELETE
        { input: "Memory supprime l'objet clés de la maison", assert: { responseContainsAny: ["clé", "suppr", "confirm"] } },
        { input: "Oui", assert: { modeAfter: "IDLE" } },
      ]
    },

    // ── 4. F2 CRUD complet (create + edit, read sémantique, dedup) ──
    {
      name: "4 — F2 CRUD complet",
      steps: [
        // Passive content for souvenir
        { input: "Le reflet sur le lac est incroyable avec cette lumière dorée.", passive: true },
        { input: "La voisine Martine est passée pour inviter au café demain à 15h.", passive: true },
        { input: "On a croisé le facteur avec un colis de tante Marie.", passive: true },
        // CREATE + EDIT
        { input: "Memory crée un souvenir de ma journée",
          assert: { modeAfter: ["F2_CREATE_VALIDATING", "F2_CREATE_BUILDING"], responseContainsAny: ["souvenir", "journée"] } },
        { input: "Rajoute que la lumière dorée sur le lac m'a particulièrement ému",
          assert: { responseContainsAny: ["lumière", "ému", "lac"] } },
        { input: "Oui c'est parfait", assert: { modeAfter: "IDLE", memoriesCountMin: 1 } },
        // READ par indice vague
        { input: "Memory c'était quoi le jour au bord du lac ?",
          assert: { modeAfter: "IDLE", responseContainsAny: ["lac", "lumière"], description: "Recherche sémantique" } },
        // READ par nom de personne
        { input: "Memory est-ce que j'ai un souvenir avec le docteur Martin ?",
          assert: { modeAfter: "IDLE", responseContainsAny: ["Martin", "bilan", "souvenir", "normal", "trouvé"], description: "Recherche par nom" } },
      ]
    },

    // ── 5. F3 planification (collecte, validation, exécution, pause) ──
    {
      name: "5 — F3 planification lettre",
      steps: [
        { input: "Memory je veux écrire une lettre de remerciement au docteur Martin",
          assert: { modeAfter: "F3_COLLECTING" } },
        { input: "Pour le remercier de sa patience depuis l'opération, docteur Philippe Martin, CHU Grenoble, ton personnel",
          assert: { modeAfter: ["F3_COLLECTING", "F3_VALIDATING"] } },
        { input: "Par courrier postal",
          assert: { modeAfter: ["F3_COLLECTING", "F3_VALIDATING"] } },
        { input: "C'est tout",
          assert: { modeAfter: ["F3_VALIDATING", "F3_EXECUTING"], responseContainsAny: ["plan", "étape"], description: "Plan généré au tour 4" } },
        // Validation du plan
        { input: "Oui ça me va",
          assert: { modeAfter: "F3_EXECUTING", planStatus: "in_progress" } },
        // Help contextuel (ne doit PAS avancer)
        { input: "Qu'est-ce que je devrais noter comme points clés ?",
          assert: { modeAfter: "F3_EXECUTING", description: "Aide sans avancer" } },
        // Avancer + status
        { input: "C'est fait", assert: { modeAfter: "F3_EXECUTING", responseContainsAny: ["étape", "2"] } },
        { input: "Où j'en suis ?", assert: { modeAfter: "F3_EXECUTING", responseContainsAny: ["étape", "sur"] } },
        { input: "C'est fait", assert: { modeAfter: "F3_EXECUTING" } },
        // Pause
        { input: "Pause", assert: { modeAfter: "F3_PAUSED", planStatus: "paused" } },
      ]
    },

    // ── 6. Switch inter-features depuis F3 pausé ──
    {
      name: "6 — Switch inter-features",
      steps: [
        { input: "Memory quelles sont mes alarmes", assert: { modeAfter: "IDLE", responseContainsAny: ["alarme"] } },
        { input: "Memory où est mon passeport ?", assert: { modeAfter: "IDLE", responseContainsAny: ["sac"] } },
      ]
    },

    // ── 7. F3 reprise + complétion ──
    {
      name: "7 — F3 reprise et complétion",
      steps: [
        { input: "Memory on reprend le plan",
          assert: { modeAfter: "F3_EXECUTING", responseContainsAny: ["reprend", "étape"] } },
        { input: "C'est fait", assert: { modeAfter: ["F3_EXECUTING", "IDLE"] } },
        { input: "C'est fait", assert: { modeAfter: ["F3_EXECUTING", "IDLE"] } },
        { input: "C'est fait", assert: { modeAfter: ["F3_EXECUTING", "IDLE"] } },
        { input: "C'est fait", assert: { modeAfter: ["F3_EXECUTING", "IDLE"] } },
        { input: "C'est fait", assert: { modeAfter: ["F3_EXECUTING", "IDLE"] } },
      ]
    },

    // ── 8. F3 scénario 2 + stop brutal ──
    {
      name: "8 — F3 tâche administrative + stop",
      steps: [
        { input: "Memory aide-moi à renouveler ma carte d'identité", assert: { modeAfter: "F3_COLLECTING" } },
        { input: "Ma carte a expiré, j'habite à Grenoble, je veux la faire à la mairie", assert: { modeAfter: ["F3_COLLECTING", "F3_VALIDATING"] } },
        { input: "C'est tout", assert: { modeAfter: ["F3_COLLECTING", "F3_VALIDATING"], responseContainsAny: ["plan", "étape", "convient"] } },
        { input: "Memory stop", assert: { modeAfter: "IDLE" } },
      ]
    },

    // ── 9. F1 deuxième résumé (nouveau contexte) ──
    {
      name: "9 — F1 nouveau contexte",
      steps: [
        { input: "Le petit Thomas a eu son bac avec mention très bien.", passive: true },
        { input: "On va organiser une fête, peut-être un livre d'astronomie comme cadeau.", passive: true },
        { input: "Memory résume", assert: {
          modeAfter: "IDLE",
          responseContainsAny: ["Thomas", "bac", "mention", "fête", "cadeau"],
          description: "Résumé du nouveau contexte"
        }},
      ]
    },

    // ── 10. F2 refus de souvenir ──
    {
      name: "10 — F2 refus de souvenir",
      steps: [
        { input: "Memory crée un souvenir de ma journée", assert: { modeAfter: ["F2_CREATE_VALIDATING", "F2_CREATE_BUILDING"] } },
        { input: "Non merci pas aujourd'hui", assert: { modeAfter: "IDLE", description: "Refus propre" } },
      ]
    },

    // ── 11. Edge cases ──
    {
      name: "11 — Edge cases",
      steps: [
        // Phrase vague
        { input: "Memory euh je sais plus le truc là", assert: { responseContainsAny: ["précis", "clarif", "voulez", "quel", "souhaitez", "rappelle", "aide"], description: "Vague → clarification" } },
        { input: "Non rien", assert: { modeAfter: ["IDLE", "ROUTING"] } },
        // Objet inconnu
        { input: "Memory où sont mes clés de voiture ?", assert: { modeAfter: "IDLE", responseContainsAny: ["pas", "enregistré", "déclarer"] } },
        // Wake word seul
        { input: "Memory", assert: { modeAfter: "ROUTING", responseContainsAny: ["puis-je", "faire", "aide", "oui"] } },
        { input: "Non rien", assert: { modeAfter: ["IDLE", "ROUTING"] } },
        // Alarme sans motif
        { input: "Memory rappelle-moi de quelque chose", assert: { responseContainsAny: ["quoi", "rappeler", "quel", "motif", "heure"] } },
        { input: "Memory stop", assert: { modeAfter: "IDLE" } },
      ]
    },

    // ── 12. F4 recherche approximative ──
    {
      name: "12 — Recherches approximatives",
      steps: [
        { input: "Memory est-ce que j'ai un rappel pour le restaurant ?", assert: { modeAfter: "IDLE", responseContainsAny: ["restaurant", "alarme", "rappel"], description: "F4 recherche approx" } },
        { input: "Memory c'était quoi le souvenir avec la lumière ?", assert: { modeAfter: "IDLE", responseContainsAny: ["lac", "lumière"], description: "F2 recherche approx" } },
      ]
    },
  ];

  // ──── Engine (compact) ────
  let log = [], results = { total: 0, passed: 0, failed: 0, errors: [], phases: [] };
  const record = (type, data) => log.push({ type, time: new Date().toISOString(), ...data });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function waitIdle(t = STEP_TIMEOUT) { const s = Date.now(); while (Date.now() - s < t) { await sleep(200); if (window._am.isIdle()) return true; } return false; }

  async function sendWait(text, passive) {
    window._amLastResponse = null; record("input", { text, passive }); window._am.enqueue(text);
    if (passive) { await sleep(PASSIVE_DELAY); return null; }
    const ok = await waitIdle(); const resp = window._amLastResponse; const state = window._am.state();
    record("response", { text: resp?.text || "(none)", mode: state.mode, timedOut: !ok });
    record("state", { mode: state.mode, alarms: state.alarms.length, objects: state.objects.length, memories: state.memories.length, plan: state.plan?.status || null });
    return { resp, state, timedOut: !ok };
  }

  function check(a, resp, state, timedOut) {
    const f = []; const t = (resp?.text || "").toLowerCase();
    if (timedOut) f.push("⏱ Timeout");
    if (a.modeAfter) { const ex = [].concat(a.modeAfter); if (!ex.includes(state.mode)) f.push(`Mode: ${ex.join("|")} ≠ ${state.mode}`); }
    if (a.responseContainsAny && !a.responseContainsAny.some(w => t.includes(w.toLowerCase()))) f.push(`Manque: [${a.responseContainsAny.join(",")}] dans "${resp?.text?.substring(0,120)}"`);
    if (a.responseNotContains) for (const w of a.responseNotContains) if (t.includes(w.toLowerCase())) f.push(`Interdit: "${w}"`);
    for (const [k,v] of Object.entries(a)) {
      if (k === "alarmsCount" && state.alarms.length !== v) f.push(`Alarmes: ${v} ≠ ${state.alarms.length}`);
      if (k === "alarmsCountMin" && state.alarms.length < v) f.push(`Alarmes: ≥${v} ≠ ${state.alarms.length}`);
      if (k === "objectsCountMin" && state.objects.length < v) f.push(`Objets: ≥${v} ≠ ${state.objects.length}`);
      if (k === "memoriesCountMin" && state.memories.length < v) f.push(`Souvenirs: ≥${v} ≠ ${state.memories.length}`);
      if (k === "planStatus" && state.plan?.status !== v) f.push(`Plan: ${v} ≠ ${state.plan?.status}`);
    }
    return f;
  }

  // ──── UI ────
  function createUI() {
    const p = document.createElement("div"); p.id = "test-panel";
    p.innerHTML = `<style>#test-panel{position:fixed;top:0;right:0;width:420px;height:100vh;background:#111;border-left:2px solid #333;z-index:9999;display:flex;flex-direction:column;font-family:sans-serif;font-size:13px;color:#ddd}#test-header{padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between}#test-progress{padding:8px 16px;background:#1a1a1a;font-size:12px;color:#888;border-bottom:1px solid #222}.ts{display:flex;gap:12px;padding:6px 16px;font-size:11px;border-bottom:1px solid #222}.ts .p{color:#4caf50}.ts .f{color:#f44336}#test-r{flex:1;overflow-y:auto;padding:12px 16px}.tp{margin-bottom:12px}.tn{font-weight:600;font-size:13px;color:#aaa;cursor:pointer;margin-bottom:4px}.tp.c .ts2{display:none}.ts2 .s{padding:3px 8px;margin:1px 0;border-radius:4px;font-size:12px;line-height:1.3}.ts2 .s.p{background:#1a2e1a;color:#4caf50;border-left:3px solid #4caf50}.ts2 .s.f{background:#2e1a1a;color:#f44336;border-left:3px solid #f44336}.ts2 .s.k{background:#1a1a1a;color:#666;border-left:3px solid #444}.fd{font-size:11px;color:#e88;white-space:pre-wrap}.si{color:#888;font-size:11px}.sr{color:#555;font-size:11px;font-style:italic}#test-a{padding:12px 16px;border-top:1px solid #333;display:flex;gap:8px}#test-a button{padding:6px 14px;border-radius:5px;border:1px solid #444;background:#222;color:#ddd;cursor:pointer;font-size:12px}#test-a button:hover{background:#333}#test-a .pr{background:#2a4a7a;border-color:#4a7abc}</style>
<div id="test-header"><h3 style="margin:0;font-size:14px">Tests v3</h3><button onclick="this.closest('#test-panel').remove()" style="background:none;border:none;color:#888;font-size:18px;cursor:pointer">✕</button></div>
<div id="test-progress">${PHASES.length} phases, ~${PHASES.reduce((a,p)=>a+p.steps.length,0)} étapes</div>
<div class="ts"><span id="tt" class="t">0</span><span id="tp2" class="p">✓ 0</span><span id="tf2" class="f">✗ 0</span></div>
<div id="test-r"></div>
<div id="test-a"><button class="pr" onclick="window._runTests()">▶ Lancer</button><button onclick="window._dlLog()">↓ Log</button><button onclick="window._dlReport()">↓ Rapport</button></div>`;
    document.body.appendChild(p);
  }

  function upd(t) { const e = document.getElementById("test-progress"); if (e) e.textContent = t; }
  function updS() {
    const a = document.getElementById("tt"); if (a) a.textContent = results.total;
    const b = document.getElementById("tp2"); if (b) b.textContent = "✓ " + results.passed;
    const c = document.getElementById("tf2"); if (c) c.textContent = "✗ " + results.failed;
  }

  function addPR(name, steps) {
    const c = document.getElementById("test-r"); if (!c) return;
    const ok = steps.every(s => s.st !== "f"); const d = document.createElement("div");
    d.className = `tp${ok ? " c" : ""}`; let h = `<div class="tn" onclick="this.parentElement.classList.toggle('c')">${ok?"✅":"❌"} ${name}</div><div class="ts2">`;
    for (const s of steps) {
      h += `<div class="s ${s.st}"><div>${s.st==="p"?"✓":s.st==="f"?"✗":"…"} ${s.l}</div><div class="si">${s.i.substring(0,90)}</div>`;
      if (s.r) h += `<div class="sr">${s.r.substring(0,120)}</div>`;
      if (s.fl?.length) h += `<div class="fd">${s.fl.join("\n")}</div>`;
      h += `</div>`;
    }
    d.innerHTML = h + "</div>"; c.appendChild(d); c.scrollTop = c.scrollHeight;
  }

  async function runTests() {
    log = []; results = { total:0, passed:0, failed:0, errors:[], phases:[], start: new Date().toISOString() };
    window._amTestMode = true; window._amLog = log; window._amLastResponse = null;
    if (confirm("Reset données ?")) { window._am.reset(); await sleep(500); }
    const c = document.getElementById("test-r"); if (c) c.innerHTML = "";

    for (let pi = 0; pi < PHASES.length; pi++) {
      const ph = PHASES[pi]; upd(`${pi+1}/${PHASES.length}: ${ph.name}`);
      const sr = [];
      for (let si = 0; si < ph.steps.length; si++) {
        const st = ph.steps[si]; results.total++;
        if (st.passive) { await sendWait(st.input, true); sr.push({st:"k",l:"Passif",i:st.input,r:null,fl:[]}); await sleep(300); continue; }
        const r = await sendWait(st.input); if (!st.assert) { sr.push({st:"p",l:"OK",i:st.input,r:r?.resp?.text||"",fl:[]}); results.passed++; await sleep(INTER_STEP_DELAY); continue; }
        const fl = check(st.assert, r?.resp, r?.state, r?.timedOut); const ok = !fl.length;
        if (ok) results.passed++; else { results.failed++; results.errors.push({ph:ph.name,step:si+1,input:st.input,desc:st.assert.description,fl}); }
        sr.push({st:ok?"p":"f",l:st.assert.description||`#${si+1}`,i:st.input,r:r?.resp?.text||"(none)",fl});
        updS(); await sleep(INTER_STEP_DELAY);
      }
      results.phases.push({name:ph.name,steps:sr}); addPR(ph.name, sr);
    }
    results.end = new Date().toISOString();
    upd(`Terminé: ${results.passed}/${results.total} ✓, ${results.failed} ✗`); updS();
    window._amTestMode = false;
  }

  function dlLog() { const b = new Blob([JSON.stringify(log,null,2)],{type:"application/json"}); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href=u; a.download=`test-log-${new Date().toISOString().replace(/[:.]/g,"-")}.json`; a.click(); URL.revokeObjectURL(u); }
  function dlReport() {
    const l = [`# Test v3 — ${new Date().toLocaleString("fr-FR")}`,``,`**${results.total} total | ✓ ${results.passed} | ✗ ${results.failed}**`,``];
    for (const p of results.phases) { const ok=p.steps.every(s=>s.st!=="f"); l.push(`## ${ok?"✅":"❌"} ${p.name}`); for (const s of p.steps) { l.push(`${s.st==="p"?"✅":s.st==="f"?"❌":"⏭"} **${s.l}**`); l.push(`  ${s.i.substring(0,90)}`); if(s.r)l.push(`  → ${s.r.substring(0,120)}`); if(s.fl?.length)for(const f of s.fl)l.push(`  ⚠ ${f}`); l.push(""); } }
    if(results.errors.length){l.push("## Erreurs"); for(const e of results.errors){l.push(`- **${e.ph}** #${e.step}: ${e.input.substring(0,70)}`); if(e.desc)l.push(`  📝 ${e.desc}`); for(const f of e.fl)l.push(`  - ${f}`);}}
    const b=new Blob([l.join("\n")],{type:"text/markdown"}); const u=URL.createObjectURL(b); const a=document.createElement("a"); a.href=u; a.download=`test-report-${new Date().toISOString().replace(/[:.]/g,"-")}.md`; a.click(); URL.revokeObjectURL(u);
  }

  window._runTests = runTests; window._dlLog = dlLog; window._dlReport = dlReport;
  document.addEventListener("DOMContentLoaded", () => {
    const s = document.createElement("section"); s.className = "panel-section";
    s.innerHTML = `<h3>Tests</h3><button class="btn-sm" style="width:100%;padding:8px" onclick="if(!document.getElementById('test-panel')){(${createUI.toString()})();}">🧪 Tests v3 (${PHASES.length} phases)</button>`;
    const lp = document.getElementById("panel-left"); if (lp) lp.appendChild(s);
  });
})();
