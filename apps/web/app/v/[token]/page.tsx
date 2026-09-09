"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function SharePage() {
  const params = useParams<{ token: string }>();
  const [data, setData] = useState<{ playbackUrl: string; filename: string } | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void fetch(`/api/public/v/${params.token}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("This share link is unavailable");
        setData(await response.json());
      })
      .catch((err: Error) => setError(err.message));
  }, [params.token]);

  if (error) return <main className="p-8 text-center text-sm text-destructive">{error}</main>;
  if (!data) return <main className="p-8 text-center text-sm text-muted-foreground">Loading…</main>;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Card className="overflow-hidden">
        <video src={data.playbackUrl} controls playsInline className="aspect-video w-full bg-black" />
        <div className="flex items-center justify-between gap-3 p-4">
          <div className="font-medium">{data.filename}</div>
          <Button asChild>
            <a href={data.playbackUrl}>Download</a>
          </Button>
        </div>
      </Card>
    </main>
  );
}
