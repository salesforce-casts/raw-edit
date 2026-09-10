import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Client-side fetch wrapper that surfaces the API's error message. */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    const error = new Error(body.error ?? `Request failed (${response.status})`);
    (error as Error & { code?: string; status?: number }).code = body.code;
    (error as Error & { code?: string; status?: number }).status = response.status;
    throw error;
  }

  return (await response.json()) as T;
}
