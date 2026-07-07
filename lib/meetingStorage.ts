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

export interface RecordingResult {
  timestamp: number;
  input_language: string;
  translated_transcript: string;
  confidence: number | null;
  low_confidence: boolean;
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
      { id: String(Date.now()), type, description, timestamp: Date.now() },
    ],
  };
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
