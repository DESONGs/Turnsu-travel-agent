function configured(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function liveState(env, key, fallback) {
  return env[key] && env[key] !== "not_run" ? env[key] : fallback;
}

function flyaiState(env) {
  if (env.TRAVEL_AGENT_FLYAI_ENABLED !== "true") return "blocked_by_configuration";
  if (!String(env.TRAVEL_AGENT_FLYAI_SMOKE_STATUS ?? "").startsWith("passed_read_only_isolated")) return "blocked_pending_read_only_smoke";
  if (configured(env.FLYAI_API_KEY)) return "available_read_only";
  return env.NODE_ENV === "production" ? "blocked_missing_api_key" : "trial_read_only";
}

function tuniuState(env) {
  if (env.TRAVEL_AGENT_TUNIU_ENABLED !== "true") return "blocked_by_configuration";
  if (!configured(env.TUNIU_API_KEY)) return "blocked_missing_api_key";
  return env.TRAVEL_AGENT_TUNIU_SMOKE_STATUS === "passed_read_only_isolated" ? "available_read_only" : "credential_configured_pending_smoke";
}

function inventoryState(flyai, tuniu) {
  if (tuniu === "available_read_only") return "available_read_only_tuniu";
  if (["available_read_only", "trial_read_only"].includes(flyai)) return flyai === "trial_read_only" ? "trial_read_only_fliggy" : "available_read_only_fliggy";
  return "blocked_pending_authorized_provider";
}

function weatherState(env) {
  if (env.TRAVEL_AGENT_AMAP_SMOKE_STATUS === "passed_live_smoke" && configured(env.AMAP_API_KEY)) return "available_amap_official";
  if (env.NODE_ENV !== "production" && env.TRAVEL_AGENT_OPEN_METEO_ENABLED !== "false") return "available_open_meteo_noncommercial_development";
  if (env.TRAVEL_AGENT_OPEN_METEO_ENABLED !== "false" && configured(env.OPEN_METEO_API_KEY)) return "available_open_meteo_commercial";
  return "blocked_pending_authorized_weather_provider";
}

function socialWorkerState(env) {
  if (env.TRAVEL_AGENT_SOCIAL_WORKER_ENABLED !== "true") return "blocked_by_configuration";
  if (env.TRAVEL_AGENT_SOCIAL_WORKER_AUDIT_STATUS !== "passed_static_audit") return "blocked_pending_static_audit";
  if (env.TRAVEL_AGENT_SOCIAL_WORKER_TERMS_STATUS !== "approved_read_only") return "blocked_pending_terms_review";
  if (!configured(env.TRAVEL_AGENT_SOCIAL_WORKER_ACCOUNT_PROFILE)) return "blocked_missing_dedicated_account";
  if (env.TRAVEL_AGENT_SOCIAL_WORKER_SMOKE_STATUS !== "passed_read_only_isolated") return "blocked_pending_isolated_smoke";
  return "worker_ready_pending_provider_routing";
}

function unavailableAuthState(reason) {
  if (reason === "https_required") return "blocked_https_required";
  if (reason === "secure_session_required") return "blocked_missing_secure_session";
  return "blocked_missing_credentials";
}

function authChannelStates(env) {
  const summary = createAuthService({ env }).providerSummary({ origin: env.TRAVEL_AGENT_PUBLIC_ORIGIN });
  const providers = new Map(summary.providers.map((provider) => [provider.id, provider]));
  const webState = (provider, smokeKey) => provider?.available === true
    ? env[smokeKey] === "passed_live_smoke" ? "passed_live_smoke" : "credential_configured_pending_smoke"
    : unavailableAuthState(provider?.unavailableReason);
  const miniState = (configured, smokeKey) => configured
    ? env[smokeKey] === "passed_live_smoke" ? "miniapp_passed_live_smoke" : "miniapp_credentials_configured_pending_smoke"
    : null;
  const combinedState = (webProvider, webSmokeKey, miniConfigured, miniSmokeKey) => {
    const web = webState(webProvider, webSmokeKey);
    const mini = miniState(miniConfigured, miniSmokeKey);
    if (webProvider?.available && miniConfigured) {
      return web === "passed_live_smoke" && mini === "miniapp_passed_live_smoke"
        ? "web_and_miniapp_passed_live_smoke"
        : "web_and_miniapp_credentials_configured_pending_smoke";
    }
    if (webProvider?.available) return web;
    if (mini) return mini;
    return web;
  };
  const googleWeb = providers.get("google");
  const wechatWeb = providers.get("wechat");
  const alipayWeb = providers.get("alipay");
  const appleWeb = providers.get("apple");
  const wechatMini = configured(env.WECHAT_MINIAPP_APP_ID) && configured(env.WECHAT_MINIAPP_APP_SECRET);
  const alipayMini = configured(env.ALIPAY_MINIAPP_APP_ID || env.ALIPAY_APP_ID)
    && configured(env.ALIPAY_MINIAPP_PRIVATE_KEY_PATH || env.ALIPAY_PRIVATE_KEY_PATH)
    && configured(env.ALIPAY_MINIAPP_PUBLIC_KEY_PATH || env.ALIPAY_PUBLIC_KEY_PATH)
    && String(env.TRAVEL_AGENT_SESSION_SECRET ?? "").length >= 32;
  return {
    google: webState(googleWeb, "TRAVEL_AGENT_GOOGLE_AUTH_SMOKE_STATUS"),
    wechat: combinedState(wechatWeb, "TRAVEL_AGENT_WECHAT_WEB_AUTH_SMOKE_STATUS", wechatMini, "TRAVEL_AGENT_WECHAT_MINIAPP_AUTH_SMOKE_STATUS"),
    alipay: combinedState(alipayWeb, "TRAVEL_AGENT_ALIPAY_WEB_AUTH_SMOKE_STATUS", alipayMini, "TRAVEL_AGENT_ALIPAY_MINIAPP_AUTH_SMOKE_STATUS"),
    apple: webState(appleWeb, "TRAVEL_AGENT_APPLE_AUTH_SMOKE_STATUS"),
  };
}

export function providerStatusSummary(env = process.env) {
  const amapJsRendererEnabled = String(env.TRAVEL_AGENT_AMAP_JS_RENDERER_ENABLED ?? "true").trim().toLowerCase() !== "false";
  const amapJsRendererConfigured = amapJsRendererEnabled && configured(env.AMAP_JS_API_KEY) && configured(env.AMAP_JS_SECURITY_CODE);
  const fliggyFlyAi = flyaiState(env);
  const tuniuOfficialMcp = tuniuState(env);
  const authorizedInventory = inventoryState(fliggyFlyAi, tuniuOfficialMcp);
  return {
    schemaVersion: "travel-provider-configuration-v1",
    routing: {
      reasoning: {
        provider: env.TRAVEL_AGENT_MODEL_PROVIDER || null,
        model: env.TRAVEL_AGENT_MODEL || null,
      },
      multimodal: {
        provider: env.TRAVEL_AGENT_VISION_PROVIDER || null,
        model: env.TRAVEL_AGENT_VISION_MODEL || null,
      },
    },
    modelSelection: publicModelSelection(env),
    model: {
      deepseek: configured(env.DEEPSEEK_API_KEY) ? liveState(env, "TRAVEL_AGENT_DEEPSEEK_SMOKE_STATUS", "credential_configured_pending_smoke") : "blocked",
      deepseekVision: configured(env.DEEPSEEK_API_KEY) ? liveState(env, "TRAVEL_AGENT_DEEPSEEK_VISION_SMOKE_STATUS", "credential_configured_pending_smoke") : "blocked",
      kimiVision: configured(env.MOONSHOT_API_KEY) ? liveState(env, "TRAVEL_AGENT_KIMI_SMOKE_STATUS", "credential_configured_pending_smoke") : "blocked",
      kimiChild: configured(env.MOONSHOT_API_KEY) && env.TRAVEL_AGENT_KIMI_CHILD_SMOKE_STATUS === "passed_live_smoke" ? "available_child_fallback" : "fallback_unavailable",
    },
    global: {
      googleMaps: env.TRAVEL_AGENT_GOOGLE_MAPS_ENABLED !== "true" ? "disabled" : env.TRAVEL_AGENT_GOOGLE_MAPS_DATA_POLICY !== "approved" ? "blocked_pending_policy_review" : configured(env.GOOGLE_MAPS_API_KEY) ? liveState(env, "TRAVEL_AGENT_GOOGLE_MAPS_SMOKE_STATUS", "configured_pending_live_acceptance") : "blocked_missing_key",
      skyscanner: env.TRAVEL_AGENT_SKYSCANNER_ENABLED === "true" && configured(env.SKYSCANNER_API_KEY) ? liveState(env, "TRAVEL_AGENT_SKYSCANNER_SMOKE_STATUS", "configured_pending_live_acceptance") : "blocked_pending_authorized_provider",
      viator: env.TRAVEL_AGENT_VIATOR_ENABLED === "true" && configured(env.VIATOR_API_KEY) ? liveState(env, "TRAVEL_AGENT_VIATOR_SMOKE_STATUS", "configured_pending_live_acceptance") : "blocked_pending_authorized_provider",
      viatorDatedAvailability: env.TRAVEL_AGENT_VIATOR_ACCESS === "full",
      currencyConversion: "ecb_daily_supported_currencies_only",
    },
    data: {
      amapOfficialMcp: configured(env.AMAP_API_KEY) ? liveState(env, "TRAVEL_AGENT_AMAP_SMOKE_STATUS", "credential_configured_pending_smoke") : "blocked",
      weather: weatherState(env),
      fliggyFlyAi,
      tuniuOfficialMcp,
      socialReadWorker: socialWorkerState(env),
      railway: authorizedInventory,
      flightsAndHotels: authorizedInventory,
    },
    mapRenderer: {
      preferred: amapJsRendererConfigured ? "amap_js" : "leaflet",
      amapJs: {
        status: !amapJsRendererEnabled
          ? "amap_js_renderer_disabled"
          : amapJsRendererConfigured
          ? liveState(env, "TRAVEL_AGENT_AMAP_JS_SMOKE_STATUS", "configured_pending_browser_smoke")
          : "amap_js_renderer_not_configured",
        publicKey: amapJsRendererConfigured ? env.AMAP_JS_API_KEY : null,
        securityServicePath: amapJsRendererConfigured ? "/_AMapService" : null,
      },
      fallback: "leaflet_or_static_map",
    },
    channels: authChannelStates(env),
  };
}
import { publicModelSelection } from "../agent/user-model-options.mjs";
import { createAuthService } from "../http/auth-providers.mjs";
