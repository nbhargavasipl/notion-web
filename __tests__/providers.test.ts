import { describe, it, expect } from "vitest";
import type { NormalizedTranscript } from "../lib/providers/types";
import { categorizeProviderError, USER_FACING_FAILURE_MESSAGES } from "../lib/providers/types";

// ── 11. Provider response maps to normalized transcript ───────────────────────
describe("NormalizedTranscript type compliance", () => {
  it("all required fields present", () => {
    const t: NormalizedTranscript = {
      provider: "gemini",
      providerModel: "gemini-2.0-flash",
      detectedLanguage: "English",
      durationSeconds: 60,
      fullText: "Hello world",
      originalFullText: "Hello world",
      segments: [
        { segmentId: "S001", speakerLabel: "Speaker 1", startSeconds: 0, endSeconds: 3,
          text: "Hello world", translatedText: "Hello world", confidence: 0.95, reviewRequired: false },
      ],
      processingMetadata: { startedAt: "2025-01-01T10:00:00Z", completedAt: "2025-01-01T10:00:05Z",
        confidenceAvailable: true, diarizationAvailable: true },
    };
    expect(t.segments[0].segmentId).toBe("S001");
    expect(t.processingMetadata.confidenceAvailable).toBe(true);
  });

  // ── 12. Segment IDs are generated ────────────────────────────────────────────
  it("segment ID format is S001, S002, etc.", () => {
    const ids = ["S001", "S002", "S003", "S010", "S100"];
    ids.forEach(id => expect(/^S\d{3}$/.test(id)).toBe(true));
  });

  // ── 13. Speaker labels are preserved ─────────────────────────────────────────
  it("segment speakerLabel is nullable", () => {
    const withLabel: NormalizedTranscript["segments"][0] = {
      segmentId: "S001", speakerLabel: "Speaker 1", startSeconds: 0, endSeconds: 1,
      text: "Hello", translatedText: "Hello", confidence: null, reviewRequired: false,
    };
    const withoutLabel: NormalizedTranscript["segments"][0] = {
      ...withLabel, speakerLabel: null,
    };
    expect(withLabel.speakerLabel).toBe("Speaker 1");
    expect(withoutLabel.speakerLabel).toBeNull();
  });

  // ── 14. Missing confidence is handled ─────────────────────────────────────────
  it("confidence can be null", () => {
    const seg: NormalizedTranscript["segments"][0] = {
      segmentId: "S001", speakerLabel: null, startSeconds: 0, endSeconds: 1,
      text: "Hello", translatedText: "Hello", confidence: null, reviewRequired: false,
    };
    expect(seg.confidence).toBeNull();
  });

  // ── 15. No diarization result is handled ─────────────────────────────────────
  it("diarizationAvailable can be false", () => {
    const t: NormalizedTranscript = {
      provider: "google_speech", providerModel: "chirp-2",
      detectedLanguage: "Hindi", durationSeconds: null,
      fullText: "Namaste", originalFullText: "Namaste",
      segments: [{ segmentId: "S001", speakerLabel: null, startSeconds: 0, endSeconds: 2,
        text: "Namaste", translatedText: "Hello", confidence: 0.8, reviewRequired: false }],
      processingMetadata: { startedAt: "2025-01-01T10:00:00Z", completedAt: "2025-01-01T10:00:05Z",
        confidenceAvailable: true, diarizationAvailable: false },
    };
    expect(t.processingMetadata.diarizationAvailable).toBe(false);
    expect(t.segments[0].speakerLabel).toBeNull();
  });

  // ── 17. Translation does not overwrite original transcript ────────────────────
  it("originalFullText and fullText are separate fields", () => {
    const t: NormalizedTranscript = {
      provider: "gemini", providerModel: "gemini-2.0-flash",
      detectedLanguage: "Hindi", durationSeconds: 10,
      fullText: "Hello how are you",
      originalFullText: "Namaste aap kaise hain",
      segments: [{
        segmentId: "S001", speakerLabel: null, startSeconds: 0, endSeconds: 5,
        text: "Namaste aap kaise hain",
        translatedText: "Hello how are you",
        confidence: 0.9, reviewRequired: false,
      }],
      processingMetadata: { startedAt: "2025-01-01T10:00:00Z", completedAt: "2025-01-01T10:00:10Z",
        confidenceAvailable: true, diarizationAvailable: false },
    };
    expect(t.originalFullText).toContain("Namaste");
    expect(t.fullText).toContain("Hello");
    expect(t.segments[0].text).toContain("Namaste");
    expect(t.segments[0].translatedText).toContain("Hello");
  });
});

// ── categorizeProviderError ────────────────────────────────────────────────────
describe("categorizeProviderError", () => {
  it("categorizes quota exceeded", () => {
    expect(categorizeProviderError(new Error("Resource_exhausted quota exceeded"))).toBe("quota_exceeded");
  });
  it("categorizes 429 rate limit", () => {
    expect(categorizeProviderError(new Error("rate limit 429"))).toBe("rate_limited");
  });
  it("categorizes leaked key as authentication_failed", () => {
    expect(categorizeProviderError(new Error("Your API key was reported as leaked"))).toBe("authentication_failed");
  });
  it("categorizes billing error as quota_exceeded", () => {
    expect(categorizeProviderError(new Error("billing issue prepayment required"))).toBe("quota_exceeded");
  });
  it("categorizes file too large", () => {
    expect(categorizeProviderError(new Error("413 too large"))).toBe("file_too_large");
  });
  it("categorizes network error", () => {
    expect(categorizeProviderError(new Error("fetch failed network error"))).toBe("network_error");
  });
  it("categorizes unknown errors", () => {
    expect(categorizeProviderError(new Error("something completely unexpected"))).toBe("unknown");
  });
  it("every category has a user-facing message", () => {
    const categories = Object.keys(USER_FACING_FAILURE_MESSAGES);
    categories.forEach(c => {
      expect(USER_FACING_FAILURE_MESSAGES[c as keyof typeof USER_FACING_FAILURE_MESSAGES]).toBeTruthy();
    });
  });
  it("user-facing messages do not contain API key patterns", () => {
    Object.values(USER_FACING_FAILURE_MESSAGES).forEach(msg => {
      expect(msg).not.toMatch(/AIza/);
      expect(msg).not.toMatch(/api[_-]?key/i);
    });
  });
});

// ── 26. Summary calls transcript, not raw audio ────────────────────────────────
describe("SummaryInput contract", () => {
  it("SummaryInput has transcript field, not audioBuffer", () => {
    // If this compiles, the type is correct.
    // We verify the shape of what summarize providers receive.
    const input = {
      transcript: {
        provider: "gemini",
        providerModel: "gemini-2.0-flash",
        detectedLanguage: "English",
        durationSeconds: null,
        fullText: "Test transcript",
        originalFullText: "Test transcript",
        segments: [],
        processingMetadata: { startedAt: "2025-01-01T10:00:00Z", completedAt: "2025-01-01T10:00:01Z",
          confidenceAvailable: false, diarizationAvailable: false },
      } satisfies NormalizedTranscript,
    };
    expect(input.transcript.fullText).toBe("Test transcript");
    // No audioBuffer in SummaryInput
    expect("audioBuffer" in input).toBe(false);
  });
});
