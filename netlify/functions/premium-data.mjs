// GET /api/premium-data?game=keno (Bearer, premium requis)
// Sert l'historique COMPLET depuis data-private/ — jamais exposé en statique.
import { readFile } from "node:fs/promises";
import { getStore } from "@netlify/blobs";
import { verifyToken, bearerFrom, json, isAdmin } from "./_lib.mjs";

const GAMES = new Set(["keno", "euromillions", "loto"]);

export default async (req) => {
  const payload = verifyToken(bearerFrom(req));
  if (!payload) return json({ error: "Connecte-toi d'abord." }, 401);
  const user = await getStore("users").get(payload.email, { type: "json" });
  if (!user?.premium && !isAdmin(payload.email)) return json({ error: "Réservé aux abonnés Premium." }, 402);

  const game = new URL(req.url).searchParams.get("game");
  if (!GAMES.has(game)) return json({ error: "jeu inconnu" }, 400);
  try {
    const raw = await readFile(new URL(`../../data-private/${game}-full.json`, import.meta.url), "utf8");
    return new Response(raw, { headers: { "content-type": "application/json" } });
  } catch {
    return json({ error: "données indisponibles (workflow pas encore passé ?)" }, 503);
  }
};

export const config = { path: "/api/premium-data" };
