import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Scissors, Gauge, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getUser } from '@/lib/authz';

export default async function LandingPage() {
  // A signed-in creator wants the dashboard, not the pitch.
  const user = await getUser();
  if (user) redirect('/dashboard');

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-5 safe-top">
      <header className="flex items-center justify-between py-5">
        <span className="text-base font-semibold tracking-tight">RawEdit</span>
        <Button asChild variant="ghost" size="sm">
          <Link href="/sign-in">Sign in</Link>
        </Button>
      </header>

      <div className="flex flex-1 flex-col justify-center py-10">
        <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          Turn a messy recording into a clean edit.
        </h1>
        <p className="mt-4 max-w-prose text-base leading-relaxed text-ink-muted">
          Record on your phone, fluff the line as many times as you need, and upload the
          raw file. RawEdit finds the takes you abandoned and the pauses between them,
          shows you exactly what it plans to cut, and renders the result at the quality
          you shot it.
        </p>

        <div className="mt-8">
          <Button asChild size="lg">
            <Link href="/sign-up">Start free</Link>
          </Button>
        </div>

        <dl className="mt-12 grid gap-6 sm:grid-cols-3">
          <Feature
            icon={<Scissors className="h-5 w-5" aria-hidden />}
            title="Finds your retakes"
            body="When you start the same sentence three times, it keeps the one you finished — and tells you why."
          />
          <Feature
            icon={<Gauge className="h-5 w-5" aria-hidden />}
            title="Keeps your quality"
            body="4K stays 4K. HDR stays HDR. One encode from the original file, never a compressed proxy."
          />
          <Feature
            icon={<ShieldCheck className="h-5 w-5" aria-hidden />}
            title="Private by default"
            body="Your originals sit in private storage behind short-lived links. You choose when they are deleted."
          />
        </dl>
      </div>

      <footer className="py-8 text-xs text-ink-subtle">
        Built for Reels, Shorts, talking heads and course recordings.
      </footer>
    </main>
  );
}

function Feature({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div>
      <dt className="flex items-center gap-2 text-sm font-medium text-ink">
        <span className="text-accent">{icon}</span>
        {title}
      </dt>
      <dd className="mt-1.5 text-sm leading-relaxed text-ink-muted">{body}</dd>
    </div>
  );
}
