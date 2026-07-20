import { NextResponse } from "next/server";
import { getSession } from "@/lib/firebase/session";
import { getServerConfig } from "@/lib/config/server";
import { createSummaryProvider, logUsage } from "@/lib/providers/factory";
import { categorizeProviderError, USER_FACING_FAILURE_MESSAGES } from "@/lib/providers/types";
import type { NormalizedTranscript, EvidenceBackedSummary } from "@/lib/providers/types";

interface SummarizeBody {
  /** New path: full normalized transcript with segment IDs */
  normalizedTranscript?: NormalizedTranscript;
  /** Legacy path: flat transcript string (old recordings without segments) */
  transcript?: string;
  segments?: Array<{ speaker: string; translated_text: string }>;
  meetingTitle?: string;
  meetingId?: string;
}

/** Build a minimal NormalizedTranscript from a flat legacy transcript string. */
function legacyTranscriptToNormalized(text: string, segments?: SummarizeBody["segments"]): NormalizedTranscript {
  const now = new Date().toISOString();

  if (segments && segments.length > 0) {
    return {
      provider: "legacy",
      providerModel: "unknown",
      detectedLanguage: "Unknown",
      durationSeconds: null,
      fullText: segments.map(s => s.translated_text).join(" "),
      originalFullText: segments.map(s => s.translated_text).join(" "),
      segments: segments.map((seg, i) => ({
        segmentId: `S${String(i + 1).padStart(3, "0")}`,
        speakerLabel: `Speaker ${seg.speaker}`,
        startSeconds: 0,
        endSeconds: 0,
        text: seg.translated_text,
        translatedText: seg.translated_text,
        confidence: null,
        reviewRequired: false,
      })),
      processingMetadata: { startedAt: now, completedAt: now, confidenceAvailable: false, diarizationAvailable: true },
    };
  }

  return {
    provider: "legacy",
    providerModel: "unknown",
    detectedLanguage: "Unknown",
    durationSeconds: null,
    fullText: text,
    originalFullText: text,
    segments: [
      {
        segmentId: "S001",
        speakerLabel: null,
        startSeconds: 0,
        endSeconds: 0,
        text,
        translatedText: text,
        confidence: null,
        reviewRequired: false,
      },
    ],
    processingMetadata: { startedAt: now, completedAt: now, confidenceAvailable: false, diarizationAvailable: false },
  };
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let cfg;
  try {
    cfg = getServerConfig();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Configuration error";
    console.error("[summarize] Config error:", msg);
    return NextResponse.json(
      { error: "Service not configured correctly.", failureCategory: "configuration_error" },
      { status: 503 }
    );
  }

  const body = (await request.json()) as SummarizeBody;
  const meetingId = body.meetingId ?? "unknown";

  // Resolve transcript — prefer new normalized format, fall back to legacy
  let transcript: NormalizedTranscript;
  if (body.normalizedTranscript) {
    transcript = body.normalizedTranscript;
  } else if (body.transcript?.trim()) {
    transcript = legacyTranscriptToNormalized(body.transcript, body.segments);
  } else {
    return NextResponse.json({ error: "transcript is required" }, { status: 400 });
  }

  const provider = createSummaryProvider();
  const providerModel = cfg.providers.summary === "claude" ? cfg.claude.summaryModel : cfg.gemini.summaryModel;

  let summary: EvidenceBackedSummary;
  try {
    summary = await provider.summarize({
      transcript,
      meetingTitle: body.meetingTitle,
    });
  } catch (err: unknown) {
    const category =
      (err as { failureCategory?: string }).failureCategory
        ? ((err as { failureCategory: string }).failureCategory as ReturnType<typeof categorizeProviderError>)
        : categorizeProviderError(err);
    const userMessage = USER_FACING_FAILURE_MESSAGES[category];
    const technical = (err as { technicalDetail?: string }).technicalDetail ?? (err instanceof Error ? err.message : String(err));

    console.error("[summarize] Provider error:", { category, provider: provider.providerName, technical });

    logUsage({
      meetingId,
      operation: "summary",
      provider: provider.providerName,
      model: providerModel,
      status: "summary_failed",
      failureCategory: category,
    });

    return NextResponse.json(
      { error: userMessage, failureCategory: category },
      { status: 502 }
    );
  }

  logUsage({
    meetingId,
    operation: "summary",
    provider: provider.providerName,
    model: summary.providerModel,
    status: "completed",
    failureCategory: null,
  });

  return NextResponse.json(summary);
}
