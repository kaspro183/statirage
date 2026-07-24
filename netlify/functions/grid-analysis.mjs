// POST /api/grid-analysis  { game, profile, numbers, extras }
// Réservé aux abonnés Premium. Calcule TOUTES les statistiques côté serveur,
// puis demande au modèle de les METTRE EN MOTS — il ne calcule rien lui-même.
import { readFile } from "node:fs/promises";
import { getStore } from "@netlify/blobs";
import { verifyToken, bearerFrom, json, isAdmin } from "./_lib.mjs";

const GAMES = {
  keno:         { label: "Keno",         max: 56, drawSize: 16 },
  euromillions: { label: "EuroMillions", max: 50, drawSize: 5  },
  loto:         { label: "Loto",         max: 49, drawSize: 5  },
  eurodreams:   { label: "EuroDreams",   max: 40, drawSize: 6  },
};

/* Rapports Keno officiels FDJ (formule du 3 nov. 2025), gains pour 1 € de mise.
   Validés par deux contrôles : les probabilités globales de gain reconstituées
   (1/15,16 · 1/7,43 · 1/20,26 · 1/10,68 · 1/11,20 · 1/3,87 · 1/7,78) correspondent
   au calcul hypergéométrique, et les TRJ tombent entre 47 % et 53 %. */
const KENO_PAY = {
  4:  { 3: 3, 4: 70 },
  5:  { 3: 2, 4: 10, 5: 80 },
  6:  { 4: 3, 5: 30, 6: 900 },
  7:  { 4: 2, 5: 5, 6: 90, 7: 3000 },
  8:  { 0: 2, 5: 5, 6: 30, 7: 100, 8: 8000 },
  9:  { 0: 2, 4: 1, 5: 2, 6: 8, 7: 25, 8: 100, 9: 30000 },
  10: { 0: 2, 5: 2, 6: 5, 7: 15, 8: 150, 9: 2000, 10: 200000 },
};

const PROFILE_LABEL = {
  balanced:   "Équilibrée (somme et équilibres au plus près des moyennes historiques)",
  cold:       "Les retardataires (numéros aux plus gros écarts actuels)",
  hot:        "Les habituées (numéros les plus sortis récemment)",
  contrarian: "Anti-consensus (évite 1–31, les dates de naissance)",
  random:     "Au hasard pur (aucun critère)",
};

async function loadDraws(game) {
  const tried = [];
  for (const p of [`../../site/data/${game}.json`, `../../data-private/${game}-full.json`]) {
    try {
      const raw = await readFile(new URL(p, import.meta.url), "utf8");
      const data = JSON.parse(raw);
      if (data?.draws?.length) return data.draws;
      tried.push(`${p} (vide)`);
    } catch (e) {
      tried.push(`${p} (${e.code || e.message})`);
    }
  }
  console.error("[grid-analysis] données introuvables :", tried.join(" · "));
  return null;
}

