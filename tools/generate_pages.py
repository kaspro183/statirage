#!/usr/bin/env python3
"""Génère les pages SEO par numéro (site/<jeu>/numero-N/index.html),
une page hub par jeu (site/<jeu>/numeros/index.html) et le sitemap.xml.

Sortie DÉTERMINISTE : le contenu ne dépend que des JSON de tirages
(aucun horodatage "now"), pour que le commit conditionnel du workflow
ne se déclenche que si les données ont réellement changé.

Usage : python tools/generate_pages.py   (depuis la racine du dépôt)
"""

import json
import os
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
BASE_URL = "https://statirage.fr"

GAMES = {
    "keno": {
        "label": "Keno", "max": 56, "draw_size": 16,
        "accent": "#A62B52", "bg1": "#8C2246", "bg2": "#4C1226", "ink": "#FFFFFF",
        "desc": "16 numéros tirés parmi 56, chaque soir à 20 h (formule FDJ depuis le 3 novembre 2025)",
    },
    "euromillions": {
        "label": "EuroMillions", "max": 50, "draw_size": 5,
        "accent": "#3D4FD8", "bg1": "#16249B", "bg2": "#090F4E", "ink": "#FFFFFF",
        "desc": "5 numéros tirés parmi 50 (plus 2 étoiles), chaque mardi et vendredi",
    },
    "loto": {
        "label": "Loto", "max": 49, "draw_size": 5,
        "accent": "#2FA9DA", "bg1": "#2E9AC8", "bg2": "#155D80", "ink": "#0F2E3A",
        "desc": "5 numéros tirés parmi 49 (plus 1 numéro chance), les lundi, mercredi et samedi",
    },
    "eurodreams": {
        "label": "EuroDreams", "max": 40, "draw_size": 6,
        "accent": "#9C4FD6", "bg1": "#7433AF", "bg2": "#3A1760", "ink": "#FFFFFF",
        "desc": "6 numéros tirés parmi 40 (plus 1 numéro Dream), chaque lundi et jeudi",
    },
}

MOIS = ["", "janvier", "février", "mars", "avril", "mai", "juin", "juillet",
        "août", "septembre", "octobre", "novembre", "décembre"]


def fmt_date(iso):
    y, m, d = iso.split("-")
    return f"{int(d)} {MOIS[int(m)]} {y}"


def number_stats(draws, n, g):
    """draws[0] = tirage le plus récent."""
    total = len(draws)
    appearances = [i for i, d in enumerate(draws) if n in d["numbers"]]
    freq = len(appearances)
    expected = total * g["draw_size"] / g["max"]
    current_gap = appearances[0] if appearances else total
    gaps = []
    for a, b in zip(appearances, appearances[1:]):
        gaps.append(b - a)
    max_gap = max(gaps + [current_gap]) if (gaps or appearances) else total
    avg_gap = (sum(gaps) / len(gaps)) if gaps else None
    last_dates = [draws[i]["date"] for i in appearances[:5]]
    companions = Counter()
    for i in appearances:
        for m in draws[i]["numbers"]:
            if m != n:
                companions[m] += 1
    recent = draws[:30]
    freq30 = sum(1 for d in recent if n in d["numbers"])
    exp30 = len(recent) * g["draw_size"] / g["max"]
    return {
        "freq": freq, "expected": expected, "current_gap": current_gap,
        "max_gap": max_gap, "avg_gap": avg_gap, "last_dates": last_dates,
        "companions": companions.most_common(5), "freq30": freq30, "exp30": exp30,
        "total": total,
    }


