import { db, closeDatabase } from "../src/db/client";
import { seedDatabase } from "./seed-data";

try {
  await seedDatabase(db);
  console.log("Fictional development seed applied. No record is approved for public launch.");
} finally {
  await closeDatabase();
}
