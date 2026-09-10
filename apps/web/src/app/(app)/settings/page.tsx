import { SettingsClient } from '@/components/settings-client';

export const metadata = { title: 'Settings — RawEdit' };
export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  return (
    <div className="py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1.5 text-sm text-ink-muted">
        These become the defaults for every new upload.
      </p>
      <SettingsClient />
    </div>
  );
}
