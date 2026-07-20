export type SummaryStatus =
  | "not_started"
  | "waiting_for_transcript"
  | "generating"
  | "completed"
  | "failed"
  | "needs_regeneration";

export interface AgendaItem {
  id: string;
  text: string;
  completed: boolean;
  notes: string;
}

export interface ActionItem {
  id: string;
  text: string;
  owner: string;
  completed: boolean;
}

export interface DiarizationSegment {
  speaker: string;
  start_time: number;
  end_time: number;
  original_text: string;
  translated_text: string;
}

export interface RecordingResult {
  timestamp: number;
  input_language: string;
  translated_transcript: string;
  confidence: number | null;
  low_confidence: boolean;
  segments?: DiarizationSegment[];
  // Backward-compatible metadata — absent on records saved before this was added
  recordingMode?: "mic_and_meeting" | "mic_only";
  microphoneCaptured?: boolean;
  meetingAudioCaptured?: boolean;
  meetingAudioEndedDuringRecording?: boolean;
  mimeType?: string;
  durationSeconds?: number;
  // GCS audio storage — absent on records saved before GCS was added
  chunkGcsPaths?: string[];  // ordered: recordings/{uid}/{meetingId}/chunk-{n}.webm
  audioGcsBucket?: string;
  // Normalized transcript — absent on records saved before provider abstraction was added
  normalizedTranscript?: import("./providers/types").NormalizedTranscript;
}

// ── Processing status ────────────────────────────────────────────────────────

export type ProcessingStatus =
  | "not_started"
  | "queued"
  | "transcribing"
  | "transcribed"
  | "transcription_failed"
  | "summarizing"
  | "completed"
  | "summary_failed";

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

export interface ProcessingState {
  status: ProcessingStatus;
  failureCategory?: ProcessingFailureCategory;
  userMessage?: string;
  retriesUsed: number;
  lastAttemptAt?: number;
}

export interface TimelineEvent {
  id: string;
  type: 'created' | 'note_added' | 'recording_started' | 'recording_done' | 'summary_generated' | 'agenda_item_added' | 'action_created';
  description: string;
  timestamp: number;
}

export interface MeetingLocalData {
  eventId: string;
  title?: string;
  meetingType: string;
  purpose: string;
  objectives: string;
  expectedOutcomes: string;
  agenda: AgendaItem[];
  notes: string;
  actionItems: ActionItem[];
  openQuestions: string[];
  risks: string[];
  recording: RecordingResult | null;
  /** Legacy flat-summary shape; kept for records saved before evidence-backed summaries */
  aiSummary: { execSummary: string; topics: string[]; actions: string[]; questions: string[]; risks: string[] } | null;
  /** Evidence-backed summary from the new provider architecture */
  evidenceSummary?: import("./providers/types").EvidenceBackedSummary;
  /** Processing state for retry/failure tracking */
  processingState?: ProcessingState;
  /** User-confirmed speaker name mappings */
  speakerMappings?: Array<{ providerLabel: string; confirmedName: string | null }>;
  timeline: TimelineEvent[];
  isPinned: boolean;
  tags: string[];
  createdAt: number;
}

const KEY = (id: string) => `mosaic_meeting_${id}`;

export function loadMeetingData(eventId: string): MeetingLocalData {
  try {
    const raw = localStorage.getItem(KEY(eventId));
    if (raw) return JSON.parse(raw) as MeetingLocalData;
  } catch {}
  const now = Date.now();
  return {
    eventId,
    meetingType: 'General',
    purpose: '',
    objectives: '',
    expectedOutcomes: '',
    agenda: [],
    notes: '',
    actionItems: [],
    openQuestions: [],
    risks: [],
    recording: null,
    aiSummary: null,
    timeline: [{ id: String(now), type: 'created', description: 'Meeting workspace opened', timestamp: now }],
    isPinned: false,
    tags: [],
    createdAt: now,
  };
}

export function saveMeetingData(data: MeetingLocalData): void {
  localStorage.setItem(KEY(data.eventId), JSON.stringify(data));
}

export function addTimelineEvent(
  data: MeetingLocalData,
  type: TimelineEvent['type'],
  description: string
): MeetingLocalData {
  return {
    ...data,
    timeline: [
      ...data.timeline,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, type, description, timestamp: Date.now() },
    ],
  };
}

export function listLocalMeetingIds(): string[] {
  const ids: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('mosaic_meeting_')) ids.push(key.slice('mosaic_meeting_'.length));
  }
  return ids;
}

export function parseSummary(text: string) {
  if (!text) return { execSummary: '', topics: [], questions: [], actions: [], risks: [] };

  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const execCount = Math.max(1, Math.min(3, Math.ceil(sentences.length * 0.25)));
  const execSummary = sentences.slice(0, execCount).join(' ').trim();

  const questions = sentences
    .filter(s => s.trim().endsWith('?'))
    .map(s => s.trim());

  const actions = sentences
    .filter(s => /\b(will|should|need to|must|action|todo|follow.?up|assign|responsible)\b/i.test(s))
    .map(s => s.trim());

  const risks = sentences
    .filter(s => /\b(risk|concern|issue|blocker|problem|challenge|dependency|unresolved)\b/i.test(s))
    .map(s => s.trim());

  const body = sentences.slice(execCount);
  const chunkSize = Math.max(1, Math.ceil(body.length / 3));
  const topics = [];
  for (let i = 0; i < body.length; i += chunkSize) {
    topics.push(body.slice(i, i + chunkSize).join(' ').trim());
  }

  return { execSummary, topics, questions, actions, risks };
}
