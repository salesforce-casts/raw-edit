import { and, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb, videos } from "@raw-edit/db";
import { getSession } from "@/server/session";
import { UploadRawVideo } from "@/components/upload-raw-video";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatMs } from "@/lib/format";
import { formatBytes } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session?.user) redirect("/sign-in");
  const rows = await getDb()
    .select()
    .from(videos)
    .where(and(eq(videos.userId, session.user.id), isNull(videos.deletedAt)))
    .orderBy(desc(videos.createdAt));

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Raw Edit</p>
          <h1 className="text-2xl font-semibold">Turn a messy recording into a clean edit.</h1>
        </div>
        <Button asChild variant="ghost">
          <Link href="/settings">Settings</Link>
        </Button>
      </header>
      <UploadRawVideo />
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Recent videos</h2>
        {rows.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">No videos yet. Upload a raw phone recording.</Card>
        ) : (
          <div className="grid gap-3">
            {rows.map((video) => (
              <Link key={video.id} href={`/videos/${video.id}`}>
                <Card className="flex items-center justify-between gap-4 p-4">
                  <div>
                    <div className="font-medium">{video.originalFilename}</div>
                    <div className="text-sm text-muted-foreground">
                      {formatMs(video.durationMs)} · {video.sizeBytes ? formatBytes(video.sizeBytes) : "size pending"}
                    </div>
                  </div>
                  <Badge variant="outline">{video.status}</Badge>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
