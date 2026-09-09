// POST /api/redeem-code { code } -> { token }
// Un code = un accès Premium de 30 jours, à usage unique, sans compte requis.
// Le token émis est un JWT standard (même mécanisme que /api/auth), avec
// premium: true et viaCode: true — /api/auth le reconnaît et le laisse
// passer sans chercher d'utilisateur associé (voir auth.mjs).
import { getStore } from "@netlify/blobs";
import { signToken, json } from "./_lib.mjs";

const CODE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 jours
const codes = () => getStore("codes");

const normCode = (c) => String(c || "").trim().toUpperCase().replace(/\s+/g, "");

export default async (req) => {
  if (req.method !== "POST") return json({ error: "méthode" }, 405);

  const { code: rawCode } = await req.json().catch(() => ({}));
  const code = normCode(rawCode);
  if (!code) return json({ error: "Code manquant." }, 400);

  const store = codes();
  const entry = await store.get(code, { type: "json" });

  if (!entry) return json({ error: "Code invalide." }, 404);
  if (entry.used) return json({ error: "Ce code a déjà été utilisé." }, 409);

  await store.setJSON(code, { ...entry, used: true, usedAt: new Date().toISOString() });

  const token = signToken({ premium: true, viaCode: true }, CODE_TTL_SECONDS);
  return json({ token, expiresInDays: 30 });
};

export const config = { path: "/api/redeem-code" };
