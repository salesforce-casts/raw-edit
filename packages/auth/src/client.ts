import { createAuthClient } from "better-auth/react";

export function createBrowserAuthClient(baseURL?: string) {
  return createAuthClient({
    baseURL,
  });
}
