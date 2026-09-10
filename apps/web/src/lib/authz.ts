import 'server-only';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from './auth';

/**
 * Authorisation helpers.
 *
 * Every route handler starts with `requireUser`, and every query it then runs is
 * scoped by that user id (see `@rawedit/db/queries`). Ownership is a property of the
 * query rather than a check that a route could forget.
 */

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('You need to be signed in.');
    this.name = 'UnauthorizedError';
  }
}

export async function getUser(): Promise<AuthedUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  return { id: session.user.id, email: session.user.email, name: session.user.name };
}

export async function requireUser(): Promise<AuthedUser> {
  const user = await getUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

/** JSON error shapes, so the client can rely on one format everywhere. */
export function jsonError(message: string, status: number, code?: string): NextResponse {
  return NextResponse.json({ error: message, code }, { status });
}

export function unauthorized(): NextResponse {
  return jsonError('You need to be signed in.', 401, 'UNAUTHORIZED');
}

export function notFound(what = 'That'): NextResponse {
  // Deliberately identical to the "not yours" case: a request for someone else's
  // video must not be distinguishable from one for a video that does not exist.
  return jsonError(`${what} was not found.`, 404, 'NOT_FOUND');
}

/**
 * Wrap a route handler so thrown errors become a consistent JSON response rather
 * than a stack trace, and so unexpected failures are logged with context.
 */
export function route<T extends unknown[]>(
  handler: (...args: T) => Promise<NextResponse>,
): (...args: T) => Promise<NextResponse> {
  return async (...args: T) => {
    try {
      return await handler(...args);
    } catch (error: unknown) {
      if (error instanceof UnauthorizedError) return unauthorized();
      if (error instanceof Error && error.name === 'NotFoundError') return notFound();

      const message = error instanceof Error ? error.message : String(error);
      console.error('[api]', message, error instanceof Error ? error.stack : '');

      // Configuration problems are the one class worth surfacing verbatim: the fix
      // is in the operator's hands and a generic 500 hides it.
      if (/is not (set|configured)|Missing:/i.test(message)) {
        return jsonError(message, 503, 'NOT_CONFIGURED');
      }
      return jsonError('Something went wrong. Please try again.', 500, 'INTERNAL');
    }
  };
}
