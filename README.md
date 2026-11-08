# Restora server

## Local setup

1. Use Node.js 20.9 or newer (Node.js 24 LTS is recommended), MongoDB 5.0 or newer, and npm.
2. Copy `.env.example` to `.env`.
3. Set `MONGODB_URI` to a MongoDB cluster you control, keep `MONGODB_DATABASE=restora`, and set a newly generated `BETTER_AUTH_SECRET` with at least 32 characters. Do not use credentials that have been pasted into chat or committed. Generate a local secret with `node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64url'))"`.
4. Keep `CLIENT_ORIGIN=http://localhost:3000` and `BETTER_AUTH_URL=http://localhost:5000` for the local client/server setup.
5. To enable Stripe Test Mode, set `STRIPE_SECRET_KEY` in `.env` to a test secret key. Run `stripe listen --forward-to localhost:5000/api/v1/payments/webhook`, copy the signing secret printed by the CLI into `STRIPE_WEBHOOK_SECRET`, and restart the API. Both Stripe variables must be set together. Never put either value in the client or commit `.env`.
6. Run `npm install`, then `npm run dev`.

The server connects to MongoDB before listening. `GET /health` checks process availability; `GET /api/v1/health` checks API routing. Better Auth is mounted at `/api/auth/*splat` before JSON body parsing, as required by Express 5.

Payment startup creates a named partial unique index to prevent concurrent pending payments for the same order. MongoDB 5.0 or newer allows it to coexist with older indexes on `payments.orderId`.

Stripe Checkout uses the server-calculated order total in USD cents. Stripe webhook signatures are verified against the raw request body; payment and order payment status changes are applied from verified events. A full refund is available to cashiers, managers, and admins.

For an end-to-end Test Mode check, start the API and Stripe CLI listener, sign in as a customer, create an order, and choose **Pay with Stripe**. Use Stripe's test card `4242 4242 4242 4242`, any future expiration date, and any CVC. Confirm payment history and the order's payment status after the webhook arrives. A real Stripe Dashboard/CLI run requires your own rotated test keys; automated tests use Stripe doubles and do not perform live charges.

## Current foundation

- Better Auth email/password authentication and MongoDB-backed sessions.
- The default role is `customer`; signup cannot set or override a role.
- The native MongoDB client is shared with the Better Auth adapter. Mongoose uses the same configured database URI for application models.
- Helmet, a credentialed single-origin CORS policy, auth route rate limiting, Zod request validation middleware, session/role middleware, and common API errors are available.
- Application feature routes and Mongoose models are added incrementally with their roadmap tasks.
