import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const out = resolve('dist-dsh/lib');
await mkdir(out, {
  recursive: true
});
for (const client of [false, true]) {
  const result = await build({
    configFile: false,
    plugins: client ? [react()] : [],
    define: {
      'process.env.NODE_ENV': '"production"'
    },
    build: {
      write: false,
      minify: 'esbuild',
      sourcemap: false,
      cssCodeSplit: false,
      target: client ? 'es2022' : 'node24',
      lib: {
        entry: resolve(client ? 'src/hosts/dsh/client.jsx' : 'src/hosts/dsh/server.mjs'),
        formats: [client ? 'cjs' : 'es']
      },
      rollupOptions: {
        external: id => client ? ['react', 'react/jsx-runtime'].includes(id) : id.startsWith('node:') || id.startsWith('@deepseek-ai/'),
        output: {
          inlineDynamicImports: true,
          exports: 'named'
        }
      }
    }
  });
  const chunks = (Array.isArray(result) ? result.flatMap(r => r.output) : result.output).filter(c => c.type === 'chunk');
  if (chunks.length !== 1) throw new Error('dsh_plugin_bundle_must_be_single_entry');
  let code = chunks[0].code;
  if (client) code = `window.__ModuleLoader__.load({id:"dsh-turnsu-travel-agent",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${code}\nreturn module.exports;}});`;
  await writeFile(resolve(out, client ? 'client.js' : 'server.js'), code);
}
process.stdout.write('Built native DSH owner bridge and browser module-loader entry.\n');
