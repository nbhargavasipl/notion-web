/**
 * Provider-independent normalized types.
 * All transcription/summary providers must produce these shapes.
 * These types are safe to serialize to Firestore or localStorage.
 */

// ── Transcript ──────────────────────────────────────────────────────────────

export interface TranscriptSegment {
  /** Stable ID used as evidence reference, e.g. "S001" */
  segmentId: string;
  /** Null when diarization is unavailable */
  speakerLabel: string | null;
  startSeconds: number;
  endSeconds: number;
  /** Text in original detected language */
  text: string;
  /** English translation; equals text when already English */
  translatedText: string;
  /** 0–1 range; null when provider does not supply confidence */
  confidence: number | null;
  /** True when segment confidence is below provider threshold */
  reviewRequired: boolean;
}

export interface NormalizedTranscript {
  provider: string;
  providerModel: string;
  detectedLanguage: string;
  /** Best-effort total; null when not returned by provider */
  durationSeconds: number | null;
  /** Full translated text (concatenation of all segments) */
  fullText: string;
  /** Full original-language text */
  originalFullText: string;
  segments: TranscriptSegment[];
  processingMetadata: {
    startedAt: string;
    completedAt: string;
    confidenceAvailable: boolean;
    diarizationAvailable: boolean;
  };
}

export interface TranscriptionInput {
  /** Raw audio bytes */
  audioBuffer: Buffer;
  mimeType: string;
  /** Hint for the provider; provider may override on detection */
  expectedLanguage?: string;
  /** When true, skip translation — summary is generated from original language text */
  skipTranslation?: boolean;
}

// ── Summary ─────────────────────────────────────────────────────────────────

export type VerificationStatus =
  | "supported"
  | "partially_supported"
  | "needs_review"
  | "unsupported";

export interface GroundedSummaryItem {
  id: string;
  text: string;
  evidenceSegmentIds: string[];
  verificationStatus: VerificationStatus;
  confidence?: number;
}

export interface GroundedActionItem extends GroundedSummaryItem {
  /** Only populated when explicitly stated in transcript */
  owner: string | null;
  /** ISO date string; only populated when explicitly stated */
  dueDate: string | null;
  /** User-toggled completion state */
  completed?: boolean;
}

/** A generated topic grouping with a meaningful heading and evidence-backed items. */
export interface SummaryTopic {
  id: string;
  title: string;
  items: GroundedSummaryItem[];
}

export interface EvidenceBackedSummary {
  executiveSummary: GroundedSummaryItem[];
  /** Legacy flat discussion points — old records only; new records use keyTopics. */
  discussionPoints: GroundedSummaryItem[];
  /** Structured topic groups with generated headings (new records). Old records will not have this. */
  keyTopics?: SummaryTopic[];
  decisions: GroundedSummaryItem[];
  actionItems: GroundedActionItem[];
  questions: GroundedSummaryItem[];
  risks: GroundedSummaryItem[];
  /**
   * Presenter suggestions and recommendations that are NOT explicit tasks.
   * Absent on old records.
   */
  recommendations?: GroundedSummaryItem[];
  /** Provider and model that generated this summary */
  provider: string;
  providerModel: string;
  generatedAt: string;
}

export interface SummaryInput {
  transcript: NormalizedTranscript;
  /** Optional meeting metadata — used as context only, never as facts */
  meetingTitle?: string;
  attendeeNames?: string[];
}

// ── Failure handling ─────────────────────────────────────────────────────────

export type ProcessingFailureCategory =
  | "quota_exceeded"
  | "rate_limited"
  | "provider_unavailable"
  | "invalid_audio"
  | "file_too_large"
  | "unsupported_format"
  | "authentication_failed"
  | "network_error"
  | "configuration_error"
  | "invalid_provider_response"
  | "unknown";

export type ProcessingStatus =
  | "not_started"
  | "queued"
  | "transcribing"
  | "transcribed"
  | "transcription_failed"
  | "summarizing"
  | "completed"
  | "summary_failed";

export interface ProcessingFailure {
  category: ProcessingFailureCategory;
  /** Safe user-facing message — never contains raw provider error details */
  userMessage: string;
  /** Technical detail for server logs only */
  technicalDetail?: string;
  retriesUsed: number;
  retryLimitReached: boolean;
}

/** Normalizes provider errors into a safe categorized failure. */
export function categorizeProviderError(err: unknown): ProcessingFailureCategory {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  // Rate-limiting (HTTP 429 is "Too Many Requests") — check before quota
  if ((msg.includes("rate") && msg.includes("limit")) || msg.includes("429")) return "rate_limited";
  if (msg.includes("quota") || msg.includes("resource_exhausted")) return "quota_exceeded";
  if (msg.includes("leaked") || msg.includes("invalid_api_key") || msg.includes("api key") || msg.includes("403") || msg.includes("401")) return "authentication_failed";
  if (msg.includes("billing") || msg.includes("prepayment") || msg.includes("credits")) return "quota_exceeded";
  if (msg.includes("too large") || msg.includes("size limit") || msg.includes("413")) return "file_too_large";
  if (msg.includes("unsupported") && msg.includes("format")) return "unsupported_format";
  if (msg.includes("unavailable") || msg.includes("503") || msg.includes("502") || msg.includes("timeout")) return "provider_unavailable";
  if (msg.includes("network") || msg.includes("fetch")) return "network_error";
  return "unknown";
}

export const USER_FACING_FAILURE_MESSAGES: Record<ProcessingFailureCategory, string> = {
  quota_exceeded:          "Free AI processing quota has been reached. Your recording has been preserved and can be retried later.",
  rate_limited:            "AI processing is temporarily busy. Your recording has been preserved and can be retried in a few minutes.",
  provider_unavailable:    "AI processing is temporarily unavailable. Your recording has been preserved and can be retried later.",
  invalid_audio:           "The audio could not be processed. Please try recording again.",
  file_too_large:          "The recording segment is too large to process. Try recording in shorter segments.",
  unsupported_format:      "The audio format is not supported by the current transcription provider.",
  authentication_failed:   "AI processing is currently unavailable in this demo. Your recording has been preserved.",
  network_error:           "A network error occurred during AI processing. Your recording has been preserved and can be retried.",
  configuration_error:     "AI processing is not configured correctly. Please contact support.",
  invalid_provider_response: "The AI service returned an unexpected response. Your recording has been preserved.",
  unknown:                 "AI processing failed. Your recording has been preserved and can be retried later.",
};

// ── Speaker mapping ──────────────────────────────────────────────────────────

export interface SpeakerMapping {
  /** e.g. "Speaker 1" as returned by provider */
  providerLabel: string;
  /** User-confirmed name, e.g. "Nidhi" */
  confirmedName: string | null;
}

// ── Usage tracking ───────────────────────────────────────────────────────────

export interface ProcessingUsageRecord {
  meetingId: string;
  applicationMode: string;
  provider: string;
  model: string;
  operation: "transcription" | "summary" | "translation";
  audioDurationSeconds: number | null;
  requestedAt: string;
  completedAt: string | null;
  status: ProcessingStatus;
  failureCategory: ProcessingFailureCategory | null;
}
