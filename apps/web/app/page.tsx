import Link from "next/link";
import { Button } from "@/components/ui/button";
export default function HomePage() {

  return (
    <main className="mx-auto flex min-h-full max-w-lg flex-col justify-center gap-8 px-6 py-16">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Raw Edit</p>
        <h1 className="text-4xl font-semibold tracking-tight">Turn a messy recording into a clean edit.</h1>
        <p className="text-muted-foreground">
          Upload an untouched iPhone MOV. We keep the original master, propose retake and silence cuts, and render
          once from the source.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Button asChild size="lg" className="h-12">
          <Link href="/sign-up">Get started</Link>
        </Button>
        <Button asChild variant="outline" size="lg" className="h-12">
          <Link href="/sign-in">Sign in</Link>
        </Button>
      </div>
    </main>
  );
}
