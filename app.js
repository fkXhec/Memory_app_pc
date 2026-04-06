// ============================================================
// ASSISTANT MÉMOIRE VOCAL — app.js v5
// Architecture: StateManager déterministe + LLM tool use
// Le StateManager gère les transitions. Le LLM extrait et formule.
// ============================================================
(function () {
  "use strict";

  // ──────────────── CONFIG ────────────────
  const MODEL = "claude-sonnet-4-6";
  const API_URL = "https://api.anthropic.com/v1/messages";
  const SESSION_TIMEOUT = 5 * 60 * 1000;
  const RELANCE_SOFT = 30 * 1000;
  const RELANCE_HARD = 3 * 60 * 1000;
  const TTS_COOLDOWN = 600;
  const STT_DEBOUNCE = 1400;
  const WAKE_RE = /\bmemor(?:y|ie?|is?|i|oire)\b/i;
  const STOP_RE = /\b(stop|arr[eê]te|annule)\b/i;
  const REQUIRED = { f2: ["title", "summary"], f4: ["motif", "datetime"], f5: ["object_name", "location"] };
  const DEFAULTS = { f2: { people: [], places: [], keywords: [] }, f4: { recurrence: "none" }, f5: { aliases: [] } };

  // ──────────────── TOOL DEFINITIONS (Claude API format) ────────────────
  const TOOL = {
    route: {
      name: "route_intent",
      description: "Identifie la feature et l'opération CRUD demandées par le patient amnésique.",
      input_schema: {
        type: "object",
        properties: {
          feature: { type: "string", enum: ["f1", "f2", "f3", "f4", "f5"] },
          crud: { type: ["string", "null"], enum: ["create", "read", "update", "delete", null] },
          confidence: { type: "string", enum: ["high", "low"] },
          extracted_fields: { type: "object", description: "Champs extraits de la phrase initiale" },
          clarification: { type: ["string", "null"], description: "Question si confidence=low" }
        },
        required: ["feature", "crud", "confidence"]
      }
    },
    alarm: {
      name: "extract_alarm_fields",
      description: "Extrait motif, datetime et récurrence depuis le message du patient.",
      input_schema: {
        type: "object",
        properties: {
          motif: { type: ["string", "null"] },
          datetime: { type: ["string", "null"], description: "ISO 8601 ou null si non mentionné" },
          recurrence: { type: ["string", "null"], enum: ["none", "daily", "weekly", "monthly", null] }
        },
        required: ["motif", "datetime", "recurrence"]
      }
    },
    object: {
      name: "extract_object_fields",
      description: "Extrait nom d'objet, emplacement et alias.",
      input_schema: {
        type: "object",
        properties: {
          object_name: { type: ["string", "null"] },
          location: { type: ["string", "null"] },
          aliases: { type: "array", items: { type: "string" }, description: "Autres noms pour le même objet" }
        },
        required: ["object_name", "location"]
      }
    },
    memory: {
      name: "extract_memory_fields",
      description: "Compile les sessions d'une journée en souvenir structuré.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Titre évocateur du souvenir" },
          summary: { type: "string", description: "Résumé 3-5 phrases" },
          people: { type: "array", items: { type: "string" } },
          places: { type: "array", items: { type: "string" } },
          keywords: { type: "array", items: { type: "string" } }
        },
        required: ["title", "summary"]
      }
    },
    f3collect: {
      name: "extract_collected_info",
      description: "Extrait les informations utiles du message patient pour structurer une tâche.",
      input_schema: {
        type: "object",
        properties: {
          new_fields: { type: "object", description: "Champs nouvellement extraits" },
          still_missing: { type: "array", items: { type: "string" }, description: "Infos encore manquantes" },
          next_question: { type: ["string", "null"], description: "Prochaine question à poser" },
          ready_for_plan: { type: "boolean" }
        },
        required: ["new_fields", "still_missing", "ready_for_plan"]
      }
    },
    f3plan: {
      name: "extract_action_plan",
      description: "Produit un plan d'action en étapes concrètes.",
      input_schema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Description courte de la tâche" },
          steps: { type: "array", items: { type: "string" }, description: "5-7 étapes concrètes" }
        },
        required: ["task", "steps"]
      }
    },
    compare: {
      name: "semantic_compare",
      description: "Détermine si deux éléments désignent la même entité.",
      input_schema: {
        type: "object",
        properties: {
          is_same: { type: "boolean" },
          duplicate_id: { type: ["string", "null"] }
        },
        required: ["is_same"]
      }
    },
    classify: {
      name: "classify_response",
      description: "Classifie la réponse du patient: oui, modifier, ou annuler.",
      input_schema: {
        type: "object",
        properties: {
          intent: { type: "string", enum: ["yes", "edit", "cancel"] },
          edit_detail: { type: ["string", "null"] }
        },
        required: ["intent"]
      }
    },
    f3intent: {
      name: "classify_f3_intent",
      description: "Classifie l'intention pendant l'exécution d'un plan d'action.",
      input_schema: {
        type: "object",
        properties: {
          intent: { type: "string", enum: ["step_done", "status_request", "pause", "help"] },
          help_response: { type: ["string", "null"], description: "Réponse d'aide si intent=help" }
        },
        required: ["intent"]
      }
    },
    findItem: {
      name: "find_item",
      description: "Identifie un élément dans une liste à partir de la description du patient.",
      input_schema: {
        type: "object",
        properties: {
          found: { type: "boolean" },
          item_id: { type: ["string", "null"] },
          speech: { type: "string", description: "Réponse pour le patient" }
        },
        required: ["found", "speech"]
      }
    },
    speak: {
      name: "formulate_response",
      description: "Formule une réponse vocale concise pour le patient (1-3 phrases, vouvoiement, ton calme).",
      input_schema: {
        type: "object",
        properties: {
          speech: { type: "string" }
        },
        required: ["speech"]
      }
    }
  };

  // ──────────────── SYSTEM PROMPTS ────────────────
  function dtStr() {
    return new Date().toLocaleString("fr-FR", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }
  function tomorrow() { return new Date(Date.now() + 86400000).toISOString().split("T")[0]; }

  const P = {
    route: () => `Tu es le routeur d'un assistant mémoire pour patient amnésique.
Date : ${dtStr()}.

FEATURES :
f1 : résumé de conversation ("résume", "on parlait de quoi")
f2 : souvenirs ("souvenir", "ma journée", "la fois où")
f3 : aide à l'action ("je veux faire", "aide-moi à", "comment faire")
f4 : alarmes/rappels ("rappelle-moi", "alarme", "quelles alarmes", "décale", "supprime le rappel")
f5 : objets/emplacements ("j'ai posé", "j'ai mis", "où est", "où sont")

CRUD : create=nouveau, read=consulter, update=modifier, delete=supprimer. null pour f1 et f3.

EXEMPLES :
"rappelle-moi d'appeler le médecin demain à 15h" → f4, create, high, extracted_fields: {motif:"appeler le médecin", datetime:"${tomorrow()}T15:00"}
"j'ai posé mon portefeuille sur la commode" → f5, create, high, extracted_fields: {object_name:"portefeuille", location:"commode"}
"où est mon passeport" → f5, read, high
"résume" → f1, null, high
"crée un souvenir de ma journée" → f2, create, high
"c'était quoi le jour au bord du lac" → f2, read, high
"quelles sont mes alarmes" → f4, read, high
"décale l'alarme du restaurant à mardi" → f4, update, high
"supprime l'alarme du médecin" → f4, delete, high
"je veux écrire une lettre" → f3, null, high
"on reprend le plan" → f3, null, high

RÈGLES : "j'ai posé/mis/rangé" = TOUJOURS f5. "rappelle-moi" = TOUJOURS f4. "où est/sont" = TOUJOURS f5.
Extrais autant de champs que possible dans extracted_fields (motif, datetime, object_name, location...).
Si ambigu, confidence="low" et pose UNE question dans clarification.`,

    alarmExtract: (collected, missing) => `Tu extrais les champs d'une alarme pour un patient amnésique.
Date actuelle : ${dtStr()}. Demain = ${tomorrow()}.

Déjà collecté : ${JSON.stringify(collected)}
Champs manquants : ${JSON.stringify(missing)}

RÈGLES :
- Convertis les dates relatives en ISO 8601 absolu. "demain" = ${tomorrow()}.
- Si l'heure N'EST PAS mentionnée, mets datetime à null.
- Si le motif N'EST PAS mentionné, mets motif à null.
- N'INVENTE JAMAIS de date, d'heure ou de motif.
- recurrence: "none" par défaut sauf si le patient dit "tous les jours/mardis/mois".`,

    objectExtract: (collected, missing) => `Tu extrais nom d'objet et emplacement pour un patient amnésique.
Déjà collecté : ${JSON.stringify(collected)}
Manquant : ${JSON.stringify(missing)}
"j'ai posé mon portefeuille sur la commode" → object_name:"portefeuille", location:"commode"
"lunettes, table de nuit" → object_name:"lunettes", location:"table de nuit"
Si un champ n'est PAS dans le message, mets null. N'invente rien.`,

    memoryExtract: (sessions, current) => `Tu compiles les sessions d'une journée en souvenir structuré.
Date : ${dtStr()}.

Sessions de la journée :
${sessions || "(aucune session)"}

${Object.keys(current).length > 0 ? `Souvenir actuel (à modifier selon les instructions du patient) :\n${JSON.stringify(current)}` : ""}

Extrais : title (titre évocateur), summary (résumé 3-5 phrases), people, places, keywords.
N'INVENTE RIEN. Si le patient demande une modification, applique-la au souvenir actuel.`,

    f3collect: (ctx, collected) => `Tu aides un patient amnésique à structurer une tâche.
Date : ${dtStr()}.
Description tâche : ${ctx.task || "à définir"}
Infos déjà collectées : ${JSON.stringify(collected)}

Analyse la réponse du patient. Mets à jour les infos. Identifie ce qui manque encore.
Si assez d'infos pour un plan concret (5-7 étapes), mets ready_for_plan=true.
Sinon, pose UNE question (la plus importante) dans next_question.
N'invente pas d'informations. Max 8 tours de questions.`,

    f3plan: (ctx) => `Produis un plan d'action en 5-7 étapes concrètes et vérifiables.
Tâche : ${ctx.task || ""}
Informations : ${JSON.stringify(ctx)}
Chaque étape = une action concrète. Pas de sous-étapes.`,

    f3execute: (plan) => {
      const step = plan?.steps?.[plan.current_step - 1];
      return `Le patient exécute un plan. Classifie son intention.
Tâche : ${plan?.task || ""}
Étape ${plan?.current_step} sur ${plan?.steps?.length} : "${step?.text || ""}"
Étapes faites : ${plan?.steps?.filter(s => s.status === "done").map(s => s.text).join(", ") || "aucune"}

"c'est fait"/"ok"/"terminé"/"fait"/"suivant" → step_done
"où j'en suis"/"rappelle"/"quel étape" → status_request
"pause"/"j'arrête"/"stop" → pause
Toute question sur l'étape → help (fournis help_response: 1-3 phrases d'aide contextuelle)`;
    },

    compare: (feature, newObj, candidates) => {
      const label = feature === "f2" ? "souvenir" : feature === "f4" ? "alarme" : "objet";
      return `Compare pour détecter un doublon (${label}).
Nouvel élément : ${JSON.stringify(newObj)}
Éléments existants : ${JSON.stringify(candidates)}
${feature === "f5" ? '"papiers" et "passeport" = probablement le même. "lunettes" et "lunettes de soleil" = peut-être différent.' : ""}
${feature === "f4" ? "Même motif (même reformulé) = doublon." : ""}
Si doublon, retourne duplicate_id de l'élément existant.`;
    },

    findItem: (feature, items, purpose) => {
      const label = feature === "f2" ? "souvenir" : feature === "f4" ? "alarme" : "objet";
      return `Le patient veut ${purpose} un ${label}. Identifie lequel.
Éléments : ${JSON.stringify(items)}
Si trouvé, item_id = l'id de l'élément. speech = description courte (1-2 phrases, vouvoiement).
Si pas trouvé, found=false, speech = "Je ne trouve pas cet élément."
${feature === "f5" ? "Retourne UNIQUEMENT le dernier emplacement, JAMAIS d'historique." : ""}`;
    },

    summary: () => `Tu résumes une conversation pour un patient amnésique.
Phrases 1-2 : sujets principaux et décisions/informations clés.
Phrase 3 : ce qui se passe à l'instant (si identifiable).
Identifie les personnes par leur nom. Vouvoie le patient.
NE DIS PAS "vous m'avez demandé un résumé". Commence directement par le contenu.
3 phrases max, ton calme et direct.`,

    f2read: (memories) => `Le patient cherche un souvenir parmi ceux-ci :
${JSON.stringify(memories)}
Trouve le plus pertinent par similarité sémantique avec sa demande.
Si trouvé : lis le souvenir (titre + résumé). Si pas trouvé : dis-le honnêtement.
1-3 phrases. Vouvoie.`,

    clarify: () => `Le patient n'a pas été clair. Pose UNE question de clarification courte.
Vouvoie. 1 phrase max.`,

    classify: () => `Classifie la réponse du patient :
"oui"/"c'est bon"/"correct"/"parfait"/"ok"/"garde ça"/"enregistre" → yes
"non"/"annule"/"laisse tomber"/"stop" → cancel
Toute demande de modification ("enlève","rajoute","change","modifie","décale") → edit
Si edit, résume dans edit_detail ce que le patient veut modifier.`
  };

  // ──────────────── TEMPLATES (déterministes, 0 appel LLM) ────────────────
  function fmtDate(iso) {
    if (!iso) return "date inconnue";
    try { return new Date(iso).toLocaleString("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }); }
    catch { return iso; }
  }
  function fmtDateShort(iso) {
    try { return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }); }
    catch { return iso; }
  }
  function fmtTime(ts) { return new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); }

  const T = {
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

  // ──────────────── LLM SERVICE (tool use) ────────────────
  async function callTool(tool, systemPrompt, userContent, retries = 1) {
    if (!S.apiKey) return { ok: false, error: "Pas de clé API" };
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": S.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 1024,
            system: systemPrompt,
            messages: [{ role: "user", content: userContent }],
            tools: [tool],
            tool_choice: { type: "tool", name: tool.name },
          }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error?.message || `HTTP ${r.status}`);
        }
        const data = await r.json();
        const tu = data.content?.find(c => c.type === "tool_use");
        if (!tu) throw new Error("No tool_use in response");
        return { ok: true, data: tu.input };
      } catch (e) {
        console.warn(`LLM attempt ${attempt}:`, e.message);
        if (attempt === retries) return { ok: false, error: e.message };
      }
    }
    return { ok: false, error: "unreachable" };
  }

  // ──────────────── STATE ────────────────
  const S = {
    mode: "IDLE",
    apiKey: "",
    collected: {},
    missing: [],
    targetId: null,
    plan: null,
    planCtx: {},
    f3turns: 0,
    // Audio
    isListening: false,
    isSpeaking: false,
    isProcessing: false,
    ttsCooldown: false,
    // Session
    currentSession: null,
    daySessions: load("am_days", []),
    // Data
    memories: load("am_mem", []),
    alarms: load("am_alarms", []),
    objects: load("am_objects", []),
  };

  // ──────────────── PERSISTENCE ────────────────
  function load(k, def) { try { return JSON.parse(localStorage.getItem(k)) || def; } catch { return def; } }
  function save() {
    try {
      localStorage.setItem("am_days", JSON.stringify(S.daySessions));
      localStorage.setItem("am_mem", JSON.stringify(S.memories));
      localStorage.setItem("am_alarms", JSON.stringify(S.alarms));
      localStorage.setItem("am_objects", JSON.stringify(S.objects));
      if (S.plan) localStorage.setItem("am_plan", JSON.stringify(S.plan));
    } catch (e) { console.warn("save:", e); }
  }

  // ──────────────── UTILS ────────────────
  const gid = (p) => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const iso = () => new Date().toISOString();
  const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };
  const $ = (s) => document.querySelector(s);

  // ──────────────── SESSION & BUFFER ────────────────
  const BUFFER_WINDOW = 10 * 60 * 1000;
  let bufferSegments = [];
  let bufferSummary = "";
  let lastSummarySegCount = 0;
  let summaryTimer = null;

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
    if (S.currentSession.segments.length > 0) {
      S.daySessions.push({ ...S.currentSession });
    }
    S.currentSession = null;
    save();
  }

  function addSegment(text, passive = true) {
    ensureSession();
    S.currentSession.segments.push({ text, ts: iso(), passive });
    // Buffer: keep only last 10 min
    const cutoff = Date.now() - BUFFER_WINDOW;
    bufferSegments.push({ text, ts: Date.now(), passive });
    bufferSegments = bufferSegments.filter(s => s.ts > cutoff);
    renderInspector();
  }

  function getBufferText() {
    return bufferSegments.filter(s => s.passive).map(s => s.text).join(" ");
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

  async function bgSummary() {
    const passiveSegs = bufferSegments.filter(s => s.passive);
    if (passiveSegs.length < 3 || passiveSegs.length === lastSummarySegCount) return;
    if (S.isProcessing) return;
    lastSummarySegCount = passiveSegs.length;
    const txt = passiveSegs.map(s => s.text).join("\n");
    const r = await callTool(TOOL.speak, P.summary(), `Transcription :\n${txt}`);
    if (r.ok) bufferSummary = r.data.speech;
  }

  // ──────────────── CRUD HELPERS ────────────────
  function featureOf(mode) {
    if (mode === "SUMMARY") return "f1";
    const m = mode.match(/^F(\d)/);
    return m ? "f" + m[1] : null;
  }

  function featureLabel(f) {
    return { f2: "souvenir", f4: "alarme", f5: "objet" }[f] || "élément";
  }

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

  function findDupCandidates(f, obj) {
    if (f === "f2") {
      const today = new Date().toLocaleDateString("fr-FR");
      return S.memories.filter(m => m.date === today);
    }
    if (f === "f4") return S.alarms;
    // F5: always send ALL objects — let LLM decide semantic similarity
    // Substring matching misses "papiers"↔"passeport" (fix R2)
    if (f === "f5") return S.objects.length > 0 ? S.objects : [];
    return [];
  }

  function insertObj(f, obj) {
    const t = iso();
    if (f === "f2") {
      S.memories.push({ id: gid("mem"), date: new Date().toLocaleDateString("fr-FR"), title: obj.title || "", summary: obj.summary || "", people: obj.people || [], places: obj.places || [], keywords: obj.keywords || [], created_at: t, edited: false });
    } else if (f === "f4") {
      S.alarms.push({ id: gid("alarm"), motif: obj.motif || "", datetime: obj.datetime || "", recurrence: obj.recurrence || "none", created_at: t });
    } else if (f === "f5") {
      S.objects.push({ id: gid("obj"), name: obj.object_name || "", aliases: obj.aliases || [], location: obj.location || "", updated_at: t });
    }
    save();
    renderInspector();
  }

  function updateObj(f, id, updates) {
    if (f === "f2") S.memories = S.memories.map(m => m.id === id ? { ...m, ...updates, edited: true } : m);
    else if (f === "f4") S.alarms = S.alarms.map(a => a.id === id ? { ...a, ...updates } : a);
    else if (f === "f5") {
      const upd = { ...updates, updated_at: iso() };
      if (updates.object_name) upd.name = updates.object_name;
      S.objects = S.objects.map(o => o.id === id ? { ...o, ...upd } : o);
    }
    save();
    renderInspector();
  }

  function deleteObj(f, id) {
    if (f === "f2") S.memories = S.memories.filter(m => m.id !== id);
    else if (f === "f4") S.alarms = S.alarms.filter(a => a.id !== id);
    else if (f === "f5") S.objects = S.objects.filter(o => o.id !== id);
    save();
    renderInspector();
  }

  function itemsFor(f) {
    if (f === "f2") return S.memories;
    if (f === "f4") return S.alarms;
    if (f === "f5") return S.objects;
    return [];
  }

  // ──────────────── MODE & RELANCE ────────────────
  let relanceTimer = null;

  function setMode(m) {
    S.mode = m;
    if (m === "IDLE") { S.collected = {}; S.missing = []; S.targetId = null; stopRelance(); }
    else startRelance();
    updateModeUI();
    renderInspector();
  }

  function startRelance() {
    stopRelance();
    if (S.mode === "IDLE") return;
    relanceTimer = setTimeout(() => {
      if (S.isSpeaking || S.isProcessing || S.mode === "IDLE") return;
      const f = featureOf(S.mode);
      let ctx = "";
      if (S.mode.includes("BUILDING")) ctx = `Il manque : ${S.missing.join(", ")}`;
      else if (S.mode.includes("VALIDATING")) ctx = "En attente de validation";
      else if (S.mode.startsWith("F3")) ctx = `Étape ${S.plan?.current_step || "?"} : ${S.plan?.steps?.[S.plan.current_step - 1]?.text || "?"}`;
      else ctx = `Mode ${S.mode}`;
      say(T.f3status(S.plan?.current_step || 1, S.plan?.steps?.length || 1, ctx, ""), f);
      relanceTimer = setTimeout(() => {
        if (S.isSpeaking || S.isProcessing || S.mode === "IDLE") return;
        say(S.mode.startsWith("F3") ? T.f3paused : T.stopped, f);
        if (S.mode.startsWith("F3") && S.plan) { S.plan.status = "paused"; save(); setMode("F3_PAUSED"); }
        else setMode("IDLE");
      }, RELANCE_HARD - RELANCE_SOFT);
    }, RELANCE_SOFT);
  }

  function stopRelance() { if (relanceTimer) { clearTimeout(relanceTimer); relanceTimer = null; } }

  // ──────────────── INPUT QUEUE ────────────────
  const queue = [];
  let queueRunning = false;

  function enqueueInput(text) {
    if (!text?.trim()) return;
    queue.push(text.trim());
    if (!queueRunning) drainQueue();
  }

  async function drainQueue() {
    queueRunning = true;
    while (queue.length) {
      const text = queue.shift();
      try { await processInput(text); } catch (e) { console.error("processInput:", e); }
      setProcessing(false);
    }
    queueRunning = false;
  }

  // ──────────────── MAIN STATE MACHINE ────────────────
  async function processInput(text) {
    if (!text) return;
    const hasWake = WAKE_RE.test(text);
    const clean = text.replace(WAKE_RE, "").trim();

    addSegment(text, !hasWake);

    // ── IDLE ──
    if (S.mode === "IDLE") {
      if (!hasWake) { logBuffer(text); return; }
      logUser(text);
      if (!clean || clean.length < 2) { say(T.welcome, null); setMode("ROUTING"); return; }
      setMode("ROUTING");
      return handleRouting(clean);
    }

    // ── ACTIVE MODE ──
    logUser(text);

    // Stop command
    if (hasWake && STOP_RE.test(text)) {
      if (S.mode.startsWith("F3") && S.plan) { S.plan.status = "paused"; save(); }
      say(T.stopped, featureOf(S.mode));
      setMode("IDLE");
      return;
    }

    // Feature switch (wake word + different content in active mode)
    if (hasWake && clean.length > 3 && S.mode !== "ROUTING") {
      if (S.mode.startsWith("F3") && S.plan) { S.plan.status = "paused"; save(); }
      setMode("ROUTING");
      return handleRouting(clean);
    }

    // Dispatch to current handler (no wake word needed in active mode)
    startRelance();
    const input = hasWake ? clean : text;
    return dispatch(input);
  }

  async function dispatch(text) {
    setProcessing(true);
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
      say("Je ne sais pas quoi faire. Dites Memory suivi de votre demande.", null);
      setMode("IDLE");
    } finally {
      setProcessing(false);
    }
  }

  // ──────────────── ROUTING ────────────────
  async function handleRouting(text) {
    setProcessing(true);
    const r = await callTool(TOOL.route, P.route(),
      `Patient dit : "${text}"\nAlarmes: ${S.alarms.length}, Objets: ${S.objects.length}, Souvenirs: ${S.memories.length}${S.plan?.status === "paused" ? ", Plan en pause: " + S.plan.task : ""}`
    );
    setProcessing(false);

    if (!r.ok || r.data.confidence === "low") {
      say(r.data?.clarification || "Je n'ai pas compris. Que voulez-vous faire ?", null);
      return;
    }

    const { feature: f, crud: c, extracted_fields: ef } = r.data;

    // Reset collected fields — prevent cross-feature contamination (fix R1)
    S.collected = {};
    if (ef && typeof ef === "object") {
      S.collected = { ...ef };
    }

    if (f === "f1") {
      setMode("SUMMARY");
      return handleSummary();
    }

    if (f === "f3") {
      if (S.plan?.status === "paused" && /\b(reprend|continu|plan)\b/i.test(text)) {
        return handleF3Paused(text);
      }
      S.planCtx = {};
      S.f3turns = 0;
      if (ef?.task) S.planCtx.task = ef.task;
      setMode("F3_COLLECTING");
      return handleF3Collecting(text);
    }

    // CRUD features (f2, f4, f5)
    if (!c) { say(`Que voulez-vous faire ?`, f); return; }

    const prefix = f.toUpperCase();
    if (c === "create") { setMode(`${prefix}_CREATE_BUILDING`); return handleCrudBuilding(text); }
    if (c === "read") { setMode(`${prefix}_READ`); return handleCrudRead(text); }
    if (c === "update") { setMode(`${prefix}_UPDATE_FINDING`); return handleCrudFinding(text); }
    if (c === "delete") { setMode(`${prefix}_DELETE_FINDING`); return handleCrudFinding(text); }

    say("Je n'ai pas compris la demande.", null);
    setMode("IDLE");
  }

  // ──────────────── F1 SUMMARY ────────────────
  async function handleSummary() {
    const passive = bufferSegments.filter(s => s.passive);
    if (passive.length < 2) {
      say("Il n'y a pas assez de conversation à résumer.", "f1");
      setMode("IDLE");
      return;
    }
    // Use pre-calculated summary if recent enough
    if (bufferSummary && passive.length - lastSummarySegCount < 3) {
      say(bufferSummary, "f1");
      setMode("IDLE");
      return;
    }
    setProcessing(true);
    const txt = passive.map(s => s.text).join("\n");
    const r = await callTool(TOOL.speak, P.summary(), `Transcription :\n${txt}`);
    setProcessing(false);
    say(r.ok ? r.data.speech : "Je n'ai pas pu produire de résumé.", "f1");
    setMode("IDLE");
  }

  // ──────────────── CRUD: BUILDING ────────────────
  async function handleCrudBuilding(text) {
    const f = featureOf(S.mode);
    if (!f) { setMode("IDLE"); return; }

    // Step 0: Early dedup for CREATE flows — check BEFORE extraction
    // When motif/object_name is already known from routing, detect duplicate immediately
    if (S.mode.includes("CREATE")) {
      if (f === "f4" && S.collected.motif && S.alarms.length > 0) {
        const candidates = S.alarms.filter(a => a.id !== S.targetId);
        if (candidates.length > 0) {
          setProcessing(true);
          const dup = await callTool(TOOL.compare,
            P.compare(f, S.collected, candidates), "Vérifie si une alarme similaire existe déjà.");
          setProcessing(false);
          if (dup.ok && dup.data.is_same && dup.data.duplicate_id) {
            S.targetId = dup.data.duplicate_id;
            const existing = candidates.find(a => a.id === dup.data.duplicate_id);
            setMode(S.mode.replace("BUILDING", "DEDUP"));
            say(T.dupFound(existing?.motif || "cette alarme"), f);
            return;
          }
        }
      }
      if (f === "f5" && S.collected.object_name && S.objects.length > 0) {
        const candidates = S.objects.filter(o => o.id !== S.targetId);
        if (candidates.length > 0) {
          setProcessing(true);
          const dup = await callTool(TOOL.compare,
            P.compare(f, S.collected, candidates), "Vérifie si cet objet existe déjà sous un autre nom.");
          setProcessing(false);
          if (dup.ok && dup.data.is_same && dup.data.duplicate_id) {
            S.targetId = dup.data.duplicate_id;
            const existing = candidates.find(o => o.id === dup.data.duplicate_id);
            setMode(S.mode.replace("BUILDING", "DEDUP"));
            say(`Vous avez déjà un objet "${existing?.name || "similaire"}". C'est le même que "${S.collected.object_name}" ?`, f);
            return;
          }
        }
      }
    }

    // Step 1: Try extraction
    setProcessing(true);
    let tool, prompt;
    const missing = getMissing(f, S.collected);
    if (f === "f4") { tool = TOOL.alarm; prompt = P.alarmExtract(S.collected, missing); }
    else if (f === "f5") { tool = TOOL.object; prompt = P.objectExtract(S.collected, missing); }
    else if (f === "f2") { tool = TOOL.memory; prompt = P.memoryExtract(getSessionsSummary(), S.collected); }
    else { setProcessing(false); setMode("IDLE"); return; }

    const r = await callTool(tool, prompt, `Patient dit : "${text}"`);
    setProcessing(false);

    if (r.ok) {
      for (const [k, v] of Object.entries(r.data)) {
        if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)) {
          if (k === "datetime" && typeof v === "string" && isNaN(Date.parse(v))) continue;
          S.collected[k] = v;
        }
      }
    }

    // Step 2: Check completeness
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

  // ──────────────── CRUD: VALIDATING ────────────────
  async function handleCrudValidating(text) {
    const f = featureOf(S.mode);
    const lc = text.toLowerCase();

    // Fix 3a: For F4, if patient gives a date/time instead of yes/no, it's an implicit edit
    if (f === "f4" && /\b(\d{1,2}\s*(h|heures?|[:.])\s*\d{0,2}|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|demain|après-demain|matin|soir|midi)\b/i.test(text)) {
      delete S.collected.datetime;
      setMode(S.mode.replace("VALIDATING", "BUILDING"));
      await handleCrudBuilding(text);
      return;
    }

    setProcessing(true);
    const r = await callTool(TOOL.classify, P.classify(), `Patient dit : "${text}"`);
    setProcessing(false);

    if (!r.ok) { say(T.error, f); return; }

    if (r.data.intent === "yes") {
      // Check for duplicates BEFORE inserting
      const candidates = findDupCandidates(f, S.collected);
      if (candidates.length > 0) {
        setProcessing(true);
        const d = await callTool(TOOL.compare, P.compare(f, S.collected, candidates), "Vérifie les doublons.");
        setProcessing(false);
        if (d.ok && d.data.is_same && d.data.duplicate_id) {
          // Fix 3b: If patient already said "même chose/c'est pareil", auto-resolve as replace
          if (/\b(m[eê]me|pareil|identique)\b/i.test(lc)) {
            const existing = candidates.find(c => c.id === d.data.duplicate_id);
            if (f === "f5" && existing) {
              const aliases = [...new Set([...(existing.aliases || []), ...(S.collected.aliases || []), S.collected.object_name])];
              updateObj(f, d.data.duplicate_id, { location: S.collected.location, aliases });
            } else {
              updateObj(f, d.data.duplicate_id, S.collected);
            }
            say("Mis à jour.", f);
            setMode("IDLE");
            return;
          }
          S.targetId = d.data.duplicate_id;
          setMode(S.mode.replace("VALIDATING", "DEDUP"));
          const existing = candidates.find(c => c.id === d.data.duplicate_id);
          say(T.dupFound(existing?.motif || existing?.name || existing?.title || "cet élément"), f);
          return;
        }
      }
      // No duplicate → insert
      insertObj(f, S.collected);
      say(T.inserted, f);
      setMode("IDLE");
    } else if (r.data.intent === "edit") {
      // Fix Cause B: the patient's correction needs to OVERWRITE existing fields.
      // Clear fields that the edit_detail mentions so extraction can replace them.
      // For F4 datetime correction ("mercredi à 10h"), clear datetime.
      // For F2 edits, clear summary so recompilation happens.
      const detail = (r.data.edit_detail || text).toLowerCase();
      if (f === "f4") {
        if (/\b(\d{1,2}[h:]|\bheure|matin|soir|après-midi|midi|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/.test(detail)) {
          delete S.collected.datetime;
        }
        if (/\b(motif|raison|pour)\b/.test(detail)) {
          delete S.collected.motif;
        }
      }
      if (f === "f2") {
        // For memory edits, force recompilation with edit instruction
        delete S.collected.summary;
        delete S.collected.title;
      }
      setMode(S.mode.replace("VALIDATING", "BUILDING"));
      await handleCrudBuilding(text);
    } else {
      say(T.cancelled, f);
      setMode("IDLE");
    }
  }

  // ──────────────── CRUD: DEDUP ────────────────
  async function handleCrudDedup(text) {
    const f = featureOf(S.mode);
    setProcessing(true);
    const r = await callTool(TOOL.classify, P.classify(), `Patient dit : "${text}"`);
    setProcessing(false);

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

  // ──────────────── CRUD: READ ────────────────
  async function handleCrudRead(text) {
    const f = featureOf(S.mode);
    const items = itemsFor(f);

    if (f === "f4") {
      say(T.alarmList(items), f);
      setMode("IDLE");
      return;
    }

    if (f === "f5") {
      const name = (S.collected.object_name || text).toLowerCase().replace(/\b(mon|ma|mes|le|la|les|où|est|sont)\b/gi, "").trim();
      const found = S.objects.find(o =>
        o.name.toLowerCase().includes(name) || name.includes(o.name.toLowerCase()) ||
        (o.aliases || []).some(a => a.toLowerCase().includes(name) || name.includes(a.toLowerCase()))
      );
      if (found) { say(T.objRead(found), f); }
      else { say(T.objNotFound(name || "cet objet"), f); }
      setMode("IDLE");
      return;
    }

    if (f === "f2") {
      if (!items.length) { say(T.noItems("souvenir"), f); setMode("IDLE"); return; }
      setProcessing(true);
      const r = await callTool(TOOL.speak, P.f2read(items), `Patient dit : "${text}"`);
      setProcessing(false);
      say(r.ok ? r.data.speech : T.notFound("souvenir"), f);
      setMode("IDLE");
      return;
    }

    setMode("IDLE");
  }

  // ──────────────── CRUD: FINDING (update/delete) ────────────────
  async function handleCrudFinding(text) {
    const f = featureOf(S.mode);
    const purpose = S.mode.includes("UPDATE") ? "modifier" : "supprimer";
    const items = itemsFor(f);

    if (!items.length) { say(T.noItems(featureLabel(f)), f); setMode("IDLE"); return; }

    setProcessing(true);
    const r = await callTool(TOOL.findItem, P.findItem(f, items, purpose), `Patient dit : "${text}"`);
    setProcessing(false);

    if (r.ok && r.data.found && r.data.item_id) {
      S.targetId = r.data.item_id;
      const item = items.find(i => i.id === r.data.item_id);
      if (S.mode.includes("UPDATE")) {
        S.collected = item ? { ...item } : {};
        // Fix Cause C: detect what the patient wants to modify from the original text
        // and clear that field so extraction can overwrite it
        const lc = text.toLowerCase();
        if (f === "f4") {
          if (/\b(\d{1,2}\s*(h|heures?|[:.])|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|matin|soir|midi|d[eé]cale)\b/i.test(text)) {
            delete S.collected.datetime;
          }
        }
        if (f === "f5" && /\b(dans|sur|sous|derrière|devant|à côté)\b/i.test(lc)) {
          delete S.collected.location;
        }
        setMode(S.mode.replace("FINDING", "BUILDING"));
        // Pass the original text so BUILDING can extract the new values
        await handleCrudBuilding(text);
      } else {
        setMode(S.mode.replace("FINDING", "CONFIRMING"));
        say(r.data.speech || "Voulez-vous confirmer la suppression ?", f);
      }
    } else {
      say(r.data?.speech || T.notFound(featureLabel(f)), f);
    }
  }

  // ──────────────── CRUD: DELETE CONFIRM ────────────────
  async function handleCrudDeleteConfirm(text) {
    const f = featureOf(S.mode);
    setProcessing(true);
    const r = await callTool(TOOL.classify, P.classify(), `Patient dit : "${text}"`);
    setProcessing(false);

    if (r.ok && r.data.intent === "yes") {
      deleteObj(f, S.targetId);
      say(T.deleted, f);
    } else {
      say(T.cancelled, f);
    }
    setMode("IDLE");
  }

  // ──────────────── F3: COLLECTING ────────────────
  async function handleF3Collecting(text) {
    S.f3turns++;
    setProcessing(true);

    if (!S.planCtx.task) S.planCtx.task = text;

    const r = await callTool(TOOL.f3collect, P.f3collect(S.planCtx, S.planCtx), `Patient dit : "${text}"`);
    setProcessing(false);

    if (!r.ok) { say(T.error, "f3"); return; }

    if (r.data.new_fields) S.planCtx = { ...S.planCtx, ...r.data.new_fields };

    if (r.data.ready_for_plan || S.f3turns >= 4) {
      setProcessing(true);
      const p = await callTool(TOOL.f3plan, P.f3plan(S.planCtx), "Produis le plan d'action.");
      setProcessing(false);

      if (p.ok && p.data.steps?.length) {
        S.plan = {
          id: gid("plan"), task: p.data.task || S.planCtx.task || "",
          status: "validating", steps: p.data.steps.map((t, i) => ({ index: i + 1, text: typeof t === "string" ? t : String(t), status: "pending" })),
          current_step: 1, created_at: iso(),
        };
        save();
        renderInspector();
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

  // ──────────────── F3: VALIDATING ────────────────
  async function handleF3Validating(text) {
    // Fix Bug 4: dedicated classify that only accepts yes/edit/cancel
    // Anything else (like "où j'en suis?") → re-ask, never cancel
    setProcessing(true);
    const r = await callTool(TOOL.classify,
      `Le patient a reçu un plan d'action et doit répondre.
Plan proposé : ${S.plan?.steps?.map((s, i) => `${i + 1}. ${s.text}`).join(", ")}

Classifie sa réponse :
- "oui"/"c'est bon"/"ça me va"/"ok"/"parfait"/"on commence" → yes
- Demande de modification ("change","enlève","ajoute","modifie") → edit
- "non"/"annule"/"laisse tomber" (refus EXPLICITE) → cancel

ATTENTION : si le patient dit quelque chose qui N'EST PAS une validation, une modification, ou un refus explicite (par exemple une question comme "où j'en suis", "c'est quoi le plan", "répète"), retourne intent="yes" avec edit_detail=null — ce n'est PAS un refus.`,
      `Patient dit : "${text}"`
    );
    setProcessing(false);

    if (r.ok && r.data.intent === "yes") {
      S.plan.status = "in_progress";
      S.plan.steps[0].status = "current";
      save();
      renderInspector();
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
      // Unknown intent — re-ask instead of cancelling
      const stepList = S.plan.steps.map((s, i) => `${i + 1}. ${s.text}`).join(". ");
      say(`Le plan comporte ${S.plan.steps.length} étapes : ${stepList}. Voulez-vous qu'on commence ?`, "f3");
    }
  }

  // ──────────────── F3: EXECUTING ────────────────
  async function handleF3Executing(text) {
    setProcessing(true);
    const r = await callTool(TOOL.f3intent, P.f3execute(S.plan), `Patient dit : "${text}"`);
    setProcessing(false);

    if (!r.ok) { say(T.error, "f3"); return; }

    switch (r.data.intent) {
      case "step_done": {
        const cs = S.plan.current_step - 1;
        if (cs >= 0 && cs < S.plan.steps.length) S.plan.steps[cs].status = "done";
        if (S.plan.current_step >= S.plan.steps.length) {
          S.plan.status = "completed";
          save(); renderInspector();
          say(T.f3complete(S.plan.task), "f3");
          setMode("IDLE");
        } else {
          S.plan.current_step++;
          S.plan.steps[S.plan.current_step - 1].status = "current";
          save(); renderInspector();
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
        S.plan.status = "paused"; save(); renderInspector();
        say(T.f3paused, "f3");
        setMode("F3_PAUSED");
        break;
      default:
        say(r.data.help_response || "Je suis là pour vous aider avec cette étape.", "f3");
        break;
    }
  }

  // ──────────────── F3: PAUSED ────────────────
  async function handleF3Paused(text) {
    if (!S.plan?.steps?.length) {
      say("Je n'ai pas de plan en mémoire.", "f3");
      setMode("IDLE");
      return;
    }
    S.plan.status = "in_progress"; save(); renderInspector();
    setMode("F3_EXECUTING");
    say(`On reprend. ${T.f3step(S.plan.current_step, S.plan.steps.length, S.plan.steps[S.plan.current_step - 1]?.text)}`, "f3");
  }

  // ──────────────── TTS / STT ────────────────
  let recognition = null, sttAccumulator = "", sttDebounce = null, restartTimeout = null;

  function speak(text) {
    if (!text) return;
    // Test mode: skip TTS entirely, just resolve immediately
    if (window._amTestMode) {
      S.isSpeaking = false;
      S.ttsCooldown = false;
      return;
    }
    window.speechSynthesis.cancel();
    S.isSpeaking = true;
    S.ttsCooldown = false;
    updateMicUI();
    sttPause();

    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    u.rate = 0.92;
    u.pitch = 0.95;
    const voices = window.speechSynthesis.getVoices();
    const v = voices.find(v => v.lang === "fr-FR" && v.name.toLowerCase().includes("google")) || voices.find(v => v.lang.startsWith("fr"));
    if (v) u.voice = v;

    u.onend = u.onerror = () => {
      S.isSpeaking = false;
      S.ttsCooldown = true;
      updateMicUI();
      setTimeout(() => { S.ttsCooldown = false; sttResume(); }, TTS_COOLDOWN);
    };
    window.speechSynthesis.speak(u);
  }

  function say(text, feature) {
    if (!text) return;
    logAssistant(text, feature);
    // Record for test runner
    if (window._amLog) {
      window._amLog.push({ type: "assistant", text, feature, mode: S.mode, time: new Date().toISOString() });
      window._amLastResponse = { text, feature, mode: S.mode };
    }
    speak(text);
  }

  function sttPause() { if (recognition) { try { recognition.abort(); } catch {} } }
  function sttResume() {
    if (S.isListening && recognition && !S.isSpeaking && !S.ttsCooldown) {
      try { recognition.start(); } catch {}
    }
  }

  function startSTT() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert("Chrome requis pour le micro."); return; }
    recognition = new SR();
    recognition.lang = "fr-FR";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (e) => {
      if (S.isSpeaking || S.ttsCooldown) return;
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      if (interim) { showInterim(sttAccumulator ? sttAccumulator + " " + interim : interim); }
      if (final.trim()) {
        sttAccumulator += (sttAccumulator ? " " : "") + final.trim();
        showInterim(sttAccumulator + " …");
        if (sttDebounce) clearTimeout(sttDebounce);
        sttDebounce = setTimeout(() => {
          const full = sttAccumulator.trim();
          sttAccumulator = "";
          hideInterim();
          if (full) enqueueInput(full);
        }, STT_DEBOUNCE);
      }
    };

    recognition.onerror = (e) => {
      if (e.error === "not-allowed") { S.isListening = false; updateMicUI(); alert("Micro refusé."); return; }
    };

    recognition.onend = () => {
      if (S.isListening && !S.isSpeaking && !S.ttsCooldown) {
        restartTimeout = setTimeout(() => {
          if (S.isListening && !S.isSpeaking && !S.ttsCooldown) { try { recognition.start(); } catch {} }
        }, 300);
      }
    };

    recognition.start();
    S.isListening = true;
    updateMicUI();
    summaryTimer = setInterval(() => { if (!S.isProcessing) bgSummary(); }, 90 * 1000);
  }

  function stopSTT() {
    S.isListening = false;
    if (restartTimeout) clearTimeout(restartTimeout);
    if (summaryTimer) clearInterval(summaryTimer);
    if (sttDebounce) clearTimeout(sttDebounce);
    stopRelance();
    sttAccumulator = "";
    if (recognition) { recognition.onend = null; try { recognition.abort(); } catch {} recognition = null; }
    hideInterim();
    updateMicUI();
  }

  // ──────────────── UI ────────────────
  const D = {};
  function cacheDom() {
    ["api-key-input", "btn-api-connect", "api-status", "btn-mic", "mic-state",
      "text-form", "text-input", "btn-reset", "conversation-log", "empty-state",
      "interim-bar", "interim-text", "mode-label", "mode-dot",
      "feature-indicator", "session-count", "session-entries", "day-sessions-count",
      "day-sessions-entries", "memories-count", "memories-entries", "plan-entries",
      "alarms-count", "alarms-entries", "objects-count", "objects-entries"
    ].forEach(id => { D[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = $("#" + id); });
  }

  function setProcessing(v) {
    S.isProcessing = v;
    updateMicUI();
    if (v) addThinking(); else rmThinking();
  }

  function updateMicUI() {
    const b = D.btnMic;
    if (!b) return;
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
    if (f && labels[f]) {
      D.featureIndicator.textContent = labels[f];
      D.featureIndicator.className = "feature-badge " + f;
    } else {
      D.featureIndicator.className = "feature-badge hidden";
    }
  }

  function featureColor(f) {
    return { f1: "var(--f1)", f2: "var(--f2)", f3: "var(--f3)", f4: "var(--f4)", f5: "var(--f5)" }[f] || "var(--text-dim)";
  }

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
    removeEmpty();
    const r = document.createElement("div"); r.className = "msg-row buffer-passive";
    r.innerHTML = `<div class="msg-buffer-passive"><span class="buffer-dot">●</span>${esc(text.substring(0, 120))}${text.length > 120 ? "…" : ""}<span class="msg-time">${fmtTime(Date.now())}</span></div>`;
    D.conversationLog.appendChild(r);
    scrollLog();
  }

  function logUser(text) {
    removeEmpty();
    const r = document.createElement("div"); r.className = "msg-row user";
    r.innerHTML = `<div class="msg-bubble">${esc(text)}<span class="msg-time">${fmtTime(Date.now())}</span></div>`;
    D.conversationLog.appendChild(r);
    scrollLog();
  }

  function logAssistant(text, feature) {
    if (!text) return;
    removeEmpty();
    const r = document.createElement("div"); r.className = "msg-row assistant";
    let tag = "";
    if (feature) {
      const labels = { f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5" };
      tag = `<span class="msg-feature-tag" style="background:${featureColor(feature)}">${labels[feature] || ""}</span>`;
    }
    r.innerHTML = `<div class="msg-bubble">${tag}${esc(text)}<span class="msg-time">${fmtTime(Date.now())}</span></div>`;
    D.conversationLog.appendChild(r);
    scrollLog();
  }

  function removeEmpty() { const e = document.getElementById("empty-state"); if (e) e.remove(); }
  function scrollLog() { requestAnimationFrame(() => D.conversationLog.scrollTop = D.conversationLog.scrollHeight); }
  function showInterim(text) { D.interimBar.classList.remove("hidden"); D.interimText.textContent = text; }
  function hideInterim() { D.interimBar.classList.add("hidden"); D.interimText.textContent = ""; }

  // ──────────────── INSPECTOR ────────────────
  function renderInspector() {
    if (!D.sessionCount) return;
    const sc = S.currentSession?.segments?.length || 0;
    D.sessionCount.textContent = sc;
    D.sessionEntries.innerHTML = sc === 0 ? '<p class="inspector-empty">Aucune session</p>' :
      (bufferSummary ? `<div class="inspector-card" style="border-left-color:var(--f1)"><strong>Résumé auto</strong><div class="detail">${esc(bufferSummary)}</div></div>` : "") +
      S.currentSession.segments.slice(-5).map(s => `<div class="inspector-card"><span class="detail">${fmtTime(new Date(s.ts))}</span> ${esc(s.text.substring(0, 80))}</div>`).join("");

    D.daySessionsCount.textContent = S.daySessions.length;
    D.daySessionsEntries.innerHTML = S.daySessions.length ?
      S.daySessions.map(s => `<div class="inspector-card"><span class="detail">${fmtTime(s.started_at)}</span> ${esc((s.summary || "…").substring(0, 60))}</div>`).join("") :
      '<p class="inspector-empty">—</p>';

    D.memoriesCount.textContent = S.memories.length;
    D.memoriesEntries.innerHTML = S.memories.length ?
      S.memories.slice().reverse().map(m => `<div class="inspector-card" style="border-left-color:var(--f2)"><strong>${esc(m.title)}</strong><div class="detail">${esc(m.date)} · ${esc(m.summary.substring(0, 80))}</div></div>`).join("") :
      '<p class="inspector-empty">Aucun souvenir</p>';

    if (S.plan?.steps?.length) {
      const icons = { planning: "📝", validating: "🔍", in_progress: "▶", paused: "⏸", completed: "✅" };
      D.planEntries.innerHTML = `<div class="inspector-card" style="border-left-color:var(--f3)"><strong>${icons[S.plan.status] || ""} ${esc(S.plan.task)}</strong><div class="detail">Étape ${S.plan.current_step}/${S.plan.steps.length}</div>` +
        S.plan.steps.map(s => `<div class="plan-step ${s.status}">${s.status === "done" ? "✓" : s.status === "current" ? "▸" : "○"} ${esc(s.text)}</div>`).join("") + "</div>";
    } else { D.planEntries.innerHTML = '<p class="inspector-empty">Aucun plan</p>'; }

    D.alarmsCount.textContent = S.alarms.length;
    D.alarmsEntries.innerHTML = S.alarms.length ?
      S.alarms.map(a => `<div class="inspector-card" style="border-left-color:var(--f4)"><strong>${esc(a.motif)}</strong><div class="detail">${fmtDate(a.datetime)}${a.recurrence !== "none" ? " · " + a.recurrence : ""}</div></div>`).join("") :
      '<p class="inspector-empty">Aucune alarme</p>';

    D.objectsCount.textContent = S.objects.length;
    D.objectsEntries.innerHTML = S.objects.length ?
      S.objects.map(o => `<div class="inspector-card" style="border-left-color:var(--f5)"><strong>${esc(o.name)}</strong>${o.aliases?.length ? `<span class="alias"> ${esc(o.aliases.join(", "))}</span>` : ""}<div class="detail">📍 ${esc(o.location)} · ${fmtTime(o.updated_at)}</div></div>`).join("") :
      '<p class="inspector-empty">Aucun objet</p>';
  }

  // ──────────────── SCENARIOS ────────────────
  const SCENARIOS = [
    { id: "f1", label: "F1", title: "Conversation", color: "var(--f1)",
      sugg: [
        "Alors Christine tu as eu des nouvelles du docteur Martin pour les résultats ?",
        "Oui il m'a appelée ce matin, tout est normal, il veut te revoir dans trois mois.",
        "Au fait pour samedi j'ai réservé au restaurant Le Panorama pour 20 heures.",
        "Moi je vais apporter un gâteau au citron, Paul tu peux t'occuper du vin ?",
        "Memory résume",
      ] },
    { id: "f4", label: "F4", title: "Alarmes", color: "var(--f4)",
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
      ] },
    { id: "f5", label: "F5", title: "Objets", color: "var(--f5)",
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
      ] },
    { id: "f2", label: "F2", title: "Souvenirs", color: "var(--f2)",
      sugg: [
        "Il fait vraiment beau, regarde les montagnes au fond on voit la neige.",
        "C'est magnifique, le reflet sur le lac est incroyable avec cette lumière.",
        "La voisine Martine est passée, elle nous invite à prendre le café demain à 15h.",
        "Memory crée un souvenir de ma journée",
        "Enlève le passage ordinaire et rajoute que la lumière dorée m'a ému",
        "Oui c'est parfait garde ça",
        "Memory c'était quoi le jour au bord du lac ?",
      ] },
    { id: "f3", label: "F3", title: "Aide à l'action", color: "var(--f3)",
      sugg: [
        "Memory je veux écrire une lettre de remerciement au docteur Martin",
        "C'est pour le remercier de sa patience et du suivi depuis l'opération",
        "Docteur Philippe Martin au centre hospitalier de Grenoble, ton personnel",
        "Oui ça me va",
        "Qu'est-ce que je pourrais mettre comme points clés ?",
        "C'est fait",
        "Où j'en suis ?",
        "C'est fait",
        "Pause",
        "Memory on reprend le plan",
      ] },
  ];

  function renderScenarios() {
    const list = $("#scenarios-list");
    if (!list) return;
    list.innerHTML = SCENARIOS.map(sc => `
      <div class="scenario-card" data-id="${sc.id}">
        <div class="scenario-header"><span class="scenario-tag" style="background:${sc.color}">${sc.label}</span><span class="scenario-name">${sc.title}</span></div>
        <div class="scenario-body">
          ${sc.sugg.map((s, i) => `<button class="suggestion-btn" data-text="${esc(s)}"><span class="suggestion-num">${i + 1}</span>${esc(s)}</button>`).join("")}
        </div>
      </div>`).join("");

    list.querySelectorAll(".scenario-card").forEach(c => {
      c.addEventListener("click", e => {
        if (e.target.closest(".suggestion-btn")) return;
        document.querySelectorAll(".scenario-card").forEach(x => x.classList.remove("active"));
        c.classList.toggle("active");
      });
    });
    list.querySelectorAll(".suggestion-btn").forEach(b => {
      b.addEventListener("click", e => { e.stopPropagation(); enqueueInput(b.dataset.text); });
    });
  }

  // ──────────────── INIT ────────────────
  async function testKey(k) {
    try {
      const r = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": k, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: MODEL, max_tokens: 5, messages: [{ role: "user", content: "." }] }),
      });
      return r.ok;
    } catch { return false; }
  }

  function init() {
    cacheDom();
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    renderScenarios();
    renderInspector();

    // Restore plan
    try { S.plan = JSON.parse(localStorage.getItem("am_plan")) || null; } catch { S.plan = null; }

    const savedKey = localStorage.getItem("am_api_key") || "";
    if (savedKey) {
      S.apiKey = savedKey;
      D.apiKeyInput.value = savedKey;
      testKey(savedKey).then(ok => {
        if (ok) { D.apiStatus.textContent = "✓ Connecté"; D.apiStatus.className = "status-text success"; }
      });
    }

    D.btnApiConnect.addEventListener("click", async () => {
      const k = D.apiKeyInput.value.trim();
      if (!k) return;
      D.apiStatus.textContent = "Vérification…"; D.apiStatus.className = "status-text";
      if (await testKey(k)) {
        S.apiKey = k;
        localStorage.setItem("am_api_key", k);
        D.apiStatus.textContent = "✓ Connecté"; D.apiStatus.className = "status-text success";
      } else {
        D.apiStatus.textContent = "✗ Clé invalide"; D.apiStatus.className = "status-text error";
      }
    });
    D.apiKeyInput.addEventListener("keydown", e => { if (e.key === "Enter") D.btnApiConnect.click(); });

    D.btnMic.addEventListener("click", () => {
      if (!S.apiKey) { alert("Clé API requise."); return; }
      if (S.isListening) stopSTT(); else startSTT();
    });

    D.textForm.addEventListener("submit", e => {
      e.preventDefault();
      const t = D.textInput.value.trim();
      if (t) { enqueueInput(t); D.textInput.value = ""; }
    });

    D.btnReset.addEventListener("click", () => {
      if (!confirm("Tout réinitialiser ?")) return;
      stopSTT();
      window.speechSynthesis.cancel();
      S.currentSession = null; S.daySessions = []; S.memories = []; S.alarms = []; S.objects = [];
      S.plan = null; S.collected = {}; S.missing = []; S.targetId = null; S.planCtx = {};
      S.isSpeaking = false; S.ttsCooldown = false; S.isProcessing = false;
      bufferSegments = []; bufferSummary = "";
      ["am_days", "am_mem", "am_plan", "am_alarms", "am_objects"].forEach(k => localStorage.removeItem(k));
      setMode("IDLE");
      D.conversationLog.innerHTML = `<div id="empty-state" class="empty-state"><p class="empty-title">Prêt</p><p class="empty-text">Connectez l'API, activez le micro.<br>Dites <strong>Memory</strong> pour activer.</p></div>`;
      renderInspector();
    });
  }

  // ──────────────── TEST HOOKS ────────────────
  window._am = {
    enqueue: enqueueInput,
    state: () => ({
      mode: S.mode, collected: { ...S.collected }, missing: [...S.missing],
      alarms: S.alarms.map(a => ({ ...a })),
      objects: S.objects.map(o => ({ ...o })),
      memories: S.memories.map(m => ({ ...m })),
      plan: S.plan ? { ...S.plan, steps: S.plan.steps?.map(s => ({ ...s })) } : null,
      daySessions: S.daySessions.length,
      bufferSegments: bufferSegments.length,
    }),
    isIdle: () => !S.isProcessing && !queueRunning && !S.isSpeaking,
    reset: () => D.btnReset?.click(),
  };

  document.addEventListener("DOMContentLoaded", init);
})();
