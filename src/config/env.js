import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  CLIENT_ORIGIN: z.string().url(),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  MONGODB_DATABASE: z.string().min(1).default("restora"),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url(),
  IMGBB_API_KEY: z.string().trim().optional(),
  STRIPE_SECRET_KEY: z.string().trim().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().trim().optional(),
  ORDER_TAX_RATE_BASIS_POINTS: z.coerce.number().int().min(0).max(10000).default(500),
  ORDER_TAX_ROUNDING_POLICY: z.enum(["half_up"]).default("half_up"),
});

export function readEnv(source = process.env) {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid server configuration: ${details}`);
  }

  const stripeSecretKey = parsed.data.STRIPE_SECRET_KEY ?? "";
  const stripeWebhookSecret = parsed.data.STRIPE_WEBHOOK_SECRET ?? "";
  if (Boolean(stripeSecretKey) !== Boolean(stripeWebhookSecret)) {
    throw new Error("Invalid server configuration: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set together");
  }
  if (stripeSecretKey && !stripeSecretKey.startsWith("sk_test_")) {
    throw new Error("Invalid server configuration: STRIPE_SECRET_KEY must be a Stripe test-mode key");
  }
  if (stripeWebhookSecret && !stripeWebhookSecret.startsWith("whsec_")) {
    throw new Error("Invalid server configuration: STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret");
  }

  const { CLIENT_ORIGIN, BETTER_AUTH_URL, ...config } = parsed.data;
  const clientOrigin = new URL(CLIENT_ORIGIN);
  const authUrl = new URL(BETTER_AUTH_URL);

  if (!["http:", "https:"].includes(clientOrigin.protocol)) {
    throw new Error("Invalid server configuration: CLIENT_ORIGIN must use HTTP or HTTPS");
  }
  if (!["http:", "https:"].includes(authUrl.protocol)) {
    throw new Error("Invalid server configuration: BETTER_AUTH_URL must use HTTP or HTTPS");
  }
  if (clientOrigin.origin !== CLIENT_ORIGIN) {
    throw new Error("Invalid server configuration: CLIENT_ORIGIN must be an origin without a path");
  }
  if (authUrl.pathname !== "/" || authUrl.search || authUrl.hash) {
    throw new Error("Invalid server configuration: BETTER_AUTH_URL must be a base origin without a path");
  }

  return {
    ...config,
    IMGBB_API_KEY: config.IMGBB_API_KEY ?? "",
    STRIPE_SECRET_KEY: stripeSecretKey,
    STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
    clientOrigin: clientOrigin.origin,
    betterAuthUrl: authUrl.origin,
  };
}
