/**
 * Central validated server configuration.
 * All environment variable access happens here — nowhere else.
 * Never import this from client-side code.
 */

export type AppMode = "demo" | "production";
export type TranscriptionProvider = "gemini" | "google_speech";
export type TranslationProvider = "gemini" | "google_translate" | "none";
export type SummaryProvider = "gemini" | "claude";

export interface MosaicServerConfig {
  appMode: AppMode;
  providers: {
    transcription: TranscriptionProvider;
    translation: TranslationProvider;
    summary: SummaryProvider;
  };
  billing: {
    allowPaidFallback: boolean;
  };
  demoLimits: {
    maxRecordingMinutes: number;
    maxProcessingMinutesPerDay: number;
    maxRecordingsPerDay: number;
    maxUploadMb: number;
    retryLimit: number;
    audioRetentionDays: number;
  };
  keys: {
    geminiApiKey?: string;
    anthropicApiKey?: string;
    transcriptionApiUrl?: string;
    transcriptionMasterKey?: string;
    gcsBucket?: string;
  };
  gemini: {
    transcriptionModel: string;
    summaryModel: string;
  };
  claude: {
    summaryModel: string;
  };
  summary: {
    verificationEnabled: boolean;
  };
}

function envStr(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new ConfigError(`Missing required environment variable: ${key}`);
  return val;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0) throw new ConfigError(`${key} must be a non-negative integer, got: ${raw}`);
  return n;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw.toLowerCase() === "true";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function validateConfig(cfg: MosaicServerConfig): void {
  const { appMode, providers, billing, keys } = cfg;

  if (billing.allowPaidFallback && appMode === "demo") {
    throw new ConfigError("Paid fallback (ALLOW_PAID_FALLBACK) cannot be enabled in demo mode.");
  }

  if (appMode === "demo" && providers.transcription === "google_speech") {
    throw new ConfigError(
      "google_speech is a paid provider and cannot be the transcription provider in demo mode. " +
      "Set TRANSCRIPTION_PROVIDER=gemini or switch to MOSAIC_APP_MODE=production."
    );
  }

  const needsGemini =
    providers.transcription === "gemini" ||
    providers.translation === "gemini" ||
    providers.summary === "gemini";

  if (needsGemini && !keys.geminiApiKey) {
    throw new ConfigError(
      "GEMINI_API_KEY is required when any provider is set to 'gemini'."
    );
  }

  if (providers.summary === "claude" && !keys.anthropicApiKey) {
    throw new ConfigError("ANTHROPIC_API_KEY is required when SUMMARY_PROVIDER=claude.");
  }

  if (providers.transcription === "google_speech") {
    if (!keys.transcriptionApiUrl) {
      throw new ConfigError("TRANSCRIPTION_API_URL is required for google_speech provider.");
    }
    if (!keys.transcriptionMasterKey) {
      throw new ConfigError("TRANSCRIPTION_MASTER_KEY is required for google_speech provider.");
    }
  }

  if (cfg.demoLimits.maxRecordingMinutes <= 0) {
    throw new ConfigError("DEMO_MAX_RECORDING_MINUTES must be > 0.");
  }
  if (cfg.demoLimits.maxUploadMb <= 0) {
    throw new ConfigError("DEMO_MAX_UPLOAD_MB must be > 0.");
  }
}

let _cache: MosaicServerConfig | null = null;

export function getServerConfig(): MosaicServerConfig {
  if (_cache) return _cache;

  const appMode = envStr("MOSAIC_APP_MODE", "demo") as AppMode;
  if (appMode !== "demo" && appMode !== "production") {
    throw new ConfigError(`MOSAIC_APP_MODE must be 'demo' or 'production', got: '${appMode}'`);
  }

  const transcriptionProvider = envStr("TRANSCRIPTION_PROVIDER", "gemini") as TranscriptionProvider;
  const translationProvider   = envStr("TRANSLATION_PROVIDER", "gemini") as TranslationProvider;
  const summaryProvider       = envStr("SUMMARY_PROVIDER", "gemini") as SummaryProvider;

  const supportedTranscription: TranscriptionProvider[] = ["gemini", "google_speech"];
  const supportedTranslation: TranslationProvider[]     = ["gemini", "google_translate", "none"];
  const supportedSummary: SummaryProvider[]             = ["gemini", "claude"];

  if (!supportedTranscription.includes(transcriptionProvider)) {
    throw new ConfigError(`Unsupported TRANSCRIPTION_PROVIDER: '${transcriptionProvider}'. Supported: ${supportedTranscription.join(", ")}`);
  }
  if (!supportedTranslation.includes(translationProvider)) {
    throw new ConfigError(`Unsupported TRANSLATION_PROVIDER: '${translationProvider}'. Supported: ${supportedTranslation.join(", ")}`);
  }
  if (!supportedSummary.includes(summaryProvider)) {
    throw new ConfigError(`Unsupported SUMMARY_PROVIDER: '${summaryProvider}'. Supported: ${supportedSummary.join(", ")}`);
  }

  const cfg: MosaicServerConfig = {
    appMode,
    providers: {
      transcription: transcriptionProvider,
      translation: translationProvider,
      summary: summaryProvider,
    },
    billing: {
      allowPaidFallback: envBool("ALLOW_PAID_FALLBACK", false),
    },
    demoLimits: {
      maxRecordingMinutes:        envInt("DEMO_MAX_RECORDING_MINUTES", 60),
      maxProcessingMinutesPerDay: envInt("DEMO_MAX_PROCESSING_MINUTES_PER_DAY", 180),
      maxRecordingsPerDay:        envInt("DEMO_MAX_RECORDINGS_PER_DAY", 10),
      maxUploadMb:                envInt("DEMO_MAX_UPLOAD_MB", 100),
      retryLimit:                 envInt("DEMO_PROCESSING_RETRY_LIMIT", 2),
      audioRetentionDays:         envInt("DEMO_AUDIO_RETENTION_DAYS", 3),
    },
    keys: {
      geminiApiKey:           process.env.GEMINI_API_KEY,
      anthropicApiKey:        process.env.ANTHROPIC_API_KEY,
      transcriptionApiUrl:    process.env.TRANSCRIPTION_API_URL,
      transcriptionMasterKey: process.env.TRANSCRIPTION_MASTER_KEY,
      gcsBucket:              process.env.GCS_RECORDINGS_BUCKET,
    },
    gemini: {
      transcriptionModel: envStr("GEMINI_TRANSCRIPTION_MODEL", "gemini-2.0-flash"),
      summaryModel:       envStr("GEMINI_SUMMARY_MODEL", "gemini-2.0-flash"),
    },
    claude: {
      summaryModel: envStr("CLAUDE_SUMMARY_MODEL", "claude-sonnet-4-6"),
    },
    summary: {
      verificationEnabled: envBool("SUMMARY_VERIFICATION_ENABLED", false),
    },
  };

  validateConfig(cfg);
  _cache = cfg;
  return cfg;
}

/** Reset cached config — for testing only. */
export function _resetConfigCache(): void {
  _cache = null;
}
