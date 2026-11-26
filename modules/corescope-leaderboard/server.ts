import path from "node:path";
import type { ServerModule } from "@aihot/backend/modules";
import { REPO_ROOT } from "@aihot/backend/config";
import { refreshLeaderboard } from "@aihot/backend/leaderboard/fetch/refresh";
import { runLeaderboardRound } from "@aihot/backend/leaderboard/method/run";
import { leaderboardUrls } from "@aihot/backend/leaderboard/read";
import { registerLeaderboard } from "../../apps/api/src/routes/leaderboard.ts";
import { sendFile } from "../../apps/api/src/routes/static.ts";
const module: ServerModule = {
  name: "corescope-leaderboard",
  http(app) {
    registerLeaderboard(app);
    app.get("/assets/:group/:file", async (req, reply) => {
      const { group, file } = req.params as { group: string; file: string };
      if (!["model-providers", "leaderboard-sources"].includes(group) || !/^[a-zA-Z0-9_.-]+$/.test(file)) return reply.code(404).send();
      return sendFile(req, reply, path.join(REPO_ROOT, "assets", group, file), { cacheControl: "public, max-age=86400" });
    });
  },
  schedules: [{ name: "leaderboard.round", cron: "5 2,8,14,20 * * *", missed: "once", run: () => process.env.COLLECT_ENABLED === "true" ? refreshLeaderboard() : runLeaderboardRound() }],
  sitemap: { entries: async () => (await leaderboardUrls()).map(loc => ({ loc })) },
};
export default module;
