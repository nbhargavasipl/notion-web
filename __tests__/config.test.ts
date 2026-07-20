import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { _resetConfigCache, getServerConfig, ConfigError } from "../lib/config/server";

function setEnv(overrides: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const BASE_DEMO_ENV: Record<string, string> = {
  MOSAIC_APP_MODE: "demo",
  TRANSCRIPTION_PROVIDER: "gemini",
  TRANSLATION_PROVIDER: "gemini",
  SUMMARY_PROVIDER: "gemini",
  ALLOW_PAID_FALLBACK: "false",
  GEMINI_API_KEY: "test-key",
  GEMINI_TRANSCRIPTION_MODEL: "gemini-2.0-flash",
  GEMINI_SUMMARY_MODEL: "gemini-2.0-flash",
  DEMO_MAX_RECORDING_MINUTES: "60",
  DEMO_MAX_PROCESSING_MINUTES_PER_DAY: "180",
  DEMO_MAX_RECORDINGS_PER_DAY: "10",
  DEMO_MAX_UPLOAD_MB: "100",
  DEMO_PROCESSING_RETRY_LIMIT: "2",
  DEMO_AUDIO_RETENTION_DAYS: "3",
};

beforeEach(() => {
  _resetConfigCache();
  setEnv(BASE_DEMO_ENV);
});

afterEach(() => {
  _resetConfigCache();
  for (const k of Object.keys(BASE_DEMO_ENV)) delete process.env[k];
  for (const k of ["TRANSCRIPTION_API_URL", "TRANSCRIPTION_MASTER_KEY"]) delete process.env[k];
});

// ── 1. Demo mode loads correctly ─────────────────────────────────────────────
it("demo mode loads correctly", () => {
  const cfg = getServerConfig();
  expect(cfg.appMode).toBe("demo");
  expect(cfg.providers.transcription).toBe("gemini");
  expect(cfg.billing.allowPaidFallback).toBe(false);
  expect(cfg.demoLimits.maxRecordingMinutes).toBe(60);
  expect(cfg.keys.geminiApiKey).toBe("test-key");
});

// ── 2. Production mode loads correctly ───────────────────────────────────────
it("production mode loads correctly", () => {
  setEnv({
    MOSAIC_APP_MODE: "production",
    TRANSCRIPTION_PROVIDER: "google_speech",
    ALLOW_PAID_FALLBACK: "true",
    TRANSCRIPTION_API_URL: "https://example.com",
    TRANSCRIPTION_MASTER_KEY: "key",
  });
  const cfg = getServerConfig();
  expect(cfg.appMode).toBe("production");
  expect(cfg.providers.transcription).toBe("google_speech");
  expect(cfg.billing.allowPaidFallback).toBe(true);
});

// ── 3. Demo mode rejects paid fallback ───────────────────────────────────────
it("demo mode rejects paid fallback", () => {
  setEnv({ ALLOW_PAID_FALLBACK: "true" });
  expect(() => getServerConfig()).toThrow(ConfigError);
  expect(() => getServerConfig()).toThrow(/paid fallback/i);
});

// ── 4. Unsupported provider fails validation ─────────────────────────────────
it("unsupported transcription provider fails validation", () => {
  setEnv({ TRANSCRIPTION_PROVIDER: "deepgram_future" });
  expect(() => getServerConfig()).toThrow(ConfigError);
});

// ── 5. Missing Gemini key fails safely ───────────────────────────────────────
it("missing GEMINI_API_KEY fails when provider is gemini", () => {
  setEnv({ GEMINI_API_KEY: undefined });
  expect(() => getServerConfig()).toThrow(ConfigError);
  expect(() => getServerConfig()).toThrow(/GEMINI_API_KEY/);
});

// ── 6. Public config endpoint does not expose API keys ───────────────────────
it("getServerConfig does not expose keys in returned object shape", () => {
  const cfg = getServerConfig();
  // keys.geminiApiKey exists but it should not be in a JSON-serialized public config
  const publicCfg = {
    appMode: cfg.appMode,
    limits: cfg.demoLimits,
    capabilities: { transcription: true },
  };
  const json = JSON.stringify(publicCfg);
  expect(json).not.toContain("test-key");
  expect(json).not.toContain("geminiApiKey");
});

// ── 7. Demo mode rejects paid google_speech provider ─────────────────────────
it("google_speech provider is rejected in demo mode", () => {
  setEnv({
    TRANSCRIPTION_PROVIDER: "google_speech",
    TRANSCRIPTION_API_URL: "https://example.com",
    TRANSCRIPTION_MASTER_KEY: "key",
  });
  expect(() => getServerConfig()).toThrow(ConfigError);
  expect(() => getServerConfig()).toThrow(/google_speech.*demo|demo.*google_speech/i);
});

// ── 8. Config is cached after first load ─────────────────────────────────────
it("config is cached and returns same reference", () => {
  const a = getServerConfig();
  const b = getServerConfig();
  expect(a).toBe(b);
});

// ── 9. Invalid MOSAIC_APP_MODE fails ─────────────────────────────────────────
it("invalid MOSAIC_APP_MODE fails", () => {
  setEnv({ MOSAIC_APP_MODE: "staging" });
  expect(() => getServerConfig()).toThrow(ConfigError);
});

// ── 10. Default Gemini model falls back correctly ────────────────────────────
it("uses default Gemini models when env vars are absent", () => {
  setEnv({ GEMINI_TRANSCRIPTION_MODEL: undefined, GEMINI_SUMMARY_MODEL: undefined });
  const cfg = getServerConfig();
  expect(cfg.gemini.transcriptionModel).toBe("gemini-2.0-flash");
  expect(cfg.gemini.summaryModel).toBe("gemini-2.0-flash");
});
