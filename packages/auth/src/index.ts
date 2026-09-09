import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { nextCookies } from "better-auth/next-js";
import { loadConfig } from "@raw-edit/config";
import { getDb, subscriptions, userProfiles } from "@raw-edit/db";

function buildAuth() {
  const config = loadConfig();
  const db = getDb(config.databaseUrl);
  return betterAuth({
    baseURL: config.betterAuthUrl,
    secret: config.betterAuthSecret || "build-time-placeholder-not-for-runtime-use",
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: { enabled: true },
    socialProviders:
      config.googleClientId && config.googleClientSecret
        ? {
            google: {
              clientId: config.googleClientId,
              clientSecret: config.googleClientSecret,
            },
          }
        : undefined,
    databaseHooks: {
      user: {
        create: {
          after: async (created) => {
            const database = getDb();
            await database.insert(userProfiles).values({ userId: created.id });
            await database.insert(subscriptions).values({ userId: created.id, plan: "free" });
          },
        },
      },
    },
    plugins: [nextCookies()],
  });
}

type AuthInstance = ReturnType<typeof buildAuth>;
let cached: AuthInstance | undefined;

export function createAuth(): AuthInstance {
  cached ??= buildAuth();
  return cached;
}
