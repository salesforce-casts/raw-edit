import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/auth-form';
import { getUser } from '@/lib/authz';

export const metadata = { title: 'Create an account — RawEdit' };

export default async function SignUpPage() {
  if (await getUser()) redirect('/dashboard');

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5 py-10">
      <Link href="/" className="mb-8 text-base font-semibold tracking-tight">
        RawEdit
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1.5 text-sm text-ink-muted">
        Free to start. No card, no watermark.
      </p>
      <AuthForm mode="sign-up" />
      <p className="mt-6 text-sm text-ink-muted">
        Already have one?{' '}
        <Link href="/sign-in" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
