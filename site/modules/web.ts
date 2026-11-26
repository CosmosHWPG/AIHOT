import leaderboard from "@aihot/corescope-leaderboard/web";
// What the site's modules add to the web pages (site/modules/index.ts).
import type { WebModule } from "@aihot/web/modules";

export const WEB_MODULES: readonly WebModule[] = [leaderboard];
