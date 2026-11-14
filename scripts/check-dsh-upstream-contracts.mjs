import { createHash } from 'node:crypto';
import { mkdtemp,readFile,writeFile,copyFile,symlink } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const url=new URL(process.env.TRAVEL_TEST_DATABASE_URL??'http://missing');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='55439'||url.pathname!=='/travel_plugin')throw new Error('Use the dedicated isolated PostgreSQL database (see validation notes).');
const sha='fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159';
const hashes={contract:'03a87ca65d0f3fab6c73c78b2c36c7e246dc18d8ccff9d483edc5cd9753e4788','live-write-contract':'08b01dcd4282ab47a772e16a81cca01defe5e89e185c66767a22d51481738d78'};
const target=await mkdtemp(join(tmpdir(),'travel-dsh-upstream-'));
for(const name of ['package.json','package-lock.json'])await copyFile(join(root,'scripts/dsh-upstream',name),join(target,name));
if(!process.env.npm_execpath)throw new Error('Run npm run test:dsh:upstream.');
execFileSync(process.execPath,[process.env.npm_execpath,'ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:target,stdio:'pipe'});
for(const[name,digest]of Object.entries(hashes)){
 const source=process.env.TRAVEL_DSH_CONTRACT_SOURCE_DIR?await readFile(join(process.env.TRAVEL_DSH_CONTRACT_SOURCE_DIR,`${name}.ts`),'utf8'):await (async()=>{const response=await fetch(`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${sha}/packages/session/session-persistence/tests/${name}.ts`,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('upstream_contract_fetch_failed');return response.text()})();if(createHash('sha256').update(source).digest('hex')!==digest)throw new Error('upstream_contract_hash_mismatch');await writeFile(join(target,`${name}.ts`),source.replaceAll("'../src/index.ts'","'@deepseek-ai/dsh-session-persistence'"));
}
await symlink(join(root,'node_modules/@deepseek-ai'),join(target,'node_modules/@deepseek-ai'),process.platform==='win32'?'junction':'dir');
await symlink(join(root,'node_modules/pg'),join(target,'node_modules/pg'),process.platform==='win32'?'junction':'dir');
const template=await readFile(join(root,'scripts/dsh-upstream/upstream.spec.template.ts'),'utf8');await writeFile(join(target,'upstream.spec.ts'),template.replaceAll('__TRAVEL_PROJECT_ROOT__',root.replaceAll('\\','/').replaceAll("'","\\'")));
execFileSync(process.execPath,[join(target,'node_modules/vitest/vitest.mjs'),'run','upstream.spec.ts'],{cwd:target,env:process.env,stdio:'inherit'});
