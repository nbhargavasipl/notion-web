"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarEvent, fetchCalendarEvent, detectPlatform,
  fmtEventTime, fmtDuration, isOngoing, isUpcoming,
} from "@/lib/googleCalendar";
import {
  MeetingLocalData, AgendaItem, ActionItem, TimelineEvent,
  RecordingResult, loadMeetingData, saveMeetingData,
  addTimelineEvent, parseSummary,
} from "@/lib/meetingStorage";

// ── Constants ──────────────────────────────────────────────────────────────────
const MEETING_TYPES = ["General", "Standup", "Client Meeting", "Sprint Review", "Planning", "Retrospective", "1:1", "Interview", "Workshop", "Demo"];

const PLATFORM_COLORS: Record<string, string> = {
  "Google Meet":     "#4ade80",
  "Microsoft Teams": "#818cf8",
  "Zoom":            "#60a5fa",
  "Webex":           "#f59e0b",
};

type Tab = "overview" | "agenda" | "notes" | "recording" | "summary" | "timeline";

function fmtTs(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDate(ts: number) {
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}
function avatarInitials(email: string, name?: string) {
  if (name) return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  return email.slice(0, 2).toUpperCase();
}
function uid() { return Math.random().toString(36).slice(2, 9); }

// ── Main Component ─────────────────────────────────────────────────────────────
export default function MeetingWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [event,     setEvent]     = useState<CalendarEvent | null>(null);
  const [data,      setData]      = useState<MeetingLocalData | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [saved,     setSaved]     = useState(true);
  const [loading,   setLoading]   = useState(true);

  // Recording state
  const [recStatus,  setRecStatus]  = useState<"idle" | "recording" | "processing" | "done" | "error">("idle");
  const [elapsed,    setElapsed]    = useState(0);
  const [transcript, setTranscript] = useState<RecordingResult | null>(null);
  const [recError,   setRecError]   = useState<string | null>(null);

  const [audioMode, setAudioMode] = useState<"full" | "mic">("mic");

  const mediaRef      = useRef<MediaRecorder | null>(null);
  const chunks        = useRef<Blob[]>([]);
  const streamRef     = useRef<MediaStream | null>(null);
  const displayRef    = useRef<MediaStream | null>(null);
  const audioCtxRef   = useRef<AudioContext | null>(null);
  const timerRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const saveTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load event + data ───────────────────────────────────────────────────────
  useEffect(() => {
    const cached = localStorage.getItem(`mosaic_event_${eventId}`);
    if (cached) setEvent(JSON.parse(cached) as CalendarEvent);

    const token = localStorage.getItem("googleCalendarToken");
    if (token) {
      fetchCalendarEvent(token, eventId).then(ev => {
        if (ev) { setEvent(ev); localStorage.setItem(`mosaic_event_${eventId}`, JSON.stringify(ev)); }
      });
    }

    const d = loadMeetingData(eventId);
    setData(d);
    if (d.recording) { setTranscript(d.recording); setRecStatus("done"); }

    // Quick recordings (no calendar event) jump straight to recording tab
    if (eventId.startsWith("quick-") && !d.recording) setActiveTab("recording");
    setLoading(false);
  }, [eventId]);

  // ── Auto-save ───────────────────────────────────────────────────────────────
  const update = useCallback((patch: Partial<MeetingLocalData>) => {
    setData(prev => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      setSaved(false);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => { saveMeetingData(next); setSaved(true); }, 800);
      return next;
    });
  }, []);

  const pushTimeline = useCallback((type: TimelineEvent["type"], description: string) => {
    setData(prev => {
      if (!prev) return prev;
      const next = addTimelineEvent(prev, type, description);
      saveMeetingData(next);
      return next;
    });
  }, []);

  // ── Recording ───────────────────────────────────────────────────────────────
  const startRecording = async () => {
    if (!event) return;
    chunks.current = [];
    setRecError(null);

    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const dest = ctx.createMediaStreamDestination();

    try {
      // Always get microphone (local voice)
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = micStream;
      ctx.createMediaStreamSource(micStream).connect(dest);

      // Try to capture system/meeting audio via screen share
      let capturedFull = false;
      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,   // required by most browsers; we stop the tracks immediately
          audio: true,
        });
        displayRef.current = displayStream;

        // Stop video tracks — we only need the audio
        displayStream.getVideoTracks().forEach(t => t.stop());

        if (displayStream.getAudioTracks().length > 0) {
          ctx.createMediaStreamSource(displayStream).connect(dest);
          capturedFull = true;
        }
      } catch {
        // User cancelled the screen-share dialog — fall back to mic only
      }

      setAudioMode(capturedFull ? "full" : "mic");

      // Record the mixed stream
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus" : "audio/webm";
      const mr = new MediaRecorder(dest.stream, { mimeType: mime });
      mediaRef.current = mr;
      mr.ondataavailable = e => { if (e.data.size > 0) chunks.current.push(e.data); };
      mr.onstop = () => { ctx.close(); uploadRecording(event); };
      mr.start(1000);

      let secs = 0;
      timerRef.current = setInterval(() => { secs++; setElapsed(secs); }, 1000);
      setElapsed(0);
      setRecStatus("recording");
      setActiveTab("recording");
      pushTimeline("recording_started", `Recording started (${capturedFull ? "mic + meeting audio" : "mic only"})`);
    } catch (err: any) {
      ctx.close();
      streamRef.current?.getTracks().forEach(t => t.stop());
      displayRef.current?.getTracks().forEach(t => t.stop());
      setRecStatus("error");
      setRecError(err.name === "NotAllowedError" ? "Microphone access denied." : err.message ?? "Could not start recording.");
    }
  };

  const stopRecording = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    displayRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current?.getTracks().forEach(t => t.stop());
    mediaRef.current?.stop();
    setRecStatus("processing");
  };

  const uploadRecording = async (ev: CalendarEvent) => {
    try {
      const blob = new Blob(chunks.current, { type: "audio/webm" });
      const form = new FormData();
      form.append("file", new File([blob], `meeting-${ev.id}.webm`, { type: "audio/webm" }));
      const res  = await fetch("/api/transcribe", { method: "POST", body: form });
      const json = await res.json();
      if (!json.success) throw new Error(json.message || `Error ${res.status}`);
      const result: RecordingResult = { ...json, timestamp: Date.now() };
      setTranscript(result);
      setRecStatus("done");
      setActiveTab("summary");
      setData(prev => {
        if (!prev) return prev;
        const next = addTimelineEvent({ ...prev, recording: result }, "recording_done", "Recording completed and transcribed");
        saveMeetingData(next);
        return next;
      });
    } catch (e: any) {
      setRecStatus("error");
      setRecError(e.message || "Upload failed.");
    }
  };

  const fmt = (s: number) => `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

  if (loading || !data) {
    return <div className="min-h-screen bg-black flex items-center justify-center text-gray-600 text-sm">Loading…</div>;
  }

  const platform   = event ? detectPlatform(event) : "Meeting";
  const ongoing    = event ? isOngoing(event) : false;
  const upcoming   = event ? isUpcoming(event) : false;
  const attendees  = event?.attendees ?? [];
  const statusLabel = ongoing ? "Live" : upcoming ? "Starting soon" : "Upcoming";
  const statusCls   = ongoing ? "bg-green-500/20 text-green-400 border-green-500/30" :
                      upcoming ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" :
                      "bg-gray-800 text-gray-500 border-gray-700";

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-black text-white">

      {/* ── Header ── */}
      <div className="border-b border-gray-800 bg-black sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-4 min-w-0">
              <button
                onClick={() => router.push("/meetings")}
                className="mt-0.5 text-gray-600 hover:text-gray-300 transition flex-shrink-0"
              >
                ← Meetings
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  {event ? (
                    <h1 className="text-xl font-bold text-white truncate">{event.summary}</h1>
                  ) : (
                    <input
                      value={data.title ?? ""}
                      onChange={e => update({ title: e.target.value })}
                      placeholder="Meeting title…"
                      className="text-xl font-bold text-white bg-transparent outline-none border-b border-transparent focus:border-gray-700 transition placeholder-gray-700 min-w-[200px]"
                    />
                  )}
                  {event && (
                    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${statusCls}`}>
                      {statusLabel}
                    </span>
                  )}
                  {ongoing && <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />}
                  {!event && (
                    <span className="text-[11px] text-gray-600 bg-gray-800 px-2 py-0.5 rounded-full">Ad-hoc</span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                  {event && <>
                    <span>{new Date(event.start.dateTime!).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span>
                    <span>·</span>
                    <span>{fmtEventTime(event)}</span>
                    <span>·</span>
                    <span>{fmtDuration(event)}</span>
                    <span>·</span>
                    <span style={{ color: PLATFORM_COLORS[platform] ?? "#888" }}>{platform}</span>
                  </>}
                  {!event && <span className="text-gray-600">{new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span>}
                  <select
                    value={data.meetingType}
                    onChange={e => update({ meetingType: e.target.value })}
                    className="bg-transparent text-gray-500 hover:text-gray-300 text-xs border-none outline-none cursor-pointer"
                  >
                    {MEETING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Attendees */}
              {attendees.length > 0 && (
                <div className="flex items-center mr-2">
                  {attendees.slice(0, 4).map((a, i) => (
                    <div
                      key={i}
                      title={a.displayName ?? a.email}
                      className="w-7 h-7 rounded-full bg-gray-700 border-2 border-black flex items-center justify-center text-[10px] font-bold text-gray-300 -ml-1.5 first:ml-0"
                    >
                      {avatarInitials(a.email, a.displayName)}
                    </div>
                  ))}
                  {attendees.length > 4 && (
                    <div className="w-7 h-7 rounded-full bg-gray-800 border-2 border-black flex items-center justify-center text-[10px] text-gray-500 -ml-1.5">
                      +{attendees.length - 4}
                    </div>
                  )}
                </div>
              )}

              {/* Pin */}
              <button
                onClick={() => update({ isPinned: !data.isPinned })}
                title={data.isPinned ? "Unpin" : "Pin"}
                className={`text-lg transition ${data.isPinned ? "text-yellow-400" : "text-gray-700 hover:text-gray-400"}`}
              >
                ★
              </button>

              {/* Save indicator */}
              <span className="text-xs text-gray-700 ml-1">{saved ? "Saved" : "Saving…"}</span>

              {/* Join link */}
              {event?.hangoutLink && (
                <a
                  href={event.hangoutLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg font-medium transition"
                >
                  Join Meeting
                </a>
              )}

              {/* Quick record */}
              {recStatus === "idle" && (
                <button
                  onClick={startRecording}
                  className="text-xs bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded-lg font-medium transition"
                >
                  ⏺ Record
                </button>
              )}
              {recStatus === "recording" && (
                <>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${audioMode === "full" ? "bg-green-500/20 text-green-400" : "bg-yellow-500/20 text-yellow-400"}`}>
                    {audioMode === "full" ? "Full audio" : "Mic only"}
                  </span>
                  <button
                    onClick={stopRecording}
                    className="text-xs border border-red-500 text-red-400 px-3 py-1.5 rounded-lg font-medium hover:bg-red-950 transition"
                  >
                    ⏹ {fmt(elapsed)}
                  </button>
                </>
              )}
              {recStatus === "processing" && (
                <span className="text-xs text-yellow-400">Transcribing…</span>
              )}
            </div>
          </div>
        </div>

        {/* ── Tab bar ── */}
        <div className="max-w-5xl mx-auto px-6">
          <div className="flex gap-0 border-b border-gray-800 -mb-px">
            {(["overview", "agenda", "notes", "recording", "summary", "timeline"] as Tab[]).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-3 text-sm font-medium capitalize border-b-2 transition ${
                  activeTab === tab
                    ? "border-white text-white"
                    : "border-transparent text-gray-600 hover:text-gray-400"
                } ${tab === "summary" && recStatus === "done" ? "text-green-400" : ""}`}
              >
                {tab}
                {tab === "recording" && recStatus === "recording" && (
                  <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse inline-block" />
                )}
                {tab === "summary" && recStatus === "done" && " ✓"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Tab Content ── */}
      <div className="max-w-5xl mx-auto px-6 py-8">

        {/* OVERVIEW */}
        {activeTab === "overview" && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="md:col-span-2 flex flex-col gap-6">
              <Section title="Purpose">
                <textarea
                  value={data.purpose}
                  onChange={e => update({ purpose: e.target.value })}
                  placeholder="What is this meeting about? Why is it being held?"
                  className="w-full bg-transparent text-gray-300 placeholder-gray-700 text-sm leading-relaxed resize-none outline-none min-h-[80px]"
                  rows={3}
                />
              </Section>
              <Section title="Objectives">
                <textarea
                  value={data.objectives}
                  onChange={e => update({ objectives: e.target.value })}
                  placeholder="What do we want to achieve by the end of this meeting?"
                  className="w-full bg-transparent text-gray-300 placeholder-gray-700 text-sm leading-relaxed resize-none outline-none min-h-[80px]"
                  rows={3}
                />
              </Section>
              <Section title="Expected Outcomes">
                <textarea
                  value={data.expectedOutcomes}
                  onChange={e => update({ expectedOutcomes: e.target.value })}
                  placeholder="What decisions, deliverables, or next steps are expected?"
                  className="w-full bg-transparent text-gray-300 placeholder-gray-700 text-sm leading-relaxed resize-none outline-none min-h-[80px]"
                  rows={3}
                />
              </Section>
            </div>

            <div className="flex flex-col gap-4">
              {/* Meeting meta card */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <h3 className="text-xs uppercase tracking-wider text-gray-600 mb-4 font-medium">Details</h3>
                <dl className="flex flex-col gap-3 text-sm">
                  {event && <>
                    <MetaRow label="Date" value={new Date(event.start.dateTime!).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })} />
                    <MetaRow label="Time" value={`${fmtEventTime(event)} · ${fmtDuration(event)}`} />
                    <MetaRow label="Platform" value={platform} color={PLATFORM_COLORS[platform]} />
                  </>}
                  <MetaRow label="Type" value={data.meetingType} />
                  {event?.organizer && <MetaRow label="Organizer" value={event.organizer.displayName ?? event.organizer.email} />}
                </dl>
              </div>

              {/* Attendees card */}
              {attendees.length > 0 && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <h3 className="text-xs uppercase tracking-wider text-gray-600 mb-4 font-medium">Attendees ({attendees.length})</h3>
                  <div className="flex flex-col gap-2.5">
                    {attendees.map((a, i) => (
                      <div key={i} className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-full bg-gray-700 flex items-center justify-center text-[10px] font-bold text-gray-300 flex-shrink-0">
                          {avatarInitials(a.email, a.displayName)}
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs text-gray-300 font-medium truncate">{a.displayName ?? a.email}</div>
                          {a.displayName && <div className="text-[10px] text-gray-600 truncate">{a.email}</div>}
                        </div>
                        {a.organizer && <span className="ml-auto text-[10px] text-blue-400 flex-shrink-0">Organizer</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* AGENDA */}
        {activeTab === "agenda" && (
          <AgendaTab data={data} update={update} pushTimeline={pushTimeline} />
        )}

        {/* NOTES */}
        {activeTab === "notes" && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs text-gray-600">
                {data.notes.trim().split(/\s+/).filter(Boolean).length} words
              </p>
              <span className="text-xs text-gray-700">{saved ? "Auto-saved" : "Saving…"}</span>
            </div>
            <textarea
              value={data.notes}
              onChange={e => {
                update({ notes: e.target.value });
                if (!data.notes && e.target.value) pushTimeline("note_added", "Notes started");
              }}
              placeholder={`Start typing your meeting notes…\n\nYou can use:\n• Bullet points\n- Dashes\n  Indented lines\n[x] Checkboxes\n> Quotes\n\nNotes save automatically.`}
              className="w-full bg-gray-900 border border-gray-800 rounded-xl p-6 text-gray-200 placeholder-gray-700 text-sm leading-relaxed resize-none outline-none focus:border-gray-700 transition min-h-[500px] font-mono"
            />
          </div>
        )}

        {/* RECORDING */}
        {activeTab === "recording" && (
          <RecordingTab
            status={recStatus}
            elapsed={elapsed}
            error={recError}
            transcript={transcript}
            fmt={fmt}
            audioMode={audioMode}
            onStart={startRecording}
            onStop={stopRecording}
            onViewSummary={() => setActiveTab("summary")}
          />
        )}

        {/* SUMMARY */}
        {activeTab === "summary" && (
          <SummaryTab
            transcript={transcript}
            data={data}
            update={update}
            pushTimeline={pushTimeline}
            recStatus={recStatus}
            onRecord={() => setActiveTab("recording")}
          />
        )}

        {/* TIMELINE */}
        {activeTab === "timeline" && (
          <TimelineTab events={data.timeline} />
        )}
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h3 className="text-xs uppercase tracking-wider text-gray-600 mb-3 font-medium">{title}</h3>
      {children}
    </div>
  );
}

function MetaRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-gray-600 flex-shrink-0">{label}</dt>
      <dd className="text-gray-300 text-right" style={color ? { color } : {}}>{value}</dd>
    </div>
  );
}

// ── Agenda Tab ──────────────────────────────────────────────────────────────────
function AgendaTab({
  data, update, pushTimeline,
}: {
  data: MeetingLocalData;
  update: (p: Partial<MeetingLocalData>) => void;
  pushTimeline: (type: TimelineEvent["type"], desc: string) => void;
}) {
  const [newText, setNewText]   = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const addItem = () => {
    if (!newText.trim()) return;
    const item: AgendaItem = { id: uid(), text: newText.trim(), completed: false, notes: "" };
    update({ agenda: [...data.agenda, item] });
    pushTimeline("agenda_item_added", `Agenda: "${item.text}"`);
    setNewText("");
  };

  const toggleItem = (id: string) =>
    update({ agenda: data.agenda.map(a => a.id === id ? { ...a, completed: !a.completed } : a) });

  const removeItem = (id: string) =>
    update({ agenda: data.agenda.filter(a => a.id !== id) });

  const updateNotes = (id: string, notes: string) =>
    update({ agenda: data.agenda.map(a => a.id === id ? { ...a, notes } : a) });

  const move = (id: string, dir: -1 | 1) => {
    const list = [...data.agenda];
    const idx  = list.findIndex(a => a.id === id);
    const to   = idx + dir;
    if (to < 0 || to >= list.length) return;
    [list[idx], list[to]] = [list[to], list[idx]];
    update({ agenda: list });
  };

  const convertToAction = (item: AgendaItem) => {
    const action: ActionItem = { id: uid(), text: item.text, owner: "", completed: false };
    update({ actionItems: [...data.actionItems, action] });
  };

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      {data.agenda.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-600 text-sm">
          No agenda items yet. Add items below to structure your meeting.
        </div>
      )}

      {data.agenda.map((item, idx) => (
        <div key={item.id} className={`bg-gray-900 border rounded-xl overflow-hidden transition ${
          item.completed ? "border-gray-800 opacity-60" : "border-gray-700"
        }`}>
          <div className="flex items-center gap-3 px-4 py-3">
            <button
              onClick={() => toggleItem(item.id)}
              className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition ${
                item.completed ? "bg-green-500 border-green-500 text-white" : "border-gray-600 hover:border-gray-400"
              }`}
            >
              {item.completed && <span className="text-[10px]">✓</span>}
            </button>

            <span className={`flex-1 text-sm ${item.completed ? "line-through text-gray-600" : "text-gray-200"}`}>
              {item.text}
            </span>

            <div className="flex items-center gap-1">
              <button onClick={() => move(item.id, -1)} disabled={idx === 0}
                className="text-gray-700 hover:text-gray-400 disabled:opacity-20 text-xs px-1">↑</button>
              <button onClick={() => move(item.id, 1)} disabled={idx === data.agenda.length - 1}
                className="text-gray-700 hover:text-gray-400 disabled:opacity-20 text-xs px-1">↓</button>
              <button onClick={() => convertToAction(item)}
                title="Convert to action item"
                className="text-gray-700 hover:text-blue-400 text-xs px-1 transition">⚡</button>
              <button onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                className="text-gray-700 hover:text-gray-400 text-xs px-1 transition">
                {expanded === item.id ? "▲" : "▼"}
              </button>
              <button onClick={() => removeItem(item.id)}
                className="text-gray-700 hover:text-red-400 text-xs px-1 transition">×</button>
            </div>
          </div>

          {expanded === item.id && (
            <div className="border-t border-gray-800 px-4 py-3">
              <textarea
                value={item.notes}
                onChange={e => updateNotes(item.id, e.target.value)}
                placeholder="Add discussion notes for this item…"
                className="w-full bg-transparent text-gray-400 placeholder-gray-700 text-xs leading-relaxed resize-none outline-none min-h-[60px]"
                rows={3}
              />
            </div>
          )}
        </div>
      ))}

      <div className="flex gap-2">
        <input
          value={newText}
          onChange={e => setNewText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && addItem()}
          placeholder="Add agenda item…"
          className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-700 outline-none focus:border-gray-600 transition"
        />
        <button
          onClick={addItem}
          disabled={!newText.trim()}
          className="bg-white text-black text-sm font-medium px-4 py-2.5 rounded-lg hover:bg-gray-100 transition disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ── Recording Tab ───────────────────────────────────────────────────────────────
function RecordingTab({
  status, elapsed, error, transcript, fmt, audioMode,
  onStart, onStop, onViewSummary,
}: {
  status: string; elapsed: number; error: string | null;
  transcript: RecordingResult | null;
  fmt: (s: number) => string;
  audioMode: "full" | "mic";
  onStart: () => void; onStop: () => void; onViewSummary: () => void;
}) {
  return (
    <div className="max-w-lg mx-auto text-center py-8">
      {status === "idle" && (
        <>
          <div className="w-20 h-20 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-6">
            <div className="w-10 h-10 rounded-full bg-red-500" />
          </div>
          <h2 className="text-xl font-bold mb-2">Ready to Record</h2>
          <p className="text-gray-500 text-sm mb-6">
            MOSAIC captures both your voice and all other participants.
          </p>

          {/* How it works */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-8 text-left">
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-4 font-medium">How it works</p>
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <span className="w-5 h-5 rounded-full bg-gray-800 text-gray-400 text-xs flex items-center justify-center flex-shrink-0 mt-0.5">1</span>
                <p className="text-sm text-gray-400">Allow microphone access when prompted — this captures your voice.</p>
              </div>
              <div className="flex items-start gap-3">
                <span className="w-5 h-5 rounded-full bg-gray-800 text-gray-400 text-xs flex items-center justify-center flex-shrink-0 mt-0.5">2</span>
                <p className="text-sm text-gray-400">A screen-share dialog will appear — select your <strong className="text-gray-200">meeting tab</strong> (Google Meet / Teams / Zoom) and make sure <strong className="text-gray-200">"Share tab audio"</strong> is checked.</p>
              </div>
              <div className="flex items-start gap-3">
                <span className="w-5 h-5 rounded-full bg-green-800/60 text-green-400 text-xs flex items-center justify-center flex-shrink-0 mt-0.5">✓</span>
                <p className="text-sm text-gray-400">MOSAIC mixes both audio streams and records everyone in the meeting.</p>
              </div>
            </div>
            <p className="text-xs text-gray-700 mt-4">If you skip the screen-share step, only your microphone will be recorded.</p>
          </div>

          <button
            onClick={onStart}
            className="bg-red-600 hover:bg-red-500 text-white font-semibold px-8 py-3 rounded-xl transition"
          >
            Start Recording
          </button>
        </>
      )}

      {status === "recording" && (
        <>
          <div className="w-20 h-20 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center mx-auto mb-6 animate-pulse">
            <div className="w-10 h-10 rounded-full bg-red-500" />
          </div>
          <div className="text-4xl font-mono font-bold mb-2 text-red-400">{fmt(elapsed)}</div>

          {/* Audio mode indicator */}
          <div className={`inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-full mb-6 ${
            audioMode === "full"
              ? "bg-green-500/10 border border-green-500/20 text-green-400"
              : "bg-yellow-500/10 border border-yellow-500/20 text-yellow-400"
          }`}>
            <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
            {audioMode === "full" ? "Capturing mic + meeting audio" : "Microphone only — others not captured"}
          </div>

          <div className="block mb-8">
            {audioMode === "mic" && (
              <p className="text-gray-600 text-xs">
                To capture other voices, stop and re-record — this time select your meeting tab in the screen-share dialog.
              </p>
            )}
          </div>

          <button
            onClick={onStop}
            className="border border-red-500 text-red-400 hover:bg-red-950 font-semibold px-8 py-3 rounded-xl transition"
          >
            Stop Recording
          </button>
        </>
      )}

      {status === "processing" && (
        <>
          <div className="w-20 h-20 rounded-full bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center mx-auto mb-6">
            <div className="text-3xl animate-spin">⟳</div>
          </div>
          <h2 className="text-xl font-bold mb-2">Transcribing…</h2>
          <p className="text-gray-500 text-sm">Processing your audio. This usually takes 10–30 seconds.</p>
        </>
      )}

      {status === "done" && transcript && (
        <>
          <div className="w-20 h-20 rounded-full bg-green-500/10 border border-green-500/20 flex items-center justify-center mx-auto mb-6">
            <span className="text-3xl text-green-400">✓</span>
          </div>
          <h2 className="text-xl font-bold mb-2">Transcription Complete</h2>
          <p className="text-gray-500 text-sm mb-6">
            Detected: <span className="text-gray-300">{transcript.input_language}</span>
            {transcript.confidence !== null && (
              <> · <span className="text-gray-300">{Math.round(transcript.confidence * 100)}% confidence</span></>
            )}
          </p>
          <button
            onClick={onViewSummary}
            className="bg-white text-black font-semibold px-8 py-3 rounded-xl hover:bg-gray-100 transition"
          >
            View Summary →
          </button>
        </>
      )}

      {status === "error" && (
        <>
          <div className="w-20 h-20 rounded-full bg-red-900/30 border border-red-800/40 flex items-center justify-center mx-auto mb-6">
            <span className="text-2xl text-red-400">!</span>
          </div>
          <h2 className="text-xl font-bold mb-2 text-red-400">Recording Failed</h2>
          <p className="text-gray-500 text-sm mb-6">{error}</p>
          <button
            onClick={onStart}
            className="bg-red-600 hover:bg-red-500 text-white font-semibold px-8 py-3 rounded-xl transition"
          >
            Try Again
          </button>
        </>
      )}
    </div>
  );
}

// ── Summary Tab ─────────────────────────────────────────────────────────────────
function SummaryTab({
  transcript, data, update, pushTimeline, recStatus, onRecord,
}: {
  transcript: RecordingResult | null;
  data: MeetingLocalData;
  update: (p: Partial<MeetingLocalData>) => void;
  pushTimeline: (type: TimelineEvent["type"], desc: string) => void;
  recStatus: string;
  onRecord: () => void;
}) {
  const [copied, setCopied] = useState(false);

  if (!transcript) {
    return (
      <div className="max-w-lg mx-auto text-center py-16">
        <div className="text-5xl mb-4">🎙</div>
        <h2 className="text-xl font-bold mb-2">No Recording Yet</h2>
        <p className="text-gray-500 text-sm mb-8">
          Record your meeting to get an AI-generated transcript and structured summary.
        </p>
        <button
          onClick={onRecord}
          disabled={recStatus === "processing"}
          className="bg-red-600 hover:bg-red-500 text-white font-semibold px-8 py-3 rounded-xl transition disabled:opacity-50"
        >
          {recStatus === "processing" ? "Transcribing…" : "Start Recording"}
        </button>
      </div>
    );
  }

  const { execSummary, topics, questions, actions, risks } = parseSummary(transcript.translated_transcript);

  const copyAll = () => {
    const text = [
      `# Meeting Summary`,
      `Language: ${transcript.input_language}`,
      ``,
      `## Executive Summary`,
      execSummary,
      ``,
      `## Full Transcript`,
      transcript.translated_transcript,
      data.actionItems.length ? `\n## Action Items\n${data.actionItems.map(a => `- ${a.text}${a.owner ? ` (${a.owner})` : ""}`).join("\n")}` : "",
      data.openQuestions.length ? `\n## Open Questions\n${data.openQuestions.map(q => `- ${q}`).join("\n")}` : "",
      data.risks.length ? `\n## Risks & Concerns\n${data.risks.map(r => `- ${r}`).join("\n")}` : "",
    ].filter(Boolean).join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      {/* Actions bar */}
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={copyAll}
          className="text-xs text-gray-500 hover:text-white border border-gray-800 hover:border-gray-600 px-3 py-1.5 rounded-lg transition"
        >
          {copied ? "Copied!" : "Copy Summary"}
        </button>
        <button
          onClick={onRecord}
          className="text-xs text-gray-500 hover:text-white border border-gray-800 hover:border-gray-600 px-3 py-1.5 rounded-lg transition"
        >
          Regenerate
        </button>
      </div>

      {/* Language + confidence */}
      <div className="flex items-center gap-2">
        <span className="bg-gray-800 text-gray-400 text-xs px-2.5 py-1 rounded-full border border-gray-700">
          {transcript.input_language} detected
        </span>
        {transcript.confidence !== null && (
          <span className="bg-gray-800 text-gray-400 text-xs px-2.5 py-1 rounded-full border border-gray-700">
            {Math.round(transcript.confidence * 100)}% confidence
          </span>
        )}
        {transcript.low_confidence && (
          <span className="bg-yellow-900/40 text-yellow-400 text-xs px-2.5 py-1 rounded-full border border-yellow-800/40">
            Low confidence
          </span>
        )}
      </div>

      {/* Executive Summary */}
      <SummarySection title="Executive Summary" icon="📋">
        <p className="text-gray-300 text-sm leading-relaxed">{execSummary}</p>
      </SummarySection>

      {/* Discussion */}
      {topics.length > 0 && (
        <SummarySection title="Discussion" icon="💬">
          {topics.map((topic, i) => (
            <div key={i} className="mb-4 last:mb-0">
              <div className="text-xs text-gray-600 uppercase tracking-wider mb-1">Topic {i + 1}</div>
              <p className="text-gray-300 text-sm leading-relaxed">{topic}</p>
            </div>
          ))}
        </SummarySection>
      )}

      {/* Full Transcript */}
      <SummarySection title="Full Transcript" icon="📝">
        <p className="text-gray-400 text-sm leading-relaxed whitespace-pre-wrap font-mono">
          {transcript.translated_transcript}
        </p>
      </SummarySection>

      {/* Action Items */}
      <SummarySection title="Action Items" icon="⚡">
        <EditableList
          items={data.actionItems.map(a => a.text)}
          placeholder="Add action item…"
          suggestions={actions}
          onAdd={text => {
            update({ actionItems: [...data.actionItems, { id: uid(), text, owner: "", completed: false }] });
            pushTimeline("action_created", `Action: "${text}"`);
          }}
          onRemove={i => update({ actionItems: data.actionItems.filter((_, idx) => idx !== i) })}
        />
      </SummarySection>

      {/* Open Questions */}
      <SummarySection title="Open Questions" icon="❓">
        <EditableList
          items={data.openQuestions}
          placeholder="Add unanswered question…"
          suggestions={questions}
          onAdd={text => update({ openQuestions: [...data.openQuestions, text] })}
          onRemove={i => update({ openQuestions: data.openQuestions.filter((_, idx) => idx !== i) })}
        />
      </SummarySection>

      {/* Risks */}
      <SummarySection title="Risks & Concerns" icon="⚠️">
        <EditableList
          items={data.risks}
          placeholder="Add risk or concern…"
          suggestions={risks}
          onAdd={text => update({ risks: [...data.risks, text] })}
          onRemove={i => update({ risks: data.risks.filter((_, idx) => idx !== i) })}
        />
      </SummarySection>
    </div>
  );
}

function SummarySection({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-800/30 transition"
      >
        <div className="flex items-center gap-2">
          <span>{icon}</span>
          <span className="font-semibold text-sm">{title}</span>
        </div>
        <span className="text-gray-600 text-xs">{collapsed ? "▼" : "▲"}</span>
      </button>
      {!collapsed && <div className="px-5 pb-5">{children}</div>}
    </div>
  );
}

function EditableList({
  items, placeholder, suggestions, onAdd, onRemove,
}: {
  items: string[];
  placeholder: string;
  suggestions: string[];
  onAdd: (text: string) => void;
  onRemove: (i: number) => void;
}) {
  const [text, setText] = useState("");

  const add = () => { if (!text.trim()) return; onAdd(text.trim()); setText(""); };

  return (
    <div className="flex flex-col gap-2">
      {suggestions.filter(s => !items.includes(s)).slice(0, 3).map((s, i) => (
        <button
          key={i}
          onClick={() => onAdd(s)}
          className="text-left text-xs text-gray-600 hover:text-gray-300 border border-dashed border-gray-800 hover:border-gray-600 rounded-lg px-3 py-2 transition"
        >
          + {s}
        </button>
      ))}
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2 group">
          <span className="text-gray-400 mt-0.5 flex-shrink-0">•</span>
          <span className="text-sm text-gray-300 flex-1">{item}</span>
          <button
            onClick={() => onRemove(i)}
            className="text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition text-xs flex-shrink-0"
          >
            ×
          </button>
        </div>
      ))}
      <div className="flex gap-2 mt-1">
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && add()}
          placeholder={placeholder}
          className="flex-1 bg-transparent border-b border-gray-800 focus:border-gray-600 text-sm text-gray-300 placeholder-gray-700 outline-none py-1 transition"
        />
        <button
          onClick={add}
          disabled={!text.trim()}
          className="text-xs text-gray-600 hover:text-white disabled:opacity-30 transition"
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ── Timeline Tab ────────────────────────────────────────────────────────────────
const TIMELINE_ICONS: Record<string, string> = {
  created:           "🗓",
  note_added:        "📝",
  recording_started: "🎙",
  recording_done:    "✅",
  summary_generated: "✨",
  agenda_item_added: "📋",
  action_created:    "⚡",
};

function TimelineTab({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="text-center py-16 text-gray-600 text-sm">
        No activity yet. Events will appear here as you use the meeting workspace.
      </div>
    );
  }

  return (
    <div className="max-w-lg flex flex-col gap-0 relative">
      <div className="absolute left-4 top-4 bottom-4 w-px bg-gray-800" />
      {[...events].reverse().map((ev, i) => (
        <div key={ev.id} className="flex items-start gap-4 pl-2 pb-6 last:pb-0 relative">
          <div className="w-6 h-6 rounded-full bg-gray-900 border border-gray-700 flex items-center justify-center text-xs flex-shrink-0 z-10">
            {TIMELINE_ICONS[ev.type] ?? "·"}
          </div>
          <div className="pt-0.5">
            <div className="text-sm text-gray-300">{ev.description}</div>
            <div className="text-xs text-gray-600 mt-0.5">{fmtDate(ev.timestamp)} · {fmtTs(ev.timestamp)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
