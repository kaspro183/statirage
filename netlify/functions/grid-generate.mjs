// POST /api/grid-generate  { game, profile, size }
// Ouvert à tous. Compose une grille à partir des tirages passés, selon un
// profil choisi, puis vérifie qu'elle a la forme d'un tirage réaliste.
// Calcul 100 % JS, sans appel à une API externe. Aucun profil ne change
// les chances de gain : chaque tirage reste indépendant.
//
// Profils :
//   equilibre  — mélange léger fréquence récente / écart + forte part de hasard
//   chauds     — privilégie les numéros les plus sortis sur les 50 derniers tirages
//   retards    — privilégie les numéros absents depuis le plus longtemps
//   historique — fréquence sur tout l'historique + paires complices +
//                numéros ayant le plus souvent suivi le dernier tirage
import { readFile } from "node:fs/promises";
import { json } from "./_lib.mjs";

const GAMES = {
  keno:         { label: "Keno",         max: 56, drawSize: 16, playSize: 10, minSize: 4, maxSize: 10, extraMax: 0,  extraCount: 0 },
  euromillions: { label: "EuroMillions", max: 50, drawSize: 5,  playSize: 5,  extraMax: 12, extraCount: 2 },
  loto:         { label: "Loto",         max: 49, drawSize: 5,  playSize: 5,  extraMax: 10, extraCount: 1 },
  eurodreams:   { label: "EuroDreams",   max: 40, drawSize: 6,  playSize: 6,  extraMax: 5,  extraCount: 1 },
};

const PROFILES = {
  equilibre:  { label: "Équilibré",             recent: 0.25, gap: 0.25, all: 0,    follow: 0,    pair: 0,    rand: 0.50 },
  chauds:     { label: "Numéros chauds",        recent: 0.70, gap: 0,    all: 0,    follow: 0,    pair: 0,    rand: 0.30 },
  retards:    { label: "Retardataires",         recent: 0,    gap: 0.70, all: 0,    follow: 0,    pair: 0,    rand: 0.30 },
  historique: { label: "Tendances historiques", recent: 0,    gap: 0,    all: 0.45, follow: 0.25, pair: 0.35, rand: 0.30 },
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

// PRNG seedé (mulberry32) : une graine aléatoire par appel.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalize(arr) {
  // arr indexé 1..max (index 0 ignoré)
  const vals = arr.slice(1);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  return arr.map((v, i) => (i === 0 ? 0 : (v - min) / span));
}

// Statistiques sur l'historique pour une famille de numéros (principaux ou complémentaires).
function familyStats(draws, max, key, withPairs) {
  const total = draws.length;
  const pick = d => (key === "numbers" ? d.numbers : d.extras || []);
  const recent = draws.slice(0, Math.min(50, total));
  const recentFreq = new Array(max + 1).fill(0);
  const allFreq = new Array(max + 1).fill(0);
  const gap = new Array(max + 1).fill(total);
  recent.forEach(d => pick(d).forEach(n => { if (n <= max) recentFreq[n]++; }));
  draws.forEach((d, i) => pick(d).forEach(n => {
    if (n > max) return;
    allFreq[n]++;
    if (gap[n] === total) gap[n] = i;  // draws[0] = plus récent
  }));

  let pairs = null, follow = null;
  if (withPairs) {
    pairs = Array.from({ length: max + 1 }, () => new Array(max + 1).fill(0));
    draws.forEach(d => {
      const ns = pick(d).filter(n => n <= max);
      for (let a = 0; a < ns.length; a++)
        for (let b = a + 1; b < ns.length; b++) { pairs[ns[a]][ns[b]]++; pairs[ns[b]][ns[a]]++; }
    });
    // « Numéro suivant » : pour chaque numéro du dernier tirage, combien de fois
    // chaque numéro est sorti au tirage qui a suivi l'une de ses apparitions.
    follow = new Array(max + 1).fill(0);
    const last = new Set(pick(draws[0]));
    for (let i = draws.length - 1; i >= 1; i--) {
      const cur = pick(draws[i]), next = pick(draws[i - 1]);
      const hits = cur.filter(n => last.has(n)).length;
      if (hits) next.forEach(n => { if (n <= max) follow[n] += hits; });
    }
  }
  return { total, recentFreq, allFreq, gap, pairs, follow, recentCount: recent.length };
}

function baseWeights(st, max, prof, rng) {
  const nRecent = normalize(st.recentFreq);
  const nGap = normalize(st.gap);
  const nAll = normalize(st.allFreq);
  const nFollow = st.follow ? normalize(st.follow) : new Array(max + 1).fill(0);
  const w = new Array(max + 1).fill(0);
  for (let n = 1; n <= max; n++) {
    w[n] = prof.recent * nRecent[n] + prof.gap * nGap[n] + prof.all * nAll[n]
         + prof.follow * nFollow[n] + prof.rand * rng();
  }
  return w;
}

