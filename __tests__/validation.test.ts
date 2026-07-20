import { describe, it, expect } from "vitest";
import { validateEvidenceBackedSummary, isItemGroundedInCitedSegments } from "../lib/providers/validation";
import type { EvidenceBackedSummary, NormalizedTranscript } from "../lib/providers/types";

const TRANSCRIPT: NormalizedTranscript = {
  provider: "gemini",
  providerModel: "gemini-2.0-flash",
  detectedLanguage: "English",
  durationSeconds: 120,
  fullText: "We decided to launch on Friday. Alice will review the proposal. There is a risk of delay.",
  originalFullText: "We decided to launch on Friday. Alice will review the proposal.",
  segments: [
    { segmentId: "S001", speakerLabel: "Speaker 1", startSeconds: 0, endSeconds: 5,
      text: "We decided to launch on Friday.", translatedText: "We decided to launch on Friday.", confidence: 0.95, reviewRequired: false },
    { segmentId: "S002", speakerLabel: "Speaker 2", startSeconds: 5, endSeconds: 12,
      text: "Alice will review the proposal.", translatedText: "Alice will review the proposal.", confidence: 0.90, reviewRequired: false },
    { segmentId: "S003", speakerLabel: "Speaker 1", startSeconds: 12, endSeconds: 18,
      text: "There is a risk of delay.", translatedText: "There is a risk of delay.", confidence: 0.88, reviewRequired: false },
  ],
  processingMetadata: { startedAt: "2025-01-01T10:00:00Z", completedAt: "2025-01-01T10:00:10Z", confidenceAvailable: true, diarizationAvailable: true },
};

function makeSummary(overrides: Partial<EvidenceBackedSummary> = {}): EvidenceBackedSummary {
  return {
    executiveSummary: [],
    discussionPoints: [],
    decisions: [],
    actionItems: [],
    questions: [],
    risks: [],
    provider: "gemini",
    providerModel: "gemini-2.0-flash",
    generatedAt: "2025-01-01T10:00:15Z",
    ...overrides,
  };
}

