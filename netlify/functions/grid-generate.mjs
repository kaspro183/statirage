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

export default async (req) => {
  if (req.method !== "POST") return json({ error: "méthode" }, 405);

  const payload = verifyToken(bearerFrom(req));
  if (!payload) return json({ error: "Connecte-toi ou entre ton code." }, 401);

  const admin = !payload.viaCode && isAdmin(payload.email);
  let isPremium = !!payload.viaCode || admin;
  if (!isPremium) {
    const user = await getStore("users").get(payload.email, { type: "json" });
    isPremium = !!user?.premium;
  }
  if (!isPremium) return json({ error: "Réservé aux abonnés Premium." }, 402);

  const { game } = await req.json().catch(() => ({}));
  const g = GAMES[game];
  if (!g) return json({ error: "jeu inconnu" }, 400);

  const draws = await loadDraws(game);
  if (!draws) return json({ error: "Données de tirages indisponibles côté serveur." }, 503);

  // L'admin n'est jamais limité par le quota mensuel — c'est justement le
  // compte utilisé pour tester la fonctionnalité, pas un client Premium.
  const quotas = getStore("ai-quota");
  let used = 0;
  let quotaKey = null;
  if (!admin) {
    const quotaId = payload.viaCode ? payload.sub : payload.email;
    quotaKey = `${quotaId}:${new Date().toISOString().slice(0, 7)}`;
    used = (await quotas.get(quotaKey, { type: "json" }))?.n || 0;
    if (used >= 40) return json({ error: "Limite de 40 générations ce mois-ci atteinte." }, 429);
  }

  const rng = mulberry32((Date.now() ^ Math.floor(Math.random() * 1e9)) | 0);
  const stats = poolStats(draws, g.max, g.extraMax, g.extraCount);
  const numbers = weightedSample(buildWeights(stats.freq, stats.gap, rng), g.playSize, rng);
  const extras = g.extraCount > 0
    ? weightedSample(buildWeights(stats.extraFreq, stats.extraGap, rng), g.extraCount, rng)
    : [];

  if (!admin) await quotas.setJSON(quotaKey, { n: used + 1 });
  return json({ numbers, extras, remaining: admin ? null : 40 - used - 1 });
};

export const config = { path: "/api/grid-generate" };