/* Toutes les mesures sont faites ici, en JavaScript — chiffres garantis exacts. */
function computeFacts(numbers, game, draws) {
  const g = GAMES[game];
  const half = g.max / 2;
  const total = draws.length;

  const sum = numbers.reduce((a, b) => a + b, 0);
  const sums = draws.map(d => d.numbers.reduce((a, b) => a + b, 0));
  const avgSum = sums.reduce((a, b) => a + b, 0) / total;
  const sumRank = sums.filter(s => s <= sum).length / total;  // percentile

  let consec = 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1] + 1) consec++;

  // Écart actuel de chaque numéro : distance au tirage le plus récent où il est sorti
  const gapOf = {};
  for (const n of numbers) {
    const idx = draws.findIndex(d => d.numbers.includes(n));
    gapOf[n] = idx === -1 ? total : idx;
  }
  const gaps = numbers.map(n => gapOf[n]);
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const expectedGap = g.max / g.drawSize;

  // Fréquence sur les 50 derniers tirages
  const recent = draws.slice(0, Math.min(50, total));
  const freq50 = {};
  for (const n of numbers) freq50[n] = recent.filter(d => d.numbers.includes(n)).length;
  const exp50 = recent.length * g.drawSize / g.max;

  // Combien de tirages passés avaient un profil comparable (somme ±10 % et même nb de consécutifs)
  const tol = avgSum * 0.1;
  const similar = draws.filter((d, i) => {
    const s = sums[i];
    if (Math.abs(s - sum) > tol) return false;
    const ds = [...d.numbers].sort((a, b) => a - b);
    let c = 0;
    for (let j = 1; j < ds.length; j++) if (ds[j] === ds[j - 1] + 1) c++;
    return c === consec;
  }).length;

  // Meilleur score historique de cette grille exacte
  let best = 0, bestDate = "";
  for (const d of draws) {
    const k = numbers.filter(n => d.numbers.includes(n)).length;
    if (k > best) { best = k; bestDate = d.date; }
  }

  // Suites consécutives
  const runs = [];
  let run = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] + 1) run.push(sorted[i]);
    else { if (run.length > 1) runs.push(run); run = [sorted[i]]; }
  }
  if (run.length > 1) runs.push(run);

  // Répartition par dizaine et dernier chiffre
  const nbDec = Math.ceil(g.max / 10);
  const decades = {};
  for (let i = 0; i < nbDec; i++) {
    const lo = i * 10 + 1, hi = Math.min((i + 1) * 10, g.max);
    decades[`${lo}-${hi}`] = numbers.filter(n => n >= lo && n <= hi).length;
  }
  const lastDigits = {};
  for (let i = 0; i < 10; i++) {
    const c = numbers.filter(n => n % 10 === i).length;
    if (c) lastDigits[i] = c;
  }

  // Percentile du nombre de pairs
  const allEvens = draws.map(d => d.numbers.filter(n => n % 2 === 0).length);
  const evensCount = numbers.filter(n => n % 2 === 0).length;
  const evensPct = Math.round(allEvens.filter(x => x <= evensCount).length / total * 100);

  // Tirages les plus ressemblants
  const similar5 = draws
    .map(d => ({ date: d.date, shared: numbers.filter(n => d.numbers.includes(n)).length }))
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 3);

  return {
    jeu: g.label,
    tiragesAnalyses: total,
    numeros: sorted,
    somme: sum,
    sommeMoyenneHistorique: +avgSum.toFixed(1),
    sommePercentile: Math.round(sumRank * 100),
    pairs: evensCount,
    impairs: numbers.length - evensCount,
    pairsPercentile: evensPct,
    basses: numbers.filter(n => n <= half).length,
    hautes: numbers.filter(n => n > half).length,
    suitesConsecutives: consec,
    detailDesSuites: runs.map(r => r.join("-")),
    repartitionParDizaine: decades,
    repartitionAttendueParDizaine: +(numbers.length * 10 / g.max).toFixed(1),
    repartitionParDernierChiffre: lastDigits,
    ecartsParNumero: gapOf,
    ecartMoyen: +avgGap.toFixed(1),
    ecartTheoriqueMoyen: +expectedGap.toFixed(1),
    numerosEnRetardFort: numbers.filter(n => gapOf[n] > 2 * expectedGap).sort((a, b) => gapOf[b] - gapOf[a]),
    sorties50DerniersTirages: freq50,
    attendu50DerniersTirages: +exp50.toFixed(1),
    tiragesAuProfilComparable: similar,
    tiragesLesPlusRessemblants: similar5,
    meilleurScoreHistorique: best,
    dateMeilleurScore: bestDate,
    probaParNumeroProchainTirage: `${g.drawSize} sur ${g.max}`,
  };
}

