"""Met à jour data/<jeu>.json depuis les archives officielles FDJ.

Script AUTONOME (aucune dépendance hors bibliothèque standard) conçu pour
tourner dans GitHub Actions — voir .github/workflows/update-data.yml.

Fonctionnement :
  1. Télécharge l'archive ZIP officielle de chaque jeu (URLs ci-dessous).
  2. Parse le CSV (délimiteur ';', colonnes boule1…/boule_1…, etoile_,
     numero_chance), valide chaque ligne (bornes, doublons, date).
  3. Écrit data/<jeu>.json : {"game", "updated", "draws": [...]}.

⚠️ À FAIRE UNE FOIS : renseigner les URLs des archives.
Sur fdj.fr, page « historique » de chaque jeu, clic droit sur le bouton de
téléchargement de l'archive → « Copier l'adresse du lien », et colle-la ici.
Ces URLs changent lors des refontes du site : si le script échoue en 404,
c'est probablement ça.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

# ----------------------------------------------------------------------------
# Configuration — à compléter (voir docstring ci-dessus).
# ----------------------------------------------------------------------------
# URLs relevées le 17/07/2026 sur les pages « historique » de fdj.fr :
#   Keno : archive nov. 2025 -> aujourd'hui (formule 16/56)
#   EuroMillions : archive fév. 2020 -> aujourd'hui
#   Loto : archive nov. 2019 -> aujourd'hui
_FDJ_BASE = "https://www.sto.api.fdj.fr/anonymous/service-draw-info/v3/documentations"
ARCHIVE_URLS: dict[str, str] = {
    "keno": f"{_FDJ_BASE}/1a2b3c4d-9876-4562-b3fc-2c963f66bft6",
    "euromillions": f"{_FDJ_BASE}/1a2b3c4d-9876-4562-b3fc-2c963f66afe6",
    "loto": f"{_FDJ_BASE}/1a2b3c4d-9876-4562-b3fc-2c963f66afp6",
    # EuroDreams : archive nov. 2023 -> aujourd'hui (relevée le 18/07/2026)
    "eurodreams": f"{_FDJ_BASE}/1a2b3c4d-9876-4562-b3fc-2c963f66afa5",
}

GAMES = {
    "keno":         {"max": 56, "count": 16, "extra_max": 0,  "extra_count": 0},
    "euromillions": {"max": 50, "count": 5,  "extra_max": 12, "extra_count": 2},
    "loto":         {"max": 49, "count": 5,  "extra_max": 10, "extra_count": 1},
    "eurodreams":   {"max": 40, "count": 6,  "extra_max": 5,  "extra_count": 1},
}

OUT_DIR = Path(__file__).resolve().parent.parent / "site" / "data"          # public : 30 derniers tirages
PRIVATE_DIR = Path(__file__).resolve().parent.parent / "data-private"        # complet : servi par l'API premium
FREE_DRAWS = 30
# PHASE DE TEST : True = JSON publics complets (chargement instantané, pas de
# paywall données). Passer à False au lancement, en même temps que FREE_MODE
# côté site.
FULL_PUBLIC = True
USER_AGENT = "TiragesLab-Updater/1.0 (github-actions)"  # -> mets ton contact

DATE_FORMATS = ("%d/%m/%Y", "%Y%m%d", "%Y-%m-%d", "%d/%m/%y")


def parse_date(value: str) -> dt.date | None:
    value = value.strip()
    for fmt in DATE_FORMATS:
        try:
            return dt.datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    return None


def download(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
        return resp.read()


CSV_HINTS = {"keno": ["keno"], "euromillions": ["euromillion", "million"],
             "loto": ["loto"], "eurodreams": ["dream"]}


def extract_csv(zip_bytes: bytes, game: str | None = None) -> str:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        if not names:
            raise ValueError("aucun CSV dans l'archive")
        chosen = names[0]
        for hint in CSV_HINTS.get(game or "", []):
            match = next((n for n in names if hint in n.lower()), None)
            if match:
                chosen = match
                break
        raw = zf.read(chosen)
    for enc in ("utf-8-sig", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise ValueError("encodage CSV non reconnu")


def parse_draws(content: str, game: str) -> tuple[list[dict], int]:
    """Retourne (tirages valides, nb lignes rejetées)."""
    cfg = GAMES[game]
    delim = ";" if content[:2048].count(";") >= content[:2048].count(",") else ","
    reader = csv.DictReader(io.StringIO(content), delimiter=delim)
    if not reader.fieldnames:
        raise ValueError("fichier vide")
    reader.fieldnames = [h.strip().lower() for h in reader.fieldnames]

    ball_re, star_re = re.compile(r"^boule[_ ]?(\d+)$"), re.compile(r"^etoile[_ ]?(\d+)$")
    ball_cols = sorted(
        ((h, int(m.group(1))) for h in reader.fieldnames if (m := ball_re.match(h))),
        key=lambda x: x[1],
    )
    extra_cols = sorted(
        ((h, int(m.group(1))) for h in reader.fieldnames if (m := star_re.match(h))),
        key=lambda x: x[1],
    )
    if not extra_cols:
        extra_cols = [(h, 1) for h in reader.fieldnames
                      if h in ("numero_dream", "numero_chance")]
    date_col = ("date_de_tirage" if "date_de_tirage" in reader.fieldnames
                else next((h for h in reader.fieldnames if "date" in h and "forclusion" not in h), None))
    time_col = next((h for h in reader.fieldnames if "heure" in h), None)
    mult_col = next((h for h in reader.fieldnames if "multiplicateur" in h), None)
    if not ball_cols or not date_col:
        raise ValueError(f"colonnes non reconnues pour {game} : {reader.fieldnames[:8]}")
    if len(ball_cols) != cfg["count"]:
        raise ValueError(
            f"archive à {len(ball_cols)} numéros/tirage alors que {game} en tire "
            f"{cfg['count']} — mauvaise archive ?"
        )

    today = dt.date.today()
    draws, rejected = [], 0
    for row in reader:
        try:
            date = parse_date(row[date_col] or "")
            nums = sorted(int(row[h]) for h, _ in ball_cols if (row.get(h) or "").strip())
            extras = sorted(int(row[h]) for h, _ in extra_cols if (row.get(h) or "").strip())
        except (ValueError, TypeError, KeyError):
            rejected += 1
            continue
        ok = (
            date is not None and date <= today
            and len(nums) == cfg["count"] and len(set(nums)) == cfg["count"]
            and all(1 <= n <= cfg["max"] for n in nums)
            and len(extras) == cfg["extra_count"]
            and all(1 <= n <= cfg["extra_max"] for n in extras)
        )
        if not ok:
            rejected += 1
            continue
        draws.append({
            "date": date.isoformat(),
            "time": (row.get(time_col) or "").strip().lower() if time_col else "",
            "numbers": nums,
            "extras": extras,
            "mult": (row.get(mult_col) or "").strip().lower() if mult_col else "",
        })
    if not draws:
        raise ValueError(f"aucune ligne valide pour {game}")
    draws.sort(key=lambda d: (d["date"], d["time"]), reverse=True)
    return draws, rejected


def update_game(game: str, url: str) -> None:
    print(f"[{game}] téléchargement…")
    zip_bytes = download(url)
    draws, rejected = parse_draws(extract_csv(zip_bytes, game), game)
    updated = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    PRIVATE_DIR.mkdir(parents=True, exist_ok=True)
    # Public : fenêtre gratuite uniquement (le paywall est côté serveur, pas en JS).
    (OUT_DIR / f"{game}.json").write_text(json.dumps({
        "game": game, "updated": updated, "count": len(draws),
        "free_draws": FREE_DRAWS, "draws": draws if FULL_PUBLIC else draws[:FREE_DRAWS],
    }, ensure_ascii=False, separators=(",", ":")))
    # Privé : historique complet, lisible seulement par /api/premium-data.
    (PRIVATE_DIR / f"{game}-full.json").write_text(json.dumps({
        "game": game, "updated": updated, "count": len(draws), "draws": draws,
    }, ensure_ascii=False, separators=(",", ":")))
    print(f"[{game}] {len(draws)} tirages -> {FREE_DRAWS} publics + complet privé"
          + (f" ({rejected} lignes rejetées)" if rejected else ""))


def main() -> int:
    failures = 0
    for game, url in ARCHIVE_URLS.items():
        if not url:
            print(f"[{game}] URL non configurée — ignoré (voir docstring)")
            continue
        try:
            update_game(game, url)
        except Exception as exc:  # noqa: BLE001
            print(f"[{game}] ÉCHEC : {exc}", file=sys.stderr)
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
