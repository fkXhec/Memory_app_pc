// ============================================================
// ASSISTANT MÉMOIRE VOCAL — app.js v4 (complete rewrite)
// 
// Fixes from v3:
// - Input queue with mutex (no concurrent processing)
// - ONE speak per input (no cascading)
// - Strict LLM JSON validation
// - Anti-feedback: TTS↔STT coordination with cooldown
// - Better routing prompts with strong examples
// - Current date/time in all prompts
// - Proper field validation before state transitions
// ============================================================
(function () {
  "use strict";

  // ---- CONFIG ----
  const CLAUDE_MODEL = "claude-sonnet-4-6";
  const SESSION_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min silence → close session
  const SUMMARY_INTERVAL_MS = 90 * 1000;       // background summary every 90s
  const RELANCE_SOFT_MS = 30 * 1000;
  const RELANCE_HARD_MS = 3 * 60 * 1000;
  const TTS_COOLDOWN_MS = 600;                  // cooldown after TTS before accepting STT
  const STT_DEBOUNCE_MS = 1400;                 // wait for user to finish speaking
  const WAKE_RE = /\bmemor(?:y|ie?|is?|i)\b/i;

  // ---- MODES ----
  const M = Object.freeze({
    IDLE: "IDLE",
    ROUTING: "ROUTING",
    SUMMARY: "SUMMARY",
    F3_COLLECTING: "F3_COLLECTING",
    F3_VALIDATING: "F3_VALIDATING",
    F3_EXECUTING: "F3_EXECUTING",
    F3_PAUSED: "F3_PAUSED",
    F2_CREATE_BUILDING: "F2_CREATE_BUILDING",
    F2_CREATE_VALIDATING: "F2_CREATE_VALIDATING",
    F2_CREATE_DEDUP: "F2_CREATE_DEDUP",
    F2_READ: "F2_READ",
    F2_UPDATE_FINDING: "F2_UPDATE_FINDING",
    F2_UPDATE_BUILDING: "F2_UPDATE_BUILDING",
    F2_UPDATE_VALIDATING: "F2_UPDATE_VALIDATING",
    F2_DELETE_FINDING: "F2_DELETE_FINDING",
    F2_DELETE_CONFIRMING: "F2_DELETE_CONFIRMING",
    F4_CREATE_BUILDING: "F4_CREATE_BUILDING",
    F4_CREATE_VALIDATING: "F4_CREATE_VALIDATING",
    F4_CREATE_DEDUP: "F4_CREATE_DEDUP",
    F4_READ: "F4_READ",
    F4_UPDATE_FINDING: "F4_UPDATE_FINDING",
    F4_UPDATE_BUILDING: "F4_UPDATE_BUILDING",
    F4_UPDATE_VALIDATING: "F4_UPDATE_VALIDATING",
    F4_DELETE_FINDING: "F4_DELETE_FINDING",
    F4_DELETE_CONFIRMING: "F4_DELETE_CONFIRMING",
    F5_CREATE_BUILDING: "F5_CREATE_BUILDING",
    F5_CREATE_VALIDATING: "F5_CREATE_VALIDATING",
    F5_CREATE_DEDUP: "F5_CREATE_DEDUP",
    F5_READ: "F5_READ",
    F5_UPDATE_FINDING: "F5_UPDATE_FINDING",
    F5_UPDATE_BUILDING: "F5_UPDATE_BUILDING",
    F5_UPDATE_VALIDATING: "F5_UPDATE_VALIDATING",
    F5_DELETE_FINDING: "F5_DELETE_FINDING",
    F5_DELETE_CONFIRMING: "F5_DELETE_CONFIRMING",
  });

  // ---- STATE ----
  const S = {
    mode: M.IDLE,
    apiKey: "",
    isConnected: false,
    isListening: false,
    isSpeaking: false,
    isProcessing: false,
    ttsCooldown: false,       // true for TTS_COOLDOWN_MS after TTS ends
    // F1
    currentSession: null,
    daySessions: load("am_days", []),
    // F2
    memories: load("am_mem", []),
    pendingObj: null,
    targetId: null,
    // F3
    plan: load("am_plan", null),
    planContext: {},
    // F4
    alarms: load("am_alarms", []),
    // F5
    objects: load("am_objects", []),
  };

  // ---- INPUT QUEUE (mutex) ----
  const inputQueue = [];
  let queueRunning = false;

  function enqueueInput(text) {
    if (!text || !text.trim()) return;
    inputQueue.push(text.trim());
    if (!queueRunning) drainQueue();
  }

  async function drainQueue() {
    queueRunning = true;
    while (inputQueue.length > 0) {
      const text = inputQueue.shift();
      try {
        await processInput(text);
      } catch (e) {
        console.error("processInput error:", e);
        setProcessing(false);
      }
    }
    queueRunning = false;
  }

  // ---- PERSISTENCE ----
  let recognition = null, summaryTimer = null, relanceTimer = null, restartTimeout = null;

  function load(k, def) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; }
    catch { return def; }
  }

  function save() {
    try {
      localStorage.setItem("am_days", JSON.stringify(S.daySessions));
      localStorage.setItem("am_mem", JSON.stringify(S.memories));
      localStorage.setItem("am_plan", JSON.stringify(S.plan));
      localStorage.setItem("am_alarms", JSON.stringify(S.alarms));
      localStorage.setItem("am_objects", JSON.stringify(S.objects));
    } catch (e) { console.warn("save error:", e); }
  }

  // ---- UTILS ----
  function gid(p) { return p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function iso() { return new Date().toISOString(); }
  function ftime(t) { return new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); }
  function fdate(d) { return new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }); }
  function fdateShort(d) { return new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }); }
  function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  function now() { return new Date(); }
  function todayStr() { return now().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); }
  const $ = s => document.querySelector(s);

  // ---- DOM CACHE ----
  const D = {};
  function cacheDom() {
    ["api-key-input", "btn-api-connect", "api-status", "btn-mic", "mic-state",
      "text-form", "text-input", "btn-reset", "conversation-log", "empty-state",
      "interim-bar", "interim-text", "scenarios-list", "mode-label", "mode-dot",
      "feature-indicator", "session-count", "session-entries", "day-sessions-count",
      "day-sessions-entries", "memories-count", "memories-entries", "plan-entries",
      "alarms-count", "alarms-entries", "objects-count", "objects-entries"
    ].forEach(id => {
      D[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = $("#" + id);
    });
  }

  // ============================================================
  // LLM — strict narrow calls with JSON validation
  // ============================================================
  async function llm(systemPrompt, userContent, retries = 1) {
    if (!S.apiKey) return { _error: "Pas de clé API" };
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": S.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: CLAUDE_MODEL,
            max_tokens: 1024,
            system: systemPrompt,
            messages: [{ role: "user", content: userContent }],
          }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error?.message || `HTTP ${r.status}`);
        }
        const d = await r.json();
        const raw = (d.content || []).find(c => c.type === "text")?.text || "";
        return parseJSON(raw);
      } catch (e) {
        console.warn(`LLM attempt ${attempt}:`, e.message);
        if (attempt === retries) return { _error: e.message, speech: "Désolé, une erreur technique est survenue." };
      }
    }
    return { _error: "unreachable" };
  }

  /** Extract JSON from LLM response text. Falls back to {speech: rawText} */
  function parseJSON(raw) {
    // Try full text as JSON
    try { return JSON.parse(raw.trim()); } catch {}
    // Try extracting JSON block
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    // Fallback: treat as plain speech
    return { speech: raw.trim() || "Je n'ai pas compris." };
  }

  /** Validate that response has required keys. Returns null if invalid. */
  function validate(obj, requiredKeys) {
    if (!obj || typeof obj !== "object") return null;
    for (const k of requiredKeys) {
      if (obj[k] === undefined || obj[k] === null) return null;
    }
    return obj;
  }

  // ============================================================
  // PROMPT BUILDERS
  // ============================================================
  function currentDateTime() {
    return now().toLocaleString("fr-FR", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  }

  const PROMPTS = {

    routing: () => `Tu es le routeur d'un assistant mémoire pour patient amnésique.
Date et heure actuelles : ${currentDateTime()}.

Le patient a dit "Memory" suivi d'une demande. Ton UNIQUE travail : identifier la feature et l'opération CRUD.

=== FEATURES ===
f1 : résumé de conversation en cours ("résume", "on parlait de quoi", "c'est quoi le sujet")
f2 : souvenirs enregistrés ("souvenir", "ma journée", "qu'est-ce que j'ai fait", "la fois où")
f3 : aide à l'action structurée ("je veux faire", "aide-moi à", "comment faire pour", toute tâche multi-étapes)
f4 : alarmes et rappels temporels ("rappelle-moi", "alarme", "n'oublie pas", "à quelle heure", "quelles alarmes", "décale", "supprime le rappel")
f5 : objets et emplacements ("j'ai posé", "j'ai mis", "j'ai rangé", "où est", "où sont", "mes clés", "mon passeport", "mes lunettes")

=== CRUD (pour f2, f4, f5) ===
create : créer/enregistrer/noter quelque chose de NOUVEAU
read : consulter/chercher/retrouver/lister
update : modifier/changer/décaler quelque chose d'EXISTANT
delete : supprimer/enlever/annuler

=== EXEMPLES DE ROUTAGE ===
"rappelle-moi d'appeler le médecin demain à 15h" → f4, create
"j'ai posé mon portefeuille sur la commode" → f5, create  
"où est mon passeport" → f5, read
"résume" → f1, null
"crée un souvenir de ma journée" → f2, create
"c'était quoi le jour au bord du lac" → f2, read
"quelles sont mes alarmes" → f4, read
"décale l'alarme du restaurant à mardi" → f4, update
"supprime l'alarme du médecin" → f4, delete
"je veux écrire une lettre de remerciement" → f3, null
"on reprend le plan" → f3, null
"mes papiers sont dans le sac" → f5, create
"aide-moi à faire les courses" → f3, null

=== ATTENTION ===
- "j'ai posé/mis/rangé [objet] [lieu]" = TOUJOURS f5 create. JAMAIS f4.
- "rappelle-moi" / "n'oublie pas" = TOUJOURS f4 create.
- "où est/sont" = TOUJOURS f5 read.
- Ne confonds JAMAIS objets (f5) et alarmes (f4).

Retourne UNIQUEMENT ce JSON, rien d'autre :
{"feature":"f1|f2|f3|f4|f5","crud":"create|read|update|delete|null","confidence":"high|low","speech":"..."}

Si confidence="low", speech = UNE question de clarification courte.
Si confidence="high", speech = "" (vide, le handler suivant parlera).`,

    summary: () => `Tu es un assistant mémoire pour patient amnésique.
On te donne la transcription d'une conversation entre PLUSIEURS personnes.
Le patient est l'une de ces personnes.

TON TRAVAIL : résumer le CONTENU de la conversation, pas le fait qu'on t'a demandé un résumé.

RÈGLES STRICTES :
- Phrases 1-2 : les sujets principaux abordés et les décisions/informations clés
- Phrase 3 : le dernier point en cours à l'instant (si identifiable)
- Identifie les personnes par leur nom quand mentionné
- NE DIS PAS "vous m'avez demandé", "voici le résumé", etc.
- Commence directement par le contenu : "La conversation portait sur..." ou "Vous discutiez de..."
- Vouvoie le patient
- 3 phrases maximum, ton calme et direct
- Si la transcription est confuse ou fragmentaire, fais de ton mieux sans inventer

Retourne UNIQUEMENT : {"speech":"..."}`,

    f3_collect: () => `Tu aides un patient amnésique à structurer une tâche.
Date actuelle : ${currentDateTime()}.
Infos déjà collectées : ${JSON.stringify(S.planContext)}

Analyse la réponse du patient et :
1. Mets à jour les infos collectées
2. Identifie ce qui MANQUE encore pour construire un plan concret
3. Si des infos manquent : pose UNE SEULE question (la plus importante)
4. Si tu as ASSEZ d'infos : produis un plan en étapes concrètes

RÈGLES :
- Maximum 5-7 étapes dans le plan
- Chaque étape = une action concrète et vérifiable
- Si la réponse du patient est vague : reformule ta question plus précisément
- Si hors-sujet : recentre gentiment
- Vouvoie. 1-2 phrases max pour les questions.
- N'INVENTE PAS d'informations que le patient n'a pas données

Retourne UNIQUEMENT :
{"status":"need_info|plan_ready","collected":{...},"missing":["..."],"plan":["étape1","étape2",...],"task":"description courte de la tâche","speech":"..."}

Si status=need_info : speech = ta question
Si status=plan_ready : speech = présentation du plan ("Voici le plan que je propose : 1. ... 2. ... Ça vous convient ?")`,

    f3_validate: () => `Tu es un assistant mémoire. Le patient a un plan d'action.
Plan : ${JSON.stringify(S.plan?.steps?.map((s, i) => `${i + 1}. ${s.text}`))}
Tâche : ${S.plan?.task || ""}

Le patient répond. Identifie s'il valide ou veut modifier.
- "oui" / "c'est bon" / "ça me va" / "ok" / "parfait" → validated
- Toute demande de modification → edit

Retourne : {"status":"validated|edit","speech":"..."}
Si validated, speech = "Très bien, on commence." (court)
Si edit, speech = reformulation de ce que le patient veut changer + question`,

    f3_execute: () => {
      const step = S.plan?.steps?.[S.plan.current_step - 1];
      return `Tu es un assistant mémoire qui guide un patient étape par étape.
Tâche : ${S.plan?.task || ""}
Étape courante : ${S.plan?.current_step} sur ${S.plan?.steps?.length}
Instruction de l'étape : "${step?.text || ""}"
Étapes déjà faites : ${S.plan?.steps?.filter(s => s.status === "done").map(s => s.text).join(", ") || "aucune"}

Le patient dit quelque chose. Identifie l'intention :
- "c'est fait" / "ok" / "terminé" / "fait" / "suivant" / "next" → step_done
- "où j'en suis" / "rappelle" / "le plan" / "quel étape" → status_request  
- "pause" / "j'arrête" / "stop" / "on arrête" → pause
- Question ou remarque sur l'étape → give_help

Retourne : {"intent":"step_done|status_request|pause|give_help","speech":"..."}

RÈGLES pour speech :
- Si step_done : confirme brièvement ("Étape X terminée.") puis annonce la prochaine étape avec un conseil pratique. Si c'était la dernière, félicite.
- Si status_request : "Vous êtes à l'étape X sur Y : [texte]. Vous avez déjà fait : [liste]."
- Si pause : "Plan mis en pause. Dites Memory on reprend quand vous voulez."
- Si give_help : réponds en contexte de l'étape, 1-3 phrases max.
- Vouvoie. JAMAIS d'invention.`;
    },

    f3_step_announce: () => {
      const step = S.plan?.steps?.[S.plan.current_step - 1];
      return `Tu es un assistant mémoire. Annonce l'étape au patient.
Tâche : ${S.plan?.task}
Étape ${S.plan?.current_step} sur ${S.plan?.steps?.length} : "${step?.text}"
Donne l'instruction clairement. Ajoute un conseil pratique si pertinent.
1-3 phrases. Vouvoie.
Retourne : {"speech":"..."}`;
    },

    // ---- CRUD PROMPTS ----

    f2_build: (partial, missing) => `Tu aides un patient amnésique à construire un SOUVENIR de sa journée.
Date actuelle : ${currentDateTime()}.

Sessions de la journée (transcriptions résumées) :
${S.daySessions.map((s, i) => `[Session ${i + 1}, ${ftime(s.started_at)}] ${s.summary || s.segments?.map(x => x.text).join(" ").substring(0, 200) || "(vide)"}`).join("\n") || "(aucune session)"}

${S.currentSession?.segments?.length > 0 ? `Session en cours :\n${S.currentSession.segments.map(x => x.text).join(" ").substring(0, 300)}` : ""}

Champs déjà remplis : ${JSON.stringify(partial)}
Champs manquants : ${JSON.stringify(missing)}

Ton travail : compile les sessions en un souvenir structuré.
Extrais : title (titre évocateur), summary (résumé 3-5 phrases), people (noms de personnes mentionnées), places (lieux), keywords (mots-clés).

Si le patient donne des instructions d'édition (enlever, ajouter, modifier), applique-les.

RÈGLES :
- N'INVENTE RIEN qui n'est pas dans les sessions ou dit par le patient
- Si pas assez de données : dis-le honnêtement
- Vouvoie

Retourne : {"object":{"title":"...","summary":"...","people":[],"places":[],"keywords":[]},"speech":"..."}
speech = lecture naturelle du souvenir proposé + "Voulez-vous le garder tel quel, le modifier, ou l'abandonner ?"`,

    f4_build: (partial, missing) => `Tu aides un patient amnésique à créer une ALARME / un RAPPEL.
Date et heure actuelles : ${currentDateTime()}.

Champs requis :
- motif : OBLIGATOIRE. Pourquoi cette alarme ? (ex: "Appeler le Dr Martin pour les résultats")
- datetime : OBLIGATOIRE. Date et heure au format "YYYY-MM-DDTHH:mm" (ex: "2026-03-20T15:00")
- recurrence : optionnel. "none" (défaut), "daily", "weekly"

Déjà rempli : ${JSON.stringify(partial)}
Manquant : ${JSON.stringify(missing)}

RÈGLES CRITIQUES :
- Convertis les dates relatives ("demain", "mercredi", "dans 3 mois") en dates absolues à partir de MAINTENANT.
- "demain" = ${new Date(Date.now() + 86400000).toISOString().split("T")[0]}
- "mercredi prochain" = calcule le prochain mercredi
- Si la date est ambiguë, DEMANDE confirmation
- Si l'heure manque, DEMANDE l'heure
- N'INVENTE JAMAIS de date ou d'heure
- Vouvoie

Retourne : {"object":{"motif":"...","datetime":"...","recurrence":"none|daily|weekly"},"speech":"..."}
Si un champ manque, speech = UNE question pour le champ manquant le plus important.
Si tout est rempli, speech = "Je crée un rappel : [motif] pour le [date lisible] à [heure]. C'est correct ?"`,

    f5_build: (partial, missing) => `Tu aides un patient amnésique à enregistrer un OBJET et son EMPLACEMENT.
Champs requis :
- object_name : OBLIGATOIRE. Nom de l'objet (ex: "passeport", "clés", "lunettes")
- location : OBLIGATOIRE. Où l'objet se trouve (ex: "tiroir du bureau", "table de nuit")
- aliases : optionnel. Autres noms pour le même objet (ex: ["papiers", "document de voyage"])

Déjà rempli : ${JSON.stringify(partial)}
Manquant : ${JSON.stringify(missing)}

RÈGLES :
- Extrais le nom de l'objet ET l'emplacement de la phrase du patient
- "j'ai posé mon portefeuille sur la commode" → object_name="portefeuille", location="commode de l'entrée"
- "mes lunettes sont sur la table" → object_name="lunettes", location="table"
- Si un champ manque, DEMANDE-le
- N'INVENTE PAS d'emplacement
- Vouvoie

Retourne : {"object":{"object_name":"...","location":"...","aliases":[]},"speech":"..."}
Si tout rempli, speech = "J'enregistre que votre [objet] est [lieu]. C'est correct ?"
Si un champ manque, speech = question pour le champ manquant.`,

    crud_confirm: () => `Le patient répond à une question oui/non/modifier.
Analyse sa réponse et retourne UNIQUEMENT :
{"intent":"yes|edit|cancel","speech":"..."}

- "oui" / "c'est bon" / "correct" / "parfait" / "ok" / "garde ça" / "enregistre" / "je confirme" → yes
- "non" / "annule" / "laisse tomber" / "pas aujourd'hui" / "stop" → cancel
- Toute demande de modification ("enlève", "rajoute", "change", "modifie") → edit

speech = confirmation courte adaptée à l'intention.`,

    crud_dedup: (feature, newObj, candidates) => `Tu vérifies les doublons pour un patient amnésique.
Type : ${feature === "f2" ? "souvenir" : feature === "f4" ? "alarme" : "objet"}

Nouvel élément : ${JSON.stringify(newObj)}
Éléments existants potentiellement similaires : ${JSON.stringify(candidates)}

${feature === "f5" ? `Pour les OBJETS : vérifie si les noms ou alias correspondent.
"trousseau" et "clés" = probablement le même objet
"papiers" et "passeport" = probablement le même objet
"mes lunettes" et "lunettes de soleil" = peut-être différent` : ""}
${feature === "f4" ? `Pour les ALARMES : même motif (même si formulé différemment) = doublon.` : ""}
${feature === "f2" ? `Pour les SOUVENIRS : même date = possible doublon.` : ""}

Retourne : {"is_duplicate":true|false,"duplicate_id":"...ou null","speech":"..."}
Si doublon détecté : speech = "Vous avez déjà [description]. Voulez-vous le remplacer ou en créer un nouveau ?"
Si pas de doublon : speech = "" (vide)`,

    crud_dedup_resolve: () => `Le patient répond à une question de doublon.
Retourne : {"intent":"replace|keep_both|cancel|same_object","speech":"..."}
- "remplacer" / "mets à jour" / "c'est le même" / "oui c'est la même chose" → same_object ou replace
- "garder les deux" / "non c'est différent" / "créer quand même" → keep_both
- "annuler" / "laisse tomber" / "non" → cancel`,

    crud_find: (feature, items, purpose) => {
      const typeLabel = feature === "f2" ? "souvenir" : feature === "f4" ? "alarme" : "objet";
      return `Tu aides un patient amnésique à ${purpose || "retrouver"} un ${typeLabel}.
Éléments existants : ${JSON.stringify(items)}

${feature === "f5" ? `RÈGLE CRITIQUE : retourne UNIQUEMENT le DERNIER emplacement enregistré. JAMAIS d'historique, JAMAIS plusieurs possibilités.` : ""}
${feature === "f4" ? `Liste les alarmes de la plus proche à la plus lointaine.` : ""}

Retourne : {"found":true|false,"item_id":"...ou null","speech":"..."}
Si trouvé : speech = description naturelle de l'élément (1-2 phrases, vouvoie)
Si pas trouvé : speech = "Je n'ai pas de ${typeLabel} correspondant." + proposition adaptée
${feature === "f5" ? `Si pas trouvé : "Je n'ai pas d'emplacement enregistré pour cet objet. Voulez-vous en déclarer un ?"` : ""}`;
    },

    relance: (context) => `Tu es un assistant mémoire. Le patient est silencieux depuis 30 secondes.
Contexte : ${context}
Reformule doucement ou rappelle où on en est. 1 phrase. Vouvoie.
Retourne : {"speech":"..."}`,

    relance_hard: () => `Le patient ne répond plus depuis 3 minutes.
Propose de mettre en pause. 1 phrase.
Retourne : {"speech":"..."}`,
  };

  // ============================================================
  // SESSION MANAGEMENT
  // ============================================================
  function ensureSession() {
    const t = Date.now();
    if (S.currentSession) {
      const segs = S.currentSession.segments;
      const last = segs.length
        ? new Date(segs[segs.length - 1].timestamp).getTime()
        : new Date(S.currentSession.started_at).getTime();
      if (t - last > SESSION_TIMEOUT_MS) closeSession();
    }
    if (!S.currentSession) {
      S.currentSession = {
        id: gid("sess"), started_at: iso(), ended_at: null,
        segments: [], summary: "",
      };
    }
  }

  function closeSession() {
    if (!S.currentSession) return;
    S.currentSession.ended_at = iso();
    if (S.currentSession.segments.length > 0) {
      S.daySessions.push({ ...S.currentSession });
    }
    S.currentSession = null;
    save();
  }

  function addSeg(text) {
    ensureSession();
    S.currentSession.segments.push({ text, timestamp: iso(), speaker: "unknown" });
    save();
    renderInspector();
  }

  async function bgSummary() {
    if (!S.currentSession || S.currentSession.segments.length < 3) return;
    if (S.isProcessing) return; // don't interfere with active processing
    const segs = S.currentSession.segments.filter(s => !WAKE_RE.test(s.text));
    if (segs.length < 3) return;
    const txt = segs.map(s => `[${ftime(s.timestamp)}] ${s.text}`).join("\n");
    const r = await llm(
      "Résume cette conversation en 2-3 phrases en français. Factuel, concis. Retourne : {\"speech\":\"...\"}",
      txt
    );
    if (r.speech && S.currentSession) {
      S.currentSession.summary = r.speech;
      renderInspector();
    }
  }

  // ============================================================
  // RELANCE TIMERS
  // ============================================================
  function startRelance() {
    stopRelance();
    if (S.mode === M.IDLE) return;

    relanceTimer = setTimeout(async () => {
      if (S.isSpeaking || S.isProcessing || S.mode === M.IDLE) return;

      const ctx = describeCurrentContext();
      const r = await llm(PROMPTS.relance(ctx), "Patient silencieux depuis 30 secondes.");
      if (r.speech && S.mode !== M.IDLE) {
        logAssistant(r.speech, featureOf(S.mode));
        speak(r.speech);
      }

      // Schedule hard relance
      relanceTimer = setTimeout(async () => {
        if (S.isSpeaking || S.isProcessing || S.mode === M.IDLE) return;
        const r2 = await llm(PROMPTS.relance_hard(), "Patient silencieux depuis 3 minutes.");
        if (r2.speech) {
          logAssistant(r2.speech, featureOf(S.mode));
          speak(r2.speech);
        }
        // Auto-pause or return to IDLE
        if (S.mode.startsWith("F3") && S.plan) {
          S.plan.status = "paused"; save();
          setMode(M.F3_PAUSED);
        } else {
          S.pendingObj = null; S.targetId = null;
          setMode(M.IDLE);
        }
      }, RELANCE_HARD_MS - RELANCE_SOFT_MS);

    }, RELANCE_SOFT_MS);
  }

  function stopRelance() {
    if (relanceTimer) { clearTimeout(relanceTimer); relanceTimer = null; }
  }

  function describeCurrentContext() {
    const m = S.mode;
    if (m.startsWith("F3")) return `Aide à l'action. Tâche: ${S.plan?.task || "?"}. Étape ${S.plan?.current_step || "?"} sur ${S.plan?.steps?.length || "?"}. Mode: ${m}`;
    if (m.startsWith("F2")) return `Souvenirs. Mode: ${m}. Objet en cours: ${JSON.stringify(S.pendingObj)}`;
    if (m.startsWith("F4")) return `Alarmes. Mode: ${m}. Objet en cours: ${JSON.stringify(S.pendingObj)}`;
    if (m.startsWith("F5")) return `Objets. Mode: ${m}. Objet en cours: ${JSON.stringify(S.pendingObj)}`;
    return `Mode: ${m}`;
  }

  // ============================================================
  // MODE MANAGEMENT
  // ============================================================
  function setMode(m) {
    S.mode = m;
    D.modeDot.className = "mode-dot " + (m === M.IDLE ? "idle" : m === M.ROUTING ? "routing" : "active");
    D.modeLabel.textContent = m;
    const f = featureOf(m);
    if (f) {
      D.featureIndicator.textContent = {
        f1: "F1 — Conversation", f2: "F2 — Souvenirs",
        f3: "F3 — Action", f4: "F4 — Alarmes", f5: "F5 — Objets"
      }[f];
      D.featureIndicator.className = "feature-badge " + f;
    } else {
      D.featureIndicator.className = "feature-badge hidden";
    }
    if (m === M.IDLE) {
      stopRelance();
      S.pendingObj = null; S.targetId = null;
    } else {
      startRelance();
    }
    renderInspector();
  }

  function featureOf(m) {
    if (!m) return null;
    if (m === M.SUMMARY) return "f1";
    if (m.startsWith("F2")) return "f2";
    if (m.startsWith("F3")) return "f3";
    if (m.startsWith("F4")) return "f4";
    if (m.startsWith("F5")) return "f5";
    return null;
  }

  function featureForMode(m) {
    if (m.startsWith("F2")) return "f2";
    if (m.startsWith("F4")) return "f4";
    if (m.startsWith("F5")) return "f5";
    return null;
  }

  function featureColor(f) {
    return { f1: "var(--f1)", f2: "var(--f2)", f3: "var(--f3)", f4: "var(--f4)", f5: "var(--f5)" }[f] || "var(--text-dim)";
  }

  // ============================================================
  // CRUD HELPERS
  // ============================================================
  const FIELDS = {
    f2: { required: ["title", "summary"], defaults: { people: [], places: [], keywords: [] } },
    f4: { required: ["motif", "datetime"], defaults: { recurrence: "none" } },
    f5: { required: ["object_name", "location"], defaults: { aliases: [] } },
  };

  function missingFields(feature, obj) {
    const cfg = FIELDS[feature];
    if (!cfg) return [];
    return cfg.required.filter(f => !obj[f] || (typeof obj[f] === "string" && !obj[f].trim()));
  }

  function completeObj(feature, obj) {
    const cfg = FIELDS[feature];
    if (!cfg) return obj;
    const full = { ...obj };
    for (const [k, v] of Object.entries(cfg.defaults)) {
      if (full[k] === undefined) full[k] = Array.isArray(v) ? [...v] : v;
    }
    return full;
  }

  function findDupCandidates(feature, obj) {
    if (feature === "f2") {
      const today = fdate(Date.now());
      return S.memories.filter(m => m.date === today);
    }
    if (feature === "f4") {
      return S.alarms; // let LLM decide semantic similarity
    }
    if (feature === "f5") {
      const name = (obj.object_name || "").toLowerCase();
      return S.objects.filter(o =>
        o.name.toLowerCase().includes(name) ||
        name.includes(o.name.toLowerCase()) ||
        o.aliases.some(a => a.toLowerCase().includes(name) || name.includes(a.toLowerCase()))
      );
    }
    return [];
  }

  function insertObj(feature, obj) {
    const t = iso();
    if (feature === "f2") {
      S.memories.push({
        id: gid("mem"), date: fdate(Date.now()),
        title: obj.title || "", summary: obj.summary || "",
        people: obj.people || [], places: obj.places || [], keywords: obj.keywords || [],
        created_at: t, edited: false,
      });
    } else if (feature === "f4") {
      S.alarms.push({
        id: gid("alarm"), motif: obj.motif || "",
        datetime: obj.datetime || "", recurrence: obj.recurrence || "none",
        created_at: t,
      });
    } else if (feature === "f5") {
      S.objects.push({
        id: gid("obj"), name: obj.object_name || "",
        aliases: obj.aliases || [], location: obj.location || "",
        updated_at: t,
      });
    }
    save(); renderInspector();
  }

  function updateObj(feature, id, updates) {
    if (feature === "f2") {
      S.memories = S.memories.map(m => m.id === id ? { ...m, ...updates, edited: true } : m);
    } else if (feature === "f4") {
      S.alarms = S.alarms.map(a => a.id === id ? { ...a, ...updates } : a);
    } else if (feature === "f5") {
      const upd = { ...updates, updated_at: iso() };
      if (updates.object_name) upd.name = updates.object_name;
      S.objects = S.objects.map(o => o.id === id ? { ...o, ...upd } : o);
    }
    save(); renderInspector();
  }

  function deleteObj(feature, id) {
    if (feature === "f2") S.memories = S.memories.filter(m => m.id !== id);
    else if (feature === "f4") S.alarms = S.alarms.filter(a => a.id !== id);
    else if (feature === "f5") S.objects = S.objects.filter(o => o.id !== id);
    save(); renderInspector();
  }

  function itemsFor(feature) {
    if (feature === "f2") return S.memories;
    if (feature === "f4") return S.alarms;
    if (feature === "f5") return S.objects;
    return [];
  }

  // ============================================================
  // MAIN PROCESS LOOP — STATE MACHINE
  // Rule: ONE speak() call per processInput() invocation
  // ============================================================
  async function processInput(text) {
    if (!text) return;

    const hasWake = WAKE_RE.test(text);
    const cleanText = text.replace(WAKE_RE, "").trim();
    const isStop = hasWake && /\b(stop|arr[eê]te|annule)\b/i.test(text);

    // Always add to session transcript
    addSeg(text);

    // ---- IDLE ----
    if (S.mode === M.IDLE) {
      if (!hasWake) {
        logBuffer(text);
        return; // passive listening, no action
      }
      logUser(text);
      if (!cleanText || cleanText.length < 2) {
        // Just "Memory" with nothing after
        sayAndStay("Oui, que puis-je faire pour vous ?", M.ROUTING, null);
        return;
      }
      setMode(M.ROUTING);
      await handleRouting(cleanText, text);
      return;
    }

    // ---- ACTIVE MODE ----
    logUser(text);

    // "Memory stop" → exit
    if (isStop) {
      if (S.mode.startsWith("F3") && S.plan) {
        S.plan.status = "paused"; save();
      }
      say("D'accord, on arrête.", featureOf(S.mode));
      setMode(M.IDLE);
      return;
    }

    // "Memory + something" in active mode → check feature switch
    if (hasWake && S.mode !== M.ROUTING && cleanText.length > 3) {
      // Heuristic: if the clean text clearly suggests another feature, switch
      const switchTarget = quickFeatureDetect(cleanText);
      const currentFeature = featureOf(S.mode);
      if (switchTarget && switchTarget !== currentFeature) {
        // Save F3 if active
        if (S.mode.startsWith("F3") && S.plan) {
          S.plan.status = "paused"; save();
        }
        setMode(M.ROUTING);
        await handleRouting(cleanText, text);
        return;
      }
    }

    // ---- DISPATCH ----
    startRelance();
    setProcessing(true);
    try {
      // Use cleanText (without "Memory") for active mode handlers
      const input = hasWake ? cleanText : text;

      switch (S.mode) {
        case M.ROUTING: await handleRouting(input, text); break;
        case M.SUMMARY: await handleSummary(); break;

        case M.F3_COLLECTING: await handleF3Collecting(input); break;
        case M.F3_VALIDATING: await handleF3Validating(input); break;
        case M.F3_EXECUTING: await handleF3Executing(input); break;
        case M.F3_PAUSED: await handleF3Paused(input); break;

        case M.F2_CREATE_BUILDING: case M.F4_CREATE_BUILDING: case M.F5_CREATE_BUILDING:
        case M.F2_UPDATE_BUILDING: case M.F4_UPDATE_BUILDING: case M.F5_UPDATE_BUILDING:
          await handleCrudBuilding(input); break;

        case M.F2_CREATE_VALIDATING: case M.F4_CREATE_VALIDATING: case M.F5_CREATE_VALIDATING:
        case M.F2_UPDATE_VALIDATING: case M.F4_UPDATE_VALIDATING: case M.F5_UPDATE_VALIDATING:
          await handleCrudValidating(input); break;

        case M.F2_CREATE_DEDUP: case M.F4_CREATE_DEDUP: case M.F5_CREATE_DEDUP:
          await handleCrudDedup(input); break;

        case M.F2_READ: case M.F4_READ: case M.F5_READ:
          await handleCrudRead(input); break;

        case M.F2_UPDATE_FINDING: case M.F4_UPDATE_FINDING: case M.F5_UPDATE_FINDING:
          await handleCrudUpdateFinding(input); break;

        case M.F2_DELETE_FINDING: case M.F4_DELETE_FINDING: case M.F5_DELETE_FINDING:
          await handleCrudDeleteFinding(input); break;

        case M.F2_DELETE_CONFIRMING: case M.F4_DELETE_CONFIRMING: case M.F5_DELETE_CONFIRMING:
          await handleCrudDeleteConfirming(input); break;

        default:
          say("Je ne sais pas quoi faire. Dites Memory suivi de votre demande.", null);
          setMode(M.IDLE);
          break;
      }
    } finally {
      setProcessing(false);
    }
  }

  /** Quick heuristic to detect feature from text without LLM call */
  function quickFeatureDetect(text) {
    const t = text.toLowerCase();
    if (/\b(r[eé]sum|on parlait|c'[eé]tait quoi le sujet)\b/.test(t)) return "f1";
    if (/\b(souvenir|journée|qu'est-ce que j'ai fait)\b/.test(t)) return "f2";
    if (/\b(rappel|alarme|rappelle.moi|n'oublie pas|quelles?.+alarme|d[eé]cale|supprime.+rappel)\b/.test(t)) return "f4";
    if (/\b(pos[eé]|mis|rang[eé]|où est|où sont|lunettes|cl[eé]s|passeport|portefeuille)\b/.test(t)) return "f5";
    if (/\b(aide.moi|je veux faire|comment faire|on reprend|le plan|lettre|courrier)\b/.test(t)) return "f3";
    return null;
  }

  // ============================================================
  // HANDLERS — each returns after ONE say()
  // ============================================================

  /** Helper: speak + log + optionally set mode */
  function say(text, feature) {
    if (!text) return;
    logAssistant(text, feature);
    speak(text);
  }

  function sayAndStay(text, mode, feature) {
    setMode(mode);
    say(text, feature);
  }

  // ---- ROUTING ----
  async function handleRouting(cleanText, fullText) {
    setProcessing(true);
    const r = await llm(
      PROMPTS.routing(),
      `Le patient dit : "${cleanText}"\nDonnées actuelles — Souvenirs: ${S.memories.length}, Alarmes: ${S.alarms.length}, Objets: ${S.objects.length}, Sessions aujourd'hui: ${S.daySessions.length}${S.plan ? ", Plan actif: " + S.plan.task : ""}`
    );
    setProcessing(false);

    // Validate response
    if (r._error || r.confidence === "low" || !r.feature) {
      say(r.speech || "Je n'ai pas compris. Que voulez-vous faire ?", null);
      // Stay in ROUTING
      return;
    }

    const f = r.feature;
    const c = r.crud;

    // Route WITHOUT speaking (the target handler will speak)
    if (f === "f1") {
      setMode(M.SUMMARY);
      await handleSummary();
    }
    else if (f === "f3") {
      // Check if resuming paused plan
      if (S.plan && S.plan.status === "paused" && /\b(reprend|continu|plan)\b/i.test(cleanText)) {
        setMode(M.F3_EXECUTING);
        await handleF3Paused(cleanText);
      } else {
        S.planContext = {};
        setMode(M.F3_COLLECTING);
        await handleF3Collecting(cleanText);
      }
    }
    else if (f === "f2") {
      if (c === "create") { S.pendingObj = {}; setMode(M.F2_CREATE_BUILDING); await handleCrudBuilding(cleanText); }
      else if (c === "read") { setMode(M.F2_READ); await handleCrudRead(cleanText); }
      else if (c === "update") { setMode(M.F2_UPDATE_FINDING); await handleCrudUpdateFinding(cleanText); }
      else if (c === "delete") { setMode(M.F2_DELETE_FINDING); await handleCrudDeleteFinding(cleanText); }
      else { say("Que voulez-vous faire avec vos souvenirs ?", "f2"); }
    }
    else if (f === "f4") {
      if (c === "create") { S.pendingObj = {}; setMode(M.F4_CREATE_BUILDING); await handleCrudBuilding(cleanText); }
      else if (c === "read") { setMode(M.F4_READ); await handleCrudRead(cleanText); }
      else if (c === "update") { setMode(M.F4_UPDATE_FINDING); await handleCrudUpdateFinding(cleanText); }
      else if (c === "delete") { setMode(M.F4_DELETE_FINDING); await handleCrudDeleteFinding(cleanText); }
      else { say("Que voulez-vous faire avec vos alarmes ?", "f4"); }
    }
    else if (f === "f5") {
      if (c === "create") { S.pendingObj = {}; setMode(M.F5_CREATE_BUILDING); await handleCrudBuilding(cleanText); }
      else if (c === "read") { setMode(M.F5_READ); await handleCrudRead(cleanText); }
      else if (c === "update") { setMode(M.F5_UPDATE_FINDING); await handleCrudUpdateFinding(cleanText); }
      else if (c === "delete") { setMode(M.F5_DELETE_FINDING); await handleCrudDeleteFinding(cleanText); }
      else { say("Que voulez-vous faire avec vos objets ?", "f5"); }
    }
    else {
      say("Je n'ai pas compris la demande. Pouvez-vous reformuler ?", null);
    }
  }

  // ---- F1: SUMMARY ----
  async function handleSummary() {
    const segs = S.currentSession?.segments?.filter(s => !WAKE_RE.test(s.text)) || [];
    if (segs.length < 2) {
      say("Il n'y a pas assez de conversation à résumer pour le moment.", "f1");
      setMode(M.IDLE);
      return;
    }
    setProcessing(true);
    const txt = segs.map(s => `[${ftime(s.timestamp)}] ${s.text}`).join("\n");
    const r = await llm(PROMPTS.summary(), `Transcription :\n${txt}`);
    setProcessing(false);
    say(r.speech || "Je n'ai pas pu produire de résumé.", "f1");
    setMode(M.IDLE);
  }

  // ---- F3: COLLECTING ----
  async function handleF3Collecting(text) {
    setProcessing(true);
    const r = await llm(PROMPTS.f3_collect(), `Patient dit : "${text}"`);
    setProcessing(false);

    if (r.collected) S.planContext = { ...S.planContext, ...r.collected };

    if (r.status === "plan_ready" && r.plan && Array.isArray(r.plan) && r.plan.length > 0) {
      S.plan = {
        id: gid("plan"), task: r.task || "",
        status: "validating", context: S.planContext,
        steps: r.plan.map((t, i) => ({
          index: i + 1,
          text: typeof t === "string" ? t : (t.text || String(t)),
          status: "pending",
        })),
        current_step: 1, created_at: iso(), last_activity: iso(),
      };
      save(); renderInspector();
      say(r.speech || "Voici le plan. Ça vous convient ?", "f3");
      setMode(M.F3_VALIDATING);
    } else {
      say(r.speech || "Pouvez-vous me donner plus de détails ?", "f3");
      // Stay in F3_COLLECTING
    }
  }

  // ---- F3: VALIDATING ----
  async function handleF3Validating(text) {
    setProcessing(true);
    const r = await llm(PROMPTS.f3_validate(), `Patient dit : "${text}"`);
    setProcessing(false);

    if (r.status === "validated") {
      S.plan.status = "in_progress";
      S.plan.steps[0].status = "current";
      S.plan.last_activity = iso();
      save(); renderInspector();
      setMode(M.F3_EXECUTING);
      // Announce first step
      setProcessing(true);
      const a = await llm(PROMPTS.f3_step_announce(), "Annonce l'étape 1.");
      setProcessing(false);
      say(a.speech || `Étape 1 : ${S.plan.steps[0].text}`, "f3");
    } else {
      // Edit requested → go back to collecting
      say(r.speech || "Que voulez-vous modifier dans le plan ?", "f3");
      setMode(M.F3_COLLECTING);
    }
  }

  // ---- F3: EXECUTING ----
  async function handleF3Executing(text) {
    setProcessing(true);
    const r = await llm(PROMPTS.f3_execute(), `Patient dit : "${text}"`);
    setProcessing(false);

    switch (r.intent) {
      case "step_done": {
        const cs = S.plan.current_step - 1;
        if (cs >= 0 && cs < S.plan.steps.length) S.plan.steps[cs].status = "done";

        if (S.plan.current_step >= S.plan.steps.length) {
          // ALL DONE
          S.plan.status = "completed"; S.plan.last_activity = iso();
          save(); renderInspector();
          say(r.speech || `Vous avez terminé : ${S.plan.task}. Bravo !`, "f3");
          setMode(M.IDLE);
        } else {
          S.plan.current_step++;
          S.plan.steps[S.plan.current_step - 1].status = "current";
          S.plan.last_activity = iso();
          save(); renderInspector();
          say(r.speech || `Étape ${S.plan.current_step} : ${S.plan.steps[S.plan.current_step - 1].text}`, "f3");
        }
        break;
      }
      case "status_request":
        say(r.speech || `Vous êtes à l'étape ${S.plan.current_step} sur ${S.plan.steps.length} : ${S.plan.steps[S.plan.current_step - 1]?.text}`, "f3");
        break;
      case "pause":
        S.plan.status = "paused"; S.plan.last_activity = iso();
        save(); renderInspector();
        say(r.speech || "Plan mis en pause. Dites Memory on reprend quand vous voulez.", "f3");
        setMode(M.F3_PAUSED);
        break;
      default: // give_help
        say(r.speech || "Je suis là pour vous aider avec cette étape.", "f3");
        break;
    }
  }

  // ---- F3: PAUSED → resume ----
  async function handleF3Paused(text) {
    if (!S.plan || !S.plan.steps?.length) {
      say("Je n'ai pas de plan en mémoire. Voulez-vous en créer un ?", "f3");
      setMode(M.IDLE);
      return;
    }
    S.plan.status = "in_progress"; S.plan.last_activity = iso();
    save(); renderInspector();
    setMode(M.F3_EXECUTING);
    setProcessing(true);
    const a = await llm(PROMPTS.f3_step_announce(), "Le patient reprend son plan. Annonce l'étape courante.");
    setProcessing(false);
    say(a.speech || `On reprend. Étape ${S.plan.current_step} : ${S.plan.steps[S.plan.current_step - 1]?.text}`, "f3");
  }

  // ---- CRUD: BUILDING ----
  async function handleCrudBuilding(text) {
    const f = featureForMode(S.mode);
    if (!f) { setMode(M.IDLE); return; }

    if (!S.pendingObj) S.pendingObj = {};
    const missing = missingFields(f, S.pendingObj);

    // Choose the right prompt
    let prompt;
    if (f === "f2") prompt = PROMPTS.f2_build(S.pendingObj, missing);
    else if (f === "f4") prompt = PROMPTS.f4_build(S.pendingObj, missing);
    else if (f === "f5") prompt = PROMPTS.f5_build(S.pendingObj, missing);
    else { setMode(M.IDLE); return; }

    setProcessing(true);
    const r = await llm(prompt, `Patient dit : "${text}"`);
    setProcessing(false);

    // Merge extracted fields
    if (r.object && typeof r.object === "object") {
      S.pendingObj = { ...S.pendingObj, ...r.object };
    }

    const stillMissing = missingFields(f, S.pendingObj);

    if (stillMissing.length === 0) {
      // All fields present → move to VALIDATING
      S.pendingObj = completeObj(f, S.pendingObj);
      renderInspector();
      const valMode = S.mode.replace("BUILDING", "VALIDATING");
      setMode(valMode);
      say(r.speech || formatValidationQuestion(f, S.pendingObj), f);
    } else {
      // Still missing fields → ask
      say(r.speech || `Il me manque : ${stillMissing.join(", ")}. Pouvez-vous préciser ?`, f);
      // Stay in BUILDING
    }
  }

  function formatValidationQuestion(f, obj) {
    if (f === "f4") return `Je crée un rappel : ${obj.motif} pour le ${obj.datetime}. C'est correct ?`;
    if (f === "f5") return `J'enregistre que votre ${obj.object_name} est ${obj.location}. C'est correct ?`;
    if (f === "f2") return `Voici votre souvenir : ${obj.title}. ${obj.summary}. Voulez-vous le garder ?`;
    return "C'est correct ?";
  }

  // ---- CRUD: VALIDATING ----
  async function handleCrudValidating(text) {
    const f = featureForMode(S.mode);
    if (!f) { setMode(M.IDLE); return; }

    setProcessing(true);
    const r = await llm(PROMPTS.crud_confirm(), `Patient dit : "${text}"`);
    setProcessing(false);

    if (r.intent === "yes") {
      // Check for duplicates
      const candidates = findDupCandidates(f, S.pendingObj);
      if (candidates.length > 0) {
        // Ask LLM to check semantic duplicates
        setProcessing(true);
        const d = await llm(PROMPTS.crud_dedup(f, S.pendingObj, candidates), "Vérifie les doublons.");
        setProcessing(false);

        if (d.is_duplicate && d.duplicate_id) {
          S.targetId = d.duplicate_id;
          const dedupMode = S.mode.replace("VALIDATING", "DEDUP");
          setMode(dedupMode);
          say(d.speech || "Un élément similaire existe déjà. Voulez-vous le remplacer ?", f);
          return;
        }
      }
      // No duplicate → insert
      insertObj(f, S.pendingObj);
      say(r.speech || "C'est enregistré.", f);
      S.pendingObj = null;
      setMode(M.IDLE);
    }
    else if (r.intent === "edit") {
      const buildMode = S.mode.replace("VALIDATING", "BUILDING");
      setMode(buildMode);
      say(r.speech || "Que voulez-vous modifier ?", f);
    }
    else {
      // cancel
      S.pendingObj = null;
      say(r.speech || "Annulé.", f);
      setMode(M.IDLE);
    }
  }

  // ---- CRUD: DEDUP ----
  async function handleCrudDedup(text) {
    const f = featureForMode(S.mode);
    if (!f) { setMode(M.IDLE); return; }

    setProcessing(true);
    const r = await llm(PROMPTS.crud_dedup_resolve(), `Patient dit : "${text}"`);
    setProcessing(false);

    if (r.intent === "replace" || r.intent === "same_object") {
      if (S.targetId) {
        if (f === "f5") {
          // For objects: update location + merge aliases
          const existing = S.objects.find(o => o.id === S.targetId);
          const newAliases = [...new Set([
            ...(existing?.aliases || []),
            ...(S.pendingObj.aliases || []),
          ])];
          updateObj(f, S.targetId, {
            location: S.pendingObj.location,
            aliases: newAliases,
            object_name: existing?.name || S.pendingObj.object_name,
          });
        } else {
          updateObj(f, S.targetId, S.pendingObj);
        }
        say(r.speech || "Mis à jour.", f);
      } else {
        insertObj(f, S.pendingObj);
        say(r.speech || "Enregistré.", f);
      }
    } else if (r.intent === "keep_both") {
      insertObj(f, S.pendingObj);
      say(r.speech || "Les deux sont conservés.", f);
    } else {
      say(r.speech || "Annulé.", f);
    }

    S.pendingObj = null; S.targetId = null;
    setMode(M.IDLE);
  }

  // ---- CRUD: READ ----
  async function handleCrudRead(text) {
    const f = featureForMode(S.mode);
    if (!f) { setMode(M.IDLE); return; }

    const items = itemsFor(f);
    if (items.length === 0 && f !== "f4") {
      const typeLabel = f === "f2" ? "souvenir" : f === "f5" ? "objet" : "élément";
      say(`Vous n'avez aucun ${typeLabel} enregistré pour le moment.`, f);
      setMode(M.IDLE);
      return;
    }

    setProcessing(true);
    const purpose = f === "f4" ? "lister" : "retrouver";
    const r = await llm(PROMPTS.crud_find(f, items, purpose), `Patient dit : "${text}"`);
    setProcessing(false);

    say(r.speech || "Je n'ai rien trouvé.", f);
    setMode(M.IDLE);
  }

  // ---- CRUD: UPDATE FINDING ----
  async function handleCrudUpdateFinding(text) {
    const f = featureForMode(S.mode);
    if (!f) { setMode(M.IDLE); return; }

    const items = itemsFor(f);
    if (items.length === 0) {
      say("Aucun élément à modifier.", f);
      setMode(M.IDLE);
      return;
    }

    setProcessing(true);
    const r = await llm(
      PROMPTS.crud_find(f, items, "modifier"),
      `Patient veut modifier. Il dit : "${text}". Identifie l'élément.`
    );
    setProcessing(false);

    if (r.found && r.item_id) {
      S.targetId = r.item_id;
      const item = items.find(i => i.id === r.item_id);
      S.pendingObj = item ? { ...item } : {};
      const buildMode = S.mode.replace("FINDING", "BUILDING");
      setMode(buildMode);
      say(r.speech || "Trouvé. Que voulez-vous modifier ?", f);
    } else {
      say(r.speech || "Je ne trouve pas cet élément. Pouvez-vous préciser ?", f);
      // Stay in FINDING
    }
  }

  // ---- CRUD: DELETE FINDING ----
  async function handleCrudDeleteFinding(text) {
    const f = featureForMode(S.mode);
    if (!f) { setMode(M.IDLE); return; }

    const items = itemsFor(f);
    if (items.length === 0) {
      say("Aucun élément à supprimer.", f);
      setMode(M.IDLE);
      return;
    }

    setProcessing(true);
    const r = await llm(
      PROMPTS.crud_find(f, items, "supprimer"),
      `Patient veut supprimer. Il dit : "${text}". Identifie l'élément.`
    );
    setProcessing(false);

    if (r.found && r.item_id) {
      S.targetId = r.item_id;
      const confirmMode = S.mode.replace("FINDING", "CONFIRMING");
      setMode(confirmMode);
      say(r.speech || "Voulez-vous confirmer la suppression ?", f);
    } else {
      say(r.speech || "Je ne trouve pas cet élément. Pouvez-vous préciser ?", f);
    }
  }

  // ---- CRUD: DELETE CONFIRMING ----
  async function handleCrudDeleteConfirming(text) {
    const f = featureForMode(S.mode);
    if (!f) { setMode(M.IDLE); return; }

    setProcessing(true);
    const r = await llm(PROMPTS.crud_confirm(), `Patient dit : "${text}"`);
    setProcessing(false);

    if (r.intent === "yes") {
      deleteObj(f, S.targetId);
      say(r.speech || "Supprimé.", f);
    } else {
      say(r.speech || "Annulé.", f);
    }
    S.targetId = null;
    setMode(M.IDLE);
  }

  // ============================================================
  // TTS / STT — with anti-feedback protection
  // ============================================================
  function speak(text) {
    if (!text) return;
    window.speechSynthesis.cancel();
    S.isSpeaking = true;
    S.ttsCooldown = false;
    updateMicUI();

    // STOP STT while speaking
    sttPause();

    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    u.rate = 0.92;
    u.pitch = 0.95;

    const voices = window.speechSynthesis.getVoices();
    const v = voices.find(v => v.lang === "fr-FR" && v.name.toLowerCase().includes("google"))
      || voices.find(v => v.lang.startsWith("fr"));
    if (v) u.voice = v;

    u.onend = () => {
      S.isSpeaking = false;
      S.ttsCooldown = true;
      updateMicUI();
      // Cooldown: wait before restarting STT to avoid capturing echo
      setTimeout(() => {
        S.ttsCooldown = false;
        sttResume();
      }, TTS_COOLDOWN_MS);
    };

    u.onerror = (e) => {
      console.warn("TTS error:", e);
      S.isSpeaking = false;
      S.ttsCooldown = true;
      updateMicUI();
      setTimeout(() => {
        S.ttsCooldown = false;
        sttResume();
      }, TTS_COOLDOWN_MS);
    };

    window.speechSynthesis.speak(u);
  }

  // ---- STT with proper pause/resume ----
  let sttDebounceTimer = null;
  let sttAccumulator = "";

  function sttPause() {
    if (recognition) {
      try { recognition.abort(); } catch {}
    }
  }

  function sttResume() {
    if (S.isListening && recognition && !S.isSpeaking && !S.ttsCooldown) {
      try { recognition.start(); } catch (e) {
        // Already started — ignore
        if (!e.message?.includes("already started")) console.warn("STT resume:", e);
      }
    }
  }

  function startSTT() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert("Veuillez utiliser Google Chrome pour la reconnaissance vocale."); return; }

    recognition = new SR();
    recognition.lang = "fr-FR";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (e) => {
      // STRICT anti-feedback: reject ALL input during speaking or cooldown
      if (S.isSpeaking || S.ttsCooldown) return;

      let interim = "";
      let finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }

      if (interim) {
        D.interimBar.classList.remove("hidden");
        D.interimText.textContent = sttAccumulator ? sttAccumulator + " " + interim : interim;
      }

      if (finalText.trim()) {
        sttAccumulator += (sttAccumulator ? " " : "") + finalText.trim();
        D.interimBar.classList.remove("hidden");
        D.interimText.textContent = sttAccumulator + " …";

        // Debounce: wait for user to finish speaking
        if (sttDebounceTimer) clearTimeout(sttDebounceTimer);
        sttDebounceTimer = setTimeout(() => {
          const full = sttAccumulator.trim();
          sttAccumulator = "";
          D.interimBar.classList.add("hidden");
          D.interimText.textContent = "";
          if (full) enqueueInput(full);
        }, STT_DEBOUNCE_MS);
      }
    };

    recognition.onerror = (e) => {
      console.warn("STT error:", e.error);
      if (e.error === "not-allowed") {
        S.isListening = false;
        updateMicUI();
        alert("Accès au microphone refusé.");
        return;
      }
      // For "no-speech", "aborted", "network" — onend will handle restart
    };

    recognition.onend = () => {
      // Auto-restart if still listening and not speaking
      if (S.isListening && !S.isSpeaking && !S.ttsCooldown) {
        restartTimeout = setTimeout(() => {
          if (S.isListening && !S.isSpeaking && !S.ttsCooldown) {
            try { recognition.start(); } catch (e) { console.warn("STT restart:", e); }
          }
        }, 300);
      }
    };

    recognition.start();
    S.isListening = true;
    updateMicUI();

    // Background summary timer
    summaryTimer = setInterval(() => {
      if (!S.isProcessing && S.currentSession?.segments?.length >= 3) bgSummary();
    }, SUMMARY_INTERVAL_MS);
  }

  function stopSTT() {
    S.isListening = false;
    if (restartTimeout) clearTimeout(restartTimeout);
    if (summaryTimer) clearInterval(summaryTimer);
    if (sttDebounceTimer) clearTimeout(sttDebounceTimer);
    stopRelance();
    sttAccumulator = "";
    if (recognition) {
      recognition.onend = null;
      try { recognition.abort(); } catch {}
      recognition = null;
    }
    D.interimBar.classList.add("hidden");
    updateMicUI();
  }

  // ============================================================
  // UI
  // ============================================================
  function updateMicUI() {
    const b = D.btnMic;
    b.classList.remove("listening", "speaking", "processing");
    if (S.isSpeaking) { b.classList.add("speaking"); D.micState.textContent = "Parle…"; }
    else if (S.isProcessing) { b.classList.add("processing"); D.micState.textContent = "Réfléchit…"; }
    else if (S.isListening) { b.classList.add("listening"); D.micState.textContent = "Écoute…"; }
    else D.micState.textContent = "Inactif";
  }

  function setProcessing(v) { S.isProcessing = v; updateMicUI(); if (v) addThinking(); else rmThinking(); }
  function addThinking() {
    rmThinking();
    const r = document.createElement("div");
    r.className = "msg-row assistant"; r.id = "thinking";
    r.innerHTML = '<div class="msg-bubble"><span class="msg-thinking">Réflexion…</span></div>';
    D.conversationLog.appendChild(r);
    scrollLog();
  }
  function rmThinking() { const e = document.getElementById("thinking"); if (e) e.remove(); }

  function logBuffer(text) {
    removeEmptyState();
    const r = document.createElement("div"); r.className = "msg-row buffer-passive";
    r.innerHTML = `<div class="msg-buffer-passive"><span class="buffer-dot">●</span>${esc(text.substring(0, 120))}${text.length > 120 ? "…" : ""}<span class="msg-time">${ftime(Date.now())}</span></div>`;
    D.conversationLog.appendChild(r);
    scrollLog();
  }

  function logUser(text) {
    removeEmptyState();
    const r = document.createElement("div"); r.className = "msg-row user";
    r.innerHTML = `<div class="msg-bubble">${esc(text)}<span class="msg-time">${ftime(Date.now())}</span></div>`;
    D.conversationLog.appendChild(r);
    scrollLog();
  }

  function logAssistant(text, feature) {
    if (!text) return;
    removeEmptyState();
    const r = document.createElement("div"); r.className = "msg-row assistant";
    let tag = "";
    if (feature) {
      const labels = { f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5" };
      tag = `<span class="msg-feature-tag" style="background:${featureColor(feature)}">${labels[feature] || ""}</span>`;
    }
    r.innerHTML = `<div class="msg-bubble">${tag}${esc(text)}<span class="msg-time">${ftime(Date.now())}</span></div>`;
    D.conversationLog.appendChild(r);
    scrollLog();
  }

  function logSystem(text) {
    const r = document.createElement("div"); r.className = "msg-row system";
    r.innerHTML = `<div class="msg-bubble">${esc(text)}</div>`;
    D.conversationLog.appendChild(r);
    scrollLog();
  }

  function removeEmptyState() {
    const es = document.getElementById("empty-state");
    if (es) es.remove();
  }

  function scrollLog() {
    requestAnimationFrame(() => D.conversationLog.scrollTop = D.conversationLog.scrollHeight);
  }

  // ============================================================
  // JSON EXPORT
  // ============================================================
  function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  window._exportMemories = () => downloadJSON(S.memories, "souvenirs.json");
  window._exportAlarms = () => downloadJSON(S.alarms, "alarmes.json");
  window._exportObjects = () => downloadJSON(S.objects, "objets.json");

  // ============================================================
  // INSPECTOR
  // ============================================================
  function renderInspector() {
    // Session
    const sc = S.currentSession?.segments?.length || 0;
    D.sessionCount.textContent = sc;
    if (sc === 0) {
      D.sessionEntries.innerHTML = '<p class="inspector-empty">Aucune session</p>';
    } else {
      let h = "";
      if (S.currentSession.summary) {
        h += `<div class="inspector-card" style="border-left-color:var(--f1)"><strong>Résumé auto</strong><div class="detail">${esc(S.currentSession.summary)}</div></div>`;
      }
      h += S.currentSession.segments.slice(-5).map(s =>
        `<div class="inspector-card" style="border-left-color:var(--text-faint)"><span class="detail">${ftime(s.timestamp)}</span> ${esc(s.text.substring(0, 80))}</div>`
      ).join("");
      D.sessionEntries.innerHTML = h;
    }

    // Day sessions
    D.daySessionsCount.textContent = S.daySessions.length;
    D.daySessionsEntries.innerHTML = S.daySessions.length
      ? S.daySessions.map(s => `<div class="inspector-card" style="border-left-color:var(--text-dim)"><span class="detail">${ftime(s.started_at)}</span> ${esc((s.summary || "…").substring(0, 60))}</div>`).join("")
      : '<p class="inspector-empty">—</p>';

    // Memories
    D.memoriesCount.textContent = S.memories.length;
    let mh = "";
    if (S.memories.length > 0) mh += `<button class="export-btn" onclick="_exportMemories()">↓ JSON</button>`;
    if (S.pendingObj && S.mode.startsWith("F2")) {
      mh += `<div class="inspector-card pending" style="border-left-color:var(--f2)"><strong>⏳ ${esc(S.pendingObj.title || "En cours…")}</strong><div class="detail">${esc((S.pendingObj.summary || "").substring(0, 100))}</div></div>`;
    }
    mh += S.memories.slice().reverse().map(m =>
      `<div class="inspector-card" style="border-left-color:var(--f2)"><strong>${esc(m.title)}</strong><div class="detail">${esc(m.date)} · ${esc(m.summary.substring(0, 80))}</div></div>`
    ).join("");
    D.memoriesEntries.innerHTML = mh || '<p class="inspector-empty">Aucun souvenir</p>';

    // Plan
    if (S.plan && S.plan.steps?.length > 0) {
      const sl = { planning: "📝", validating: "🔍", in_progress: "▶", paused: "⏸", completed: "✅" };
      let ph = `<div class="inspector-card" style="border-left-color:var(--f3)"><strong>${sl[S.plan.status] || ""} ${esc(S.plan.task)}</strong><div class="detail">Étape ${S.plan.current_step}/${S.plan.steps.length}</div>`;
      ph += S.plan.steps.map(s =>
        `<div class="plan-step ${s.status}">${s.status === "done" ? "✓" : s.status === "current" ? "▸" : "○"} ${esc(s.text)}</div>`
      ).join("");
      ph += "</div>";
      D.planEntries.innerHTML = ph;
    } else {
      D.planEntries.innerHTML = '<p class="inspector-empty">Aucun plan</p>';
    }

    // Alarms
    D.alarmsCount.textContent = S.alarms.length;
    let ah = "";
    if (S.alarms.length > 0) ah += `<button class="export-btn" onclick="_exportAlarms()">↓ JSON</button>`;
    ah += S.alarms.length
      ? S.alarms.map(a => `<div class="inspector-card" style="border-left-color:var(--f4)"><strong>${esc(a.motif)}</strong><div class="detail">${esc(a.datetime)}${a.recurrence !== "none" ? " · " + a.recurrence : ""}</div></div>`).join("")
      : '<p class="inspector-empty">Aucune alarme</p>';
    D.alarmsEntries.innerHTML = ah;

    // Objects
    D.objectsCount.textContent = S.objects.length;
    let oh = "";
    if (S.objects.length > 0) oh += `<button class="export-btn" onclick="_exportObjects()">↓ JSON</button>`;
    oh += S.objects.length
      ? S.objects.map(o => `<div class="inspector-card" style="border-left-color:var(--f5)"><strong>${esc(o.name)}</strong>${o.aliases.length ? `<span class="alias"> ${esc(o.aliases.join(", "))}</span>` : ""}<div class="detail">📍 ${esc(o.location)} · ${ftime(o.updated_at)}</div></div>`).join("")
      : '<p class="inspector-empty">Aucun objet</p>';
    D.objectsEntries.innerHTML = oh;
  }

  // ============================================================
  // SCENARIOS
  // ============================================================
  const SCENARIOS = [
    {
      id: "f1", label: "F1", title: "Conversation", color: "var(--f1)",
      desc: "Parlez 2-3 min sans Memory, puis « Memory résume ».",
      sugg: [
        "Alors Christine tu as eu des nouvelles du docteur Martin pour les résultats ?",
        "Oui il m'a appelée ce matin, tout est normal, il veut te revoir dans trois mois.",
        "Au fait pour samedi j'ai réservé au restaurant Le Panorama pour 20 heures.",
        "Moi je vais apporter un gâteau au citron pour le dessert.",
        "Paul tu peux t'occuper du vin ? Pas de problème je prends du Riesling.",
        "Memory résume",
      ],
    },
    {
      id: "f2", label: "F2", title: "Souvenirs", color: "var(--f2)",
      desc: "Accumulez du contexte puis « Memory crée un souvenir ».",
      sugg: [
        "Ce matin j'ai vu le docteur Martin, tout va bien.",
        "Cet après-midi promenade au lac avec Christine, lumière magnifique sur les montagnes.",
        "Memory crée un souvenir de ma journée",
        "Enlève le passage du matin, rajoute que la lumière dorée m'a ému.",
        "Oui c'est parfait garde ça",
        "Memory c'était quoi le jour au bord du lac ?",
      ],
    },
    {
      id: "f3", label: "F3", title: "Aide à l'action", color: "var(--f3)",
      desc: "« Memory je veux écrire une lettre de remerciement... »",
      sugg: [
        "Memory je veux écrire une lettre de remerciement au docteur Martin",
        "C'est pour le remercier de sa patience et du suivi depuis l'opération",
        "Docteur Philippe Martin au centre hospitalier de Grenoble, ton personnel et respectueux",
        "Oui ça me va",
        "Qu'est-ce que je pourrais mettre comme points clés ?",
        "C'est fait",
        "Où j'en suis ?",
        "Pause",
      ],
    },
    {
      id: "f4", label: "F4", title: "Alarmes", color: "var(--f4)",
      desc: "Créez, doublon, consultez, modifiez, supprimez.",
      sugg: [
        "Memory rappelle-moi de confirmer la réservation du restaurant avant jeudi",
        "Mercredi matin à 10 heures",
        "Oui c'est bon",
        "Memory rappelle-moi d'appeler le docteur Martin dans 3 mois",
        "Le 15 juin à 9 heures du matin",
        "Oui",
        "Memory rappelle-moi de confirmer le restaurant",
        "Non c'est la même laisse tomber",
        "Memory quelles sont mes alarmes",
        "Memory décale l'alarme du restaurant à mardi à 14 heures",
        "Oui",
        "Memory supprime l'alarme du docteur Martin",
        "Oui",
      ],
    },
    {
      id: "f5", label: "F5", title: "Objets", color: "var(--f5)",
      desc: "Déclarez, cherchez, fusion d'alias.",
      sugg: [
        "Memory j'ai posé mon portefeuille sur la commode de l'entrée",
        "Oui",
        "Memory mes lunettes de soleil sont dans la boîte à gants",
        "Oui",
        "Memory le passeport est dans le tiroir du bureau",
        "Oui",
        "Memory où est mon portefeuille ?",
        "Memory j'ai mis mes papiers dans le sac à dos",
        "Oui c'est la même chose",
        "Memory où est mon passeport ?",
      ],
    },
  ];

  function renderScenarios() {
    D.scenariosList.innerHTML = SCENARIOS.map(sc => `
      <div class="scenario-card" data-id="${sc.id}">
        <div class="scenario-header">
          <span class="scenario-tag" style="background:${sc.color}">${sc.label}</span>
          <span class="scenario-name">${sc.title}</span>
        </div>
        <div class="scenario-body">
          <p class="scenario-desc">${sc.desc}</p>
          <div class="scenario-suggestions">
            <p class="scenario-suggestions-label">Cliquer = envoyer</p>
            ${sc.sugg.map((s, i) => `<button class="suggestion-btn" data-text="${esc(s)}"><span class="suggestion-num">${i + 1}</span>${esc(s)}</button>`).join("")}
          </div>
        </div>
      </div>
    `).join("");

    D.scenariosList.querySelectorAll(".scenario-card").forEach(c => {
      c.addEventListener("click", e => {
        if (e.target.closest(".suggestion-btn")) return;
        document.querySelectorAll(".scenario-card").forEach(x => x.classList.remove("active"));
        c.classList.toggle("active");
      });
    });

    D.scenariosList.querySelectorAll(".suggestion-btn").forEach(b => {
      b.addEventListener("click", e => {
        e.stopPropagation();
        enqueueInput(b.dataset.text);
      });
    });
  }

  // ============================================================
  // INIT
  // ============================================================
  async function testKey(k) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": k,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 5, messages: [{ role: "user", content: "." }] }),
      });
      return r.ok;
    } catch { return false; }
  }

  function init() {
    cacheDom();

    // Load voices
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();

    renderScenarios();
    renderInspector();

    // API key from localStorage
    const savedKey = localStorage.getItem("am_api_key") || "";
    if (savedKey) {
      S.apiKey = savedKey;
      D.apiKeyInput.value = savedKey;
      testKey(savedKey).then(ok => {
        if (ok) {
          S.isConnected = true;
          D.apiStatus.textContent = "✓ Connecté";
          D.apiStatus.className = "status-text success";
        }
      });
    }

    // API connect button
    D.btnApiConnect.addEventListener("click", async () => {
      const k = D.apiKeyInput.value.trim();
      if (!k) return;
      D.apiStatus.textContent = "Vérification…";
      D.apiStatus.className = "status-text";
      if (await testKey(k)) {
        S.apiKey = k;
        S.isConnected = true;
        localStorage.setItem("am_api_key", k);
        D.apiStatus.textContent = "✓ Connecté";
        D.apiStatus.className = "status-text success";
      } else {
        D.apiStatus.textContent = "✗ Clé invalide";
        D.apiStatus.className = "status-text error";
      }
    });
    D.apiKeyInput.addEventListener("keydown", e => { if (e.key === "Enter") D.btnApiConnect.click(); });

    // Mic toggle
    D.btnMic.addEventListener("click", () => {
      if (!S.isConnected && !S.apiKey) { alert("Clé API requise."); return; }
      if (S.isListening) stopSTT(); else startSTT();
    });

    // Text input
    D.textForm.addEventListener("submit", e => {
      e.preventDefault();
      const t = D.textInput.value.trim();
      if (t) { enqueueInput(t); D.textInput.value = ""; }
    });

    // Reset
    D.btnReset.addEventListener("click", () => {
      if (!confirm("Tout réinitialiser ? Toutes les données seront perdues.")) return;
      stopSTT();
      window.speechSynthesis.cancel();
      S.currentSession = null; S.daySessions = []; S.memories = [];
      S.alarms = []; S.objects = []; S.plan = null;
      S.pendingObj = null; S.targetId = null; S.planContext = {};
      S.isSpeaking = false; S.ttsCooldown = false; S.isProcessing = false;
      ["am_days", "am_mem", "am_plan", "am_alarms", "am_objects"].forEach(k => localStorage.removeItem(k));
      setMode(M.IDLE);
      D.conversationLog.innerHTML = `
        <div id="empty-state" class="empty-state">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" style="margin-bottom:12px;opacity:.3">
            <circle cx="24" cy="24" r="20" stroke="var(--accent)" stroke-width="1.5"/>
            <path d="M15 20Q24 30 33 20" stroke="var(--accent)" stroke-width="1.5" fill="none"/>
            <circle cx="18" cy="16" r="2" fill="var(--accent)" opacity=".5"/>
            <circle cx="30" cy="16" r="2" fill="var(--accent)" opacity=".5"/>
          </svg>
          <p class="empty-title">Prêt</p>
          <p class="empty-text">Connectez l'API, activez le micro, parlez.<br>Dites <strong>Memory</strong> pour activer une commande.</p>
        </div>`;
      renderInspector();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();