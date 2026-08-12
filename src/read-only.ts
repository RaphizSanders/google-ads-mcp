/**
 * Explicit read-only boundary for the Google Ads MCP.
 *
 * Compatibility: the mode is opt-in so existing deployments keep their current
 * behavior. Once enabled, only tools classified in GOOGLE_ADS_READ_TOOL_NAMES
 * are registered. Unknown future tools are therefore blocked by default.
 */

export const GOOGLE_ADS_READ_TOOL_NAMES = new Set([
  "list_accounts",
  "get_account_info",
  "run_gaql",
  "get_campaign_performance",
  "get_ad_group_performance",
  "get_ad_performance",
  "get_keyword_performance",
  "get_shopping_products",
  "get_device_breakdown",
  "get_daily_trend",
  "get_geo_performance",
  "get_search_terms",
  "get_purchase_conversions",
  "compare_periods",
  "get_performance_alerts",
  "get_change_history",
  "get_ad_creatives",
  "get_image_assets",
  "get_video_assets",
  "list_conversion_actions",
  "list_negative_keywords",
  "list_asset_groups",
  "get_asset_group_performance",
  "list_audience_segments",
  "list_extensions",
  "list_merchant_centers",
  "list_labels",
  "list_remarketing_lists",
  "get_account_currency",
] as const);

export const GOOGLE_ADS_WRITE_TOOL_NAMES = new Set([
  "create_campaign",
  "update_campaign",
  "update_budget",
  "create_ad_group",
  "update_ad_group",
  "create_ad",
  "update_ad_status",
  "create_keyword",
  "remove_keyword",
  "add_negative_keyword",
  "bulk_update_status",
  "upload_image_asset",
  "upload_video_asset",
  "create_pmax_campaign",
  "create_asset_group",
  "update_asset_group",
  "create_display_campaign",
  "create_responsive_display_ad",
  "create_video_campaign",
  "create_video_ad",
  "create_shopping_campaign",
  "create_demand_gen_campaign",
  "create_audience_segment",
  "update_ad_group_targeting",
  "add_placement",
  "create_sitelink_extension",
  "create_callout_extension",
  "delete_campaign",
  "delete_ad_group",
  "delete_ad",
  "set_device_bid_adjustment",
  "set_ad_schedule",
  "create_conversion_action",
  "set_listing_group_filter",
  "set_campaign_locations",
  "set_campaign_languages",
  "set_location_bid_adjustment",
  "set_age_bid_adjustment",
  "set_gender_bid_adjustment",
  "update_ad",
  "create_structured_snippet",
  "create_call_extension",
  "create_price_extension",
  "create_promotion_extension",
  "create_label",
  "assign_label",
  "create_shared_negative_list",
  "add_audience_signal",
  "create_audience_from_lists",
  "create_remarketing_list",
  "update_remarketing_list",
] as const);

export function parseReadOnlyMode(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error("GOOGLE_ADS_READ_ONLY must be one of: true, false, 1, 0");
}

export function createReadOnlyToolServer<T extends object>(server: T, readOnly: boolean): T {
  if (!readOnly) return server;

  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      const registerTool = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
      return (name: string, ...args: unknown[]) => {
        if (!GOOGLE_ADS_READ_TOOL_NAMES.has(name as never)) return undefined;
        return Reflect.apply(registerTool, target, [name, ...args]);
      };
    },
  });
}
