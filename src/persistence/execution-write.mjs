import { currentTravelExecution } from "../../travel-agent-pi-package/src/host/execution-context.ts";
import { executionError } from "../../travel-agent-pi-package/src/host/execution-contract.ts";

/** Lock run ownership and the product mutation in the same PostgreSQL transaction.
 * A cancellation either precedes this transaction, or follows the committed write.
 */
export async function executionWrite(pool, action, { productWrite = false, tripId = null } = {}) {
  const context = currentTravelExecution();
  if (!context) return action(pool);
  context.signal.throwIfAborted();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT status,worker_id,fence,lease_until FROM travel_runs WHERE run_id=$1 FOR UPDATE", [context.runId]);
    const row = result.rows[0];
    if (!row || row.status !== "running" || row.worker_id !== context.workerId || Number(row.fence) !== context.fence || Number(row.lease_until) <= Date.now()) throw executionError("execution_ownership_lost");
    context.signal.throwIfAborted();
    if (productWrite) await client.query("UPDATE travel_runs SET product_write_count=product_write_count+1,trip_id=COALESCE(trip_id,$2) WHERE run_id=$1", [context.runId, tripId]);
    const value = await action(client);
    await client.query("COMMIT");
    return value;
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}
