import { defineWebModule } from "@aihot/web/modules";
import { IconChart } from "../../apps/web/app/components/icons";
export default defineWebModule({
  name: "corescope-leaderboard",
  sidebar: { section: "模型", items: [{ to: "/leaderboard", label: "模型榜", icon: IconChart }] },
  tabs: [{ key: "leaderboard", to: "/leaderboard", label: "模型榜", icon: IconChart }],
  tools: [{ to: "/leaderboard", label: "模型榜", icon: <IconChart size={18} /> }],
});
