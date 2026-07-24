// GET /api/draw-analysis?game=keno
// Analyse rédigée du DERNIER tirage. Public (contenu éditorial + SEO).
// Un seul appel au modèle par tirage : le résultat est mis en cache dans un blob,
// clé = jeu + date du tirage. Tous les visiteurs suivants lisent le cache.
import { readFile } from "node:fs/promises";
import { getStore } from "@netlify/blobs";
import { json } from "./_lib.mjs";

const GAMES = {
  keno:         { label: "Keno",         max: 56, drawSize: 16 },
  euromillions: { label: "EuroMillions", max: 50, drawSize: 5  },
  loto:         { label: "Loto",         max: 49, drawSize: 5  },
  eurodreams:   { label: "EuroDreams",   max: 40, drawSize: 6  },
};

async function loadDraws(game) {
  const tried = [];
  for (const p of [`../../site/data/${game}.json`, `../../data-private/${game}-full.json`]) {
    try {
      const raw = await readFile(new URL(p, import.meta.url), "utf8");
      const data = JSON.parse(raw);
      if (data?.draws?.length) return data.draws;
      tried.push(`${p} (vide)`);
    } catch (e) { tried.push(`${p} (${e.code || e.message})`); }
  }
  console.error("[draw-analysis] données introuvables :", tried.join(" · "));
  return null;
}

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const frDate = iso => {
  const [y, m, d] = iso.split("-");
  return `${+d} ${MOIS[+m - 1]} ${y}`;
};

/* Tous les chiffres sont calculés ici. Le modèle ne fait que les mettre en mots. */
function drawFacts(game, draws) {
  const g = GAMES[game];
  const d = draws[0];
  const nums = [...d.numbers].sort((a, b) => a - b);
  const k = nums.length;
  const total = draws.length;

  // Suites consécutives
  const runs = [];
  let run = [nums[0]];
  for (let i = 1; i < k; i++) {
    if (nums[i] === nums[i - 1] + 1) run.push(nums[i]);
    else { if (run.length > 1) runs.push(run); run = [nums[i]]; }
  }
  if (run.length > 1) runs.push(run);

  // Somme et rang percentile
  const sum = nums.reduce((a, b) => a + b, 0);
  const allSums = draws.map(x => x.numbers.reduce((a, b) => a + b, 0));
  const avgSum = allSums.reduce((a, b) => a + b, 0) / total;
  const sumPct = Math.round(allSums.filter(s => s <= sum).length / total * 100);

  // Équilibres
  const evens = nums.filter(n => n % 2 === 0).length;
  const lows = nums.filter(n => n <= g.max / 2).length;

  // Répartition par dizaine
  const decades = {};
  for (let i = 0; i < Math.ceil(g.max / 10); i++) {
    const lo = i * 10 + 1, hi = Math.min((i + 1) * 10, g.max);
    decades[`${lo}-${hi}`] = nums.filter(n => n >= lo && n <= hi).length;
  }

  // Écarts : depuis combien de tirages chaque numéro sorti était-il absent ?
  const gaps = {};
  for (const n of nums) {
    let g2 = 0;
    for (let i = 1; i < draws.length; i++) {
      if (draws[i].numbers.includes(n)) break;
      g2++;
    }
    gaps[n] = g2;
  }
  const expGap = g.max / g.drawSize;
  const retards = Object.entries(gaps)
    .filter(([, v]) => v >= 2 * expGap)
    .sort((a, b) => b[1] - a[1])
    .map(([n, v]) => ({ numero: +n, absentDepuis: v }));

  // Numéros revenus depuis les tirages précédents
  const repeats = [];
  for (let lag = 1; lag <= 2 && lag < draws.length; lag++) {
    const prev = draws[lag].numbers;
    repeats.push({ lag, communs: nums.filter(n => prev.includes(n)) });
  }
  const repeatExpected = +(k * g.drawSize / g.max).toFixed(1);

  // Tirages les plus ressemblants
  const similar = draws.slice(1)
    .map(x => ({ date: x.date, communs: x.numbers.filter(n => nums.includes(n)).length }))
    .sort((a, b) => b.communs - a.communs)
    .slice(0, 2);

  return {
    jeu: g.label,
    date: d.date,
    dateFr: frDate(d.date),
    numeros: nums,
    multiplicateur: d.mult || null,
    complementaires: d.extras && d.extras.length ? d.extras : null,
    tiragesAnalyses: total,
    somme: sum,
    sommeMoyenneHistorique: +avgSum.toFixed(1),
    sommePercentile: sumPct,
    pairs: evens,
    impairs: k - evens,
    moitieBasse: lows,
    moitieHaute: k - lows,
    suitesConsecutives: runs.map(r => r.join("-")),
    repartitionParDizaine: decades,
    repartitionAttendueParDizaine: +(k * 10 / g.max).toFixed(1),
    numerosEnRetardQuiSortent: retards,
    ecartTheoriqueMoyen: +expGap.toFixed(1),
    numerosRevenus: repeats,
    numerosRevenusAttendus: repeatExpected,
    tiragesLesPlusRessemblants: similar,
    probaParNumero: `${g.drawSize} sur ${g.max}`,
  };
}

