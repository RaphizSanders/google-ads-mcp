/** Junta os catálogos dos módulos em src/tools/ (sem outras dependências, para não criar ciclo). */
import { catalog as targetingGeo } from "./targeting-geo.catalog.js";
import { catalog as bidModifiers } from "./bid-modifiers.catalog.js";
import { catalog as placementsBrandSafety } from "./placements-brand-safety.catalog.js";
import { catalog as rsaAds } from "./rsa-ads.catalog.js";
import { catalog as extensions } from "./extensions.catalog.js";
import { catalog as assetLibrary } from "./asset-library.catalog.js";
import { catalog as keywords } from "./keywords.catalog.js";
import { catalog as negatives } from "./negatives.catalog.js";
import { catalog as plannerRecommendations } from "./planner-recommendations.catalog.js";
import { catalog as budgets } from "./budgets.catalog.js";
import { catalog as bidding } from "./bidding.catalog.js";
import { catalog as experimentsTracking } from "./experiments-tracking.catalog.js";
import { catalog as conversionsCore } from "./conversions-core.catalog.js";
import { catalog as conversionsOffline } from "./conversions-offline.catalog.js";
import { catalog as conversionsReporting } from "./conversions-reporting.catalog.js";
import { catalog as pmaxAssets } from "./pmax-assets.catalog.js";
import { catalog as pmaxSignals } from "./pmax-signals.catalog.js";
import { catalog as shopping } from "./shopping.catalog.js";
import { catalog as retailReporting } from "./retail-reporting.catalog.js";
import { catalog as demandGen } from "./demand-gen.catalog.js";
import { catalog as videoDisplay } from "./video-display.catalog.js";
import { catalog as audiences } from "./audiences.catalog.js";
import { catalog as diagnostics } from "./diagnostics.catalog.js";
import { catalog as reports } from "./reports.catalog.js";
import { catalog as accountAuth } from "./account-auth.catalog.js";
import { catalog as accountAdmin } from "./account-admin.catalog.js";

const CATALOGS = [
  targetingGeo,
  bidModifiers,
  placementsBrandSafety,
  rsaAds,
  extensions,
  assetLibrary,
  keywords,
  negatives,
  plannerRecommendations,
  budgets,
  bidding,
  experimentsTracking,
  conversionsCore,
  conversionsOffline,
  conversionsReporting,
  pmaxAssets,
  pmaxSignals,
  shopping,
  retailReporting,
  demandGen,
  videoDisplay,
  audiences,
  diagnostics,
  reports,
  accountAuth,
  accountAdmin,
];

export const MODULE_READ_TOOLS: string[] = CATALOGS.flatMap((c) => c.read);
export const MODULE_WRITE_TOOLS: string[] = CATALOGS.flatMap((c) => c.write);
export const MODULE_CHAINED_WRITE_TOOLS: string[] = CATALOGS.flatMap((c) => c.chained);
