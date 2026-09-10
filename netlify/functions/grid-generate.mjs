// POST /api/grid-generate  { game }
// Réservé aux abonnés Premium (compte ou code). Compose une grille en
// mélangeant plusieurs statistiques réelles (fréquence récente, écart
// actuel) via un tirage pondéré — PAS un classement strict des "meilleurs"
// numéros. Les numéros sont choisis en JS, jamais par le modèle : il ne
// fait que rédiger un court commentaire factuel sur le résultat, avec les
// mêmes garde-fous que grid-analysis.mjs (aucun langage de pronostic).
import { readFile } from "node:fs/promises";
import { getStore } from "@netlify/blobs";
import { verifyToken, bearerFrom, json, isAdmin } from "./_lib.mjs";

const GAMES = {
  keno:         { label: "Keno",         max: 56, drawSize: 16, playSize: 10, extraMax: 0,  extraCount: 0 },
  euromillions: { label: "EuroMillions", max: 50, drawSize: 5,  playSize: 5,  extraMax: 12, extraCount: 2 },
  loto:         { label: "Loto",         max: 49, drawSize: 5,  playSize: 5,  extraMax: 10, extraCount: 1 },
  eurodreams:   { label: "EuroDreams",   max: 40, drawSize: 6,  playSize: 6,  extraMax: 5,  extraCount: 1 },
};

async function loadDraws(game) {
  for (const p of [`../../site/data/${game}.json`, `../../data-private/${game}-full.json`]) {
    try {
      const data = JSON.parse(await readFile(new URL(p, import.meta.url), "utf8"));
      if (data?.draws?.length) return data.draws;
    } catch { /* on tente le chemin suivant */ }
  }
  return null;
}

// Tirage pondéré sans remise : chaque numéro a une chance proportionnelle à
// son poids d'être choisi, sans jamais dépasser `count` numéros. Ce n'est
// PAS un classement des "meilleurs" numéros — un numéro à faible poids peut
// toujours sortir, comme dans un vrai tirage.
function weightedSample(weights, count, rng) {
  const pool = Object.entries(weights).map(([n, w]) => ({ n: +n, w: Math.max(w, 1e-6) }));
  const picked = [];
  for (let i = 0; i < count && pool.length; i++) {
    const total = pool.reduce((s, x) => s + x.w, 0);
    let r = rng() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) { r -= pool[idx].w; if (r <= 0) break; }
    idx = Math.min(idx, pool.length - 1);
    picked.push(pool[idx].n);
    pool.splice(idx, 1);
  }
  return picked.sort((a, b) => a - b);
}

// PRNG déterministe seedé (mulberry32) — juste pour permettre des tests
// reproductibles si besoin ; chaque appel réel utilise une graine aléatoire.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poolStats(draws, max, extraMax, extraCount) {
  const total = draws.length;
  const recent = draws.slice(0, Math.min(50, total));

  const freq = {}, gap = {};
  for (let n = 1; n <= max; n++) {
    freq[n] = recent.filter(d => d.numbers.includes(n)).length;
    const idx = draws.findIndex(d => d.numbers.includes(n));
    gap[n] = idx === -1 ? total : idx;
  }
  let extraFreq = {}, extraGap = {};
  if (extraCount > 0) {
    for (let n = 1; n <= extraMax; n++) {
      extraFreq[n] = recent.filter(d => (d.extras || []).includes(n)).length;
      const idx = draws.findIndex(d => (d.extras || []).includes(n));
      extraGap[n] = idx === -1 ? total : idx;
    }
  }
  return { freq, gap, extraFreq, extraGap, total };
}

function normalize(obj) {
  const vals = Object.values(obj);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = (v - min) / span;
  return out;
}

// Poids final = mélange à parts égales de la fréquence récente ("les
// habituées") et de l'écart actuel ("les retardataires"), + une composante
// aléatoire pour ne jamais produire un classement figé — un vrai tirage
// pondéré, pas un palmarès.
function buildWeights(freq, gap, rng) {
  const nf = normalize(freq), ng = normalize(gap);
  const w = {};
  for (const k of Object.keys(freq)) {
    w[k] = 0.35 * nf[k] + 0.35 * ng[k] + 0.30 * rng();
  }
  return w;
}