const SYSTEM = `Tu rédiges l'analyse d'une grille de loterie pour Statirage, un site français de statistiques de jeux de tirage.

RÈGLE ABSOLUE : tous les chiffres te sont fournis, déjà calculés. Tu ne calcules RIEN et tu n'inventes RIEN. Si une donnée n'est pas dans le JSON fourni, tu n'en parles pas.

Le positionnement du site est l'honnêteté statistique : chaque tirage est indépendant, aucune grille n'a plus de chances qu'une autre, un retard n'est pas une dette que le hasard rembourserait. Tu décris ce que CONTIENT la grille — jamais ce qu'elle VAUDRAIT pour l'avenir.

Interdits absolus : « chances augmentées », « optimisée », « prometteuse », « bien partie », « numéros porteurs », toute forme de pronostic ou d'encouragement à jouer davantage.

Format : 3 à 4 phrases, 70 mots maximum, en français, ton posé et factuel — celui d'un statisticien qui commente des données, pas d'un vendeur. Cite les chiffres marquants (somme vs moyenne, écarts notables, consécutifs, profil comparable). Termine par une mise en perspective sur l'indépendance des tirages, formulée naturellement et sans lourdeur.

Réponds uniquement par le texte de l'analyse, sans titre ni préambule.`;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "méthode" }, 405);

  const payload = verifyToken(bearerFrom(req));
  if (!payload) return json({ error: "Connecte-toi d'abord." }, 401);
  const user = await getStore("users").get(payload.email, { type: "json" });
  if (!user?.premium && !isAdmin(payload.email)) return json({ error: "Réservé aux abonnés Premium." }, 402);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: "Analyse indisponible (clé API non configurée)." }, 503);
  // Modèle surchargeable via la variable d'environnement ANTHROPIC_MODEL.
  // claude-sonnet-4-6 est l'ID canonique de la génération Sonnet 4.6.
  const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  const { game, profile, numbers } = await req.json().catch(() => ({}));
  const g = GAMES[game];
  if (!g) return json({ error: "jeu inconnu" }, 400);
  if (!Array.isArray(numbers) || !numbers.length || numbers.length > g.drawSize
      || numbers.some(n => !Number.isInteger(n) || n < 1 || n > g.max)
      || new Set(numbers).size !== numbers.length) {
    return json({ error: "grille invalide" }, 400);
  }

  const draws = await loadDraws(game);
  if (!draws) return json({ error: "Données de tirages indisponibles côté serveur." }, 503);
  console.log(`[grid-analysis] ${game} · ${numbers.length} n° · ${draws.length} tirages · modèle ${MODEL}`);

  const facts = computeFacts(numbers, game, draws);

  // Limite d'usage : 40 analyses par mois et par compte
  const quotaKey = `${payload.email}:${new Date().toISOString().slice(0, 7)}`;
  const quotas = getStore("ai-quota");
  const used = (await quotas.get(quotaKey, { type: "json" }))?.n || 0;
  if (used >= 40) return json({ error: "Limite de 40 analyses ce mois-ci atteinte." }, 429);

  let text;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM,
        messages: [{
          role: "user",
          content: `Profil demandé : ${PROFILE_LABEL[profile] || profile || "non précisé"}\n\nDonnées calculées :\n${JSON.stringify(facts, null, 2)}`,
        }],
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error(`[grid-analysis] API ${resp.status} — ${detail.slice(0, 400)}`);
      const hint =
        resp.status === 401 ? "clé API refusée"
        : resp.status === 404 ? `modèle « ${MODEL} » introuvable`
        : resp.status === 400 ? "requête rejetée par l'API"
        : resp.status === 429 ? "quota API dépassé"
        : `erreur ${resp.status}`;
      return json({ error: `L'analyse a échoué : ${hint}.` }, 502);
    }
    const data = await resp.json();
    text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
    if (!text) {
      console.error("[grid-analysis] réponse sans texte :", JSON.stringify(data).slice(0, 400));
      return json({ error: "L'analyse est revenue vide. Réessaie dans un instant." }, 502);
    }
  } catch (e) {
    console.error("[grid-analysis] exception :", e && e.message, e && e.stack);
    return json({ error: `L'analyse n'a pas pu être générée (${e && e.message ? e.message : "erreur réseau"}).` }, 502);
  }

  await quotas.setJSON(quotaKey, { n: used + 1 });
  return json({ analysis: text, remaining: 40 - used - 1 });
};

export const config = { path: "/api/grid-analysis" };
