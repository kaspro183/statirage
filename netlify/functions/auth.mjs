// POST /api/auth  { action: "signup"|"login", email, password }
// GET  /api/auth  (Authorization: Bearer <token>) -> profil { email, premium }
import { getStore } from "@netlify/blobs";
import {
  hashPassword, verifyPassword, signToken, verifyToken,
  bearerFrom, json, normEmail, validEmail,
} from "./_lib.mjs";

const users = () => getStore("users");

export default async (req) => {
  if (req.method === "GET") {
    const payload = verifyToken(bearerFrom(req));
    if (!payload) return json({ error: "non connecté" }, 401);
    const user = await users().get(payload.email, { type: "json" });
    if (!user) return json({ error: "compte introuvable" }, 401);
    return json({ email: payload.email, premium: !!user.premium });
  }
  if (req.method !== "POST") return json({ error: "méthode" }, 405);

  const { action, email: rawEmail, password } = await req.json().catch(() => ({}));
  const email = normEmail(rawEmail);
  if (!validEmail(email)) return json({ error: "Adresse email invalide." }, 400);
  if (!password || password.length < 8)
    return json({ error: "Mot de passe : 8 caractères minimum." }, 400);

  const store = users();
  const existing = await store.get(email, { type: "json" });

  if (action === "signup") {
    if (existing) return json({ error: "Un compte existe déjà avec cet email." }, 409);
    await store.setJSON(email, {
      password: hashPassword(password),
      premium: false,
      createdAt: new Date().toISOString(),
    });
    return json({ token: signToken({ email }), email, premium: false });
  }

  if (action === "login") {
    if (!existing || !verifyPassword(password, existing.password))
      return json({ error: "Email ou mot de passe incorrect." }, 401);
    return json({ token: signToken({ email }), email, premium: !!existing.premium });
  }

  return json({ error: "action inconnue" }, 400);
};

export const config = { path: "/api/auth" };