def page_css(g):
    return f"""
:root {{ --accent:{g['accent']}; --bg1:{g['bg1']}; --bg2:{g['bg2']}; --ink:{g['ink']};
  --papier:#F7F3E8; --papier2:#EFE9DA; --encre:#20261F; --ligne:#DDD5C2; --muted:#79806F; }}
* {{ box-sizing:border-box; margin:0; }}
body {{ font-family:'Poppins',system-ui,sans-serif; background:linear-gradient(160deg,var(--bg1),var(--bg2)); min-height:100vh; padding:18px 12px 40px; color:var(--encre); }}
.card {{ max-width:760px; margin:0 auto 16px; background:var(--papier); border-radius:22px; padding:24px; }}
h1 {{ font-size:clamp(21px,5vw,28px); line-height:1.25; margin-bottom:6px; }}
h2 {{ font-size:18px; margin:18px 0 8px; }}
p {{ font-size:14.5px; line-height:1.6; color:#3a4136; margin-bottom:10px; }}
.crumb {{ font-size:12.5px; margin-bottom:14px; color:var(--muted); }}
.crumb a {{ color:var(--accent); text-decoration:none; font-weight:600; }}
.bigball {{ width:64px; height:64px; border-radius:50%; background:var(--accent); color:var(--ink);
  display:inline-flex; align-items:center; justify-content:center; font-size:26px; font-weight:700; margin-bottom:12px; }}
.stat-grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:14px 0; }}
.stat {{ background:#fff; border:1px solid var(--ligne); border-radius:14px; padding:12px 14px; }}
.stat .v {{ font-size:21px; font-weight:700; color:var(--accent); }}
.stat .l {{ font-size:12px; color:var(--muted); margin-top:2px; }}
table {{ width:100%; border-collapse:collapse; font-size:13.5px; margin:8px 0; }}
th,td {{ text-align:left; padding:7px 6px; border-bottom:1px solid var(--papier2); }}
th {{ color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.4px; }}
.ball {{ display:inline-flex; width:30px; height:30px; border-radius:50%; background:#fff; border:1px solid var(--ligne);
  align-items:center; justify-content:center; font-weight:600; font-size:12.5px; margin-right:4px; }}
.nav-nums {{ display:flex; justify-content:space-between; gap:10px; margin-top:6px; }}
.btn {{ display:inline-block; background:var(--accent); color:var(--ink); font-weight:600; font-size:13.5px;
  padding:9px 16px; border-radius:999px; text-decoration:none; }}
.chip {{ display:inline-block; border:1px solid var(--ligne); background:#fff; color:var(--encre); font-weight:600;
  font-size:13px; padding:7px 13px; border-radius:999px; text-decoration:none; margin:3px 3px 0 0; }}
.note {{ font-size:12.5px; color:var(--muted); border-top:1px solid var(--ligne); padding-top:12px; margin-top:16px; }}
.hub-grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(52px,1fr)); gap:7px; margin:12px 0; }}
.hub-grid a {{ aspect-ratio:1; display:flex; align-items:center; justify-content:center; background:#fff;
  border:1px solid var(--ligne); border-radius:10px; font-weight:600; text-decoration:none; color:var(--encre); }}
.hub-grid a:hover {{ border-color:var(--accent); color:var(--accent); }}
footer {{ max-width:760px; margin:14px auto 0; text-align:center; font-size:12px; color:rgba(255,255,255,.75); }}
footer a {{ color:#fff; }}
"""


def head(title, desc, canonical, css):
    return f"""<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{canonical}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
<style>{css}</style>
</head>
<body>
"""


def footer_html(last_date):
    return f"""<footer>Données : archives officielles FDJ, à jour du dernier tirage du {fmt_date(last_date)} ·
<a href="{BASE_URL}/">statirage.fr</a> — L'intelligence statistique au service du hasard.<br>
Jouer comporte des risques. Joueurs Info Service : 09&nbsp;74&nbsp;75&nbsp;13&nbsp;13 (appel non surtaxé).</footer>
</body>
</html>"""