// ── 18. Every summary item requires evidence ──────────────────────────────────
describe("validateEvidenceBackedSummary", () => {
  it("item with valid evidence is preserved as-is", () => {
    const summary = makeSummary({
      decisions: [{ id: "d1", text: "Launch on Friday", evidenceSegmentIds: ["S001"], verificationStatus: "supported" }],
    });
    const result = validateEvidenceBackedSummary(summary, TRANSCRIPT);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].verificationStatus).toBe("supported");
  });

  // ── 19. Invalid evidence IDs are rejected ────────────────────────────────────
  it("invalid evidence ID downgrades to needs_review", () => {
    const summary = makeSummary({
      decisions: [{ id: "d1", text: "Some decision", evidenceSegmentIds: ["S999"], verificationStatus: "supported" }],
    });
    const result = validateEvidenceBackedSummary(summary, TRANSCRIPT);
    expect(result.decisions[0].verificationStatus).toBe("needs_review");
    expect(result.decisions[0].evidenceSegmentIds).toHaveLength(0);
  });

  // ── 20. Owner without explicit evidence is removed ────────────────────────────
  it("owner is removed when not found in cited segments", () => {
    const summary = makeSummary({
      actionItems: [{
        id: "a1", text: "Review the proposal", evidenceSegmentIds: ["S003"],
        verificationStatus: "supported", owner: "Bob", dueDate: null,
      }],
    });
    const result = validateEvidenceBackedSummary(summary, TRANSCRIPT);
    // S003 mentions "delay" not "Bob"
    expect(result.actionItems[0].owner).toBeNull();
  });

  // ── 21. Due date without explicit evidence is removed ─────────────────────────
  it("dueDate is removed when no date pattern in cited segments", () => {
    const summary = makeSummary({
      actionItems: [{
        id: "a1", text: "Review the proposal", evidenceSegmentIds: ["S002"],
        verificationStatus: "supported", owner: null, dueDate: "2025-02-01",
      }],
    });
    const result = validateEvidenceBackedSummary(summary, TRANSCRIPT);
    // S002 mentions no date
    expect(result.actionItems[0].dueDate).toBeNull();
  });

  // ── 22. Unsupported claims are not shown as confirmed ─────────────────────────
  it("empty evidence array results in needs_review, not supported", () => {
    const summary = makeSummary({
      risks: [{ id: "r1", text: "Risk of delay", evidenceSegmentIds: [], verificationStatus: "supported" }],
    });
    const result = validateEvidenceBackedSummary(summary, TRANSCRIPT);
    expect(result.risks[0].verificationStatus).toBe("needs_review");
  });

  // ── 23. Empty sections remain empty ──────────────────────────────────────────
  it("empty sections are preserved as empty", () => {
    const summary = makeSummary();
    const result = validateEvidenceBackedSummary(summary, TRANSCRIPT);
    expect(result.decisions).toHaveLength(0);
    expect(result.actionItems).toHaveLength(0);
    expect(result.questions).toHaveLength(0);
  });

  // ── 24. Empty item text is filtered ──────────────────────────────────────────
  it("items with empty text are filtered", () => {
    const summary = makeSummary({
      decisions: [{ id: "d1", text: "   ", evidenceSegmentIds: ["S001"], verificationStatus: "supported" }],
    });
    const result = validateEvidenceBackedSummary(summary, TRANSCRIPT);
    expect(result.decisions).toHaveLength(0);
  });

  // ── 25. Duplicate items are removed ──────────────────────────────────────────
  it("duplicate items are deduplicated", () => {
    const summary = makeSummary({
      decisions: [
        { id: "d1", text: "Launch on Friday", evidenceSegmentIds: ["S001"], verificationStatus: "supported" },
        { id: "d2", text: "launch on friday", evidenceSegmentIds: ["S001"], verificationStatus: "supported" },
      ],
    });
    const result = validateEvidenceBackedSummary(summary, TRANSCRIPT);
    expect(result.decisions).toHaveLength(1);
  });

  // ── Mixed valid + invalid evidence IDs ───────────────────────────────────────
  it("mixed valid/invalid IDs: valid ones kept, status downgraded to needs_review", () => {
    const summary = makeSummary({
      decisions: [{ id: "d1", text: "Launch on Friday", evidenceSegmentIds: ["S001", "S999"], verificationStatus: "supported" }],
    });
    const result = validateEvidenceBackedSummary(summary, TRANSCRIPT);
    expect(result.decisions[0].evidenceSegmentIds).toEqual(["S001"]);
    expect(result.decisions[0].verificationStatus).toBe("needs_review");
  });
});

// ── isItemGroundedInCitedSegments ─────────────────────────────────────────────
describe("isItemGroundedInCitedSegments", () => {
  it("returns true when key words appear in cited segments", () => {
    const result = isItemGroundedInCitedSegments("launch on Friday", ["S001"], TRANSCRIPT);
    expect(result).toBe(true);
  });

  it("returns false when no evidence IDs provided", () => {
    const result = isItemGroundedInCitedSegments("launch on Friday", [], TRANSCRIPT);
    expect(result).toBe(false);
  });

  it("returns false when key words are absent from cited segments", () => {
    // S003 talks about "delay", not "quarterly forecast"
    const result = isItemGroundedInCitedSegments("quarterly forecast results", ["S003"], TRANSCRIPT);
    expect(result).toBe(false);
  });
});

// ── 34. Old-format transcript compatibility ───────────────────────────────────
it("handles transcript with no segments gracefully", () => {
  const emptyTranscript: NormalizedTranscript = {
    ...TRANSCRIPT,
    segments: [],
    fullText: "Some flat text",
  };
  const summary = makeSummary({
    decisions: [{ id: "d1", text: "Some decision", evidenceSegmentIds: ["S001"], verificationStatus: "supported" }],
  });
  // Should not throw even with empty segments
  const result = validateEvidenceBackedSummary(summary, emptyTranscript);
  expect(result.decisions[0].verificationStatus).toBe("needs_review");
});
