/**
 * Provider factories.
 * All provider instantiation goes through here.
 * Components and API routes never import provider implementations directly.
 */

import { getServerConfig } from "../config/server";
import type { TranscriptionInput, SummaryInput, NormalizedTranscript, EvidenceBackedSummary } from "./types";
import { transcribeWithGemini } from "./transcription/gemini";
import { transcribeWithGoogleSpeechProxy } from "./transcription/google-speech-proxy";
import { summarizeWithGemini } from "./summary/gemini";
import { summarizeWithClaude } from "./summary/claude";

export interface TranscriptionProviderInstance {
  transcribe(input: TranscriptionInput): Promise<NormalizedTranscript>;
  providerName: string;
}

export interface SummaryProviderInstance {
  summarize(input: SummaryInput): Promise<EvidenceBackedSummary>;
  providerName: string;
}

export function createTranscriptionProvider(): TranscriptionProviderInstance {
  const cfg = getServerConfig();

  switch (cfg.providers.transcription) {
    case "gemini": {
      if (!cfg.keys.geminiApiKey) throw new Error("GEMINI_API_KEY missing");
      const key = cfg.keys.geminiApiKey;
      const model = cfg.gemini.transcriptionModel;
      return {
        providerName: "gemini",
        transcribe: (input) => transcribeWithGemini(input, key, model),
      };
    }
    case "google_speech": {
      if (!cfg.keys.transcriptionApiUrl || !cfg.keys.transcriptionMasterKey) {
        throw new Error("TRANSCRIPTION_API_URL or TRANSCRIPTION_MASTER_KEY missing");
      }
      const url = cfg.keys.transcriptionApiUrl;
      const masterKey = cfg.keys.transcriptionMasterKey;
      return {
        providerName: "google_speech",
        transcribe: (input) => transcribeWithGoogleSpeechProxy(input, url, masterKey),
      };
    }
    default:
      throw new Error(`Unknown transcription provider: ${cfg.providers.transcription}`);
  }
}

export function createSummaryProvider(): SummaryProviderInstance {
  const cfg = getServerConfig();

  switch (cfg.providers.summary) {
    case "gemini": {
      if (!cfg.keys.geminiApiKey) throw new Error("GEMINI_API_KEY missing");
      const key = cfg.keys.geminiApiKey;
      const model = cfg.gemini.summaryModel;
      return {
        providerName: "gemini",
        summarize: (input) => summarizeWithGemini(input, key, model),
      };
    }
    case "claude": {
      if (!cfg.keys.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY missing");
      const key = cfg.keys.anthropicApiKey;
      const model = cfg.claude.summaryModel;
      return {
        providerName: "claude",
        summarize: (input) => summarizeWithClaude(input, key, model),
      };
    }
    default:
      throw new Error(`Unknown summary provider: ${cfg.providers.summary}`);
  }
}

/** Log usage record to server console (replace with DB/queue in production). */
export function logUsage(record: {
  meetingId: string;
  operation: string;
  provider: string;
  model: string;
  status: string;
  failureCategory?: string | null;
  audioDurationSeconds?: number | null;
}): void {
  const entry = {
    ...record,
    applicationMode: getServerConfig().appMode,
    timestamp: new Date().toISOString(),
  };
  console.log("[MOSAIC:usage]", JSON.stringify(entry));
}
