import { headers } from "next/headers";
import { createAuth } from "@raw-edit/auth";
import { AppError } from "@raw-edit/contracts";

export async function getSession() {
  if (!process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET) {
    return null;
  }
  const auth = createAuth();
  return auth.api.getSession({
    headers: await headers(),
  });
}

export async function requireUser() {
  const session = await getSession();
  if (!session?.user) {
    throw new AppError("UNAUTHORIZED", "Sign in required", 401);
  }
  return session.user;
}
