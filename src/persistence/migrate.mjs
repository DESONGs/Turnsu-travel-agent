import { AuthRepository } from "./auth-repository.mjs";
import { PostgresTripRepository } from "./postgres-trip-repository.mjs";
import { TravelJournalRepository } from "./travel-journal-repository.mjs";
import { ExecutionRepository } from "./execution-repository.mjs";
import { ContinuityRepository } from "./continuity-repository.mjs";
import { DSH_SESSION_SQL } from "../../travel-agent-pi-package/src/dsh/postgres-session.ts";
import { MCP_OAUTH_SQL } from "../mcp/oauth.mjs";

if (!process.env.DATABASE_URL) {
  process.stderr.write("DATABASE_URL is required for db:migrate\n");
  process.exitCode = 1;
} else {
  const repository = new PostgresTripRepository({ databaseUrl: process.env.DATABASE_URL });
  await repository.migrate();
  await repository.close();
  const auth = new AuthRepository({ databaseUrl: process.env.DATABASE_URL });
  await auth.migrate();
  await auth.transaction(async db => { await db.query('SELECT pg_advisory_xact_lock(715803127)');await db.query(MCP_OAUTH_SQL); });
  await auth.close();
  const journal = new TravelJournalRepository({ databaseUrl: process.env.DATABASE_URL });
  await journal.migrate();
  await journal.close();
  const executions = new ExecutionRepository({ databaseUrl: process.env.DATABASE_URL });
  await executions.migrate();
  await executions.pool.query(DSH_SESSION_SQL);
  await executions.close();
  const continuity = new ContinuityRepository({ databaseUrl: process.env.DATABASE_URL });
  await continuity.migrate();
  await continuity.close();
  process.stdout.write("PostgreSQL trip, authentication, execution, DSH session, preference, watch, notification and photo journal schemas are ready.\n");
}
