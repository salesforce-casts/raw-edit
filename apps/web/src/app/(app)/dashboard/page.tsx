import { DashboardClient } from '@/components/dashboard/dashboard-client';

export const metadata = { title: 'Your videos — RawEdit' };
export const dynamic = 'force-dynamic';

/**
 * The main screen. One heading, one big button, and the library underneath — no
 * enterprise chrome, because the creator is usually holding a phone and has just
 * finished recording.
 */
export default function DashboardPage() {
  return (
    <div className="py-8">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        Turn a messy recording into a clean edit.
      </h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        Upload the raw file. We will find the failed takes and the dead air, and show you
        what we plan to cut before anything is rendered.
      </p>
      <DashboardClient />
    </div>
  );
}
