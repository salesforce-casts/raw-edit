import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/authz';
import { UserMenu } from '@/components/dashboard/user-menu';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect('/sign-in');

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-20 border-b border-border bg-canvas/85 backdrop-blur safe-top">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4">
          <Link href="/dashboard" className="text-base font-semibold tracking-tight">
            RawEdit
          </Link>
          <UserMenu name={user.name} email={user.email} />
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 pb-16 safe-bottom">{children}</main>
    </div>
  );
}
