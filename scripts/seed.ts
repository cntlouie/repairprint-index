import { db, closeDatabase } from "../src/db/client";
import { seedDatabase } from "./seed-data";

async function main(): Promise<void> {
  try {
    await seedDatabase(db);
    console.log("Fictional development seed applied. No record is approved for public launch.");
  } finally {
    await closeDatabase();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
