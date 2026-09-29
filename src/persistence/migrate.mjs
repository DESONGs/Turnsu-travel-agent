import { AuthRepository } from "./auth-repository.mjs";
import { PostgresTripRepository } from "./postgres-trip-repository.mjs";
import { TravelJournalRepository } from "./travel-journal-repository.mjs";
import { ExecutionRepository } from "./execution-repository.mjs";

if (!process.env.DATABASE_URL) {
  process.stderr.write("DATABASE_URL is required for db:migrate\n");
  process.exitCode = 1;
} else {
  const repository = new PostgresTripRepository({ databaseUrl: process.env.DATABASE_URL });
  await repository.migrate();
  await repository.close();
  const auth = new AuthRepository({ databaseUrl: process.env.DATABASE_URL });
  await auth.migrate();
  await auth.close();
  const journal = new TravelJournalRepository({ databaseUrl: process.env.DATABASE_URL });
  await journal.migrate();
  await journal.close();
  const executions = new ExecutionRepository({ databaseUrl: process.env.DATABASE_URL });
  await executions.migrate();
  await executions.close();
  process.stdout.write("PostgreSQL trip, authentication, execution and photo journal schemas are ready.\n");
}
