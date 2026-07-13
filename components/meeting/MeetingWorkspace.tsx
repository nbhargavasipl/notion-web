"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarEvent, fetchCalendarEvent, detectPlatform,
  fmtEventTime, fmtDuration, isOngoing, isUpcoming,
} from "@/lib/googleCalendar";
import {
  MeetingLocalData, TimelineEvent,
  RecordingResult, DiarizationSegment, loadMeetingData, saveMeetingData,
  addTimelineEvent, parseSummary,
} from "@/lib/meetingStorage";
import { auth } from "@/lib/firebase/client";
import { syncMeetingToFirestore, loadMeetingFromFirestore } from "@/lib/firestoreSync";

// ── Recording types ────────────────────────────────────────────────────────────
type RecordingMode    = "mic_and_meeting" | "mic_only";
type AudioSourceStatus = "idle" | "connected" | "muted" | "not_shared" | "no_audio" | "disconnected" | "denied" | "error";

// ── Constants ──────────────────────────────────────────────────────────────────
const MEETING_TYPES = ["General", "Standup", "Client Meeting", "Sprint Review", "Planning", "Retrospective", "1:1", "Interview", "Workshop", "Demo"];

const PLATFORM_COLORS: Record<string, string> = {
  "Google Meet":     "#4ade80",
  "Microsoft Teams": "#818cf8",
  "Zoom":            "#60a5fa",
  "Webex":           "#f59e0b",
};


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
  const [saved,     setSaved]     = useState(true);
  const [loading,   setLoading]   = useState(true);

  // Recording state
  const [recStatus,  setRecStatus]  = useState<"idle" | "recording" | "processing" | "done" | "error">("idle");
  const [elapsed,    setElapsed]    = useState(0);
  const [transcript, setTranscript] = useState<RecordingResult | null>(null);
  const [recError,   setRecError]   = useState<string | null>(null);

  const [addingMeetingAudio,     setAddingMeetingAudio]     = useState(false);
  const [audioDevices,           setAudioDevices]           = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId,       setSelectedDeviceId]       = useState<string>("");
  // Audio source tracking
  const [recordingMode,          setRecordingMode]          = useState<RecordingMode>("mic_only");
  const [micStatus,              setMicStatus]              = useState<AudioSourceStatus>("idle");
  const [meetingAudioStatus,     setMeetingAudioStatus]     = useState<AudioSourceStatus>("not_shared");
  const [micLevel,               setMicLevel]               = useState(0);
  const [meetingLevel,           setMeetingLevel]           = useState(0);
  const [recWarning,             setRecWarning]             = useState<string | null>(null);

  const mediaRef             = useRef<MediaRecorder | null>(null);
  const chunks               = useRef<Blob[]>([]);
  const streamRef            = useRef<MediaStream | null>(null);
  const displayRef           = useRef<MediaStream | null>(null);
  const audioCtxRef          = useRef<AudioContext | null>(null);
  const audioDestRef         = useRef<MediaStreamAudioDestinationNode | null>(null);
  const timerRef             = useRef<ReturnType<typeof setInterval> | null>(null);
  const saveTimer            = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Extra refs for new audio routing + cleanup
  const micGainRef           = useRef<GainNode | null>(null);
  const meetingGainRef       = useRef<GainNode | null>(null);
  const micAnalyserRef       = useRef<AnalyserNode | null>(null);
  const meetingAnalyserRef   = useRef<AnalyserNode | null>(null);
  const levelTimerRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const trackCleanupFnsRef   = useRef<Array<() => void>>([]);
  const meetingEndedRef      = useRef(false);
  const isSettingUpRef       = useRef(false);

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

    const local = loadMeetingData(eventId);
    setData(local);
    if (local.recording) { setTranscript(local.recording); setRecStatus("done"); }
    setLoading(false);

    // Merge Firestore data — wins if newer than what's in localStorage
    const uid = auth.currentUser?.uid;
    if (uid) {
      loadMeetingFromFirestore(uid, eventId).then(remote => {
        if (!remote) return;
        setData(prev => {
          if (!prev) return prev;
          if (remote.createdAt <= prev.createdAt && prev.recording === remote.recording) return prev;
          const merged: MeetingLocalData = remote.createdAt > prev.createdAt ? remote : {
            ...prev,
            recording: remote.recording ?? prev.recording,
            aiSummary: remote.aiSummary ?? prev.aiSummary,
            notes:     remote.notes || prev.notes,
            actionItems: remote.actionItems.length > prev.actionItems.length ? remote.actionItems : prev.actionItems,
          };
          saveMeetingData(merged);
          if (merged.recording) { setTranscript(merged.recording); setRecStatus("done"); }
          return merged;
        });
      }).catch(() => {});
    }
  }, [eventId]);

  // ── Cleanup on unmount ──────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (levelTimerRef.current)  clearInterval(levelTimerRef.current);
      if (timerRef.current)       clearInterval(timerRef.current);
      if (saveTimer.current)      clearTimeout(saveTimer.current);
      trackCleanupFnsRef.current.forEach(fn => fn());
      displayRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (audioCtxRef.current?.state !== "closed") audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  // ── Auto-save ───────────────────────────────────────────────────────────────
  const fireSync = (data: MeetingLocalData) => {
    const uid = auth.currentUser?.uid;
    if (uid) syncMeetingToFirestore(uid, data).catch(() => {});
  };

  const update = useCallback((patch: Partial<MeetingLocalData>) => {
    setData(prev => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      setSaved(false);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => { saveMeetingData(next); setSaved(true); fireSync(next); }, 800);
      return next;
    });
  }, []);

  const pushTimeline = useCallback((type: TimelineEvent["type"], description: string) => {
    setData(prev => {
      if (!prev) return prev;
      const next = addTimelineEvent(prev, type, description);
      saveMeetingData(next);
      fireSync(next);
      return next;
    });
  }, []);

  // ── Recording ───────────────────────────────────────────────────────────────

  // Tears down timers, level monitoring, and track event listeners.
  // Does NOT stop tracks or close AudioContext — those must stay alive until
  // MediaRecorder.onstop fires so the final audio chunk is not cut short.
  const cleanupMonitoring = useCallback(() => {
    if (levelTimerRef.current)  { clearInterval(levelTimerRef.current);  levelTimerRef.current  = null; }
    if (timerRef.current)       { clearInterval(timerRef.current);       timerRef.current       = null; }
    trackCleanupFnsRef.current.forEach(fn => fn());
    trackCleanupFnsRef.current = [];
    setMicLevel(0);
    setMeetingLevel(0);
  }, []);

  const startRecording = async (withMeetingAudio = false) => {
    if (isSettingUpRef.current || recStatus === "processing") return;
    isSettingUpRef.current = true;

    cleanupMonitoring();
    meetingEndedRef.current = false;
    chunks.current = [];
    setRecError(null);
    setRecWarning(null);
    setMicStatus("idle");
    setMeetingAudioStatus(withMeetingAudio ? "idle" : "not_shared");

    let ctx: AudioContext | null = null;
    let mode: RecordingMode = "mic_only";

    try {
      ctx = new AudioContext();
      audioCtxRef.current = ctx;
      // Chrome may suspend AudioContext even inside a click handler
      if (ctx.state === "suspended") await ctx.resume();

      const dest = ctx.createMediaStreamDestination();
      audioDestRef.current = dest;

      // ── Microphone ──────────────────────────────────────────────────────────
      const micConstraints: MediaStreamConstraints = selectedDeviceId
        ? { audio: { deviceId: { exact: selectedDeviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
        : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

      let micStream: MediaStream;
      try {
        micStream = await navigator.mediaDevices.getUserMedia(micConstraints);
      } catch (err: unknown) {
        setMicStatus("denied");
        const e = err instanceof Error ? err : new Error(String(err));
        throw new Error((e as { name?: string }).name === "NotAllowedError" ? "Microphone access denied." : (e.message ?? "Could not access microphone."));
      }

      streamRef.current = micStream;
      setMicStatus("connected");

      if (audioDevices.length === 0) {
        navigator.mediaDevices.enumerateDevices().then(devs =>
          setAudioDevices(devs.filter(d => d.kind === "audioinput"))
        );
      }

      // mic → gain → analyser → destination
      const micSource   = ctx.createMediaStreamSource(micStream);
      const micGain     = ctx.createGain();
      micGain.gain.value = 1.0;
      micGainRef.current = micGain;
      const micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 256;
      micAnalyserRef.current = micAnalyser;
      micSource.connect(micGain);
      micGain.connect(micAnalyser);
      micAnalyser.connect(dest);

      // Track lifecycle — mic
      const micTrack = micStream.getAudioTracks()[0];
      if (micTrack) {
        const onMicEnded   = () => { setMicStatus("disconnected"); pushTimeline("recording_started", "Microphone disconnected during recording"); };
        const onMicMuted   = () => setMicStatus("muted");
        const onMicUnmuted = () => setMicStatus("connected");
        micTrack.addEventListener("ended",  onMicEnded);
        micTrack.addEventListener("mute",   onMicMuted);
        micTrack.addEventListener("unmute", onMicUnmuted);
        trackCleanupFnsRef.current.push(() => {
          micTrack.removeEventListener("ended",  onMicEnded);
          micTrack.removeEventListener("mute",   onMicMuted);
          micTrack.removeEventListener("unmute", onMicUnmuted);
        });
      }

      // ── Meeting audio via getDisplayMedia ────────────────────────────────────
      if (withMeetingAudio) {
        try {
          // systemAudio:"include" enables broader capture on supported OS/browser combos.
          // selfBrowserSurface:"exclude" prevents the MOSAIC tab from appearing in the picker.
          const displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
            systemAudio: "include",
            selfBrowserSurface: "exclude",
          } as DisplayMediaStreamOptions);
          displayRef.current = displayStream;

          const liveAudioTrack = displayStream.getAudioTracks().find(t => t.readyState === "live");

          if (liveAudioTrack) {
            // meeting audio → gain → analyser → destination
            const meetingSource   = ctx.createMediaStreamSource(displayStream);
            const meetingGain     = ctx.createGain();
            meetingGain.gain.value = 1.0;
            meetingGainRef.current = meetingGain;
            const meetingAnalyser = ctx.createAnalyser();
            meetingAnalyser.fftSize = 256;
            meetingAnalyserRef.current = meetingAnalyser;
            meetingSource.connect(meetingGain);
            meetingGain.connect(meetingAnalyser);
            meetingAnalyser.connect(dest);

            mode = "mic_and_meeting";
            setMeetingAudioStatus("connected");

            // Track lifecycle — meeting audio
            const onMeetingEnded = () => {
              meetingEndedRef.current = true;
              setMeetingAudioStatus("disconnected");
              setRecordingMode("mic_only");
              setRecWarning("Meeting audio disconnected — continuing with microphone only.");
              pushTimeline("recording_started", "Meeting audio disconnected — continuing with microphone");
            };
            const onMeetingMuted   = () => setMeetingAudioStatus("muted");
            const onMeetingUnmuted = () => setMeetingAudioStatus("connected");
            liveAudioTrack.addEventListener("ended",  onMeetingEnded);
            liveAudioTrack.addEventListener("mute",   onMeetingMuted);
            liveAudioTrack.addEventListener("unmute", onMeetingUnmuted);
            trackCleanupFnsRef.current.push(() => {
              liveAudioTrack.removeEventListener("ended",  onMeetingEnded);
              liveAudioTrack.removeEventListener("mute",   onMeetingMuted);
              liveAudioTrack.removeEventListener("unmute", onMeetingUnmuted);
            });
          } else {
            // Screen/window shared but browser gave no audio track.
            // The display video track is NOT stopped here — stopping it in Chrome
            // can terminate the entire capture session including any audio.
            setMeetingAudioStatus("no_audio");
            const videoLabel = displayStream.getVideoTracks()[0]?.label ?? "";
            const isNativeApp = /window|screen/i.test(videoLabel) && !/tab/i.test(videoLabel);
            setRecWarning(
              isNativeApp
                ? "No audio from this window or screen. Native desktop app audio is not available in the browser. Recording microphone only. Full audio capture will be supported in the MOSAIC desktop app."
                : 'No meeting audio — make sure to enable "Share tab audio" when selecting your meeting tab in the sharing dialog.'
            );
          }
        } catch (err: unknown) {
          const name = err instanceof Error ? (err as { name?: string }).name : "";
          const cancelled = name === "NotAllowedError" || name === "AbortError";
          setMeetingAudioStatus(cancelled ? "not_shared" : "error");
          if (!cancelled) {
            setRecWarning("Could not access screen audio. Recording with microphone only.");
          }
          // Either way, continue with mic-only
        }
      }

      setRecordingMode(mode);

      // ── MediaRecorder ────────────────────────────────────────────────────────
      const mimeTypes = ["audio/webm;codecs=opus", "audio/webm", "video/webm;codecs=opus", "video/webm"];
      const mime = mimeTypes.find(t => MediaRecorder.isTypeSupported(t)) ?? "";

      const mr = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
      mediaRef.current = mr;
      mr.ondataavailable = e => { if (e.data.size > 0) chunks.current.push(e.data); };
      mr.onstop = () => {
        // Stop ALL tracks only after the recorder has flushed its final chunk.
        // Stopping the display video track early kills display-capture audio in Chrome.
        displayRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current?.getTracks().forEach(t => t.stop());
        displayRef.current = null;
        streamRef.current  = null;
        ctx?.close().catch(() => {});
        uploadRecording(eventId, mode, mime);
      };
      mr.start(1000);

      // Live level monitoring (~10 fps — avoids 60-fps re-render flood)
      levelTimerRef.current = setInterval(() => {
        if (micAnalyserRef.current) {
          const buf = new Uint8Array(micAnalyserRef.current.frequencyBinCount);
          micAnalyserRef.current.getByteFrequencyData(buf);
          setMicLevel(buf.reduce((a, b) => a + b, 0) / (buf.length * 255));
        }
        if (meetingAnalyserRef.current) {
          const buf = new Uint8Array(meetingAnalyserRef.current.frequencyBinCount);
          meetingAnalyserRef.current.getByteFrequencyData(buf);
          setMeetingLevel(buf.reduce((a, b) => a + b, 0) / (buf.length * 255));
        }
      }, 100);

      let secs = 0;
      timerRef.current = setInterval(() => { secs++; setElapsed(secs); }, 1000);
      setElapsed(0);
      setRecStatus("recording");
      pushTimeline("recording_started", mode === "mic_and_meeting"
        ? "Recording started (mic + meeting audio)"
        : "Recording started (microphone only)");

    } catch (err: unknown) {
      cleanupMonitoring();
      ctx?.close().catch(() => {});
      streamRef.current?.getTracks().forEach(t => t.stop());
      displayRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current  = null;
      displayRef.current = null;
      audioCtxRef.current   = null;
      audioDestRef.current  = null;
      setRecStatus("error");
      setRecError(err instanceof Error ? (err.message ?? "Could not start recording.") : "Could not start recording.");
    } finally {
      isSettingUpRef.current = false;
    }
  };

  const stopRecording = () => {
    cleanupMonitoring();
    mediaRef.current?.stop(); // onstop handles tracks, AudioContext, and upload
    setRecStatus("processing");
  };

  const addMeetingAudio = async () => {
    if (!audioCtxRef.current || !audioDestRef.current) return;
    setAddingMeetingAudio(true);
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        systemAudio: "include",
        selfBrowserSurface: "exclude",
      } as DisplayMediaStreamOptions);

      const liveTrack = displayStream.getAudioTracks().find(t => t.readyState === "live");

      if (liveTrack) {
        // Replace old display stream if one already exists
        displayRef.current?.getTracks().forEach(t => t.stop());
        displayRef.current = displayStream;

        const ctx  = audioCtxRef.current;
        const dest = audioDestRef.current;

        const meetingSource   = ctx.createMediaStreamSource(displayStream);
        const meetingGain     = ctx.createGain();
        meetingGain.gain.value = 1.0;
        meetingGainRef.current = meetingGain;
        const meetingAnalyser = ctx.createAnalyser();
        meetingAnalyser.fftSize = 256;
        meetingAnalyserRef.current = meetingAnalyser;
        meetingSource.connect(meetingGain);
        meetingGain.connect(meetingAnalyser);
        meetingAnalyser.connect(dest);

        setMeetingAudioStatus("connected");
        setRecordingMode("mic_and_meeting");
        setRecWarning(null);

        const onMeetingEnded = () => {
          meetingEndedRef.current = true;
          setMeetingAudioStatus("disconnected");
          setRecordingMode("mic_only");
          setRecWarning("Meeting audio disconnected — continuing with microphone only.");
          pushTimeline("recording_started", "Meeting audio disconnected — continuing with microphone");
        };
        const onMeetingMuted   = () => setMeetingAudioStatus("muted");
        const onMeetingUnmuted = () => setMeetingAudioStatus("connected");
        liveTrack.addEventListener("ended",  onMeetingEnded);
        liveTrack.addEventListener("mute",   onMeetingMuted);
        liveTrack.addEventListener("unmute", onMeetingUnmuted);
        trackCleanupFnsRef.current.push(() => {
          liveTrack.removeEventListener("ended",  onMeetingEnded);
          liveTrack.removeEventListener("mute",   onMeetingMuted);
          liveTrack.removeEventListener("unmute", onMeetingUnmuted);
        });

        pushTimeline("recording_started", "Meeting audio added to recording");
      } else {
        displayStream.getTracks().forEach(t => t.stop());
        setMeetingAudioStatus("no_audio");
        setRecWarning('No meeting audio — in the sharing dialog, select your meeting tab and enable "Share tab audio".');
      }
    } catch {
      // User cancelled the dialog — keep current mode
    } finally {
      setAddingMeetingAudio(false);
    }
  };

  const uploadRecording = async (id: string, mode: RecordingMode, mimeType?: string) => {
    try {
      if (chunks.current.length === 0) throw new Error("No audio was captured. Try recording again.");
      const blobType = mimeType || "audio/webm";
      const blob = new Blob(chunks.current, { type: blobType });
      const form = new FormData();
      form.append("file", new File([blob], `meeting-${id}.webm`, { type: blobType }));
      const res  = await fetch("/api/transcribe", { method: "POST", body: form });
      const json = await res.json();
      if (!json.success) throw new Error(json.message || json.error || `Transcription service error (HTTP ${res.status})`);
      const result: RecordingResult = {
        ...json,
        timestamp: Date.now(),
        recordingMode: mode,
        microphoneCaptured: true,
        meetingAudioCaptured: mode === "mic_and_meeting",
        meetingAudioEndedDuringRecording: meetingEndedRef.current,
        mimeType: blobType,
      };
      setTranscript(result);
      setRecStatus("done");
      setData(prev => {
        if (!prev) return prev;
        const next = addTimelineEvent({ ...prev, recording: result }, "recording_done", "Recording completed and transcribed");
        saveMeetingData(next);
        fireSync(next);
        return next;
      });
    } catch (e: unknown) {
      setRecStatus("error");
      setRecError(e instanceof Error ? (e.message || "Upload failed.") : "Upload failed.");
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
                  onClick={() => startRecording(true)}
                  className="text-xs bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded-lg font-medium transition"
                >
                  ⏺ Record
                </button>
              )}
              {recStatus === "recording" && (
                <>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${recordingMode === "mic_and_meeting" ? "bg-green-500/20 text-green-400" : "bg-yellow-500/20 text-yellow-400"}`}>
                    {recordingMode === "mic_and_meeting" ? "Mic + Meeting Audio" : "Mic Only"}
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

      </div>

      {/* ── Content ── */}
      <div className="max-w-2xl mx-auto px-6 py-8 flex flex-col gap-10">

        {/* Recording */}
        <div>
          <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-3">Recording</p>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            {recStatus === "idle" && (
              <div className="flex flex-col gap-3">
                {/* Option 1: Browser-tab meeting */}
                <button
                  onClick={() => startRecording(true)}
                  className="w-full flex items-center justify-between bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-600 rounded-xl px-5 py-4 transition text-left group"
                >
                  <div>
                    <p className="text-sm font-semibold text-white mb-0.5">⏺ Mic + Meeting audio <span className="text-xs font-normal text-blue-400 ml-1">Recommended</span></p>
                    <p className="text-xs text-gray-500">For Google Meet, Teams, or Zoom in browser — share the tab to capture all participants.</p>
                  </div>
                  <span className="text-gray-600 group-hover:text-gray-400 ml-4 flex-shrink-0 text-lg">→</span>
                </button>

                {/* Option 2: Mic only */}
                <button
                  onClick={() => startRecording(false)}
                  className="w-full flex items-center justify-between border border-gray-800 hover:border-gray-700 rounded-xl px-5 py-3 transition text-left"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-400 mb-0.5">Microphone only</p>
                    <p className="text-xs text-gray-600">When call audio plays through speakers so the mic picks it up.</p>
                  </div>
                </button>

                {/* Zoom desktop app tip */}
                <div className="bg-blue-950/30 border border-blue-900/30 rounded-xl px-4 py-3">
                  <p className="text-xs text-blue-400 font-medium mb-1">Using Zoom / Teams desktop app?</p>
                  <p className="text-xs text-gray-500">
                    Browser cannot capture audio from desktop apps directly.{" "}
                    <strong className="text-gray-400">Best options:</strong>{" "}
                    join via browser (zoom.us in Chrome), put Zoom on speakers so mic picks it up,
                    or use a virtual audio device like BlackHole (macOS) and select it below.
                  </p>
                  {/* Audio device selector — useful for BlackHole / Loopback users */}
                  {audioDevices.length > 1 && (
                    <select
                      value={selectedDeviceId}
                      onChange={e => setSelectedDeviceId(e.target.value)}
                      className="mt-2 w-full bg-gray-900 border border-gray-700 text-xs text-gray-300 rounded-lg px-3 py-1.5 outline-none"
                    >
                      <option value="">Default microphone</option>
                      {audioDevices.map(d => (
                        <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0, 6)}`}</option>
                      ))}
                    </select>
                  )}
                  {audioDevices.length <= 1 && (
                    <button
                      onClick={async () => {
                        // Request permission first so labels appear
                        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
                        s.getTracks().forEach(t => t.stop());
                        const devs = await navigator.mediaDevices.enumerateDevices();
                        setAudioDevices(devs.filter(d => d.kind === "audioinput"));
                      }}
                      className="mt-2 text-xs text-blue-500 hover:text-blue-400 underline"
                    >
                      Show audio devices
                    </button>
                  )}
                </div>
              </div>
            )}
            {recStatus === "recording" && (
              <div className="flex flex-col gap-3">
                {/* Timer + mode badge + stop button */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-xl font-mono font-bold text-red-400">{fmt(elapsed)}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${
                      recordingMode === "mic_and_meeting"
                        ? "bg-green-500/10 border-green-500/30 text-green-400"
                        : "bg-yellow-500/10 border-yellow-500/30 text-yellow-400"
                    }`}>
                      {recordingMode === "mic_and_meeting" ? "Mic + Meeting Audio" : "Microphone Only"}
                    </span>
                  </div>
                  <button
                    onClick={stopRecording}
                    className="border border-red-500 text-red-400 hover:bg-red-950 text-sm font-semibold px-4 py-2 rounded-lg transition"
                  >
                    ⏹ Stop
                  </button>
                </div>

                {/* Live audio source status */}
                <AudioSourcePanel
                  micStatus={micStatus}
                  meetingAudioStatus={meetingAudioStatus}
                  micLevel={micLevel}
                  meetingLevel={meetingLevel}
                />

                {/* Warning banner (missing/dropped meeting audio) */}
                {recWarning && (
                  <div className="bg-yellow-950/20 border border-yellow-900/30 rounded-lg px-4 py-2.5 text-xs text-yellow-400">
                    {recWarning}
                  </div>
                )}

                {/* Add meeting audio mid-recording */}
                {recordingMode === "mic_only" && !recWarning?.includes("desktop") && (
                  <div className="flex items-center justify-between bg-gray-800/50 border border-gray-700/50 rounded-lg px-4 py-2.5">
                    <p className="text-xs text-gray-500">Add your meeting tab to also capture remote participants.</p>
                    <button
                      onClick={addMeetingAudio}
                      disabled={addingMeetingAudio}
                      className="text-xs bg-yellow-600 hover:bg-yellow-500 disabled:opacity-50 text-white font-medium px-3 py-1.5 rounded-md transition ml-3 flex-shrink-0"
                    >
                      {addingMeetingAudio ? "Opening…" : "+ Add meeting audio"}
                    </button>
                  </div>
                )}
              </div>
            )}
            {recStatus === "processing" && (
              <div className="flex items-center gap-3 text-sm text-gray-400">
                <span className="animate-spin inline-block">⟳</span>
                Transcribing… usually takes 10–30 seconds.
              </div>
            )}
            {recStatus === "done" && transcript && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-green-400">
                  <span>✓</span>
                  <span>
                    {transcript.input_language} detected
                    {transcript.confidence !== null && ` · ${Math.round(transcript.confidence * 100)}% confidence`}
                  </span>
                  {transcript.low_confidence && (
                    <span className="text-xs text-yellow-500 ml-1">(low confidence)</span>
                  )}
                </div>
                <button
                  onClick={() => startRecording(true)}
                  className="text-xs text-gray-600 hover:text-gray-400 border border-gray-800 hover:border-gray-600 px-2.5 py-1 rounded-lg transition"
                >
                  Re-record
                </button>
              </div>
            )}
            {recStatus === "error" && (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm text-red-400 font-medium">Recording failed</p>
                  <p className="text-xs text-gray-600 mt-0.5">{recError}</p>
                </div>
                <button
                  onClick={() => startRecording(true)}
                  className="text-xs bg-red-600 hover:bg-red-500 text-white font-semibold px-4 py-2 rounded-lg transition flex-shrink-0"
                >
                  Try Again
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Transcript + AI Summary — shown once recording is done */}
        {transcript && (
          <SummaryTab
            transcript={transcript}
            data={data}
            update={update}
            pushTimeline={pushTimeline}
            recStatus={recStatus}
            onRecord={startRecording}
          />
        )}

        {/* Notes */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider">Notes</p>
            <span className="text-xs text-gray-700">{saved ? "Saved" : "Saving…"}</span>
          </div>
          <textarea
            value={data.notes}
            onChange={e => {
              update({ notes: e.target.value });
              if (!data.notes && e.target.value) pushTimeline("note_added", "Notes started");
            }}
            placeholder="Start typing your meeting notes…"
            className="w-full bg-gray-900 border border-gray-800 rounded-xl p-5 text-gray-200 placeholder-gray-700 text-sm leading-relaxed resize-none outline-none focus:border-gray-700 transition min-h-[300px]"
          />
        </div>

      </div>
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
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const generateSummary = async (result: RecordingResult) => {
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: result.translated_transcript, segments: result.segments }),
      });
      const summary = await res.json();
      if (!res.ok) throw new Error(summary?.error || `HTTP ${res.status}`);
      update({ aiSummary: summary });
      pushTimeline('summary_generated', 'AI summary generated');
    } catch (e) {
      setAiError(e instanceof Error ? e.message : 'Failed to generate summary');
    } finally {
      setAiLoading(false);
    }
  };

  // Auto-generate when transcript arrives and no cached summary exists
  useEffect(() => {
    if (transcript && !data.aiSummary && !aiLoading) {
      generateSummary(transcript);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcript?.timestamp]);

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

  const summary = data.aiSummary ?? parseSummary(transcript.translated_transcript);
  const { execSummary, topics, questions, actions, risks } = summary;

  const copyAll = () => {
    const transcriptText = transcript.segments && transcript.segments.length > 0
      ? transcript.segments.map(s => `Speaker ${s.speaker}: ${s.translated_text}`).join('\n')
      : transcript.translated_transcript;
    const text = [
      `# Meeting Summary`,
      `Language: ${transcript.input_language}`,
      ``,
      `## Executive Summary`,
      execSummary,
      ``,
      `## Full Transcript`,
      transcriptText,
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
          onClick={() => {
            update({ aiSummary: null });
            generateSummary(transcript);
          }}
          disabled={aiLoading}
          className="text-xs text-gray-500 hover:text-white border border-gray-800 hover:border-gray-600 px-3 py-1.5 rounded-lg transition disabled:opacity-50"
        >
          {aiLoading ? "Generating…" : "Regenerate Summary"}
        </button>
      </div>

      {/* Language + confidence */}
      <div className="flex items-center gap-2 flex-wrap">
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
        {data.aiSummary && (
          <span className="bg-blue-900/40 text-blue-400 text-xs px-2.5 py-1 rounded-full border border-blue-800/40">
            AI summary
          </span>
        )}
      </div>

      {/* Loading state */}
      {aiLoading && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-8 text-center">
          <div className="text-gray-400 text-sm animate-pulse">Generating AI summary…</div>
        </div>
      )}

      {/* Error state */}
      {aiError && !aiLoading && (
        <div className="bg-red-950/30 border border-red-900/40 rounded-xl px-5 py-3 text-red-400 text-sm">
          Summary generation failed: {aiError}. Showing basic summary below.
        </div>
      )}

      {/* Executive Summary */}
      {!aiLoading && (
        <SummarySection title="Executive Summary" icon="📋">
          <p className="text-gray-300 text-sm leading-relaxed">{execSummary}</p>
        </SummarySection>
      )}

      {/* Discussion */}
      {!aiLoading && topics.length > 0 && (
        <SummarySection title="Discussion" icon="💬">
          {topics.map((topic, i) => (
            <div key={i} className="mb-4 last:mb-0">
              <div className="text-xs text-gray-600 uppercase tracking-wider mb-1">Topic {i + 1}</div>
              <p className="text-gray-300 text-sm leading-relaxed">{topic}</p>
            </div>
          ))}
        </SummarySection>
      )}

      {/* Full Transcript — diarized if segments available, otherwise flat */}
      <SummarySection title="Full Transcript" icon="📝">
        {transcript.segments && transcript.segments.length > 0 ? (
          <DiarizedTranscript segments={transcript.segments} />
        ) : (
          <p className="text-gray-400 text-sm leading-relaxed whitespace-pre-wrap font-mono">
            {transcript.translated_transcript}
          </p>
        )}
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

const SPEAKER_COLORS = [
  "text-blue-400", "text-green-400", "text-purple-400",
  "text-yellow-400", "text-pink-400", "text-cyan-400",
];

function fmtTime(secs: number) {
  const m = Math.floor(secs / 60).toString().padStart(2, "0");
  const s = Math.floor(secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function DiarizedTranscript({ segments }: { segments: DiarizationSegment[] }) {
  const speakers = Array.from(new Set(segments.map(s => s.speaker))).sort();
  const colorMap = Object.fromEntries(speakers.map((sp, i) => [sp, SPEAKER_COLORS[i % SPEAKER_COLORS.length]]));

  return (
    <div className="flex flex-col gap-3">
      {/* Speaker legend */}
      <div className="flex flex-wrap gap-2 mb-1">
        {speakers.map(sp => (
          <span key={sp} className={`text-xs font-medium px-2 py-0.5 rounded-full bg-gray-800 border border-gray-700 ${colorMap[sp]}`}>
            Speaker {sp}
          </span>
        ))}
      </div>
      {/* Segments */}
      {segments.map((seg, i) => (
        <div key={i} className="flex gap-3 items-start">
          <span className={`text-[10px] font-mono text-gray-600 mt-0.5 flex-shrink-0 w-10 text-right`}>
            {fmtTime(seg.start_time)}
          </span>
          <span className={`text-xs font-semibold flex-shrink-0 w-16 ${colorMap[seg.speaker]}`}>
            Spkr {seg.speaker}
          </span>
          <p className="text-gray-300 text-sm leading-relaxed">{seg.translated_text}</p>
        </div>
      ))}
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

// ── Audio source status panel ──────────────────────────────────────────────────
function AudioSourcePanel({
  micStatus, meetingAudioStatus, micLevel, meetingLevel,
}: {
  micStatus: AudioSourceStatus;
  meetingAudioStatus: AudioSourceStatus;
  micLevel: number;
  meetingLevel: number;
}) {
  return (
    <div className="bg-gray-800/40 border border-gray-700/50 rounded-lg px-4 py-3">
      <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-2">Audio Sources</p>
      <div className="flex flex-col gap-2">
        <AudioSourceRow label="Microphone"    status={micStatus}          level={micLevel} />
        <AudioSourceRow label="Meeting Audio" status={meetingAudioStatus} level={meetingLevel} />
      </div>
    </div>
  );
}

function AudioSourceRow({ label, status, level }: { label: string; status: AudioSourceStatus; level: number }) {
  const cfg: Record<AudioSourceStatus, { text: string; cls: string }> = {
    idle:         { text: "—",              cls: "text-gray-600"  },
    connected:    { text: "Connected",      cls: "text-green-400" },
    muted:        { text: "Muted",          cls: "text-yellow-400"},
    not_shared:   { text: "Not shared",     cls: "text-gray-600"  },
    no_audio:     { text: "No audio track", cls: "text-yellow-500"},
    disconnected: { text: "Disconnected",   cls: "text-red-400"   },
    denied:       { text: "Access denied",  cls: "text-red-400"   },
    error:        { text: "Error",          cls: "text-red-400"   },
  };
  const { text, cls } = cfg[status] ?? cfg.idle;
  const isActive = status === "connected" || status === "muted";

  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-gray-500">{label}</span>
      <div className="flex items-center gap-2">
        {/* Simple level bar — only when source is connected */}
        {isActive && (
          <div className="flex items-end gap-px h-3">
            {[0.15, 0.35, 0.55, 0.75].map((threshold, i) => (
              <div
                key={i}
                className={`w-1 rounded-sm transition-all duration-100 ${level > threshold ? "bg-green-400" : "bg-gray-700"}`}
                style={{ height: `${(i + 1) * 25}%` }}
              />
            ))}
          </div>
        )}
        <span className={`text-xs font-medium ${cls}`}>{text}</span>
      </div>
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

