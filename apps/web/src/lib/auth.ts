import 'server-only';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { getDb, schema } from '@rawedit/db';
import { newId } from '@rawedit/core';
import { appUrl } from './container.js';

/**
 * Better Auth over the same Drizzle schema the rest of the app uses, so `user.id` is
 * a real foreign key everywhere rather than a string copied between systems.
 */
export const auth = betterAuth({
  database: drizzleAdapter(getDb(), {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  baseURL: appUrl(),
  secret: process.env['BETTER_AUTH_SECRET'],

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    // Email delivery is not part of v1; verification is opt-in via the env var so a
    // self-hosted deployment can turn it on once it has an email provider.
    requireEmailVerification: process.env['REQUIRE_EMAIL_VERIFICATION'] === '1',
  },

  socialProviders: {
    ...(process.env['GOOGLE_CLIENT_ID'] && process.env['GOOGLE_CLIENT_SECRET']
      ? {
          google: {
            clientId: process.env['GOOGLE_CLIENT_ID'],
            clientSecret: process.env['GOOGLE_CLIENT_SECRET'],
            // Drive import reuses this grant when the user connects their account.
            scope: ['https://www.googleapis.com/auth/drive.readonly'],
            accessType: 'offline',
          },
        }
      : {}),
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },

  advanced: {
    database: {
      generateId: () => newId('usr'),
    },
  },

  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
