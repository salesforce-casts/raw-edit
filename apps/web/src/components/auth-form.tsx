'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, Input, Spinner } from '@/components/ui/primitives';
import { signIn, signUp } from '@/lib/auth-client';

export function AuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const isSignUp = mode === 'sign-up';

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const name = String(form.get('name') ?? '').trim();

    if (isSignUp && password.length < 10) {
      toast.error('Use at least 10 characters.');
      return;
    }

    setPending(true);
    try {
      const result = isSignUp
        ? await signUp.email({ email, password, name: name || email.split('@')[0]! })
        : await signIn.email({ email, password });

      if (result.error) {
        toast.error(result.error.message ?? 'That did not work. Please check your details.');
        return;
      }
      router.push('/dashboard');
      router.refresh();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      {isSignUp ? (
        <Field label="Name">
          <Input name="name" autoComplete="name" placeholder="Your name" />
        </Field>
      ) : null}

      <Field label="Email">
        <Input
          name="email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          placeholder="you@example.com"
        />
      </Field>

      <Field label="Password" hint={isSignUp ? 'At least 10 characters.' : undefined}>
        <Input
          name="password"
          type="password"
          required
          minLength={isSignUp ? 10 : undefined}
          autoComplete={isSignUp ? 'new-password' : 'current-password'}
          placeholder="••••••••••"
        />
      </Field>

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? <Spinner /> : null}
        {isSignUp ? 'Create account' : 'Sign in'}
      </Button>
    </form>
  );
}
