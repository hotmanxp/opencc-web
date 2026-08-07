// Pure type re-export — keeps `@zn-ai/zn-agent-core/opencc-server` as
// the single source of truth for plugin DTOs while the frontend
// imports from a stable shared surface.
export type {
  OpenccPluginDto as PluginDto,
  OpenccMarketplacePluginDto as MarketplacePluginDto,
  OpenccPluginActionResult as PluginActionResult,
  OpenccPluginListResult as PluginListResult,
  OpenccPluginScope as PluginScope,
  OpenccPluginComponentCounts as PluginComponentCounts,
  OpenccPluginReloadCounts as PluginReloadCounts,
  OpenccMarketplaceDto as MarketplaceDto,
  OpenccMarketplaceActionResult as MarketplaceActionResult,
} from '@zn-ai/zn-agent-core/opencc-server'
