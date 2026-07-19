// POST /api/stripe-webhook : Stripe nous notifie les paiements/résiliations.
// Vérification de signature OBLIGATOIRE — c'est elle qui garantit que la
// requête vient bien de Stripe et pas d'un petit malin.
import Stripe from "stripe";
import { getStore } from "@netlify/blobs";
import { json } from "./_lib.mjs";

export default async (req) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers.get("stripe-signature");
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      await req.text(), sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch {
    return json({ error: "signature invalide" }, 400);
  }

  const users = getStore("users");
  const setPremium = async (email, value) => {
    if (!email) return;
    const user = await users.get(email, { type: "json" });
    if (user) await users.setJSON(email, { ...user, premium: value });
  };

  switch (event.type) {
    case "checkout.session.completed":
      await setPremium(event.data.object.metadata?.email
        || event.data.object.customer_email, true);
      break;
    case "customer.subscription.deleted":
      await setPremium(event.data.object.metadata?.email, false);
      break;
  }
  return json({ received: true });
};

export const config = { path: "/api/stripe-webhook" };