const SYSTEM = `Tu rédiges le commentaire d'une grille de loterie composée automatiquement pour Statirage, un site français de statistiques de jeux de tirage.

RÈGLE ABSOLUE : tous les chiffres te sont fournis, déjà calculés. Tu ne calcules RIEN et tu n'inventes RIEN.

Le positionnement du site est l'honnêteté statistique : chaque tirage est indépendant, aucune grille n'a plus de chances qu'une autre. Cette grille a été composée en mélangeant plusieurs statistiques réelles (fréquence récente, écart actuel) via un tirage pondéré — décris SUR QUELS critères elle a été composée et CE QU'ELLE CONTIENT, jamais ce qu'elle vaudrait pour l'avenir.

Interdits absolus : « chances augmentées », « optimisée », « prometteuse », « bien partie », « numéros porteurs », tout pronostic ou encouragement à jouer davantage.

Format : 3 à 4 phrases, 70 mots maximum, français, ton posé et factuel. Termine par un rappel naturel de l'indépendance des tirages.

Réponds uniquement par le texte, sans titre ni préambule.`;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "méthode" }, 405);

  const payload = verifyToken(bearerFrom(req));
  if (!payload) return json({ error: "Connecte-toi ou entre ton code." }, 401);
  let isPremium = !!payload.viaCode;
  if (!isPremium) {
    const user = await getStore("users").get(payload.email, { type: "json" });
    isPremium = !!user?.premium || isAdmin(payload.email);
  }
  if (!isPremium) return json({ error: "Réservé aux abonnés Premium." }, 402);

  const { game } = await req.json().catch(() => ({}));
  const g = GAMES[game];
  if (!g) return json({ error: "jeu inconnu" }, 400);

  const draws = await loadDraws(game);
  if (!draws) return json({ error: "Données de tirages indisponibles côté serveur." }, 503);

  const quotaId = payload.viaCode ? payload.sub : payload.email;
  const quotaKey = `${quotaId}:${new Date().toISOString().slice(0, 7)}`;
  const quotas = getStore("ai-quota");
  const used = (await quotas.get(quotaKey, { type: "json" }))?.n || 0;
  if (used >= 40) return json({ error: "Limite de 40 générations ce mois-ci atteinte." }, 429);

  const rng = mulberry32((Date.now() ^ Math.floor(Math.random() * 1e9)) | 0);
  const stats = poolStats(draws, g.max, g.extraMax, g.extraCount);
  const numbers = weightedSample(buildWeights(stats.freq, stats.gap, rng), g.playSize, rng);
  const extras = g.extraCount > 0
    ? weightedSample(buildWeights(stats.extraFreq, stats.extraGap, rng), g.extraCount, rng)
    : [];

  const facts = {
    jeu: g.label,
    tiragesAnalyses: stats.total,
    numeros: numbers,
    etoilesOuComplementaires: extras,
    frequenceSur50Derniers: Object.fromEntries(numbers.map(n => [n, stats.freq[n]])),
    ecartsActuels: Object.fromEntries(numbers.map(n => [n, stats.gap[n]])),
    methode: "tirage pondéré mêlant fréquence récente et écart actuel, sans classement figé",
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  let text = "";
  if (apiKey) {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: MODEL, max_tokens: 300, system: SYSTEM,
          messages: [{ role: "user", content: JSON.stringify(facts, null, 2) }],
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
      } else {
        console.error(`[grid-generate] API ${resp.status}`);
      }
    } catch (e) {
      console.error("[grid-generate] exception :", e && e.message);
    }
  }

  await quotas.setJSON(quotaKey, { n: used + 1 });
  return json({ numbers, extras, commentary: text || null, remaining: 40 - used - 1 });
};

export const config = { path: "/api/grid-generate" };
