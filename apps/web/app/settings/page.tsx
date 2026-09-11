"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const OPTIONS = [
  { id: "natural", label: "Natural" },
  { id: "tight", label: "Tight" },
  { id: "very_tight", label: "Very tight" },
] as const;

export default function SettingsPage() {
  const [pacingPreset, setPacingPreset] = useState<"natural" | "tight" | "very_tight">("natural");
  const [email, setEmail] = useState<string>();

  useEffect(() => {
    void fetch("/api/settings")
      .then((response) => response.json())
      .then((json) => {
        if (json.pacingPreset) setPacingPreset(json.pacingPreset);
      })
      .catch(() => undefined);
    void fetch("/api/auth/get-session")
      .then((response) => response.json())
      .then((json) => setEmail(json?.user?.email))
      .catch(() => undefined);
  }, []);

  function save(next: "natural" | "tight" | "very_tight") {
    setPacingPreset(next);
    void fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pacingPreset: next }),
    });
  }

  return (
    <main className="mx-auto max-w-lg px-4 py-10">
      <Card className="space-y-3 p-6">
        <h1 className="text-xl font-semibold">Settings</h1>
        {email ? <p className="text-sm text-muted-foreground">Signed in as {email}</p> : null}
        <div>
          <div className="mb-2 text-sm font-medium">Pacing</div>
          <div className="flex flex-wrap gap-2">
            {OPTIONS.map((option) => (
              <Button
                key={option.id}
                variant={pacingPreset === option.id ? "default" : "outline"}
                onClick={() => save(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            One control for pause threshold and padding. Not three numbers.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Retention options (7 / 30 / 90 days / never) are stored on your profile and applied by the scheduled cleanup
          job. Originals are never deleted during editing.
        </p>
      </Card>
    </main>
  );
}
