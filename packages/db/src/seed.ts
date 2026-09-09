import { eq } from "drizzle-orm";
import { getDb } from "./index";
import { subscriptions, user, userProfiles } from "./schema";

async function seed() {
  const db = getDb();
  const demoUserId = "demo_user_raw_edit";
  const existing = await db.select().from(user).where(eq(user.id, demoUserId)).limit(1);
  if (existing.length === 0) {
    await db.insert(user).values({
      id: demoUserId,
      name: "Demo Creator",
      email: "demo@rawedit.dev",
      emailVerified: true,
    });
    await db.insert(userProfiles).values({ userId: demoUserId });
    await db.insert(subscriptions).values({ userId: demoUserId, plan: "creator" });
    console.log("seeded demo user demo@rawedit.dev");
  } else {
    console.log("demo user already present");
  }
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
