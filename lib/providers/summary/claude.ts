import Anthropic from "@anthropic-ai/sdk";
import type {
  SummaryInput,
  EvidenceBackedSummary,
  GroundedSummaryItem,
  GroundedActionItem,
  SummaryTopic,
  NormalizedTranscript,
} from "../types";
import { categorizeProviderError, USER_FACING_FAILURE_MESSAGES } from "../types";
import { validateEvidenceBackedSummary } from "../validation";

// ── Configuration ────────────────────────────────────────────────────────────

/** Estimated character threshold before chunked processing is used (~125 k tokens). */
const CHAR_THRESHOLD = 500_000;

/** Maximum segments per analysis chunk. */
const CHUNK_SEGMENT_SIZE = 200;

// ── System prompt ─────────────────────────────────────────────────────────────

const SUMMARY_SYSTEM_PROMPT = `You are generating meeting intelligence from a supplied transcript.

Use only the transcript as factual evidence.

Do not use outside knowledge.

Do not assume that claims made by a speaker are independently verified.

Do not invent facts, decisions, tasks, owners, dates, risks, questions or recommendations.

An action item must be an explicit task, request, commitment or agreed next step.
Do not convert general advice, marketing recommendations, product benefits or hypothetical examples into action items.
When a speaker makes a suggestion without the other party explicitly accepting or committing to it, place it in "recommendations" not "actionItems".

Include an owner only when the transcript explicitly assigns or accepts the task.

Include a due date only when the transcript explicitly states it.

Every output item must cite one or more supplied transcript segment IDs.

Return an empty array when a category was not discussed.

When evidence is ambiguous, use needs_review.

Return valid JSON matching the supplied schema.`;

// ── Transcript builder ────────────────────────────────────────────────────────

