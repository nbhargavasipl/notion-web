/**
 * Gemini evidence-backed summary provider.
 * Every generated claim must reference transcript segment IDs.
 * Evidence is validated deterministically after generation.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
  SummaryInput,
  EvidenceBackedSummary,
  GroundedSummaryItem,
  GroundedActionItem,
  NormalizedTranscript,
} from "../types";
import { categorizeProviderError, USER_FACING_FAILURE_MESSAGES } from "../types";
import { validateEvidenceBackedSummary } from "../validation";

const SUMMARY_SYSTEM_INSTRUCTION = `You are a precise meeting analyst.

CRITICAL RULES:
1. Use ONLY the supplied transcript as your factual source.
2. Do not add facts, names, deadlines or decisions that are not explicitly in the transcript.
3. Every item you generate MUST reference segment IDs (e.g. "S001") from the transcript.
4. When information is missing or unclear, return null, an empty array [], or "Not specified".
5. Never infer an owner, deadline, decision or commitment that was not stated.
6. Do not generate placeholder content to fill sections.
7. Return ONLY valid JSON — no markdown, no explanation.`;

function buildTranscriptText(transcript: NormalizedTranscript): string {
  if (transcript.segments.length === 0) return transcript.fullText;
  return transcript.segments
    .map(s => {
      const speaker = s.speakerLabel ? `[${s.speakerLabel}]` : "";
      return `[${s.segmentId}]${speaker} ${s.translatedText}`;
    })
    .join("\n");
}

function buildSummaryPrompt(input: SummaryInput): string {
  const transcriptText = buildTranscriptText(input.transcript);
  const segmentIds = input.transcript.segments.map(s => s.segmentId);

  return `${SUMMARY_SYSTEM_INSTRUCTION}

MEETING CONTEXT (for orientation only — do not treat as confirmed facts):
Title: ${input.meetingTitle ?? "Not specified"}
Attendees: ${input.attendeeNames?.join(", ") ?? "Not specified"}

TRANSCRIPT SEGMENT IDs AVAILABLE: ${segmentIds.join(", ")}

TRANSCRIPT:
${transcriptText}

Return a JSON object with exactly this structure:

{
  "executiveSummary": [
    {
      "id": "exec-1",
      "text": "2-3 sentence summary grounded in transcript",
      "evidenceSegmentIds": ["S001", "S002"],
      "verificationStatus": "supported"
    }
  ],
  "discussionPoints": [
    {
      "id": "disc-1",
      "text": "Topic discussed",
      "evidenceSegmentIds": ["S003"],
      "verificationStatus": "supported"
    }
  ],
  "decisions": [
    {
      "id": "dec-1",
      "text": "Decision made (quote directly or paraphrase conservatively)",
      "evidenceSegmentIds": ["S005"],
      "verificationStatus": "supported"
    }
  ],
  "actionItems": [
    {
      "id": "act-1",
      "text": "Action to be taken",
      "owner": "Speaker 1 or name if stated, null otherwise",
      "dueDate": "ISO date if stated, null otherwise",
      "evidenceSegmentIds": ["S007"],
      "verificationStatus": "supported"
    }
  ],
  "questions": [
    {
      "id": "q-1",
      "text": "Open question raised",
      "evidenceSegmentIds": ["S009"],
      "verificationStatus": "supported"
    }
  ],
  "risks": [
    {
      "id": "risk-1",
      "text": "Risk, blocker or concern raised",
      "evidenceSegmentIds": ["S011"],
      "verificationStatus": "supported"
    }
  ]
}

Rules:
- evidenceSegmentIds must only contain IDs from: ${segmentIds.join(", ")}
- owner must be null unless a person was explicitly assigned
- dueDate must be null unless a date was explicitly stated
- Return empty arrays [] for sections with nothing to report
- verificationStatus: "supported" when clearly in transcript, "needs_review" when inferred`;
}

function cleanJson(text: string): string {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function coerceItem(raw: Record<string, unknown>, prefix: string, index: number): GroundedSummaryItem {
  return {
    id: (typeof raw.id === "string" && raw.id) ? raw.id : `${prefix}-${index + 1}`,
    text: typeof raw.text === "string" ? raw.text.trim() : "",
    evidenceSegmentIds: Array.isArray(raw.evidenceSegmentIds)
      ? (raw.evidenceSegmentIds as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    verificationStatus: (raw.verificationStatus === "supported" || raw.verificationStatus === "partially_supported" || raw.verificationStatus === "needs_review" || raw.verificationStatus === "unsupported")
      ? raw.verificationStatus
      : "needs_review",
    confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
  };
}

function coerceActionItem(raw: Record<string, unknown>, index: number): GroundedActionItem {
  const base = coerceItem(raw, "act", index);
  return {
    ...base,
    owner: (typeof raw.owner === "string" && raw.owner && raw.owner.toLowerCase() !== "null") ? raw.owner : null,
    dueDate: (typeof raw.dueDate === "string" && raw.dueDate && raw.dueDate.toLowerCase() !== "null") ? raw.dueDate : null,
  };
}

function parseRawSummary(raw: unknown, transcript: NormalizedTranscript): EvidenceBackedSummary {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Summary response is not an object");
  }
  const r = raw as Record<string, unknown>;

  const toItems = (field: string, prefix: string): GroundedSummaryItem[] =>
    Array.isArray(r[field])
      ? (r[field] as unknown[])
          .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
          .map((x, i) => coerceItem(x, prefix, i))
          .filter(item => item.text.length > 0)
      : [];

  const toActionItems = (): GroundedActionItem[] =>
    Array.isArray(r.actionItems)
      ? (r.actionItems as unknown[])
          .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
          .map((x, i) => coerceActionItem(x, i))
          .filter(item => item.text.length > 0)
      : [];

  const draft: EvidenceBackedSummary = {
    executiveSummary: toItems("executiveSummary", "exec"),
    discussionPoints: toItems("discussionPoints", "disc"),
    decisions: toItems("decisions", "dec"),
    actionItems: toActionItems(),
    questions: toItems("questions", "q"),
    risks: toItems("risks", "risk"),
    provider: "gemini",
    providerModel: "",
    generatedAt: new Date().toISOString(),
  };

  return validateEvidenceBackedSummary(draft, transcript);
}

export async function summarizeWithGemini(
  input: SummaryInput,
  apiKey: string,
  model: string
): Promise<EvidenceBackedSummary> {
  if (input.transcript.segments.length === 0 && !input.transcript.fullText.trim()) {
    return {
      executiveSummary: [],
      discussionPoints: [],
      decisions: [],
      actionItems: [],
      questions: [],
      risks: [],
      provider: "gemini",
      providerModel: model,
      generatedAt: new Date().toISOString(),
    };
  }

  const client = new GoogleGenerativeAI(apiKey);
  const genModel = client.getGenerativeModel({
    model,
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  });

  let rawText: string;
  try {
    const result = await genModel.generateContent(buildSummaryPrompt(input));
    rawText = result.response.text().trim();
  } catch (err: unknown) {
    const category = categorizeProviderError(err);
    throw Object.assign(new Error(USER_FACING_FAILURE_MESSAGES[category]), {
      failureCategory: category,
      technicalDetail: err instanceof Error ? err.message : String(err),
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleanJson(rawText));
  } catch {
    throw Object.assign(
      new Error(USER_FACING_FAILURE_MESSAGES["invalid_provider_response"]),
      { failureCategory: "invalid_provider_response", technicalDetail: "Non-JSON summary response from Gemini" }
    );
  }

  const summary = parseRawSummary(parsedJson, input.transcript);
  summary.providerModel = model;
  return summary;
}