def number_page(game_key, g, n, st, last_date):
    label = g["label"]
    url = f"{BASE_URL}/{game_key}/numero-{n}/"
    ratio = st["freq"] / st["expected"] if st["expected"] else 0
    if ratio >= 1.12:
        verdict = "au-dessus de sa fréquence théorique — un « numéro chaud » du moment"
    elif ratio <= 0.88:
        verdict = "en dessous de sa fréquence théorique — un « numéro en retard »"
    else:
        verdict = "conforme à sa fréquence théorique — dans la norme du hasard"
    title = f"Numéro {n} au {label} — statistiques, fréquence et écart | Statirage"
    desc = (f"Le numéro {n} au {label} : {st['freq']} sorties sur {st['total']} tirages "
            f"(attendu ≈ {st['expected']:.1f}), écart actuel {st['current_gap']}, record {st['max_gap']}. "
            f"Statistiques à jour du {fmt_date(last_date)}.")
    avg_gap = f"{st['avg_gap']:.1f}" if st["avg_gap"] is not None else "—"
    dates_rows = "".join(
        f"<tr><td>{fmt_date(d)}</td></tr>" for d in st["last_dates"]
    ) or "<tr><td>Jamais sorti sur l'historique chargé</td></tr>"
    comp_rows = "".join(
        f"<tr><td><span class='ball'>{m}</span></td><td>{c}× ensemble</td>"
        f"<td><a href='{BASE_URL}/{game_key}/numero-{m}/' style='color:var(--accent);font-weight:600;text-decoration:none'>voir le {m} →</a></td></tr>"
        for m, c in st["companions"]
    )
    prev_n = n - 1 if n > 1 else g["max"]
    next_n = n + 1 if n < g["max"] else 1

    jsonld = json.dumps({
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Statirage", "item": BASE_URL + "/"},
            {"@type": "ListItem", "position": 2, "name": f"Numéros {label}", "item": f"{BASE_URL}/{game_key}/numeros/"},
            {"@type": "ListItem", "position": 3, "name": f"Numéro {n}", "item": url},
        ],
    }, ensure_ascii=False)

    html = head(title, desc, url, page_css(g))
    html += f"""<div class="card">
<div class="crumb"><a href="{BASE_URL}/">Statirage</a> › <a href="{BASE_URL}/{game_key}/numeros/">Numéros {label}</a> › {n}</div>
<span class="bigball">{n}</span>
<h1>Le numéro {n} au {label} : ses statistiques complètes</h1>
<p>Au {label} ({g['desc']}), voici tout ce que l'historique des tirages dit du numéro <strong>{n}</strong>.
Sur les <strong>{st['total']} tirages</strong> analysés, il est {verdict}.</p>

<div class="stat-grid">
  <div class="stat"><div class="v">{st['freq']}</div><div class="l">sorties observées</div></div>
  <div class="stat"><div class="v">{st['expected']:.1f}</div><div class="l">sorties attendues (théorie)</div></div>
  <div class="stat"><div class="v">{st['current_gap']}</div><div class="l">tirages depuis sa dernière sortie</div></div>
  <div class="stat"><div class="v">{st['max_gap']}</div><div class="l">plus long écart observé</div></div>
  <div class="stat"><div class="v">{avg_gap}</div><div class="l">écart moyen entre deux sorties</div></div>
  <div class="stat"><div class="v">{st['freq30']} / {st['exp30']:.1f}</div><div class="l">sorties sur les 30 derniers tirages (observé / attendu)</div></div>
</div>

<h2>Ses 5 dernières sorties</h2>
<table><tbody>{dates_rows}</tbody></table>

<h2>Les numéros qui l'accompagnent le plus souvent</h2>
<p>Simple curiosité combinatoire : ces co-sorties fréquentes n'ont aucun pouvoir prédictif.</p>
<table><tbody>{comp_rows}</tbody></table>

<h2>Ce que ces chiffres veulent dire — et ce qu'ils ne veulent pas dire</h2>
<p>Chaque tirage du {label} est indépendant : le numéro {n} a exactement <strong>{g['draw_size']} chances sur {g['max']}</strong>
(soit {100*g['draw_size']/g['max']:.1f}&nbsp;%) de sortir au prochain tirage, qu'il soit « chaud », « en retard » ou parfaitement dans la norme.
Un écart, même record, n'est pas une dette que le hasard devrait rembourser. Ces statistiques décrivent le passé — elles ne prédisent rien.</p>

<div class="nav-nums">
  <a class="chip" href="{BASE_URL}/{game_key}/numero-{prev_n}/">← Numéro {prev_n}</a>
  <a class="btn" href="{BASE_URL}/?jeu={game_key}">Explorer toutes les stats {label}</a>
  <a class="chip" href="{BASE_URL}/{game_key}/numero-{next_n}/">Numéro {next_n} →</a>
</div>

<div class="note">Statistiques calculées sur les {st['total']} tirages {label} chargés, à jour du tirage du {fmt_date(last_date)}.
Source : archives officielles FDJ. Statirage n'est pas affilié à la FDJ.</div>
</div>
<script type="application/ld+json">{jsonld}</script>
{footer_html(last_date)}"""
    return html


