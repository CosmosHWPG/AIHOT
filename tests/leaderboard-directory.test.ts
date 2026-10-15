import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDb, sql } from "@aihot/backend/db";
import { importModelDirectory } from "@aihot/backend/leaderboard/directory";
import { tag } from "./setup.ts";

after(closeDb);

test("a populated directory restart sends no duplicate INSERT and keeps operator edits", async () => {
  const marker = tag();
  const dir = await mkdtemp(path.join(os.tmpdir(), "directory-restart-"));
  const file = path.join(dir, "models.json");
  const source = `directory-${marker}`;
  const models = Array.from({ length: 205 }, (_, i) => [`directory-${marker}-${i}`, `Model ${i}`, null, null, null]);
  const names = Object.fromEntries(Array.from({ length: 405 }, (_, i) => [`Alias ${i}`, models[i % models.length]![0]]));
  const fn = `directory_guard_${marker}`;
  try {
    await writeFile(file, JSON.stringify({ models, aliases: { [source]: names } }));
    assert.deepEqual(await importModelDirectory(file), { models: 205, aliases: 405 });
    const [first, second] = await sql`SELECT id,slug FROM lb_models WHERE slug IN (${models[0]![0]}, ${models[1]![0]}) ORDER BY slug`;
    assert.ok(first && second);
    await sql`UPDATE lb_models SET name='Operator display name' WHERE id=${first.id}`;
    await sql`UPDATE lb_aliases SET model_id=${second.id},normalized_alias='operator-target' WHERE source_key=${source} AND alias='Alias 0'`;
    // BEFORE INSERT triggers also fire before ON CONFLICT DO NOTHING. This detects attempted
    // duplicate writes, rather than merely checking that duplicate rows were not committed.
    await sql.unsafe(`CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'restart attempted to reinsert an existing directory row'; END $$`);
    await sql.unsafe(`CREATE TRIGGER "${fn}" BEFORE INSERT ON lb_models FOR EACH ROW EXECUTE FUNCTION "${fn}"()`);
    await sql.unsafe(`CREATE TRIGGER "${fn}" BEFORE INSERT ON lb_aliases FOR EACH ROW EXECUTE FUNCTION "${fn}"()`);
    assert.deepEqual(await importModelDirectory(file), { models: 0, aliases: 0 });
    assert.equal((await sql`SELECT name FROM lb_models WHERE id=${first.id}`)[0]!.name, 'Operator display name');
    const [alias] = await sql`SELECT model_id,normalized_alias FROM lb_aliases WHERE source_key=${source} AND alias='Alias 0'`;
    assert.deepEqual([alias!.model_id,alias!.normalized_alias], [second.id,'operator-target']);
  } finally {
    await sql.unsafe(`DROP TRIGGER IF EXISTS "${fn}" ON lb_models`);
    await sql.unsafe(`DROP TRIGGER IF EXISTS "${fn}" ON lb_aliases`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS "${fn}"()`);
    await sql`DELETE FROM lb_aliases WHERE source_key=${source}`;
    await sql`DELETE FROM lb_models WHERE slug LIKE ${`directory-${marker}-%`}`;
    await unlink(file).catch(() => {});
    await rmdir(dir);
  }
});

test("a later directory version adds missing models and aliases without rewriting earlier rows", async () => {
  const marker = tag();
  const dir = await mkdtemp(path.join(os.tmpdir(), "directory-increment-"));
  const file = path.join(dir, "models.json");
  const source = `directory-${marker}`;
  const existing = [`directory-${marker}-existing`, 'Original name', null, null, null];
  const added = [`directory-${marker}-new`, 'New model', null, null, null];
  try {
    await writeFile(file, JSON.stringify({ models: [existing], aliases: { [source]: { First: existing[0] } } }));
    assert.deepEqual(await importModelDirectory(file), { models: 1, aliases: 1 });
    await sql`UPDATE lb_models SET name='Operator name' WHERE slug=${existing[0]}`;
    await writeFile(file, JSON.stringify({ models: [existing, added], aliases: { [source]: { First: existing[0], Second: existing[0], Third: added[0] } } }));
    assert.deepEqual(await importModelDirectory(file), { models: 1, aliases: 2 });
    assert.equal((await sql`SELECT name FROM lb_models WHERE slug=${existing[0]}`)[0]!.name, 'Operator name');
    assert.equal((await sql`SELECT count(*)::int AS n FROM lb_aliases WHERE source_key=${source}`)[0]!.n, 3);
    assert.deepEqual(await importModelDirectory(file), { models: 0, aliases: 0 });
  } finally {
    await sql`DELETE FROM lb_aliases WHERE source_key=${source}`;
    await sql`DELETE FROM lb_models WHERE slug LIKE ${`directory-${marker}-%`}`;
    await unlink(file).catch(() => {});
    await rmdir(dir);
  }
});
