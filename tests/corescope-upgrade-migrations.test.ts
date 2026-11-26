import './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { runMigrations } from '../scripts/migrate.ts';
import { CORESCOPE_MIGRATION_HOLDS, coreScopeMigrationHold } from '../scripts/corescope-migration-holds.ts';
import { LEGACY_SQL_SHA256, legacyMigrationRoot, legacySnapshot, seedUpgradeFixture } from './corescope-upgrade-fixture.ts';

const root = path.resolve(import.meta.dirname, '..');
const temporary = path.join(root, '.data/corescope-upgrade-rehearsal');
mkdirSync(temporary, { recursive: true });
const directories: string[] = [];
const schemaNames: string[] = [];
const database = new URL(process.env.DATABASE_URL!);
if (!/(?:_test|_ci)$/.test(database.pathname)) throw new Error('Disposable test database required');
const admin = postgres(database.href, { max: 1, onnotice: () => {} });
after(async () => {
  for (const schema of schemaNames) await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  for (const directory of directories) {
    assert.ok(path.resolve(directory).startsWith(path.resolve(temporary) + path.sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('published CoreScope SQL and audited holds cannot silently change', () => {
  const directory = mkdtempSync(path.join(temporary, 'history-'));
  directories.push(directory);
  legacyMigrationRoot(root, directory);
  assert.equal(Object.keys(LEGACY_SQL_SHA256).length, 45);
  for (const name of Object.keys(CORESCOPE_MIGRATION_HOLDS)) {
    const sql = readFileSync(path.join(root, 'database/migrations', name), 'utf8');
    assert.ok(coreScopeMigrationHold(name, sql));
    assert.throws(() => coreScopeMigrationHold(name, sql + '\n-- unreviewed change'), /audited SHA256/);
  }
  assert.equal(coreScopeMigrationHold('0045_event_capacity_deferrals.sql', 'synthetic'), null);
});

test('populated legacy schema upgrades without losing evidence and cold installs retain the same schema', async () => {
  const directory = mkdtempSync(path.join(temporary, 'legacy-'));
  directories.push(directory);
  const legacy = legacyMigrationRoot(root, directory);
  for (const mode of ['populated', 'cold']) {
    const schema = `upgrade_${process.pid}_${mode}_${Date.now()}`;
    schemaNames.push(schema);
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const db = postgres(database.href, { max: 1, onnotice: () => {}, connection: { search_path: `${schema},public` } });
    try {
      let before;
      if (mode === 'populated') {
        assert.equal(await runMigrations(db, legacy), 45);
        await seedUpgradeFixture(db);
        before = await legacySnapshot(db);
      }
      assert.ok(await runMigrations(db, root) > 0);
      if (before) assert.deepEqual(await legacySnapshot(db, before), before, 'every pre-existing column and synthetic row is retained');
      const held = await db<{ name: string; sql_sha256: string; held_at: Date }[]>`SELECT name,sql_sha256,held_at FROM schema_migration_holds ORDER BY name`;
      assert.equal(held.length, Object.keys(CORESCOPE_MIGRATION_HOLDS).length);
      assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name=ANY(${held.map(r=>r.name)}::text[])`).length, 0);
      const [bad] = await db`SELECT count(*)::int AS n FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} AND NOT i.indisvalid`;
      assert.equal(bad!.n, 0);
      for (const [table,column] of [['reports','issue_number'],['stories','digest_version'],['receipt_attempts','auto_released'],['feedback','surface_id'],['publications','suppress_original']]) {
        assert.equal((await db`SELECT 1 FROM information_schema.columns WHERE table_schema=${schema} AND table_name=${table} AND column_name=${column}`).length, 1);
      }
      assert.equal(await runMigrations(db, root), 0);
      assert.deepEqual(await db`SELECT name,sql_sha256,held_at FROM schema_migration_holds ORDER BY name`, held);
      if (mode === 'populated') {
        await assert.rejects(db`UPDATE publications SET suppress_original=true,body_mode='full',syndicate=true WHERE article_id='upgrade-report'`, /publications_suppressed_body_summary/);
        await db`INSERT INTO schema_migrations (name) VALUES ('0045_drop_topics.sql')`;
        await assert.rejects(runMigrations(db, root), /already applied/);
      }
    } finally { await db.end(); }
  }
});
