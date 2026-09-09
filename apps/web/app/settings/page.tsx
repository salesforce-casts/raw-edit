import { redirect } from "next/navigation";
import { getSession } from "@/server/session";
import { Card } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session?.user) redirect("/sign-in");
  return (
    <main className="mx-auto max-w-lg px-4 py-10">
      <Card className="space-y-3 p-6">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Signed in as {session.user.email}</p>
        <p className="text-sm text-muted-foreground">
          Retention options (7 / 30 / 90 days / never) are stored on your profile and applied by the scheduled cleanup
          job. Originals are never deleted during editing.
        </p>
      </Card>
    </main>
  );
}
