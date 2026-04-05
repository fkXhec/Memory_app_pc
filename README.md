# Assistant Mémoire Vocal — PoC

Prothèse cognitive pour amnésie antérograde.

## Lancement

```bash
npx serve .
```

Puis ouvrir **http://localhost:3000** dans **Google Chrome** (obligatoire pour le micro).

Alternative sans serveur : ouvrir `index.html` directement dans Chrome (le micro peut ne pas fonctionner sans HTTPS/localhost).

## Utilisation

1. Entrer votre clé API Claude (Anthropic) dans le champ prévu
2. Cliquer sur le bouton micro pour activer l'écoute
3. Parler normalement — le buffer se remplit automatiquement
4. Dire **"Memory"** suivi de votre commande pour activer une fonction

## Commandes

- **"Memory, résume"** → résumé de la conversation en cours (F1)
- **"Memory, crée un souvenir"** → compilation de la journée (F2)
- **"Memory, je veux faire [tâche]"** → aide à l'action structurée (F3)
- **"Memory, rappelle-moi de [quoi] à [quand]"** → alarme avec motif (F4)
- **"Memory, [objet] est [emplacement]"** → enregistrement objet (F5)
- **"Memory, où est [objet] ?"** → recherche objet (F5)

## Prérequis

- Google Chrome (Web Speech API)
- Clé API Anthropic (Claude)
- Connexion internet (pour l'API Claude)
