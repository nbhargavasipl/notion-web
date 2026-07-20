/**
 * Google Speech-to-Text provider via the existing MOSAIC-Transcript proxy.
 * Active in production mode only. Creates paid GCP charges.
 * In demo mode this provider must never be instantiated.
 */

import type { TranscriptionInput, NormalizedTranscript, TranscriptSegment } from "../types";
import { categorizeProviderError, USER_FACING_FAILURE_MESSAGES } from "../types";

function generateSegmentId(index: number): string {
  return `S${String(index + 1).padStart(3, "0")}`;
}

interface GoogleSpeechProxyResponse {
  success?: boolean;
  input_language?: string;
  original_transcript?: string;
  translated_transcript?: string;
  confidence?: number | null;
  low_confidence?: boolean;
  error?: string;
  message?: string;
}

export async function transcribeWithGoogleSpeechProxy(
  input: TranscriptionInput,
  apiUrl: string,
  apiKey: string
): Promise<NormalizedTranscript> {
  const startedAt = new Date().toISOString();

  const blob = new Blob([new Uint8Array(input.audioBuffer)], { type: input.mimeType });
  const form = new FormData();
  form.append("file", blob, "audio.webm");

  const skipTranslation = input.skipTranslation ?? false;
  const proxyUrl = `${apiUrl.replace(/\/$/, "")}/?target_language=en${skipTranslation ? "&skip_translation=true" : ""}`;

  let proxyResponse: Response;
  try {
    proxyResponse = await fetch(proxyUrl, {
      method: "POST",
      headers: { "X-API-Key": apiKey },
      body: form,
    });
  } catch (err: unknown) {
    const category = categorizeProviderError(err);
    throw Object.assign(new Error(USER_FACING_FAILURE_MESSAGES[category]), {
      failureCategory: category,
      technicalDetail: err instanceof Error ? err.message : String(err),
    });
  }

  let data: GoogleSpeechProxyResponse;
  try {
    data = (await proxyResponse.json()) as GoogleSpeechProxyResponse;
  } catch {
    throw Object.assign(
      new Error(USER_FACING_FAILURE_MESSAGES["invalid_provider_response"]),
      { failureCategory: "invalid_provider_response", technicalDetail: `HTTP ${proxyResponse.status}` }
    );
  }

  if (!proxyResponse.ok || data.success === false) {
    const raw = data.error ?? data.message ?? `HTTP ${proxyResponse.status}`;
    const category = categorizeProviderError(new Error(raw));
    throw Object.assign(new Error(USER_FACING_FAILURE_MESSAGES[category]), {
      failureCategory: category,
      technicalDetail: raw,
    });
  }

  const completedAt = new Date().toISOString();
  const originalText = data.original_transcript ?? data.translated_transcript ?? "";
  const translatedText = skipTranslation
    ? originalText
    : (data.translated_transcript ?? originalText);
  const confidence = data.confidence ?? null;

  const segment: TranscriptSegment = {
    segmentId: generateSegmentId(0),
    speakerLabel: null,
    startSeconds: 0,
    endSeconds: 0,
    text: originalText,
    translatedText,
    confidence,
    reviewRequired: !!data.low_confidence,
  };

  return {
    provider: "google_speech",
    providerModel: "chirp-2",
    detectedLanguage: data.input_language ?? "Unknown",
    durationSeconds: null,
    fullText: translatedText,
    originalFullText: originalText,
    segments: [segment],
    processingMetadata: {
      startedAt,
      completedAt,
      confidenceAvailable: confidence !== null,
      diarizationAvailable: false,
    },
  };
}
