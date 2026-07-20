/**
 * Deterministic evidence validation.
 * Runs after summary generation regardless of provider.
 * The language model is not trusted to validate itself.
 */

import type {
  EvidenceBackedSummary,
  GroundedSummaryItem,
  GroundedActionItem,
  SummaryTopic,
  NormalizedTranscript,
} from "./types";

/**
 * Validates all evidence segment IDs in a summary against the actual transcript.
 * - Removes items with no evidence
 * - Marks items with invalid evidence IDs as "needs_review"
 * - Removes owner/dueDate unsupported by transcript content
 * Returns a cleaned, validated summary.
 */
export function validateEvidenceBackedSummary(
  summary: EvidenceBackedSummary,
  transcript: NormalizedTranscript
): EvidenceBackedSummary {
  const validIds = new Set(transcript.segments.map(s => s.segmentId));

  function validateItem(item: GroundedSummaryItem): GroundedSummaryItem | null {
    if (!item.text.trim()) return null;

    const validEvidence = item.evidenceSegmentIds.filter(id => validIds.has(id));
    const hasInvalidIds = validEvidence.length < item.evidenceSegmentIds.length;

    if (validEvidence.length === 0) {
      // No valid evidence — mark needs_review but keep (do not silently delete)
      return {
        ...item,
        evidenceSegmentIds: [],
        verificationStatus: "needs_review",
      };
    }

    return {
      ...item,
      evidenceSegmentIds: validEvidence,
      verificationStatus: hasInvalidIds ? "needs_review" : item.verificationStatus,
    };
  }

  function validateActionItem(item: GroundedActionItem): GroundedActionItem | null {
    const base = validateItem(item);
    if (!base) return null;

    // Owner requires explicit support in cited segments
    let owner = item.owner;
    if (owner && base.evidenceSegmentIds.length > 0) {
      const citedText = base.evidenceSegmentIds
        .map(id => transcript.segments.find(s => s.segmentId === id)?.translatedText ?? "")
        .join(" ")
        .toLowerCase();
      const ownerMentioned = citedText.includes(owner.toLowerCase().replace("speaker ", ""));
      if (!ownerMentioned) {
        owner = null; // cannot verify owner from cited segments — remove it
      }
    } else {
      owner = null;
    }

    // Due date requires explicit support in cited segments
    let dueDate = item.dueDate;
    if (dueDate && base.evidenceSegmentIds.length > 0) {
      const citedText = base.evidenceSegmentIds
        .map(id => transcript.segments.find(s => s.segmentId === id)?.translatedText ?? "")
        .join(" ")
        .toLowerCase();
      const datePattern = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[\/\-]\d{1,2}|next week|this week|tomorrow|by \w+day|end of \w+)\b/i;
      if (!datePattern.test(citedText)) {
        dueDate = null;
      }
    } else {
      dueDate = null;
    }

    return { ...base, owner, dueDate } as GroundedActionItem;
  }

  function filterAndValidate<T extends GroundedSummaryItem>(
    items: T[],
    validator: (item: T) => T | null
  ): T[] {
    return items.map(validator).filter((x): x is T => x !== null);
  }

  // Deduplicate by text (case-insensitive)
  function dedup<T extends GroundedSummaryItem>(items: T[]): T[] {
    const seen = new Set<string>();
    return items.filter(item => {
      const key = item.text.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Validate structured topic groups (new records)
  let validatedKeyTopics: SummaryTopic[] | undefined;
  if (summary.keyTopics !== undefined) {
    validatedKeyTopics = summary.keyTopics
      .map(topic => ({
        ...topic,
        items: dedup(filterAndValidate(topic.items, validateItem)),
      }))
      .filter(t => t.title.trim() && t.items.length > 0);
  }

  return {
    ...summary,
    executiveSummary: dedup(filterAndValidate(summary.executiveSummary, validateItem)),
    discussionPoints: dedup(filterAndValidate(summary.discussionPoints, validateItem)),
    keyTopics:        validatedKeyTopics,
    decisions:        dedup(filterAndValidate(summary.decisions, validateItem)),
    actionItems:      dedup(filterAndValidate(summary.actionItems, validateActionItem)),
    questions:        dedup(filterAndValidate(summary.questions, validateItem)),
    risks:            dedup(filterAndValidate(summary.risks, validateItem)),
    recommendations:  summary.recommendations !== undefined
      ? dedup(filterAndValidate(summary.recommendations, validateItem))
      : undefined,
  };
}

/**
 * Verifies that a summary item's text is plausibly grounded in its cited segments.
 * Returns false when key terms from the item text are absent from cited segment text.
 * This is a lightweight check — not a semantic model.
 */
export function isItemGroundedInCitedSegments(
  itemText: string,
  evidenceSegmentIds: string[],
  transcript: NormalizedTranscript
): boolean {
  if (evidenceSegmentIds.length === 0) return false;

  const citedText = evidenceSegmentIds
    .map(id => transcript.segments.find(s => s.segmentId === id)?.translatedText ?? "")
    .join(" ")
    .toLowerCase();

  // Extract meaningful words (3+ chars) from item text
  const words = itemText.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
  if (words.length === 0) return true;

  // At least 30% of key words must appear in cited segments
  const matchCount = words.filter(w => citedText.includes(w)).length;
  return matchCount / words.length >= 0.3;
}
