/** Módulos de tools por área. Cada um registra as suas tools no registerGoogleAdsTools. */
import type { ToolContext } from "../tool-kit.js";
import { registerTargetingGeoTools } from "./targeting-geo.js";
import { registerBidModifiersTools } from "./bid-modifiers.js";
import { registerPlacementsBrandSafetyTools } from "./placements-brand-safety.js";
import { registerRsaAdsTools } from "./rsa-ads.js";
import { registerExtensionsTools } from "./extensions.js";
import { registerAssetLibraryTools } from "./asset-library.js";
import { registerKeywordsTools } from "./keywords.js";
import { registerNegativesTools } from "./negatives.js";
import { registerPlannerRecommendationsTools } from "./planner-recommendations.js";
import { registerBudgetsTools } from "./budgets.js";
import { registerBiddingTools } from "./bidding.js";
import { registerExperimentsTrackingTools } from "./experiments-tracking.js";
import { registerConversionsCoreTools } from "./conversions-core.js";
import { registerConversionsOfflineTools } from "./conversions-offline.js";
import { registerConversionsReportingTools } from "./conversions-reporting.js";
import { registerPmaxAssetsTools } from "./pmax-assets.js";
import { registerPmaxSignalsTools } from "./pmax-signals.js";
import { registerShoppingTools } from "./shopping.js";
import { registerRetailReportingTools } from "./retail-reporting.js";
import { registerDemandGenTools } from "./demand-gen.js";
import { registerVideoDisplayTools } from "./video-display.js";
import { registerAudiencesTools } from "./audiences.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerReportsTools } from "./reports.js";
import { registerAccountAuthTools } from "./account-auth.js";
import { registerAccountAdminTools } from "./account-admin.js";

export const TOOL_MODULES: Array<(ctx: ToolContext) => void> = [
  registerTargetingGeoTools,
  registerBidModifiersTools,
  registerPlacementsBrandSafetyTools,
  registerRsaAdsTools,
  registerExtensionsTools,
  registerAssetLibraryTools,
  registerKeywordsTools,
  registerNegativesTools,
  registerPlannerRecommendationsTools,
  registerBudgetsTools,
  registerBiddingTools,
  registerExperimentsTrackingTools,
  registerConversionsCoreTools,
  registerConversionsOfflineTools,
  registerConversionsReportingTools,
  registerPmaxAssetsTools,
  registerPmaxSignalsTools,
  registerShoppingTools,
  registerRetailReportingTools,
  registerDemandGenTools,
  registerVideoDisplayTools,
  registerAudiencesTools,
  registerDiagnosticsTools,
  registerReportsTools,
  registerAccountAuthTools,
  registerAccountAdminTools,
];
