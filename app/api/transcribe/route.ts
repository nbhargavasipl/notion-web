import { NextResponse } from "next/server";
import { getSession } from "@/lib/firebase/session";
import { getServerConfig } from "@/lib/config/server";
import { createTranscriptionProvider, logUsage } from "@/lib/providers/factory";
import { categorizeProviderError, USER_FACING_FAILURE_MESSAGES } from "@/lib/providers/types";
import type { NormalizedTranscript } from "@/lib/providers/types";

const MAX_BYTES = 150 * 1024 * 1024; // 150 MB hard ceiling

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let cfg;
  try {
    cfg = getServerConfig();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Configuration error";
    console.error("[transcribe] Config error:", msg);
    return NextResponse.json(
      { success: false, error: "Service not configured correctly.", failureCategory: "configuration_error" },
      { status: 503 }
    );
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const meetingId = (formData.get("meetingId") as string | null) ?? "unknown";
  const skipTranslation = formData.get("skipTranslation") === "true";

  if (!file) {
    return NextResponse.json({ success: false, error: "No audio file provided." }, { status: 400 });
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { success: false, error: USER_FACING_FAILURE_MESSAGES["file_too_large"], failureCategory: "file_too_large" },
      { status: 413 }
    );
  }

  const maxBytes = cfg.demoLimits.maxUploadMb * 1024 * 1024;
  if (cfg.appMode === "demo" && file.size > maxBytes) {
    return NextResponse.json(
      {
        success: false,
        error: `Recording exceeds the ${cfg.demoLimits.maxUploadMb} MB demo limit.`,
        failureCategory: "file_too_large",
      },
      { status: 413 }
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = Buffer.from(arrayBuffer);
  const mimeType = file.type || "audio/webm";

  const provider = createTranscriptionProvider();
  const startedAt = new Date().toISOString();

  let normalizedTranscript: NormalizedTranscript;
  try {
    normalizedTranscript = await provider.transcribe({ audioBuffer, mimeType, skipTranslation });
  } catch (err: unknown) {
    const category =
      (err as { failureCategory?: string }).failureCategory
        ? ((err as { failureCategory: string }).failureCategory as ReturnType<typeof categorizeProviderError>)
        : categorizeProviderError(err);
    const userMessage = USER_FACING_FAILURE_MESSAGES[category];
    const technical = (err as { technicalDetail?: string }).technicalDetail ?? (err instanceof Error ? err.message : String(err));

    console.error("[transcribe] Provider error:", { category, provider: provider.providerName, technical });

    logUsage({
      meetingId,
      operation: "transcription",
      provider: provider.providerName,
      model: cfg.providers.transcription === "gemini" ? cfg.gemini.transcriptionModel : "google_speech_proxy",
      status: "transcription_failed",
      failureCategory: category,
    });

    return NextResponse.json(
      { success: false, error: userMessage, failureCategory: category },
      { status: 502 }
    );
  }

  logUsage({
    meetingId,
    operation: "transcription",
    provider: provider.providerName,
    model: normalizedTranscript.providerModel,
    status: "transcribed",
    failureCategory: null,
    audioDurationSeconds: normalizedTranscript.durationSeconds,
  });

  // Backward-compatible response: old fields + new normalizedTranscript
  return NextResponse.json({
    success: true,
    // Legacy fields (MeetingWorkspace reads these)
    input_language: normalizedTranscript.detectedLanguage,
    translated_transcript: normalizedTranscript.fullText,
    confidence: normalizedTranscript.segments[0]?.confidence ?? null,
    low_confidence: normalizedTranscript.segments.some(s => s.reviewRequired),
    // New normalized transcript for evidence-backed summaries
    normalizedTranscript,
    // Metadata
    provider: provider.providerName,
    startedAt,
    completedAt: normalizedTranscript.processingMetadata.completedAt,
  });
}
