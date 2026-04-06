# Assistant Mémoire Vocal — Prototype v5

Prothèse cognitive vocale pour amnésie antérograde.  
Architecture : **StateManager déterministe + LLM tool use**.

## Lancement

```bash
npx serve .
```

Ouvrir **http://localhost:3000** dans **Google Chrome** (requis pour Web Speech API).

## Architecture v5 (vs v4)

| Aspect | v4 (ancien) | v5 (nouveau) |
|--------|-------------|-------------|
| Gestion d'état | LLM pilote tout | StateManager déterministe (code) |
| Communication LLM | Texte libre + parsing JSON fragile | **Tool use** natif Claude (retours structurés garantis) |
| Réponses factuelles | LLM reformule | **Templates** déterministes (0 hallucination) |
| Dedup | Après insertion (self-dedup possible) | **Avant** insertion (programmatique + LLM) |
| Contexte LLM | Historique de conversation | **Contexte injecté** structuré à chaque tour |

## Commandes

- **"Memory, résume"** → F1 résumé conversation
- **"Memory, crée un souvenir"** → F2 compilation journalière
- **"Memory, je veux faire [tâche]"** → F3 aide à l'action
- **"Memory, rappelle-moi [quoi] à [quand]"** → F4 alarme
- **"Memory, [objet] est [lieu]"** → F5 objet
- **"Memory, où est [objet] ?"** → F5 lecture
- **"Memory stop"** → retour IDLE

En mode actif : pas besoin de redire "Memory" — parlez directement.

## Prérequis

- Google Chrome
- Clé API Anthropic (Claude)
