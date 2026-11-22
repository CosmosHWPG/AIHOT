// Deliberate CoreScope divergence from the pinned upstream migration history. SQL files stay immutable.
import { createHash } from 'node:crypto';

export const CORESCOPE_MIGRATION_UPSTREAM = 'aec61a4cca18ff1521f4d32040ba5ee1750d9017';
export interface MigrationHold { sha256: string; reason: string }

export const CORESCOPE_MIGRATION_HOLDS: Readonly<Record<string, MigrationHold>> = {
  "0044_leaderboard_model_names.sql": {
    "sha256": "d3fd4b47a969951faecfac68341de4c8c6de4a98e6d50c722b79324b5661528f",
    "reason": "Preserve CoreScope model names and provider ownership; upstream site-specific model rewrites are not a schema prerequisite."
  },
  "0045_drop_topics.sql": {
    "sha256": "d0e3032f59a4ed94ecd3b5b01eb055aecdfd50c34e547904ecb26166e46b358f",
    "reason": "Preserve the existing legacy topic catalogue alongside industry/topics.json."
  },
  "0049_drop_leaderboard_usd_prices.sql": {
    "sha256": "f93baa42020356b9eae8992b8ca061b0f226012591501bb8d0faaee3a69350d7",
    "reason": "Preserve legacy leaderboard price evidence."
  },
  "0050_drop_lb_rankings_unused_columns.sql": {
    "sha256": "abf9bad287d3c0de652d888499a87733da389e3fc202599d1c63e1d0b9a5f75e",
    "reason": "Preserve stored leaderboard confidence and component evidence."
  },
  "0051_drop_unused_state.sql": {
    "sha256": "a2335f91576fc4942ef7dbaebf5e48b795334f305bb037934744be2d187ec229",
    "reason": "Preserve CoreScope topic/regroup/store state, story status/context, source provenance, translation receipts, admin roles and service price evidence."
  },
  "0052_drop_lb_prices_verified_on.sql": {
    "sha256": "ffaa28844eb07b2d9950438804c264cfba7307c6ee38075aa4b4882c0310b8ed",
    "reason": "Preserve leaderboard price verification dates."
  },
  "0053_drop_leaderboard_monitor.sql": {
    "sha256": "7acc2e44c8b969b575ddef584aa12e2a463ed596b6a5388706f833f5441a7286",
    "reason": "Preserve leaderboard, monitor and FX rows and their settings; these CoreScope features are retained."
  },
  "0146_drop_admin_sessions_auth_claims.sql": {
    "sha256": "e45eadcfaf34f8e79f3728ccb5fab101c469c2d5e963b361757196ed33cfb70e",
    "reason": "Preserve legacy session authentication evidence."
  },
  "0147_drop_admin_users_feishu_union_id.sql": {
    "sha256": "50aebaeecd78fc18e3701927d4a1b561c4917116b82fb8f02c91c358845cdbd4",
    "reason": "Preserve existing administrator identities."
  },
  "0149_admin_sessions_auth_method_drop_check.sql": {
    "sha256": "6a9ba17825b57cd22ac40ca0d02838eef1d19821c6f6e5bf8957c8f7aa955f62",
    "reason": "Keep the password/Feishu constraint installed by 0054; its password-only replacement is held as well."
  },
  "0150_admin_sessions_auth_method_add_check.sql": {
    "sha256": "3145b0e6a6aaabc5e6192910d041ab590dd2bdfdd185ce2b21571effcc1be2ef",
    "reason": "Do not reject retained historical Feishu sessions; 0054 already supplies the required password-compatible constraint."
  },
  "0153_drop_sources_first_party.sql": {
    "sha256": "d2144450fc216296081ffac81bef1c6968ae677c69310041187c70178a1216d3",
    "reason": "Preserve explicit source first-party attribution independently of tier."
  },
  "0154_drop_stories_action.sql": {
    "sha256": "1247a9cecdfeb8a083f4f1d4afcd577a812366b7c89354af4ed00b6a789ef49a",
    "reason": "Preserve stored story action evidence."
  },
  "0155_drop_stories_frame.sql": {
    "sha256": "fdf91bb9a15760f36b8225feda761213080632e7a8ff773b30b83f0910981403",
    "reason": "Preserve stored story frame evidence."
  },
  "0156_drop_facts_version.sql": {
    "sha256": "7e6c37f65d22142ac697abd4d8c5fd80a175f9ff8bb591201157cb83e505fabc",
    "reason": "Preserve existing fact version identifiers."
  },
  "0157_drop_deliveries_origin.sql": {
    "sha256": "3126294e717474b75b52aa015f1317c5b7c077e4b771c2425a392cf5c08762cc",
    "reason": "Preserve delivery provenance."
  },
  "0158_drop_receipts_origin.sql": {
    "sha256": "32e4c25767d8d01cdd177d9c136037a6edb6fac5b7ebcb7850be855255ad9522",
    "reason": "Preserve the paid receipt ledger and provenance."
  },
  "0162_drop_stories_latest.sql": {
    "sha256": "db78b73d177b9c9012f996b8231e73e31d479c55c0ad387c17f011868a9ccccf",
    "reason": "Preserve legacy story latest text."
  },
  "0163_drop_story_digests_latest.sql": {
    "sha256": "e53b3bc56da3c75d12510af38a37928ad2e1d54ca10daa1743926e609fae5d3b",
    "reason": "Preserve legacy digest latest text."
  },
  "0164_drop_reports_model.sql": {
    "sha256": "73024e8145f80b8feb742dfaf6fa534605db3d78a140849fc5a02c82e9847d8e",
    "reason": "Preserve historical report model evidence."
  },
  "0165_drop_reports_origin.sql": {
    "sha256": "2725accbc628af5b60913ecffa79f30a34a4e3fb2bdeb936c2e47a6714afa9b7",
    "reason": "Preserve report provenance."
  },
  "0169_drop_selected_ledger_visible_at.sql": {
    "sha256": "386779623996b0a8d6bbc0190b531bd43d9b8d306a3693e96dc62fbec12d75a9",
    "reason": "Preserve historical selected visibility timestamps and their index."
  }
};

/** Only CRLF/LF transport differences are normalized; every other SQL byte must match the reviewed file. */
export function migrationSqlHash(text: string): string {
  return createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');
}

export function coreScopeMigrationHold(name: string, text: string): MigrationHold | null {
  const hold = CORESCOPE_MIGRATION_HOLDS[name];
  if (!hold) return null;
  if (migrationSqlHash(text) !== hold.sha256) throw new Error(`${name}: held upstream SQL differs from its audited SHA256; review it before any migration`);
  return hold;
}