def hub_page(game_key, g, draws, last_date, stats_all):
    label = g["label"]
    url = f"{BASE_URL}/{game_key}/numeros/"
    hot = max(range(1, g["max"] + 1), key=lambda n: stats_all[n]["freq"])
    late = max(range(1, g["max"] + 1), key=lambda n: stats_all[n]["current_gap"])
    title = f"Statistiques de chaque numéro du {label} (1 à {g['max']}) | Statirage"
    desc = (f"Fréquence, écart et historique de sortie de chacun des {g['max']} numéros du {label}, "
            f"sur {len(draws)} tirages. Données officielles FDJ à jour du {fmt_date(last_date)}.")
    links = "".join(
        f"<a href='{BASE_URL}/{game_key}/numero-{n}/'>{n}</a>" for n in range(1, g["max"] + 1)
    )
    html = head(title, desc, url, page_css(g))
    html += f"""<div class="card">
<div class="crumb"><a href="{BASE_URL}/">Statirage</a> › Numéros {label}</div>
<h1>Les {g['max']} numéros du {label}, un par un</h1>
<p>Le {label} : {g['desc']}. Choisis un numéro pour consulter sa fiche complète —
fréquence de sortie, écart actuel, record d'absence, dernières apparitions et compagnons de tirage —
calculée sur les <strong>{len(draws)} tirages</strong> de notre historique.</p>
<p>En ce moment : le numéro le plus sorti est le <a href="{BASE_URL}/{game_key}/numero-{hot}/" style="color:var(--accent);font-weight:700">{hot}</a>
({stats_all[hot]['freq']} sorties) et le plus grand retard est tenu par le
<a href="{BASE_URL}/{game_key}/numero-{late}/" style="color:var(--accent);font-weight:700">{late}</a>
({stats_all[late]['current_gap']} tirages d'absence).</p>
<div class="hub-grid">{links}</div>
<div class="note">Aucun numéro n'est « dû » : chaque tirage est indépendant et chaque numéro garde
{g['draw_size']} chances sur {g['max']} de sortir. Ces fiches décrivent le passé, elles ne prédisent rien.</div>
</div>
{footer_html(last_date)}"""
    return html


def write_if_changed(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            if f.read() == content:
                return False
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return True


def main():
    sitemap_urls = [(f"{BASE_URL}/", None, "daily", "1.0")]
    written = 0
    for game_key, g in GAMES.items():
        data_path = os.path.join(SITE, "data", f"{game_key}.json")
        if not os.path.exists(data_path):
            print(f"[skip] {data_path} introuvable")
            continue
        with open(data_path, encoding="utf-8") as f:
            data = json.load(f)
        draws = data["draws"]
        if not draws:
            continue
        last_date = draws[0]["date"]
        stats_all = {n: number_stats(draws, n, g) for n in range(1, g["max"] + 1)}

        hub = hub_page(game_key, g, draws, last_date, stats_all)
        if write_if_changed(os.path.join(SITE, game_key, "numeros", "index.html"), hub):
            written += 1
        sitemap_urls.append((f"{BASE_URL}/{game_key}/numeros/", last_date, "daily", "0.8"))

        for n in range(1, g["max"] + 1):
            page = number_page(game_key, g, n, stats_all[n], last_date)
            if write_if_changed(os.path.join(SITE, game_key, f"numero-{n}", "index.html"), page):
                written += 1
            sitemap_urls.append((f"{BASE_URL}/{game_key}/numero-{n}/", last_date, "daily", "0.6"))

    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for loc, lastmod, freq, prio in sitemap_urls:
        lines.append("  <url>")
        lines.append(f"    <loc>{loc}</loc>")
        if lastmod:
            lines.append(f"    <lastmod>{lastmod}</lastmod>")
        lines.append(f"    <changefreq>{freq}</changefreq>")
        lines.append(f"    <priority>{prio}</priority>")
        lines.append("  </url>")
    lines.append("</urlset>\n")
    if write_if_changed(os.path.join(SITE, "sitemap.xml"), "\n".join(lines)):
        written += 1

    print(f"{written} fichier(s) écrit(s)/mis à jour · {len(sitemap_urls)} URL dans le sitemap.")


if __name__ == "__main__":
    main()
