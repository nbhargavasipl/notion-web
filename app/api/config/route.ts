/**
 * Public configuration endpoint.
 * Exposes only safe, non-secret configuration to the frontend.
 * Never exposes API keys, service accounts, or provider-specific details.
 */

// Must run on the server at request time — env vars are not available at build time.
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerConfig } from "@/lib/config/server";

export interface PublicMosaicConfig {
  appMode: "demo" | "production";
  limits: {
    maxRecordingMinutes: number;
    maxUploadMb: number;
  };
  capabilities: {
    transcription: boolean;
    translation: boolean;
    summary: boolean;
    speakerDiarization: boolean;
    paidFallback: boolean;
  };
}

export async function GET() {
  let cfg;
  try {
    cfg = getServerConfig();
  } catch {
    // Return safe defaults if config is broken — never expose error details
    return NextResponse.json(
      {
        appMode: "demo",
        limits: { maxRecordingMinutes: 60, maxUploadMb: 100 },
        capabilities: {
          transcription: false,
          translation: false,
          summary: false,
          speakerDiarization: false,
          paidFallback: false,
        },
      } satisfies PublicMosaicConfig,
      { status: 200 }
    );
  }

  const diarizationAvailable =
    cfg.providers.transcription === "gemini"; // Gemini can separate speakers

  const publicConfig: PublicMosaicConfig = {
    appMode: cfg.appMode,
    limits: {
      maxRecordingMinutes: cfg.demoLimits.maxRecordingMinutes,
      maxUploadMb: cfg.demoLimits.maxUploadMb,
    },
    capabilities: {
      transcription: !!(cfg.keys.geminiApiKey || cfg.keys.transcriptionApiUrl),
      translation: cfg.providers.translation !== "none",
      summary: cfg.providers.summary === "claude" ? !!cfg.keys.anthropicApiKey : !!cfg.keys.geminiApiKey,
      speakerDiarization: diarizationAvailable,
      paidFallback: cfg.billing.allowPaidFallback,
    },
  };

  return NextResponse.json(publicConfig);
}
