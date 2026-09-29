import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { TravelJournalRepository } from '../../../../src/persistence/travel-journal-repository.mjs';

const url = new URL(process.env.TRAVEL_JOURNAL_TEST_DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/travel_execution_test') throw new Error('isolated_test_database_required');
const admin = new Pool({ connectionString: url.toString() });
const results = [];
try {
  for (const mode of ['concurrent', 'sequential']) {
    const schema = `journal_qa_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
    const repositories = Array.from({ length: 4 }, () => new TravelJournalRepository({ databaseUrl: scoped.toString() }));
    try {
      const rows = mode === 'concurrent'
        ? await Promise.allSettled(repositories.map((repo, index) => repo.list(`qa_trip_${index}`)))
        : await (async () => { const values = []; for (const [index, repo] of repositories.entries()) { try { values.push({ status: 'fulfilled', value: await repo.list(`qa_trip_${index}`) }); } catch (reason) { values.push({ status: 'rejected', reason }); } } return values; })();
      results.push({ mode, results: rows.map(row => row.status === 'fulfilled' ? { status: row.status, entries: row.value.length } : { status: row.status, code: row.reason.code, message: row.reason.message }) });
    } finally {
      await Promise.all(repositories.map(repo => repo.close()));
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  }
} finally { await admin.end(); }
await writeFile(new URL('./journal-cold-start-results.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results));
if (results.some(group => group.results.some(row => row.status === 'rejected'))) process.exitCode = 1;
