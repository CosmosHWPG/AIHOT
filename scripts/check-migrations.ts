// Check new migrations against the PR base; deployed SQL is immutable in both engine and module trees.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { FIRST_ONLINE_MIGRATION, migrationPlan } from "./migration-safety.ts";

const isMigration = (file: string) => /^(database\/migrations|modules\/[^/]+\/migrations)\/[^/]+\.sql$/.test(file);

export function checkMigrations(root: string, base: string, publishedBases: readonly string[] = []): string[] {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  // A fork merge has two published histories. Each explicitly supplied ref remains immutable;
  // merely choosing an old filename cannot make unreviewed SQL into deployed history.
  const histories = [base, ...publishedBases].map((ref) => ({ ref,
    files: git("ls-tree", "-r", "--name-only", ref).split("\n").filter(isMigration) }));
  const before = new Set(histories.flatMap(({ files }) => files));
  const current = git("ls-files", "--cached", "--others", "--exclude-standard").split("\n").filter((file) => isMigration(file) && existsSync(path.join(root, file)));
  const problems: string[] = [];
  const canonical = (text: string) => text.replaceAll("\r\n", "\n");
  for (const { ref, files } of histories) {
    for (const file of files) {
      if (!existsSync(path.join(root, file)) || canonical(readFileSync(path.join(root, file), "utf8")) !== canonical(git("show", `${ref}:${file}`))) problems.push(`${file}: deployed migrations from ${ref} are immutable; add a new migration`);
    }
  }
  const names = new Set<string>();
  for (const file of current) {
    const name = path.basename(file);
    if (names.has(name)) problems.push(`${file}: two migrations are named ${name}`);
    names.add(name);
    if (before.has(file)) continue;
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name) || Number(name.slice(0, 4)) < FIRST_ONLINE_MIGRATION) {
      problems.push(`${file}: new migrations start at ${String(FIRST_ONLINE_MIGRATION).padStart(4, "0")} and use NNNN_name.sql`);
      continue;
    }
    try { migrationPlan(readFileSync(path.join(root, file), "utf8")); }
    catch (error) { problems.push(`${file}: ${(error as Error).message}`); }
  }
  return problems;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { base: { type: "string", default: "HEAD" }, "published-base": { type: "string", multiple: true } } });
  const problems = checkMigrations(path.resolve(import.meta.dirname, ".."), values.base!, values["published-base"]);
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
  else console.log("migration history and online safety checked");
}
