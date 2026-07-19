// POST /api/checkout (Bearer) -> { url } : session Stripe Checkout (abonnement)
import Stripe from "stripe";
import { verifyToken, bearerFrom, json } from "./_lib.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "méthode" }, 405);
  const payload = verifyToken(bearerFrom(req));
  if (!payload) return json({ error: "Connecte-toi d'abord." }, 401);

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const origin = new URL(req.url).origin;
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    customer_email: payload.email,
    metadata: { email: payload.email },
    subscription_data: { metadata: { email: payload.email } },
    allow_promotion_codes: true,
    success_url: `${origin}/?abonnement=merci`,
    cancel_url: `${origin}/?abonnement=annule`,
  });
  return json({ url: session.url });
};

export const config = { path: "/api/checkout" };