const SYSTEM = `Tu rédiges le commentaire quotidien du tirage pour Statirage, un site français de statistiques de jeux de tirage.

RÈGLE ABSOLUE : tous les chiffres te sont fournis, déjà calculés. Tu ne calcules RIEN et tu n'inventes RIEN. Si une donnée n'est pas dans le JSON, tu n'en parles pas.

Le site est bâti sur l'honnêteté statistique : les tirages sont indépendants, aucun numéro n'est « dû », un retard n'est pas une dette que le hasard rembourserait. Tu décris ce qui VIENT DE SE PASSER — jamais ce qui va se passer.

Interdits absolus : tout pronostic, toute suggestion de jeu, « numéros à surveiller », « en forme », « chaud », « annoncé », « prometteur », « il faudra suivre ». Aucune recommandation, même implicite.

Choisis les 2 ou 3 faits les plus remarquables du tirage (une longue suite, une somme atypique, un numéro longtemps absent qui ressort, un nombre inhabituel de répétitions) et raconte-les avec leurs chiffres. Compare toujours à la référence fournie : une valeur seule ne dit rien.

Format : 4 à 5 phrases, 110 mots maximum, en français, ton d'un chroniqueur statisticien — précis, vivant, jamais vendeur. Termine par une remise en perspective sur l'indépendance des tirages, formulée naturellement et sans lourdeur, en variant la formule d'un jour à l'autre.

Réponds uniquement par le texte, sans titre ni préambule.`;

export default async (req) => {
  const url = new URL(req.url);
  const game = url.searchParams.get("game") || "keno";
  const g = GAMES[game];
  if (!g) return json({ error: "jeu inconnu" }, 400);

  const draws = await loadDraws(game);
  if (!draws) return json({ error: "Données de tirages indisponibles." }, 503);

  const facts = drawFacts(game, draws);
  const cacheKey = `${game}:${facts.date}`;
  const store = getStore("draw-analysis");

  // 1. Le tirage a-t-il déjà été commenté ?
  try {
    const hit = await store.get(cacheKey, { type: "json" });
    if (hit?.analysis) {
      return json({ analysis: hit.analysis, date: facts.date, cached: true });
    }
  } catch { /* pas de cache : on génère */ }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: "Analyse indisponible (clé API non configurée)." }, 503);
  const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

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
        max_tokens: 500,
        system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(facts, null, 2) }],
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error(`[draw-analysis] API ${resp.status} — ${detail.slice(0, 400)}`);
      const hint = resp.status === 401 ? "clé API refusée"
        : resp.status === 404 ? `modèle « ${MODEL} » introuvable`
        : resp.status === 429 ? "quota API dépassé"
        : `erreur ${resp.status}`;
      return json({ error: `L'analyse a échoué : ${hint}.` }, 502);
    }
    const data = await resp.json();
    text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
    if (!text) {
      console.error("[draw-analysis] réponse vide :", JSON.stringify(data).slice(0, 300));
      return json({ error: "L'analyse est revenue vide." }, 502);
    }
  } catch (e) {
    console.error("[draw-analysis] exception :", e && e.message);
    return json({ error: `L'analyse n'a pas pu être générée (${e && e.message ? e.message : "erreur réseau"}).` }, 502);
  }

  // 2. On mémorise pour tous les visiteurs suivants
  try {
    await store.setJSON(cacheKey, { analysis: text, date: facts.date, at: new Date().toISOString() });
  } catch (e) {
    console.error("[draw-analysis] cache non écrit :", e && e.message);
  }
  console.log(`[draw-analysis] généré ${game} ${facts.date} · ${text.length} car.`);
  return json({ analysis: text, date: facts.date, cached: false });
};

export const config = { path: "/api/draw-analysis" };
