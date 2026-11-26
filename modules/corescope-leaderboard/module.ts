import { defineModule } from "@aihot/contracts/modules";
export default defineModule({
  name: "corescope-leaderboard",
  apiPaths: [/^\/api\/site\/leaderboard(?:\/|$)/, /^\/assets\/(?:model-providers|leaderboard-sources)\//],
  pages: [
    { layout: "web/routes/leaderboard-boards.tsx", id: "leaderboard-boards", pages: [
      { path: "leaderboard", file: "web/routes/leaderboard.tsx", id: "leaderboard" },
      { path: "leaderboard/category/:key", file: "web/routes/leaderboard.tsx", id: "leaderboard-category" },
    ] },
    { path: "leaderboard/sources", file: "web/routes/leaderboard-sources.tsx" },
    { path: "leaderboard/sources/:key", file: "web/routes/leaderboard-source.tsx" },
    { path: "leaderboard/rules", file: "web/routes/leaderboard-rules.tsx" },
    { path: "leaderboard/:slug", file: "web/routes/leaderboard-model.tsx" },
  ],
});