function buildTranscriptText(transcript: NormalizedTranscript): string {
  if (transcript.segments.length === 0) return transcript.fullText;
  return transcript.segments
    .map(s => {
      const speaker = s.speakerLabel ? `[${s.speakerLabel}]` : "";
      return `[${s.segmentId}]${speaker} ${s.translatedText}`;
    })
    .join("\n");
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildSummaryPrompt(input: SummaryInput): string {
  const transcriptText = buildTranscriptText(input.transcript);
  const segmentIds = input.transcript.segments.map(s => s.segmentId);

  return `MEETING CONTEXT (orientation only — do not treat as confirmed facts):
Title: ${input.meetingTitle ?? "Not specified"}
Attendees: ${input.attendeeNames?.join(", ") ?? "Not specified"}

AVAILABLE SEGMENT IDs: ${segmentIds.join(", ")}

TRANSCRIPT:
${transcriptText}

Return a JSON object with exactly this structure:

{
  "executiveSummary": [
    {
      "id": "exec-1",
      "text": "3-5 sentences covering meeting purpose, major discussion, and main outcome",
      "evidenceSegmentIds": ["S001", "S002"],
      "verificationStatus": "supported"
    }
  ],
  "keyTopics": [
    {
      "id": "topic-1",
      "title": "Meaningful heading generated from the actual transcript content",
      "items": [
        {
          "id": "topic-1-item-1",
          "text": "Concise evidence-backed bullet point. Prefix speaker claims with 'The presenter stated that...' or 'According to the presentation...' when the claim is not independently verifiable.",
          "evidenceSegmentIds": ["S003"],
          "verificationStatus": "supported"
        }
      ]
    }
  ],
  "decisions": [
    {
      "id": "dec-1",
      "text": "Explicit decision or agreement made during the meeting",
      "evidenceSegmentIds": ["S005"],
      "verificationStatus": "supported"
    }
  ],
  "actionItems": [
    {
      "id": "act-1",
      "text": "Explicit task, commitment, or agreed next step — NOT a suggestion or recommendation",
      "owner": "Name if explicitly assigned or accepted, null otherwise",
      "dueDate": "Explicit date if stated (e.g. 'Friday', 'next week'), null otherwise",
      "evidenceSegmentIds": ["S007"],
      "verificationStatus": "supported"
    }
  ],
  "recommendations": [
    {
      "id": "rec-1",
      "text": "Suggestion, advice, or recommendation discussed but not assigned as an explicit task",
      "evidenceSegmentIds": ["S009"],
      "verificationStatus": "supported"
    }
  ],
  "questions": [
    {
      "id": "q-1",
      "text": "Open question that was raised but not resolved",
      "evidenceSegmentIds": ["S011"],
      "verificationStatus": "supported"
    }
  ],
  "risks": [
    {
      "id": "risk-1",
      "text": "Risk, concern, or blocker explicitly raised in the meeting",
      "evidenceSegmentIds": ["S013"],
      "verificationStatus": "supported"
    }
  ]
}

CRITICAL RULES:
- evidenceSegmentIds must only contain IDs from the AVAILABLE SEGMENT IDs list above
- owner must be null unless a person was explicitly assigned or accepted the task
- dueDate must be null unless a specific date or timeframe was explicitly stated
- Return empty arrays [] for sections with nothing to report
- verificationStatus: "supported" = clearly stated; "needs_review" = inferred or ambiguous
- keyTopics headings must reflect actual content — do not use generic titles
- Separate actionItems (explicit tasks) from recommendations (suggestions/advice)`;
}

// ── Chunk synthesis prompt ────────────────────────────────────────────────────

function buildSynthesisPrompt(chunkExecSummaries: GroundedSummaryItem[][], allSegmentIds: string[]): string {
  const sectionsText = chunkExecSummaries
    .map((items, i) => `[Section ${i + 1}]\n${items.map(it => `- ${it.text} (evidence: ${it.evidenceSegmentIds.join(", ")})`).join("\n")}`)
    .join("\n\n");

  return `The following are executive summaries from different sections of the same meeting transcript.
Segment IDs referenced come from these available IDs: ${allSegmentIds.slice(0, 100).join(", ")}${allSegmentIds.length > 100 ? "..." : ""}

${sectionsText}

Synthesize a single unified executive summary for the complete meeting.
Cover: overall purpose, major discussion themes, and main outcome.
Cite segment IDs from the section analyses above.
Return ONLY a JSON array:
[
  {
    "id": "exec-1",
    "text": "Unified summary covering the whole meeting",
    "evidenceSegmentIds": ["S001", "S050"],
    "verificationStatus": "supported"
  }
]`;
}

// ── Item coercers ─────────────────────────────────────────────────────────────

function coerceItem(raw: Record<string, unknown>, prefix: string, index: number): GroundedSummaryItem {
  return {
    id: (typeof raw.id === "string" && raw.id) ? raw.id : `${prefix}-${index + 1}`,
    text: typeof raw.text === "string" ? raw.text.trim() : "",
    evidenceSegmentIds: Array.isArray(raw.evidenceSegmentIds)
      ? (raw.evidenceSegmentIds as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    verificationStatus: (
      raw.verificationStatus === "supported" ||
      raw.verificationStatus === "partially_supported" ||
      raw.verificationStatus === "needs_review" ||
      raw.verificationStatus === "unsupported"
    ) ? raw.verificationStatus : "needs_review",
    confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
  };
}

function coerceActionItem(raw: Record<string, unknown>, index: number): GroundedActionItem {
  const base = coerceItem(raw, "act", index);
  return {
    ...base,
    owner: (typeof raw.owner === "string" && raw.owner && raw.owner.toLowerCase() !== "null") ? raw.owner : null,
    dueDate: (typeof raw.dueDate === "string" && raw.dueDate && raw.dueDate.toLowerCase() !== "null") ? raw.dueDate : null,
    completed: false,
  };
}

function coerceTopic(raw: Record<string, unknown>, index: number): SummaryTopic | null {
  if (typeof raw !== "object" || raw === null) return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  const items = Array.isArray(raw.items)
    ? (raw.items as unknown[])
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((x, i) => coerceItem(x, `topic-${index + 1}-item`, i))
        .filter(item => item.text.length > 0)
    : [];
  return {
    id: (typeof raw.id === "string" && raw.id) ? raw.id : `topic-${index + 1}`,
    title,
    items,
  };
}

// ── Raw response parser ───────────────────────────────────────────────────────

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

  const toTopics = (): SummaryTopic[] =>
    Array.isArray(r.keyTopics)
      ? (r.keyTopics as unknown[])
          .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
          .map((x, i) => coerceTopic(x, i))
          .filter((t): t is SummaryTopic => t !== null)
      : [];

  const draft: EvidenceBackedSummary = {
    executiveSummary:  toItems("executiveSummary", "exec"),
    discussionPoints:  toItems("discussionPoints", "disc"), // legacy field — Claude may not return this
    keyTopics:         toTopics(),
    decisions:         toItems("decisions", "dec"),
    actionItems:       toActionItems(),
    questions:         toItems("questions", "q"),
    risks:             toItems("risks", "risk"),
    recommendations:   toItems("recommendations", "rec"),
    provider:          "claude",
    providerModel:     "",
    generatedAt:       new Date().toISOString(),
  };

  return validateEvidenceBackedSummary(draft, transcript);
}

// ── API call helper ───────────────────────────────────────────────────────────

async function callClaude(client: Anthropic, model: string, userPrompt: string, systemPrompt: string): Promise<string> {
  const message = await client.messages.create({
    model,
    max_tokens: 8192,
    temperature: 0.05,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const block = message.content[0];
  let text = (block.type === "text" ? block.text : "").trim();
  // Strip markdown code fences if Claude wrapped the JSON
  text = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  return text;
}

// ── Single-pass summary ───────────────────────────────────────────────────────

async function singlePassSummary(
  input: SummaryInput,
  client: Anthropic,
  model: string
): Promise<EvidenceBackedSummary> {
  let rawText: string;
  try {
    rawText = await callClaude(client, model, buildSummaryPrompt(input), SUMMARY_SYSTEM_PROMPT);
  } catch (err: unknown) {
    const category = categorizeProviderError(err);
    throw Object.assign(new Error(USER_FACING_FAILURE_MESSAGES[category]), {
      failureCategory: category,
      technicalDetail: err instanceof Error ? err.message : String(err),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw Object.assign(
      new Error(USER_FACING_FAILURE_MESSAGES["invalid_provider_response"]),
      { failureCategory: "invalid_provider_response", technicalDetail: "Non-JSON summary response from Claude" }
    );
  }

  const summary = parseRawSummary(parsed, input.transcript);
  summary.providerModel = model;
  return summary;
}

// ── Chunked + synthesis summary ───────────────────────────────────────────────

function dedup<T extends { text: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = item.text.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeChunkSummaries(
  chunks: EvidenceBackedSummary[]
): Omit<EvidenceBackedSummary, "executiveSummary"> {
  // Merge keyTopics: group by normalized title
  const topicMap = new Map<string, SummaryTopic>();
  for (const chunk of chunks) {
    for (const topic of (chunk.keyTopics ?? [])) {
      const key = topic.title.toLowerCase().trim();
      const existing = topicMap.get(key);
      if (existing) {
        existing.items = dedup([...existing.items, ...topic.items]);
      } else {
        topicMap.set(key, { ...topic, items: [...topic.items] });
      }
    }
  }

  return {
    discussionPoints:  dedup(chunks.flatMap(c => c.discussionPoints)),
    keyTopics:         Array.from(topicMap.values()),
    decisions:         dedup(chunks.flatMap(c => c.decisions)),
    actionItems:       dedup(chunks.flatMap(c => c.actionItems)),
    questions:         dedup(chunks.flatMap(c => c.questions)),
    risks:             dedup(chunks.flatMap(c => c.risks)),
    recommendations:   dedup(chunks.flatMap(c => c.recommendations ?? [])),
    provider:          "claude",
    providerModel:     chunks[0]?.providerModel ?? "",
    generatedAt:       new Date().toISOString(),
  };
}

async function chunkAndSynthesize(
  input: SummaryInput,
  client: Anthropic,
  model: string
): Promise<EvidenceBackedSummary> {
  const segments = input.transcript.segments;

  // Split segments into chunks
  const chunkTranscripts: NormalizedTranscript[] = [];
  for (let i = 0; i < segments.length; i += CHUNK_SEGMENT_SIZE) {
    const chunkSegs = segments.slice(i, i + CHUNK_SEGMENT_SIZE);
    chunkTranscripts.push({
      ...input.transcript,
      segments: chunkSegs,
      fullText: chunkSegs.map(s => s.translatedText).join(" "),
      originalFullText: chunkSegs.map(s => s.text).join(" "),
    });
  }

  // Analyze each chunk sequentially to avoid parallel rate-limiting
  const chunkSummaries: EvidenceBackedSummary[] = [];
  for (const chunkTranscript of chunkTranscripts) {
    const chunkSummary = await singlePassSummary(
      { ...input, transcript: chunkTranscript },
      client,
      model
    );
    chunkSummaries.push(chunkSummary);
  }

  // Merge non-executive sections
  const merged = mergeChunkSummaries(chunkSummaries);

  // Synthesize executive summary from all chunk exec summaries
  const allSegmentIds = segments.map(s => s.segmentId);
  const chunkExecs = chunkSummaries.map(c => c.executiveSummary).filter(e => e.length > 0);
  let executiveSummary: GroundedSummaryItem[] = [];

  if (chunkExecs.length > 0) {
    try {
      const synthText = await callClaude(
        client,
        model,
        buildSynthesisPrompt(chunkExecs, allSegmentIds),
        SUMMARY_SYSTEM_PROMPT
      );
      const synthParsed = JSON.parse(synthText);
      if (Array.isArray(synthParsed)) {
        executiveSummary = (synthParsed as unknown[])
          .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
          .map((x, i) => coerceItem(x, "exec", i))
          .filter(item => item.text.length > 0);
      }
    } catch {
      // Fall back to using chunk exec summaries directly
      executiveSummary = dedup(chunkSummaries.flatMap(c => c.executiveSummary));
    }
  }

  const fullSummary: EvidenceBackedSummary = {
    executiveSummary,
    ...merged,
  };

  // Final validation against the complete original transcript
  return validateEvidenceBackedSummary(
    { ...fullSummary, providerModel: model },
    input.transcript
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function summarizeWithClaude(
  input: SummaryInput,
  apiKey: string,
  model: string
): Promise<EvidenceBackedSummary> {
  if (input.transcript.segments.length === 0 && !input.transcript.fullText.trim()) {
    return {
      executiveSummary: [],
      discussionPoints: [],
      keyTopics:         [],
      decisions:         [],
      actionItems:       [],
      questions:         [],
      risks:             [],
      recommendations:   [],
      provider:          "claude",
      providerModel:     model,
      generatedAt:       new Date().toISOString(),
    };
  }

  const client = new Anthropic({ apiKey });
  const transcriptText = buildTranscriptText(input.transcript);

  if (transcriptText.length <= CHAR_THRESHOLD) {
    const summary = await singlePassSummary(input, client, model);
    summary.providerModel = model;
    return summary;
  }

  // Large transcript — chunk and synthesize
  const summary = await chunkAndSynthesize(input, client, model);
  summary.providerModel = model;
  return summary;
}
