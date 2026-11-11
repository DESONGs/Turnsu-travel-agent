import { currentTravelExecution } from "../../travel-agent-pi-package/src/host/execution-context.ts";
import { AuthRepository } from './auth-repository.mjs';
import { PRODUCT_SQL } from '../../travel-agent-pi-package/src/product/continuity.ts';
export class ContinuityRepository extends AuthRepository {
  constructor(options){super(options);if(this.db)this.db.exec(PRODUCT_SQL);}
  async transaction(task){return super.transaction(async c=>{const execution=currentTravelExecution();if(execution){execution.signal.throwIfAborted();if(this.pool){const r=await c.query("SELECT run_id FROM travel_runs WHERE run_id=$1 AND user_id=$2 AND worker_id=$3 AND fence=$4 AND status='running' AND lease_until>(extract(epoch from clock_timestamp())*1000)::bigint FOR UPDATE",[execution.runId,execution.userId,execution.workerId,execution.fence]);if(!r.rowCount)throw Object.assign(new Error('execution_ownership_lost'),{code:'execution_ownership_lost'});}else await execution.assertCurrent();}return task(c);});}
  async migrate(){await super.migrate();if(this.pool){this.productReady??=(async()=>{const c=await this.pool.connect();try{await c.query("BEGIN");await c.query("SELECT pg_advisory_xact_lock(715803126)");await c.query(PRODUCT_SQL);await c.query("COMMIT");}catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}})().catch(e=>{this.productReady=null;throw e});await this.productReady;}}
}
