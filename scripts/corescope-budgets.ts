// Local controls use the same audited update as the authenticated administration page.
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { listBudgets, updateBudget } from "@aihot/backend/admin/settings";
import { temporaryLlmBudgetStatus } from "@aihot/backend/providers/temporary-budget";

const address = new URL(config.databaseUrl);
if (!["localhost","127.0.0.1"].includes(address.hostname) || address.port !== "5448" || address.pathname !== "/corescope") {
  throw new Error("Budget operations require the independent local CoreScope database on port 5448.");
}
const option = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length+3);
try {
  const command = process.argv[2] ?? "status";
  if (command === "set") {
    const service = option("service");
    const enabled = option("enabled");
    const reason = option("reason");
    if (!service || !["true","false"].includes(enabled ?? "") || !reason?.trim()) {
      throw new Error("Use set --service=llm --enabled=true|false --reason=REASON");
    }
    console.log(JSON.stringify(await updateBudget(service,{ enabled: enabled === "true",reason },"corescope-budget-operations")));
  } else if (command === "status") {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(),budgets: await listBudgets(),temporaryLlm: await temporaryLlmBudgetStatus() }));
  } else throw new Error("Use status or set --service=SERVICE --enabled=true|false --reason=REASON");
} finally { await closeDb(); }