// Tirage pondéré sans remise. Pour le profil historique, le poids d'un
// candidat augmente avec le nombre de fois où il est sorti avec les numéros
// déjà choisis (paires complices).
function sample(base, max, count, rng, pairs, pairWeight) {
  const picked = [];
  const avail = new Set(Array.from({ length: max }, (_, i) => i + 1));
  let pairMax = 1;
  if (pairs && pairWeight) for (let a = 1; a <= max; a++) for (let b = 1; b <= max; b++) pairMax = Math.max(pairMax, pairs[a][b]);
  while (picked.length < count && avail.size) {
    const cand = [...avail];
    const ws = cand.map(n => {
      let w = Math.max(base[n], 1e-6);
      if (pairs && pairWeight && picked.length) {
        const p = picked.reduce((s, m) => s + pairs[n][m], 0) / (picked.length * pairMax);
        w += pairWeight * p;
      }
      return w;
    });
    const total = ws.reduce((a, b) => a + b, 0);
    let r = rng() * total, idx = 0;
    for (; idx < cand.length - 1; idx++) { r -= ws[idx]; if (r <= 0) break; }
    picked.push(cand[idx]);
    avail.delete(cand[idx]);
  }
  return picked.sort((a, b) => a - b);
}

// Une grille « réaliste » ressemble à un tirage typique : somme centrale,
// pairs/impairs et bas/hauts équilibrés, numéros étalés, peu de suites.
// Renvoie le nombre de critères non respectés (0 = grille réaliste).
function violations(nums, max) {
  const k = nums.length;
  let v = 0;
  const mean = k * (max + 1) / 2;
  const sd = Math.sqrt(k * (max + 1) * (max - k) / 12);
  const sum = nums.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - mean) > 1.3 * sd) v++;
  if (k >= 4) {
    const lo = Math.round(k * 0.2), hi = k - lo;
    const evens = nums.filter(n => n % 2 === 0).length;
    const lows = nums.filter(n => n <= max / 2).length;
    if (evens < lo || evens > hi) v++;
    if (lows < lo || lows > hi) v++;
  }
  let consec = 0, run = 1, longest = 1;
  for (let i = 1; i < k; i++) {
    if (nums[i] === nums[i - 1] + 1) { consec++; run++; longest = Math.max(longest, run); }
    else run = 1;
  }
  if (consec > (k >= 8 ? 2 : 1)) v++;
  if (longest >= 3) v++;   // pas de suite de 3 numéros (ex. 1-2-3)
  const perDecade = {};
  nums.forEach(n => { const d = Math.floor((n - 1) / 10); perDecade[d] = (perDecade[d] || 0) + 1; });
  if (Math.max(...Object.values(perDecade)) > Math.max(2, Math.ceil(k * 0.4))) v++;
  return v;
}

function realisticSample(base, max, count, rng, pairs, pairWeight) {
  let best = null, bestV = Infinity;
  for (let i = 0; i < 400; i++) {
    const g = sample(base, max, count, rng, pairs, pairWeight);
    const v = violations(g, max);
    if (v < bestV) { best = g; bestV = v; }
    if (v === 0) break;
  }
  return best;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "méthode" }, 405);

  const body = await req.json().catch(() => ({}));
  const g = GAMES[body.game];
  if (!g) return json({ error: "jeu inconnu" }, 400);
  const profileKey = PROFILES[body.profile] ? body.profile : "historique";
  const prof = PROFILES[profileKey];

  let size = g.playSize;
  if (g.minSize && Number.isInteger(body.size)) size = Math.min(g.maxSize, Math.max(g.minSize, body.size));

  const draws = await loadDraws(body.game);
  if (!draws) return json({ error: "Données de tirages indisponibles côté serveur." }, 503);

  const rng = mulberry32((Date.now() ^ Math.floor(Math.random() * 1e9)) | 0);

  const st = familyStats(draws, g.max, "numbers", true);
  const numbers = realisticSample(baseWeights(st, g.max, prof, rng), g.max, size, rng, st.pairs, prof.pair);

  let extras = [];
  if (g.extraCount > 0) {
    const ex = familyStats(draws, g.extraMax, "extras", false);
    extras = sample(baseWeights(ex, g.extraMax, prof, rng), g.extraMax, g.extraCount, rng, null, 0);
  }

  // Explication factuelle de chaque numéro, calculée sur les tirages passés.
  const details = numbers.map(n => {
    let partner = null;
    if (profileKey === "historique") {
      for (const m of numbers) {
        if (m === n) continue;
        const c = st.pairs[n][m];
        if (!partner || c > partner.count) partner = { n: m, count: c };
      }
    }
    return {
      n,
      recent: st.recentFreq[n],
      recentOf: st.recentCount,
      gap: st.gap[n],
      all: st.allFreq[n],
      allOf: st.total,
      partner,
    };
  });

  return json({ numbers, extras, size, profile: profileKey, profileLabel: prof.label, draws: st.total, details });
};

export const config = { path: "/api/grid-generate" };
