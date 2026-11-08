import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { betterAuth } from "better-auth";

export function createAuth({ database, mongoClient, config }) {
  const secureCookies = config.NODE_ENV === "production";

  return betterAuth({
    appName: "Restora",
    baseURL: config.betterAuthUrl,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.clientOrigin],
    database: mongodbAdapter(database, { client: mongoClient }),
    emailAndPassword: {
      enabled: true,
    },
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "customer",
          input: false,
        },
      },
    },
    advanced: {
      useSecureCookies: secureCookies,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: secureCookies,
      },
    },
  });
}
