import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, createAccessControl } from "better-auth/plugins";

export const AUTH_ROLES = Object.freeze([
  "admin",
  "manager",
  "waiter",
  "chef",
  "cashier",
  "customer",
]);

const staffAccessControl = createAccessControl({
  user: ["get", "list", "set-role"],
});
const noUserManagement = staffAccessControl.newRole({ user: [] });
const authRoles = Object.fromEntries(
  AUTH_ROLES.map((role) => [
    role,
    role === "admin"
      ? staffAccessControl.newRole({ user: ["get", "list", "set-role"] })
      : noUserManagement,
  ]),
);

export function rejectClientRoleInput({ path, body }) {
  if (
    ["/sign-up/email", "/update-user"].includes(path) &&
    body &&
    typeof body === "object" &&
    (
      Object.hasOwn(body, "role") ||
      (body.data && typeof body.data === "object" && Object.hasOwn(body.data, "role"))
    )
  ) {
    throw APIError.from("BAD_REQUEST", {
      code: "ROLE_ASSIGNMENT_FORBIDDEN",
      message: "Roles can only be assigned by an administrator",
    });
  }
}

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
    plugins: [
      admin({
        defaultRole: "customer",
        adminRoles: ["admin"],
        roles: authRoles,
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (context) => {
        rejectClientRoleInput(context);
      }),
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
