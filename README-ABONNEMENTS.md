# Système d'abonnements — mise en route

Architecture : le paywall est appliqué **côté serveur**. Le site public ne
contient que les 30 derniers tirages ; l'historique complet vit dans
`data-private/` (jamais publié) et n'est servi que par `/api/premium-data`
aux comptes abonnés. Impossible à contourner depuis le navigateur.

## Découpage gratuit / premium

| Gratuit (SEO + habitude)            | Premium 39 €/an                        |
|-------------------------------------|----------------------------------------|
| Dernier tirage (rail de boules)     | Historique complet des 3 jeux          |
| Grille chaud/froid sur 30 tirages   | Fenêtres 50 / 100 / tout               |
| Chauds & retards (fenêtre 30)       | Z-scores, structure, paires, verdict   |
|                                     | Atelier des grilles & réducteurs       |

## Mise en route (~30 min, une fois)

1. **Stripe** (stripe.com, gratuit) : crée un produit « Statirage Premium »
   avec un prix récurrent annuel de 39 €. Note l'ID du prix (`price_...`).
2. **Clés & webhook Stripe** : Développeurs → Clés API → note `sk_live_...`
   (ou `sk_test_...` pour tester). Puis Développeurs → Webhooks →
   « Ajouter un endpoint » : URL `https://TON-SITE.netlify.app/api/stripe-webhook`,
   événements `checkout.session.completed` et `customer.subscription.deleted`.
   Note le secret `whsec_...`.
3. **Variables d'environnement Netlify** (Site configuration → Environment
   variables) :
   - `AUTH_SECRET` : une longue chaîne aléatoire (40+ caractères, garde-la secrète)
   - `STRIPE_SECRET_KEY` : la clé `sk_...`
   - `STRIPE_PRICE_ID` : l'ID `price_...`
   - `STRIPE_WEBHOOK_SECRET` : le secret `whsec_...`
4. **Pousse tout le dossier sur GitHub** (y compris `netlify.toml`,
   `package.json`, `netlify/functions/`). Netlify installe les dépendances
   et déploie les fonctions automatiquement.
5. **Relance le workflow** GitHub Actions une fois : il génère maintenant
   les JSON publics tronqués ET les historiques complets privés.
6. **Teste le parcours** : crée un compte sur ton site → clique S'abonner →
   paie avec la carte de test Stripe `4242 4242 4242 4242` (en mode test) →
   retour sur le site → l'historique complet se débloque.

## Points de vigilance

- En mode test Stripe, personne ne paie réellement : bascule les clés en
  `live` quand tout est validé.
- CGV, mentions légales et politique de confidentialité sont obligatoires
  avant d'encaisser de vrais paiements (une page statique suffit pour
  démarrer — à ajouter).
- La résiliation : active le Customer Portal dans Stripe (Settings →
  Billing → Customer portal) pour offrir la résiliation en un clic.
