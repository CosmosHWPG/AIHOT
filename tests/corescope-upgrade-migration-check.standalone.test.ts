// A fork merge retains both published SQL histories without exempting newly invented old numbers.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkMigrations } from "../scripts/check-migrations.ts";

test("a merge checks each published history, tolerates checkout line endings and rejects invented history", () => {
  const root = mkdtempSync(path.join(tmpdir(), "corescope-upgrade-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const write = (name: string, text: string) => {
    const file = path.join(root, "database/migrations", name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  try {
    git("init", "-q");
    git("config", "user.email", "upgrade-test@example.invalid");
    git("config", "user.name", "Upgrade test");
    git("config", "core.autocrlf", "false");
    write("0001_shared.sql", "CREATE TABLE fixture (id int);\n");
    git("add", "."); git("commit", "-qm", "shared");
    const shared = git("rev-parse", "HEAD").trim();
    write("0042_local.sql", "ALTER TABLE fixture ADD COLUMN local_value text;\n");
    git("add", "."); git("commit", "-qm", "fork history");
    const fork = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", "--detach", shared);
    write("0042_upstream.sql", "ALTER TABLE fixture ADD COLUMN upstream_value text;\n");
    git("add", "."); git("commit", "-qm", "upstream history");
    const upstream = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", "--detach", fork);
    write("0042_upstream.sql", "ALTER TABLE fixture ADD COLUMN upstream_value text;\r\n");
    assert.match(checkMigrations(root, fork).join("\n"), /new migrations start/);
    assert.deepEqual(checkMigrations(root, fork, [upstream]), []);
    write("0043_invented.sql", "CREATE TABLE invented (id int);\n");
    assert.match(checkMigrations(root, fork, [upstream]).join("\n"), /0043_invented.*new migrations/);
    rmSync(path.join(root, "database/migrations/0043_invented.sql"));
    write("0042_upstream.sql", "ALTER TABLE fixture ADD COLUMN upstream_value boolean;\n");
    assert.match(checkMigrations(root, fork, [upstream]).join("\n"), /0042_upstream.*immutable/);
    write("0042_upstream.sql", "ALTER TABLE fixture ADD COLUMN upstream_value text;\n");
    write("0042_local.sql", "ALTER TABLE fixture ADD COLUMN local_value boolean;\n");
    assert.match(checkMigrations(root, fork, [upstream]).join("\n"), /0042_local.*immutable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
