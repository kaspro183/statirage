# Tirages Lab — site statique avec mise à jour automatique

Dashboard Keno / EuroMillions / Loto qui charge automatiquement les derniers
tirages, sans serveur : une tâche planifiée GitHub Actions régénère les
fichiers `site/data/*.json` après chaque tirage, et la page les lit.

## Contenu

```
site/index.html                    # le dashboard (autonome)
site/data/                         # keno.json, euromillions.json, loto.json
tools/update_data.py               # télécharge les archives FDJ -> JSON
.github/workflows/update-data.yml  # planification (après chaque tirage)
```

## Mise en route (une seule fois, ~15 min)

1. **(Déjà fait)** Les URLs d'archives FDJ sont pré-remplies dans `tools/update_data.py` (relevées le 17/07/2026).
2. **Tester en local** : `python3 tools/update_data.py`
   → doit créer `site/data/keno.json`, etc.
3. **Créer un dépôt GitHub** et pousser tout le dossier.
   Le workflow est détecté automatiquement (onglet Actions). Lance-le une
   première fois à la main : Actions → « Mise à jour des tirages » →
   « Run workflow ».
4. **Brancher l'hébergement** : sur Netlify (ou Vercel), « Import from
   GitHub », répertoire de publication : `site`. Chaque commit du bot
   redéploie le site avec les nouveaux tirages.

## Fonctionnement de la page

- Hébergée : charge `data/<jeu>.json` automatiquement au clic sur l'onglet.
- En local (double-clic sur index.html) : le navigateur bloque le chargement
  de fichiers (`file://`) — la page bascule sur l'import CSV manuel.
- Si un JSON manque, la page propose l'import CSV : rien ne casse.

## Si le workflow échoue un jour

Cause n°1 : la FDJ a changé les URLs d'archives (refonte du site).
Re-copier les nouvelles URLs dans `tools/update_data.py`, committer.
Le script rejette toute ligne invalide plutôt que d'insérer du douteux.
