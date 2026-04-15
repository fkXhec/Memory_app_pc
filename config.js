// config.js — Constants, regex, tool schemas
export const MODEL = "claude-sonnet-4-6";
export const API_URL = "https://api.anthropic.com/v1/messages";
export const SESSION_TIMEOUT = 5 * 60 * 1000;
export const RELANCE_SOFT = 30 * 1000;
export const RELANCE_HARD = 3 * 60 * 1000;
export const TTS_COOLDOWN = 600;
export const STT_DEBOUNCE = 1400;
export const BUFFER_WINDOW = 10 * 60 * 1000;
export const WAKE_RE = /\bmemor(?:y|ie?|is?|i|oire)\b/i;
export const STOP_RE = /\b(stop|arr[eê]te|annule)\b/i;
export const REQUIRED = { f2: ["title", "summary"], f4: ["motif", "datetime"], f5: ["object_name", "location"] };
export const DEFAULTS = { f2: { people: [], places: [], keywords: [] }, f4: { recurrence: "none" }, f5: { aliases: [] } };

// Tool definitions for Claude tool_use
export const TOOL = {
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
        aliases: { type: "array", items: { type: "string" } }
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
        title: { type: "string" },
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
        new_fields: { type: "object" },
        still_missing: { type: "array", items: { type: "string" } },
        next_question: { type: ["string", "null"] },
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
        task: { type: "string" },
        steps: { type: "array", items: { type: "string" } }
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
        help_response: { type: ["string", "null"] }
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
        speech: { type: "string" }
      },
      required: ["found", "speech"]
    }
  },
  speak: {
    name: "formulate_response",
    description: "Formule une réponse vocale concise pour le patient (1-3 phrases, vouvoiement, ton calme).",
    input_schema: {
      type: "object",
      properties: { speech: { type: "string" } },
      required: ["speech"]
    }
  }
};
