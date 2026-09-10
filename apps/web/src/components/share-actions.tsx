'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Copy, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ShareActions({ downloadUrl }: { downloadUrl: string | null }) {
  const [copied, setCopied] = React.useState(false);

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {downloadUrl ? (
        <Button asChild className="gap-2">
          {/* The signed URL already carries a Content-Disposition filename. */}
          <a href={downloadUrl}>
            <Download className="h-4 w-4" aria-hidden />
            Download
          </a>
        </Button>
      ) : null}

      <Button
        variant="outline"
        className="gap-2"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(window.location.href);
            setCopied(true);
            toast.success('Link copied.');
            setTimeout(() => setCopied(false), 2000);
          } catch {
            toast.error('Could not copy. Copy it from the address bar instead.');
          }
        }}
      >
        <Copy className="h-4 w-4" aria-hidden />
        {copied ? 'Copied' : 'Copy link'}
      </Button>
    </div>
  );
}
