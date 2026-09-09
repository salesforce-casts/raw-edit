"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SignUpPage() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-4">
      <Card className="p-6">
        <h1 className="mb-4 text-xl font-semibold">Create account</h1>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setPending(true);
            const form = new FormData(event.currentTarget);
            const result = await authClient.signUp.email({
              name: String(form.get("name")),
              email: String(form.get("email")),
              password: String(form.get("password")),
            });
            setPending(false);
            if (result.error) {
              setError(result.error.message ?? "Could not sign up");
              return;
            }
            router.push("/dashboard");
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" minLength={8} required />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button className="w-full" disabled={pending}>
            Create account
          </Button>
        </form>
        <p className="mt-4 text-sm text-muted-foreground">
          Already have an account? <Link href="/sign-in">Sign in</Link>
        </p>
      </Card>
    </main>
  );
}
