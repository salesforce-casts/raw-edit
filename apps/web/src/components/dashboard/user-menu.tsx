'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LogOut, Settings, User as UserIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { signOut } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

export function UserMenu({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <UserIcon className="h-4 w-4" />
      </Button>

      <div
        role="menu"
        className={cn(
          'absolute right-0 z-30 mt-2 w-56 origin-top-right rounded-xl border border-border bg-surface p-1 shadow-lg',
          open ? 'block' : 'hidden',
        )}
      >
        <div className="border-b border-border px-3 py-2">
          <p className="truncate text-sm font-medium text-ink">{name}</p>
          <p className="truncate text-xs text-ink-subtle">{email}</p>
        </div>
        <Link
          href="/settings"
          role="menuitem"
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink hover:bg-surface-muted"
          onClick={() => setOpen(false)}
        >
          <Settings className="h-4 w-4" aria-hidden />
          Settings
        </Link>
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
          onClick={async () => {
            await signOut();
            router.push('/');
            router.refresh();
          }}
        >
          <LogOut className="h-4 w-4" aria-hidden />
          Sign out
        </button>
      </div>
    </div>
  );
}
