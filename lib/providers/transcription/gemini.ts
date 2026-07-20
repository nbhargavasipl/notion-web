/**
 * Gemini transcription provider.
 * Sends audio inline to Gemini Flash multimodal — free-tier compatible.
 * Used in demo mode; does not call Google Speech-to-Text (no paid charges).
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
  TranscriptionInput,
  NormalizedTranscript,
  TranscriptSegment,
} from "../types";
import { categorizeProviderError, USER_FACING_FAILURE_MESSAGES } from "../types";

const TRANSCRIPTION_PROMPT = `You are a professional meeting transcription assistant.

Transcribe the audio accurately. Return ONLY a valid JSON object with exactly this structure:

{
  "detectedLanguage": "English",
  "durationSeconds": 45.2,
  "segments": [
    {
      "speakerLabel": "Speaker 1",
      "startSeconds": 0.0,
      "endSeconds": 5.2,
      "text": "Original text in the detected language",
      "translatedText": "English translation (identical to text when already English)",
      "confidence": 0.95
    }
  ]
}

Rules:
- Transcribe what is actually said — do not add, infer or paraphrase
- Detect the language and report it in "detectedLanguage"
- If already in English, set translatedText equal to text
- Separate speakers as Speaker 1, Speaker 2, etc. where distinguishable
- When speakers cannot be separated, use "Speaker 1" for all segments
- Set timestamps as best estimates in seconds from start of audio
- Set confidence between 0.0 and 1.0 where available; null if unavailable
- Skip segments that are pure silence or fully inaudible
- Do not invent words for inaudible speech
- Return ONLY valid JSON — no markdown, no explanation`;

interface GeminiTranscriptSegmentRaw {
  speakerLabel?: string;
  startSeconds?: number;
  endSeconds?: number;
  text?: string;
  translatedText?: string;
  confidence?: number | null;
}

interface GeminiTranscriptRaw {
  detectedLanguage?: string;
  durationSeconds?: number | null;
  segments?: GeminiTranscriptSegmentRaw[];
}

function generateSegmentId(index: number): string {
  return `S${String(index + 1).padStart(3, "0")}`;
}

function cleanJsonResponse(text: string): string {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

export async function transcribeWithGemini(
  input: TranscriptionInput,
  apiKey: string,
  model: string
): Promise<NormalizedTranscript> {
  const startedAt = new Date().toISOString();

  const client = new GoogleGenerativeAI(apiKey);
  const genModel = client.getGenerativeModel({ model });

  const base64Audio = input.audioBuffer.toString("base64");

  let rawText: string;
  try {
    const result = await genModel.generateContent([
      {
        inlineData: {
          data: base64Audio,
          mimeType: input.mimeType,
        },
      },
      { text: TRANSCRIPTION_PROMPT },
    ]);
    rawText = result.response.text().trim();
  } catch (err: unknown) {
    const category = categorizeProviderError(err);
    throw Object.assign(new Error(USER_FACING_FAILURE_MESSAGES[category]), {
      failureCategory: category,
      technicalDetail: err instanceof Error ? err.message : String(err),
    });
  }

  let parsed: GeminiTranscriptRaw;
  try {
    parsed = JSON.parse(cleanJsonResponse(rawText)) as GeminiTranscriptRaw;
  } catch {
    throw Object.assign(
      new Error(USER_FACING_FAILURE_MESSAGES["invalid_provider_response"]),
      { failureCategory: "invalid_provider_response", technicalDetail: `Non-JSON response from ${model}` }
    );
  }

  if (!parsed.segments || !Array.isArray(parsed.segments)) {
    throw Object.assign(
      new Error(USER_FACING_FAILURE_MESSAGES["invalid_provider_response"]),
      { failureCategory: "invalid_provider_response", technicalDetail: "segments array missing from Gemini response" }
    );
  }

  const completedAt = new Date().toISOString();
  const detectedLanguage = parsed.detectedLanguage ?? "Unknown";
  const diarizationAvailable = parsed.segments.some(
    s => s.speakerLabel && s.speakerLabel !== "Speaker 1" && parsed.segments!.some(t => t.speakerLabel !== s.speakerLabel)
  );

  const skipTranslation = input.skipTranslation ?? false;

  const segments: TranscriptSegment[] = parsed.segments.map((seg, i) => {
    const text = (seg.text ?? "").trim();
    const translatedText = skipTranslation ? text : (seg.translatedText ?? text).trim();
    const confidence = typeof seg.confidence === "number" ? seg.confidence : null;
    return {
      segmentId: generateSegmentId(i),
      speakerLabel: seg.speakerLabel ?? "Speaker 1",
      startSeconds: seg.startSeconds ?? 0,
      endSeconds: seg.endSeconds ?? 0,
      text,
      translatedText,
      confidence,
      reviewRequired: confidence !== null && confidence < 0.6,
    };
  }).filter(s => s.text.length > 0);

  const fullText = segments.map(s => s.translatedText).join(" ").trim();
  const originalFullText = segments.map(s => s.text).join(" ").trim();
  const hasConfidence = segments.some(s => s.confidence !== null);

  return {
    provider: "gemini",
    providerModel: model,
    detectedLanguage,
    durationSeconds: parsed.durationSeconds ?? null,
    fullText,
    originalFullText,
    segments,
    processingMetadata: {
      startedAt,
      completedAt,
      confidenceAvailable: hasConfidence,
      diarizationAvailable,
    },
  };
}
