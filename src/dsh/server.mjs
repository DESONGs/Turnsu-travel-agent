import { createTravelCloudApp } from './cloud-app.mjs';
import { loadTravelRuntimeEnv } from '../http/runtime-env.mjs';
const env=await loadTravelRuntimeEnv();
const cloud=await createTravelCloudApp(env,{listen:true});
process.stdout.write(`DSH Travel API ready on ${env.TRAVEL_AGENT_BIND_HOST??'127.0.0.1'}:${env.PORT??8797}\n`);
await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve)});
await cloud.close();
