// POST /api/admin-codes (Bearer d'un compte admin) -> { code }
// Génère un nouveau code premium (usage unique, 30 jours) à distribuer
// manuellement (email, message...) après un paiement PayPal reçu à la main.
// Réservé aux emails listés dans ADMIN_EMAILS (voir _lib.mjs).
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { verifyToken, bearerFrom, json, isAdmin } from "./_lib.mjs";

const codes = () => getStore("codes");

function genCode() {
  // Format lisible à recopier/dicter : STAT-XXXX-XXXX (sans 0/O/1/I ambigus)
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const part = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  return `STAT-${part()}-${part()}`;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "méthode" }, 405);
  const payload = verifyToken(bearerFrom(req));
  if (!payload?.email || !isAdmin(payload.email)) return json({ error: "non autorisé" }, 403);

  const store = codes();
  let code;
  do { code = genCode(); } while (await store.get(code, { type: "json" }));

  await store.setJSON(code, { createdAt: new Date().toISOString(), createdBy: payload.email, used: false });
  return json({ code });
};

export const config = { path: "/api/admin-codes" };
