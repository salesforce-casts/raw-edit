import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/auth-form';
import { getUser } from '@/lib/authz';

export const metadata = { title: 'Sign in — RawEdit' };

export default async function SignInPage() {
  if (await getUser()) redirect('/dashboard');

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5 py-10">
      <Link href="/" className="mb-8 text-base font-semibold tracking-tight">
        RawEdit
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-1.5 text-sm text-ink-muted">Sign in to pick up where you left off.</p>
      <AuthForm mode="sign-in" />
      <p className="mt-6 text-sm text-ink-muted">
        New here?{' '}
        <Link href="/sign-up" className="font-medium text-accent hover:underline">
          Create an account
        </Link>
      </p>
    </main>
  );
}
