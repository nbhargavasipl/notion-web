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
  addTimelineEvent,
} from "@/lib/meetingStorage";
import type {
  NormalizedTranscript, EvidenceBackedSummary,
  GroundedSummaryItem, GroundedActionItem, TranscriptSegment,
} from "@/lib/providers/types";
import type { PublicMosaicConfig } from "@/app/api/config/route";
import { syncMeetingToFirestore, loadMeetingFromFirestore } from "@/lib/firestoreSync";
import { auth } from "@/lib/firebase/client";

// ── Types ──────────────────────────────────────────────────────────────────────
type RecordingMode = "mic_and_meeting" | "mic_only";
type WorkspaceTab = "summary" | "notes" | "transcript";

// ── Constants ──────────────────────────────────────────────────────────────────
const MEETING_TYPES = ["General", "Standup", "Client Meeting", "Sprint Review", "Planning", "Retrospective", "1:1", "Interview", "Workshop", "Demo"];
const CHUNK_SECS = 5 * 60;

const PLATFORM_COLORS: Record<string, string> = {
  "Google Meet":     "#4ade80",
  "Microsoft Teams": "#818cf8",
  "Zoom":            "#60a5fa",
  "Webex":           "#f59e0b",
};

const SPEAKER_COLORS = [
  "text-blue-400", "text-green-400", "text-purple-400",
  "text-yellow-400", "text-pink-400", "text-cyan-400",
];

function avatarInitials(email: string, name?: string) {
  if (name) return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  return email.slice(0, 2).toUpperCase();
}
function uid() { return Math.random().toString(36).slice(2, 9); }
function fmtTime(secs: number) {
  const m = Math.floor(secs / 60).toString().padStart(2, "0");
  const s = Math.floor(secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

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
  const [appConfig,  setAppConfig]  = useState<PublicMosaicConfig | null>(null);

  const [audioDevices,     setAudioDevices]     = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [micLevel,         setMicLevel]         = useState(0);
  const [recWarning,       setRecWarning]       = useState<string | null>(null);
  const [chunkProgress,    setChunkProgress]    = useState<{ done: number; total: number } | null>(null);
  const [debugAudioUrl,    setDebugAudioUrl]    = useState<string | null>(null);

  // Tab + summary state
  const [activeTab,         setActiveTab]         = useState<WorkspaceTab>("notes");
  const [highlightSegmentId, setHighlightSegmentId] = useState<string | null>(null);
  const [summaryLoading,    setSummaryLoading]    = useState(false);
  const [summaryError,      setSummaryError]      = useState<string | null>(null);
  const [hasUserEditedSummary, setHasUserEditedSummary] = useState(false);

  // Refs — recording
  const mediaRef             = useRef<MediaRecorder | null>(null);
  const chunks               = useRef<Blob[]>([]);
  const streamRef            = useRef<MediaStream | null>(null);
  const displayRef           = useRef<MediaStream | null>(null);
  const audioCtxRef          = useRef<AudioContext | null>(null);
  const audioDestRef         = useRef<MediaStreamAudioDestinationNode | null>(null);
  const timerRef             = useRef<ReturnType<typeof setInterval> | null>(null);
  const saveTimer            = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micGainRef           = useRef<GainNode | null>(null);
  const micAnalyserRef       = useRef<AnalyserNode | null>(null);
  const levelTimerRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const trackCleanupFnsRef   = useRef<Array<() => void>>([]);
  const meetingEndedRef      = useRef(false);
  const isSettingUpRef       = useRef(false);
  const debugAudioUrlRef     = useRef<string | null>(null);
  const isFinalStopRef       = useRef(false);
  const chunkRotateTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunkResultsRef      = useRef<Map<number, { text: string; lang: string; conf: number | null; low: boolean }>>(new Map());
  const chunkNormalizedRef   = useRef<Map<number, NormalizedTranscript>>(new Map());
  const pendingChunksRef     = useRef(0);
  const totalSegmentsRef     = useRef(0);
  const chunkGcsPathsRef     = useRef<Map<number, string>>(new Map());

  // Refs — summary (prevent concurrent calls, avoid stale closures)
  const summaryLoadingRef        = useRef(false);
  const initialTabSetRef         = useRef(false);
  const autoSummarizedTimestampRef = useRef<number | null>(null);

  // ── Load public app config ──────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/config")
      .then(r => r.json())
      .then((cfg: PublicMosaicConfig) => setAppConfig(cfg))
      .catch(() => {});
  }, []);

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

    const currentUid = auth.currentUser?.uid;
    if (!currentUid) { setLoading(false); return; }

    loadMeetingFromFirestore(currentUid, eventId).then(remote => {
      if (!remote) {
        syncMeetingToFirestore(currentUid, local).catch(() => {});
        return;
      }
      const merged: MeetingLocalData = {
        ...local,
        ...remote,
        recording:   remote.recording   ?? local.recording,
        aiSummary:   remote.aiSummary   ?? local.aiSummary,
        notes:       remote.notes.length >= local.notes.length ? remote.notes : local.notes,
        actionItems: remote.actionItems.length >= local.actionItems.length ? remote.actionItems : local.actionItems,
      };
      saveMeetingData(merged);
      setData(merged);
      if (merged.recording) { setTranscript(merged.recording); setRecStatus("done"); }
    }).catch(() => {}).finally(() => setLoading(false));
  }, [eventId]);

  // ── Initialize default tab once data loads ──────────────────────────────────
  useEffect(() => {
    if (!data || initialTabSetRef.current) return;
    initialTabSetRef.current = true;
    if (data.evidenceSummary || data.aiSummary) {
      setActiveTab("summary");
    } else if (data.recording) {
      setActiveTab("transcript");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!data]);

  // ── Cleanup on unmount ──────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (levelTimerRef.current)       clearInterval(levelTimerRef.current);
      if (timerRef.current)            clearInterval(timerRef.current);
      if (saveTimer.current)           clearTimeout(saveTimer.current);
      if (chunkRotateTimerRef.current) clearInterval(chunkRotateTimerRef.current);
      trackCleanupFnsRef.current.forEach(fn => fn());
      displayRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (audioCtxRef.current?.state !== "closed") audioCtxRef.current?.close().catch(() => {});
      if (debugAudioUrlRef.current) { URL.revokeObjectURL(debugAudioUrlRef.current); debugAudioUrlRef.current = null; }
    };
  }, []);

  // ── Auto-save ───────────────────────────────────────────────────────────────
  const update = useCallback((patch: Partial<MeetingLocalData>) => {
    setData(prev => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      setSaved(false);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const currentUid = auth.currentUser?.uid;
        if (currentUid) {
          syncMeetingToFirestore(currentUid, next)
            .then(() => { saveMeetingData(next); setSaved(true); })
            .catch(() => { saveMeetingData(next); setSaved(true); });
        } else {
          saveMeetingData(next);
          setSaved(true);
        }
      }, 800);
      return next;
    });
  }, []);

  const pushTimeline = useCallback((type: TimelineEvent["type"], description: string) => {
    setData(prev => {
      if (!prev) return prev;
      const next = addTimelineEvent(prev, type, description);
      const currentUid = auth.currentUser?.uid;
      if (currentUid) syncMeetingToFirestore(currentUid, next).catch(() => {});
      saveMeetingData(next);
      return next;
    });
  }, []);

  // ── Summary generation ──────────────────────────────────────────────────────
  const generateSummary = useCallback(async (result: RecordingResult, isRegeneration = false) => {
    if (summaryLoadingRef.current) return;

    if (isRegeneration && hasUserEditedSummary) {
      const confirmed = window.confirm(
        "Regenerating will replace your manual edits to the summary. Continue?"
      );
      if (!confirmed) return;
      setHasUserEditedSummary(false);
    }

    summaryLoadingRef.current = true;
    setSummaryLoading(true);
    setSummaryError(null);

    try {
      const body = result.normalizedTranscript
        ? { normalizedTranscript: result.normalizedTranscript, meetingTitle: data?.title, meetingId: eventId }
        : { transcript: result.translated_transcript, segments: result.segments, meetingId: eventId };

      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json() as EvidenceBackedSummary & { error?: string; failureCategory?: string };

      if (!res.ok) {
        throw new Error(json.error ?? "AI processing is temporarily unavailable. Your recording has been preserved.");
      }

      if (json.provider) {
        update({ evidenceSummary: json, aiSummary: null });
        pushTimeline("summary_generated", "AI summary generated");
        // Auto-switch to summary tab — but not while user is actively recording
        setData(prev => {
          if (prev?.recording && recStatus !== "recording" && recStatus !== "processing") {
            setActiveTab("summary");
          } else if (!prev?.recording) {
            // No recording context check — just switch
          }
          return prev;
        });
        // Unconditional switch when not actively capturing
        if (recStatus !== "recording" && recStatus !== "processing") {
          setActiveTab("summary");
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "AI processing failed. Your recording has been preserved.";
      setSummaryError(msg);
    } finally {
      setSummaryLoading(false);
      summaryLoadingRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.title, eventId, hasUserEditedSummary, recStatus, update, pushTimeline]);

  // Auto-trigger summary after transcript arrives — fires at most once per transcript timestamp
  useEffect(() => {
    if (
      transcript &&
      !data?.evidenceSummary &&
      !data?.aiSummary &&
      !summaryLoadingRef.current &&
      autoSummarizedTimestampRef.current !== transcript.timestamp
    ) {
      autoSummarizedTimestampRef.current = transcript.timestamp;
      generateSummary(transcript);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcript?.timestamp]);

  // ── Evidence click: navigate to transcript + scroll + highlight ─────────────
  const handleEvidenceClick = useCallback((segmentId: string) => {
    setHighlightSegmentId(segmentId);
    setActiveTab("transcript");
  }, []);

  const handleHighlightClear = useCallback(() => {
    setHighlightSegmentId(null);
  }, []);

  // ── Update action item in evidence summary ──────────────────────────────────
  const handleUpdateActionItem = useCallback((itemId: string, changes: Partial<GroundedActionItem>) => {
    setData(prev => {
      if (!prev?.evidenceSummary) return prev;
      const updatedItems = prev.evidenceSummary.actionItems.map(item =>
        item.id === itemId ? { ...item, ...changes } : item
      );
      const next = {
        ...prev,
        evidenceSummary: { ...prev.evidenceSummary, actionItems: updatedItems },
      };
      saveMeetingData(next);
      return next;
    });
    setHasUserEditedSummary(true);
  }, []);

  // ── Recording ───────────────────────────────────────────────────────────────
  const cleanupMonitoring = useCallback(() => {
    if (levelTimerRef.current)       { clearInterval(levelTimerRef.current);       levelTimerRef.current       = null; }
    if (timerRef.current)            { clearInterval(timerRef.current);            timerRef.current            = null; }
    if (chunkRotateTimerRef.current) { clearInterval(chunkRotateTimerRef.current); chunkRotateTimerRef.current = null; }
    trackCleanupFnsRef.current.forEach(fn => fn());
    trackCleanupFnsRef.current = [];
    setMicLevel(0);
  }, []);

  const startRecording = async () => {
    if (isSettingUpRef.current || recStatus === "processing") return;
    isSettingUpRef.current = true;

    cleanupMonitoring();
    meetingEndedRef.current = false;
    isFinalStopRef.current = false;
    chunks.current = [];
    chunkResultsRef.current = new Map();
    chunkNormalizedRef.current = new Map();
    chunkGcsPathsRef.current = new Map();
    pendingChunksRef.current = 0;
    totalSegmentsRef.current = 0;
    setChunkProgress(null);
    setRecError(null);
    setRecWarning(null);
    if (debugAudioUrlRef.current) { URL.revokeObjectURL(debugAudioUrlRef.current); debugAudioUrlRef.current = null; setDebugAudioUrl(null); }

    // Room-recording microphone constraints — voice isolation intentionally OFF
    // so remote voices playing through speakers are captured acoustically.
    const supported = navigator.mediaDevices.getSupportedConstraints();
    const roomAudioConstraints: MediaTrackConstraints = {};
    if (supported.echoCancellation) roomAudioConstraints.echoCancellation = false;
    if (supported.noiseSuppression) roomAudioConstraints.noiseSuppression = false;
    if (supported.autoGainControl)  roomAudioConstraints.autoGainControl  = false;
    if (supported.channelCount)     roomAudioConstraints.channelCount     = 1;
    if (selectedDeviceId && supported.deviceId) roomAudioConstraints.deviceId = { exact: selectedDeviceId };
    const micConstraints: MediaStreamConstraints = { audio: roomAudioConstraints };

    const micPromise = navigator.mediaDevices.getUserMedia(micConstraints);

    let ctx: AudioContext | null = null;
    const mode: RecordingMode = "mic_only";

    try {
      ctx = new AudioContext();
      audioCtxRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();

      const dest = ctx.createMediaStreamDestination();
      audioDestRef.current = dest;

      let micStream: MediaStream;
      try {
        micStream = await micPromise;
      } catch (err: unknown) {
        const e = err instanceof Error ? err : new Error(String(err));
        throw new Error((e as { name?: string }).name === "NotAllowedError" ? "Microphone access denied." : (e.message ?? "Could not access microphone."));
      }

      streamRef.current = micStream;

      if (process.env.NODE_ENV === "development") {
        const track = micStream.getAudioTracks()[0];
        if (track) {
          const settings = track.getSettings();
          console.log("[MOSAIC][dev] Mic track settings:", {
            requested: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            actual: { echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression, autoGainControl: settings.autoGainControl, sampleRate: settings.sampleRate, channelCount: settings.channelCount },
            deviceId: settings.deviceId, label: track.label, enabled: track.enabled, muted: track.muted, readyState: track.readyState,
          });
        }
      }

      if (audioDevices.length === 0) {
        navigator.mediaDevices.enumerateDevices().then(devs =>
          setAudioDevices(devs.filter(d => d.kind === "audioinput"))
        );
      }

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

      const micTrack = micStream.getAudioTracks()[0];
      if (micTrack) {
        const onMicEnded = () => {
          setRecWarning("Microphone disconnected. Please check your microphone connection.");
          pushTimeline("recording_started", "Microphone disconnected during recording");
        };
        micTrack.addEventListener("ended", onMicEnded);
        trackCleanupFnsRef.current.push(() => micTrack.removeEventListener("ended", onMicEnded));
      }

      // Quick Recording: mic only — no getDisplayMedia, no screen picker.

      const mimeTypes = ["audio/webm;codecs=opus", "audio/webm", "video/webm;codecs=opus", "video/webm"];
      const mime = mimeTypes.find(t => MediaRecorder.isTypeSupported(t)) ?? "";
      const blobType = mime || "audio/webm";

      const uploadChunkToGcs = async (blob: Blob, chunkIndex: number) => {
        try {
          const res = await fetch("/api/recordings/signed-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ meetingId: eventId, chunkIndex, mimeType: blobType }),
          });
          if (!res.ok) return;
          const { uploadUrl, gcsPath } = await res.json() as { uploadUrl: string; gcsPath: string };
          await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": blobType }, body: blob });
          chunkGcsPathsRef.current.set(chunkIndex, gcsPath);
        } catch {
          console.warn(`GCS upload failed for chunk ${chunkIndex}`);
        }
      };

      const finalizeCombined = () => {
        const indices = Array.from(chunkResultsRef.current.keys()).sort((a, b) => a - b);
        if (indices.length === 0) {
          setRecStatus("error");
          setRecError("No audio was captured. Try recording again.");
          return;
        }
        const first    = chunkResultsRef.current.get(indices[0])!;
        const combined = indices.map(i => chunkResultsRef.current.get(i)!.text).join("\n\n");
        const confs    = indices.map(i => chunkResultsRef.current.get(i)!.conf).filter((c): c is number => c !== null);
        const avgConf  = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
        const anyLow   = indices.some(i => chunkResultsRef.current.get(i)!.low);
        const gcsPaths = indices.map(i => chunkGcsPathsRef.current.get(i)).filter((p): p is string => p !== undefined);

        const chunkNTs = indices.map(i => chunkNormalizedRef.current.get(i)).filter((n): n is NormalizedTranscript => !!n);
        let mergedNormalized: NormalizedTranscript | undefined;
        if (chunkNTs.length > 0) {
          let segCounter = 0;
          const allSegments = chunkNTs.flatMap(nt => nt.segments.map(seg => ({
            ...seg,
            segmentId: `S${String(++segCounter).padStart(3, "0")}`,
          })));
          mergedNormalized = {
            ...chunkNTs[0],
            fullText: chunkNTs.map(nt => nt.fullText).join(" "),
            originalFullText: chunkNTs.map(nt => nt.originalFullText).join(" "),
            segments: allSegments,
            durationSeconds: chunkNTs.reduce((s, nt) => s + (nt.durationSeconds ?? 0), 0) || null,
            processingMetadata: {
              ...chunkNTs[0].processingMetadata,
              completedAt: chunkNTs[chunkNTs.length - 1].processingMetadata.completedAt,
            },
          };
        }

        const result: RecordingResult = {
          translated_transcript: combined,
          input_language: first.lang,
          confidence: avgConf,
          low_confidence: anyLow,
          timestamp: Date.now(),
          recordingMode: mode,
          microphoneCaptured: true,
          meetingAudioCaptured: false,
          meetingAudioEndedDuringRecording: meetingEndedRef.current,
          mimeType: blobType,
          chunkGcsPaths: gcsPaths.length > 0 ? gcsPaths : undefined,
          audioGcsBucket: gcsPaths.length > 0 ? (process.env.NEXT_PUBLIC_GCS_RECORDINGS_BUCKET || undefined) : undefined,
          normalizedTranscript: mergedNormalized,
        };
        setTranscript(result);
        setRecStatus("done");
        setChunkProgress(null);
        setData(prev => {
          if (!prev) return prev;
          const next = addTimelineEvent({ ...prev, recording: result }, "recording_done", "Recording completed and transcribed");
          const currentUid = auth.currentUser?.uid;
          if (currentUid) {
            syncMeetingToFirestore(currentUid, next)
              .then(() => saveMeetingData(next))
              .catch(() => saveMeetingData(next));
          } else {
            saveMeetingData(next);
          }
          return next;
        });
      };

      const transcribeChunk = async (blob: Blob, chunkIndex: number) => {
        pendingChunksRef.current++;
        uploadChunkToGcs(blob, chunkIndex);
        const translationEnabled = localStorage.getItem("mosaic_translation_enabled") === "true";
        try {
          const form = new FormData();
          form.append("file", new File([blob], `chunk-${chunkIndex}.webm`, { type: blobType }));
          if (!translationEnabled) form.append("skipTranslation", "true");
          const res  = await fetch("/api/transcribe", { method: "POST", body: form });
          const json = await res.json() as {
            success?: boolean; translated_transcript?: string; input_language?: string;
            confidence?: number | null; low_confidence?: boolean;
            normalizedTranscript?: NormalizedTranscript;
            error?: string; message?: string;
          };
          if (json.success !== false) {
            chunkResultsRef.current.set(chunkIndex, {
              text: json.translated_transcript ?? "",
              lang: json.input_language ?? "Unknown",
              conf: json.confidence ?? null,
              low:  !!json.low_confidence,
            });
            if (json.normalizedTranscript) chunkNormalizedRef.current.set(chunkIndex, json.normalizedTranscript);
          } else {
            chunkResultsRef.current.set(chunkIndex, {
              text: `[Part ${chunkIndex + 1} could not be transcribed]`,
              lang: "Unknown", conf: null, low: false,
            });
          }
        } catch {
          chunkResultsRef.current.set(chunkIndex, {
            text: `[Part ${chunkIndex + 1} unavailable]`,
            lang: "Unknown", conf: null, low: false,
          });
        } finally {
          pendingChunksRef.current--;
          setChunkProgress({ done: chunkResultsRef.current.size, total: totalSegmentsRef.current });
          if (isFinalStopRef.current && pendingChunksRef.current === 0) finalizeCombined();
        }
      };

      const startSegment = (chunkIndex: number) => {
        chunks.current = [];
        totalSegmentsRef.current++;
        const mr = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
        mediaRef.current = mr;
        mr.ondataavailable = e => { if (e.data.size > 0) chunks.current.push(e.data); };
        mr.onstop = () => {
          const blob = new Blob(chunks.current, { type: blobType });
          const isFinal = isFinalStopRef.current;

          if (isFinal) {
            displayRef.current?.getTracks().forEach(t => t.stop());
            streamRef.current?.getTracks().forEach(t => t.stop());
            displayRef.current = null;
            streamRef.current  = null;
            ctx?.close().catch(() => {});
            audioCtxRef.current  = null;
            audioDestRef.current = null;
          } else {
            startSegment(chunkIndex + 1);
          }

          if (blob.size > 0) {
            if (isFinal && process.env.NODE_ENV === "development") {
              const devUrl = URL.createObjectURL(blob);
              debugAudioUrlRef.current = devUrl;
              setDebugAudioUrl(devUrl);
              console.log("[MOSAIC][dev] Raw recording ready:", devUrl, `(${blob.size} bytes)`);
            }
            transcribeChunk(blob, chunkIndex);
          } else if (isFinal && pendingChunksRef.current === 0) {
            finalizeCombined();
          }
        };
        mr.start(1000);
      };

      startSegment(0);

      chunkRotateTimerRef.current = setInterval(() => {
        if (mediaRef.current?.state === "recording") mediaRef.current.stop();
      }, CHUNK_SECS * 1000);

      levelTimerRef.current = setInterval(() => {
        if (micAnalyserRef.current) {
          const buf = new Uint8Array(micAnalyserRef.current.frequencyBinCount);
          micAnalyserRef.current.getByteFrequencyData(buf);
          setMicLevel(buf.reduce((a, b) => a + b, 0) / (buf.length * 255));
        }
      }, 100);

      let secs = 0;
      timerRef.current = setInterval(() => { secs++; setElapsed(secs); }, 1000);
      setElapsed(0);
      setRecStatus("recording");
      pushTimeline("recording_started", "Recording started (microphone)");

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
    isFinalStopRef.current = true;
    mediaRef.current?.stop();
    setRecStatus("processing");
  };

  const fmt = (s: number) => `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

  // ── Loading skeleton ─────────────────────────────────────────────────────────
  if (loading || !data) {
    return (
      <div className="min-h-screen bg-black text-white">
        <div className="border-b border-gray-800 bg-black sticky top-0 z-10 h-16" />
        <div className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-8 animate-pulse">
          <div className="h-5 bg-gray-800 rounded w-40" />
          <div className="h-32 bg-gray-900 border border-gray-800 rounded-xl" />
          <div className="h-8 bg-gray-900 border border-gray-800 rounded" />
          <div className="h-64 bg-gray-900 border border-gray-800 rounded-xl" />
        </div>
      </div>
    );
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

      {/* Demo mode banner */}
      {appConfig?.appMode === "demo" && (
        <div className="bg-gray-900 border-b border-gray-800 px-4 py-1.5 text-center">
          <span className="text-[11px] text-gray-500">
            Demo Mode · Free processing limits apply ·{" "}
            {appConfig.capabilities.speakerDiarization ? "Speaker separation available" : "Single-speaker transcription"}
          </span>
        </div>
      )}

      {/* ── Header ── */}
      <div className="border-b border-gray-800 bg-black sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 pt-4 pb-0">
          <div className="flex items-start justify-between gap-4 pb-3">
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
              {attendees.length > 0 && (
                <div className="flex items-center mr-2">
                  {attendees.slice(0, 4).map((a, i) => (
                    <div key={i} title={a.displayName ?? a.email}
                      className="w-7 h-7 rounded-full bg-gray-700 border-2 border-black flex items-center justify-center text-[10px] font-bold text-gray-300 -ml-1.5 first:ml-0">
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
              <button
                onClick={() => update({ isPinned: !data.isPinned })}
                title={data.isPinned ? "Unpin" : "Pin"}
                className={`text-lg transition ${data.isPinned ? "text-yellow-400" : "text-gray-700 hover:text-gray-400"}`}
              >★</button>
              <span className="text-xs text-gray-700 ml-1">{saved ? "Saved" : "Saving…"}</span>
              {event?.hangoutLink && (
                <a href={event.hangoutLink} target="_blank" rel="noopener noreferrer"
                  className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg font-medium transition">
                  Join Meeting
                </a>
              )}
              {/* Quick record — unchanged */}
              {recStatus === "idle" && (
                <button onClick={() => startRecording()}
                  className="text-xs bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded-lg font-medium transition">
                  ⏺ Record
                </button>
              )}
              {recStatus === "recording" && (
                <button onClick={stopRecording}
                  className="text-xs border border-red-500 text-red-400 px-3 py-1.5 rounded-lg font-medium hover:bg-red-950 transition">
                  ⏹ {fmt(elapsed)}
                </button>
              )}
              {recStatus === "processing" && (
                <span className="text-xs text-yellow-400">
                  {chunkProgress && chunkProgress.total > 1
                    ? `Transcribing… ${chunkProgress.done}/${chunkProgress.total}`
                    : "Transcribing…"}
                </span>
              )}
            </div>
          </div>

          {/* ── Tab bar (part of sticky header) ── */}
          <div className="flex border-t border-gray-800 -mx-6 px-6">
            {(["summary", "notes", "transcript"] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-5 py-3 text-sm font-medium transition border-b-2 -mb-px ${
                  activeTab === tab
                    ? "text-white border-white"
                    : "text-gray-500 hover:text-gray-300 border-transparent"
                }`}
              >
                {tab === "summary" ? "Summary" : tab === "notes" ? "Notes" : "Transcript"}
              </button>
            ))}
            {summaryLoading && (
              <span className="ml-auto flex items-center pr-1 text-[11px] text-gray-600 animate-pulse">
                Generating summary…
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="max-w-4xl mx-auto px-6 py-6 flex flex-col gap-6">

        {/* Recording card — always at top, above tabs */}
        <div>
          <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-3">Recording</p>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            {recStatus === "idle" && (
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => startRecording()}
                  className="w-full flex items-center justify-between bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-600 rounded-xl px-5 py-4 transition text-left group"
                >
                  <div>
                    <p className="text-sm font-semibold text-white mb-0.5">⏺ Start Recording</p>
                    <p className="text-xs text-gray-500">Records room audio through your microphone. Transcribes and summarizes with AI.</p>
                  </div>
                  <span className="text-gray-600 group-hover:text-gray-400 ml-4 flex-shrink-0 text-lg">→</span>
                </button>
                <p className="text-xs text-gray-700 px-1">
                  For virtual meetings, use your computer speakers and disconnect headphones so all participants can be heard.
                </p>
                {audioDevices.length > 1 && (
                  <div className="px-1">
                    <label className="text-xs text-gray-500 mb-1 block">Microphone</label>
                    <select
                      value={selectedDeviceId}
                      onChange={e => setSelectedDeviceId(e.target.value)}
                      className="w-full bg-gray-900 border border-gray-700 text-xs text-gray-300 rounded-lg px-3 py-1.5 outline-none"
                    >
                      <option value="">Default microphone</option>
                      {audioDevices.map(d => (
                        <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0, 6)}`}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}
            {recStatus === "recording" && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-xl font-mono font-bold text-red-400">{fmt(elapsed)}</span>
                    <div className="flex items-end gap-px h-3" aria-label="Microphone level">
                      {[0.15, 0.35, 0.55, 0.75].map((threshold, i) => (
                        <div key={i}
                          className={`w-1 rounded-sm transition-all duration-100 ${micLevel > threshold ? "bg-green-400" : "bg-gray-700"}`}
                          style={{ height: `${(i + 1) * 25}%` }} />
                      ))}
                    </div>
                    <span className="text-xs text-gray-500">Recording</span>
                  </div>
                  <button onClick={stopRecording}
                    className="border border-red-500 text-red-400 hover:bg-red-950 text-sm font-semibold px-4 py-2 rounded-lg transition">
                    ⏹ Stop
                  </button>
                </div>
                {recWarning && (
                  <div className="bg-yellow-950/20 border border-yellow-900/30 rounded-lg px-4 py-2.5 text-xs text-yellow-400">
                    {recWarning}
                  </div>
                )}
              </div>
            )}
            {recStatus === "processing" && (
              <div className="flex items-center gap-3 text-sm text-gray-400">
                <span className="animate-spin inline-block">⟳</span>
                {chunkProgress && chunkProgress.total > 1
                  ? `Transcribing… (${chunkProgress.done}/${chunkProgress.total} segments done)`
                  : "Transcribing… usually takes 10–30 seconds."}
              </div>
            )}
            {recStatus === "done" && transcript && (
              <div className="flex flex-col gap-3">
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
                  <button onClick={() => startRecording()}
                    className="text-xs text-gray-600 hover:text-gray-400 border border-gray-800 hover:border-gray-600 px-2.5 py-1 rounded-lg transition">
                    Re-record
                  </button>
                </div>
                {process.env.NODE_ENV === "development" && debugAudioUrl && (
                  <div className="border border-yellow-900/30 rounded-lg p-3 bg-yellow-950/10">
                    <p className="text-[10px] font-mono text-yellow-600 mb-2">[DEV] Raw recording — play to confirm remote audio captured before evaluating transcript</p>
                    <audio src={debugAudioUrl} controls className="w-full" style={{ height: "32px" }} />
                  </div>
                )}
              </div>
            )}
            {recStatus === "error" && (
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm text-red-400 font-medium">Recording failed</p>
                  <p className="text-xs text-gray-600 mt-0.5">{recError}</p>
                </div>
                <button onClick={() => startRecording()}
                  className="text-xs bg-red-600 hover:bg-red-500 text-white font-semibold px-4 py-2 rounded-lg transition flex-shrink-0">
                  Try Again
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Tab content ── */}
        {activeTab === "summary" && (
          <SummaryTabPanel
            transcript={transcript}
            data={data}
            update={update}
            summaryLoading={summaryLoading}
            summaryError={summaryError}
            onRegenerate={() => { setSummaryError(null); if (transcript) generateSummary(transcript, true); }}
            onEvidenceClick={handleEvidenceClick}
            onUpdateActionItem={handleUpdateActionItem}
            recStatus={recStatus}
            onStartRecording={startRecording}
          />
        )}

        {activeTab === "notes" && (
          <NotesTabPanel
            notes={data.notes}
            saved={saved}
            onChange={notes => update({ notes })}
            onFirstNote={() => { if (!data.notes) pushTimeline("note_added", "Notes started"); }}
          />
        )}

        {activeTab === "transcript" && (
          <TranscriptTabPanel
            transcript={transcript}
            data={data}
            update={update}
            highlightSegmentId={highlightSegmentId}
            onHighlightClear={handleHighlightClear}
          />
        )}
      </div>
    </div>
  );
}

// ── Summary Tab Panel ──────────────────────────────────────────────────────────
function SummaryTabPanel({
  transcript, data, update, summaryLoading, summaryError,
  onRegenerate, onEvidenceClick, onUpdateActionItem, recStatus, onStartRecording,
}: {
  transcript: RecordingResult | null;
  data: MeetingLocalData;
  update: (p: Partial<MeetingLocalData>) => void;
  summaryLoading: boolean;
  summaryError: string | null;
  onRegenerate: () => void;
  onEvidenceClick: (segmentId: string) => void;
  onUpdateActionItem: (itemId: string, changes: Partial<GroundedActionItem>) => void;
  recStatus: string;
  onStartRecording: () => void;
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
          onClick={onStartRecording}
          disabled={recStatus === "processing"}
          className="bg-red-600 hover:bg-red-500 text-white font-semibold px-8 py-3 rounded-xl transition disabled:opacity-50"
        >
          {recStatus === "processing" ? "Transcribing…" : "Start Recording"}
        </button>
      </div>
    );
  }

  const evidenceSummary = data.evidenceSummary;
  const normalizedSegments = transcript.normalizedTranscript?.segments;

  const copyAll = () => {
    const transcriptText = normalizedSegments
      ? normalizedSegments.map(s => `${s.speakerLabel ?? "Speaker"}: ${s.translatedText}`).join("\n")
      : transcript.segments && transcript.segments.length > 0
        ? transcript.segments.map(s => `Speaker ${s.speaker}: ${s.translated_text}`).join("\n")
        : transcript.translated_transcript;
    const lines = [
      "# Meeting Summary",
      `Language: ${transcript.input_language}`,
      "",
    ];
    if (evidenceSummary) {
      if (evidenceSummary.executiveSummary.length > 0) {
        lines.push("## Executive Summary");
        evidenceSummary.executiveSummary.forEach(i => lines.push(`- ${i.text}`));
        lines.push("");
      }
      if (evidenceSummary.actionItems.length > 0) {
        lines.push("## Action Items");
        evidenceSummary.actionItems.forEach(i => {
          let line = `- [ ] ${i.text}`;
          if (i.owner) line += ` (Owner: ${i.owner})`;
          if (i.dueDate) line += ` (Due: ${i.dueDate})`;
          lines.push(line);
        });
        lines.push("");
      }
    }
    lines.push("## Full Transcript", transcriptText);
    navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Loading state
  if (summaryLoading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-12 text-center">
          <div className="text-2xl mb-3 animate-pulse">✦</div>
          <p className="text-gray-400 text-sm animate-pulse">Generating meeting summary…</p>
          <p className="text-gray-600 text-xs mt-2">Claude is analysing the complete discussion</p>
        </div>
      </div>
    );
  }

  // Only show legacy summary when there's no evidence summary, no active error, and explicit prior aiSummary exists
  const legacySummary = (!evidenceSummary && !summaryError && !summaryLoading && data.aiSummary) ? data.aiSummary : null;

  return (
    <div className="flex flex-col gap-5">
      {/* Error / retry */}
      {summaryError && (
        <div className="bg-yellow-950/30 border border-yellow-900/40 rounded-xl px-5 py-3 flex items-center justify-between gap-4">
          <span className="text-yellow-400 text-sm">{summaryError}</span>
          <button onClick={onRegenerate}
            className="text-xs text-yellow-300 border border-yellow-800 hover:border-yellow-600 px-3 py-1.5 rounded-lg transition flex-shrink-0">
            Retry Summary
          </button>
        </div>
      )}

      {/* Actions bar */}
      <div className="flex items-center gap-2 justify-end">
        <button onClick={copyAll}
          className="text-xs text-gray-500 hover:text-white border border-gray-800 hover:border-gray-600 px-3 py-1.5 rounded-lg transition">
          {copied ? "Copied!" : "Copy"}
        </button>
        <button onClick={onRegenerate}
          className="text-xs text-gray-500 hover:text-white border border-gray-800 hover:border-gray-600 px-3 py-1.5 rounded-lg transition">
          Regenerate Summary
        </button>
      </div>

      {/* Confidence / meta chips */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="bg-gray-800 text-gray-400 text-xs px-2.5 py-1 rounded-full border border-gray-700">
          {transcript.input_language} detected
        </span>
        {transcript.confidence !== null && (
          <span className="bg-gray-800 text-gray-400 text-xs px-2.5 py-1 rounded-full border border-gray-700">
            {Math.round((transcript.confidence ?? 0) * 100)}% confidence
          </span>
        )}
        {transcript.low_confidence && (
          <span className="bg-yellow-900/40 text-yellow-400 text-xs px-2.5 py-1 rounded-full border border-yellow-800/40">
            Low confidence
          </span>
        )}
        {evidenceSummary && (
          <span className="bg-blue-900/40 text-blue-400 text-xs px-2.5 py-1 rounded-full border border-blue-800/40">
            Evidence-backed summary
          </span>
        )}
      </div>

      {/* ── Evidence-backed summary ── */}
      {evidenceSummary && (
        <>
          {/* 1. Action Items — always shown */}
          <ActionItemsSection
            items={evidenceSummary.actionItems}
            segments={normalizedSegments}
            onEvidenceClick={onEvidenceClick}
            onUpdateItem={onUpdateActionItem}
          />

          {/* 2. Executive Summary */}
          {evidenceSummary.executiveSummary.length > 0 && (
            <SummarySection title="Executive Summary" icon="📋">
              {evidenceSummary.executiveSummary.map(item => (
                <EvidenceItem key={item.id} item={item} segments={normalizedSegments} onNavigateToTranscript={onEvidenceClick} />
              ))}
            </SummarySection>
          )}

          {/* 3. Key Discussion Topics — structured (new records) */}
          {(evidenceSummary.keyTopics?.length ?? 0) > 0 && (
            <SummarySection title="Key Discussion Topics" icon="💬">
              {evidenceSummary.keyTopics!.map(topic => (
                <div key={topic.id} className="mb-5 last:mb-0">
                  <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{topic.title}</h4>
                  {topic.items.map(item => (
                    <EvidenceItem key={item.id} item={item} segments={normalizedSegments} onNavigateToTranscript={onEvidenceClick} />
                  ))}
                </div>
              ))}
            </SummarySection>
          )}

          {/* Fall back to flat discussionPoints for old records */}
          {!(evidenceSummary.keyTopics?.length) && evidenceSummary.discussionPoints.length > 0 && (
            <SummarySection title="Discussion" icon="💬">
              {evidenceSummary.discussionPoints.map(item => (
                <EvidenceItem key={item.id} item={item} segments={normalizedSegments} onNavigateToTranscript={onEvidenceClick} />
              ))}
            </SummarySection>
          )}

          {/* 4. Decisions */}
          {evidenceSummary.decisions.length > 0 && (
            <SummarySection title="Decisions" icon="✅">
              {evidenceSummary.decisions.map(item => (
                <EvidenceItem key={item.id} item={item} segments={normalizedSegments} onNavigateToTranscript={onEvidenceClick} />
              ))}
            </SummarySection>
          )}

          {/* 5. Open Questions */}
          {evidenceSummary.questions.length > 0 && (
            <SummarySection title="Open Questions" icon="❓">
              {evidenceSummary.questions.map(item => (
                <EvidenceItem key={item.id} item={item} segments={normalizedSegments} onNavigateToTranscript={onEvidenceClick} />
              ))}
            </SummarySection>
          )}

          {/* 6. Risks & Concerns */}
          {evidenceSummary.risks.length > 0 && (
            <SummarySection title="Risks & Concerns" icon="⚠️">
              {evidenceSummary.risks.map(item => (
                <EvidenceItem key={item.id} item={item} segments={normalizedSegments} onNavigateToTranscript={onEvidenceClick} />
              ))}
            </SummarySection>
          )}

          {/* 7. Recommendations Discussed — NOT action items */}
          {(evidenceSummary.recommendations?.length ?? 0) > 0 && (
            <SummarySection title="Recommendations Discussed" icon="💡">
              {evidenceSummary.recommendations!.map(item => (
                <EvidenceItem key={item.id} item={item} segments={normalizedSegments} onNavigateToTranscript={onEvidenceClick} />
              ))}
            </SummarySection>
          )}

          {/* Empty state — action items section always renders, so only check content sections */}
          {evidenceSummary.executiveSummary.length === 0 &&
           !(evidenceSummary.keyTopics?.length) &&
           evidenceSummary.discussionPoints.length === 0 && (
            <div className="text-gray-600 text-sm text-center py-8 bg-gray-900 border border-gray-800 rounded-xl">
              Nothing significant was extracted from this transcript.
            </div>
          )}
        </>
      )}

      {/* ── Legacy flat summary (old records) ── */}
      {!evidenceSummary && legacySummary && (
        <>
          {legacySummary.execSummary && (
            <SummarySection title="Executive Summary" icon="📋">
              <p className="text-gray-300 text-sm leading-relaxed">{legacySummary.execSummary}</p>
            </SummarySection>
          )}
          {legacySummary.topics.length > 0 && (
            <SummarySection title="Discussion" icon="💬">
              {legacySummary.topics.map((topic, i) => (
                <div key={i} className="mb-4 last:mb-0">
                  <div className="text-xs text-gray-600 uppercase tracking-wider mb-1">Topic {i + 1}</div>
                  <p className="text-gray-300 text-sm leading-relaxed">{topic}</p>
                </div>
              ))}
            </SummarySection>
          )}
          {legacySummary.actions.length > 0 && (
            <SummarySection title="Action Items" icon="⚡">
              <EditableList
                items={data.actionItems.map(a => a.text)}
                placeholder="Add action item…"
                suggestions={legacySummary.actions}
                onAdd={text => { update({ actionItems: [...data.actionItems, { id: uid(), text, owner: "", completed: false }] }); }}
                onRemove={i => update({ actionItems: data.actionItems.filter((_, idx) => idx !== i) })}
              />
            </SummarySection>
          )}
        </>
      )}
    </div>
  );
}

// ── Action Items Section ───────────────────────────────────────────────────────
function ActionItemsSection({
  items, segments, onEvidenceClick, onUpdateItem,
}: {
  items: GroundedActionItem[];
  segments: TranscriptSegment[] | undefined;
  onEvidenceClick: (segmentId: string) => void;
  onUpdateItem: (id: string, changes: Partial<GroundedActionItem>) => void;
}) {
  const completedCount = items.filter(i => i.completed).length;
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-800 flex items-center gap-2">
        <span>⚡</span>
        <span className="font-semibold text-sm">Action Items</span>
        {items.length > 0 && completedCount > 0 && (
          <span className="text-xs text-gray-500 ml-1">{completedCount}/{items.length} done</span>
        )}
        {items.length > 0 && (
          <span className="text-xs text-gray-600 ml-auto">{items.length} item{items.length !== 1 ? "s" : ""}</span>
        )}
      </div>
      {items.length === 0 ? (
        <div className="px-5 py-4 text-sm text-gray-600">
          No explicit action items or commitments were detected in this meeting.
        </div>
      ) : (
        <div className="divide-y divide-gray-800">
          {items.map(item => (
            <ActionItemRow
              key={item.id}
              item={item}
              segments={segments}
              onEvidenceClick={onEvidenceClick}
              onUpdate={changes => onUpdateItem(item.id, changes)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ActionItemRow({
  item, segments, onEvidenceClick, onUpdate,
}: {
  item: GroundedActionItem;
  segments: TranscriptSegment[] | undefined;
  onEvidenceClick: (segmentId: string) => void;
  onUpdate: (changes: Partial<GroundedActionItem>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(item.text);

  const commitEdit = () => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== item.text) onUpdate({ text: trimmed });
    setEditing(false);
  };

  return (
    <div className="flex items-start gap-3 px-5 py-4 group">
      {/* Checkbox */}
      <button
        onClick={() => onUpdate({ completed: !item.completed })}
        className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition ${
          item.completed ? "bg-green-600 border-green-600" : "border-gray-600 hover:border-gray-400"
        }`}
        aria-label={item.completed ? "Mark incomplete" : "Mark complete"}
      >
        {item.completed && <span className="text-white text-[9px] font-bold">✓</span>}
      </button>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            value={editText}
            onChange={e => setEditText(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") { setEditText(item.text); setEditing(false); } }}
            className="w-full bg-transparent text-sm text-gray-200 outline-none border-b border-gray-600 pb-0.5"
            autoFocus
          />
        ) : (
          <p
            className={`text-sm leading-relaxed cursor-text ${item.completed ? "line-through text-gray-600" : "text-gray-200"}`}
            onClick={() => { setEditText(item.text); setEditing(true); }}
          >
            {item.text}
          </p>
        )}

        {(item.owner || item.dueDate) && (
          <div className="flex items-center gap-3 mt-1">
            {item.owner && <span className="text-xs text-blue-400">Owner: {item.owner}</span>}
            {item.dueDate && <span className="text-xs text-gray-500">Due: {item.dueDate}</span>}
          </div>
        )}

        {/* Evidence chips */}
        {item.evidenceSegmentIds.length > 0 && (
          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
            {item.evidenceSegmentIds.map(segId => {
              const seg = segments?.find(s => s.segmentId === segId);
              const num = segId.replace(/^S0*/, "") || segId;
              return (
                <button
                  key={segId}
                  onClick={() => onEvidenceClick(segId)}
                  title={seg ? `"${seg.translatedText.slice(0, 120)}${seg.translatedText.length > 120 ? "…" : ""}"` : segId}
                  className="text-[10px] font-mono text-gray-600 hover:text-blue-400 bg-gray-800 hover:bg-gray-700 px-1.5 py-0.5 rounded transition"
                >
                  [{num}]
                </button>
              );
            })}
          </div>
        )}

        {item.verificationStatus === "needs_review" && (
          <span className="text-[10px] text-yellow-600 mt-1 block">Needs review</span>
        )}
      </div>

      {/* Delete */}
      <button
        onClick={() => onUpdate({ text: "" })}
        className="opacity-0 group-hover:opacity-100 text-gray-700 hover:text-red-400 transition text-xs flex-shrink-0 mt-0.5"
        title="Remove action item"
        aria-label="Remove action item"
      >×</button>
    </div>
  );
}

// ── Notes Tab Panel ────────────────────────────────────────────────────────────
function NotesTabPanel({
  notes, saved, onChange, onFirstNote,
}: {
  notes: string;
  saved: boolean;
  onChange: (notes: string) => void;
  onFirstNote?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <span className="text-xs text-gray-700">{saved ? "Saved" : "Saving…"}</span>
      </div>
      <textarea
        value={notes}
        onChange={e => {
          if (!notes && e.target.value) onFirstNote?.();
          onChange(e.target.value);
        }}
        placeholder="Start typing your meeting notes…"
        className="w-full bg-gray-900 border border-gray-800 rounded-xl p-5 text-gray-200 placeholder-gray-700 text-sm leading-relaxed resize-none outline-none focus:border-gray-700 transition min-h-[400px]"
      />
    </div>
  );
}

// ── Transcript Tab Panel ───────────────────────────────────────────────────────
function TranscriptTabPanel({
  transcript, data, update, highlightSegmentId, onHighlightClear,
}: {
  transcript: RecordingResult | null;
  data: MeetingLocalData;
  update: (p: Partial<MeetingLocalData>) => void;
  highlightSegmentId: string | null;
  onHighlightClear: () => void;
}) {
  const [search, setSearch] = useState("");
  const segmentRefs = useRef<{ [id: string]: HTMLDivElement | null }>({});

  // Scroll to highlighted segment on mount or when highlight changes
  useEffect(() => {
    if (!highlightSegmentId) return;
    const el = segmentRefs.current[highlightSegmentId];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const t = setTimeout(onHighlightClear, 2500);
      return () => clearTimeout(t);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightSegmentId]);

  if (!transcript) {
    return (
      <div className="text-center py-16">
        <div className="text-4xl mb-4">📄</div>
        <p className="text-gray-500 text-sm">No transcript yet. Record a meeting to generate a transcript.</p>
      </div>
    );
  }

  const normalizedSegments = transcript.normalizedTranscript?.segments;

  const filteredSegments = normalizedSegments?.filter(seg =>
    !search || seg.translatedText.toLowerCase().includes(search.toLowerCase())
  );

  const uniqueSpeakers = normalizedSegments
    ? Array.from(new Set(normalizedSegments.map(s => s.speakerLabel).filter((s): s is string => !!s))).sort()
    : [];

  const handleSpeakerRename = (providerLabel: string, confirmedName: string) => {
    const existing = data.speakerMappings ?? [];
    const without = existing.filter(m => m.providerLabel !== providerLabel);
    update({ speakerMappings: [...without, { providerLabel, confirmedName: confirmedName.trim() || null }] });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Search */}
      <div className="flex items-center gap-3">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search transcript…"
          className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 text-sm text-gray-300 placeholder-gray-700 outline-none focus:border-gray-600 transition"
        />
        {search && (
          <button onClick={() => setSearch("")}
            className="text-xs text-gray-600 hover:text-gray-300 transition">
            Clear
          </button>
        )}
        {normalizedSegments && search && (
          <span className="text-xs text-gray-600">
            {filteredSegments?.length ?? 0} / {normalizedSegments.length} segments
          </span>
        )}
      </div>

      {/* Speaker legend with rename */}
      {uniqueSpeakers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {uniqueSpeakers.map((label, i) => (
            <SpeakerChip
              key={label}
              providerLabel={label}
              colorClass={SPEAKER_COLORS[i % SPEAKER_COLORS.length]}
              speakerMappings={data.speakerMappings}
              onRename={handleSpeakerRename}
            />
          ))}
        </div>
      )}

      {/* Transcript segments */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {normalizedSegments ? (
          filteredSegments && filteredSegments.length > 0 ? (
            <NormalizedTranscriptView
              segments={filteredSegments}
              speakerMappings={data.speakerMappings}
              highlightSegmentId={highlightSegmentId}
              segmentRefs={segmentRefs}
              searchTerm={search}
            />
          ) : (
            <div className="px-5 py-8 text-center text-sm text-gray-600">
              {search ? `No segments matching "${search}"` : "No segments to display."}
            </div>
          )
        ) : transcript.segments && transcript.segments.length > 0 ? (
          <DiarizedTranscript segments={transcript.segments} />
        ) : (
          <div className="p-5">
            <p className="text-gray-400 text-sm leading-relaxed whitespace-pre-wrap font-mono">
              {transcript.translated_transcript}
            </p>
          </div>
        )}
      </div>

      {/* Language + confidence footer */}
      <div className="flex items-center gap-3 text-xs text-gray-600">
        <span>Language: {transcript.input_language}</span>
        {transcript.confidence !== null && (
          <span>· {Math.round((transcript.confidence ?? 0) * 100)}% confidence</span>
        )}
        {transcript.low_confidence && <span className="text-yellow-600">· Low confidence — review recommended</span>}
        {normalizedSegments && (
          <span>· {normalizedSegments.length} segments</span>
        )}
      </div>
    </div>
  );
}

// ── Speaker chip with rename ───────────────────────────────────────────────────
function SpeakerChip({
  providerLabel, colorClass, speakerMappings, onRename,
}: {
  providerLabel: string;
  colorClass: string;
  speakerMappings: MeetingLocalData["speakerMappings"];
  onRename: (label: string, name: string) => void;
}) {
  const mapping = speakerMappings?.find(m => m.providerLabel === providerLabel);
  const displayName = mapping?.confirmedName ?? providerLabel;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(displayName);

  const commit = () => {
    onRename(providerLabel, value);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className={`flex items-center gap-1 bg-gray-800 border border-gray-600 rounded-full px-3 py-1 ${colorClass}`}>
        <input
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
          onBlur={commit}
          className="bg-transparent text-xs outline-none w-24"
          autoFocus
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => { setValue(displayName); setEditing(true); }}
      className={`text-xs font-medium px-3 py-1 rounded-full bg-gray-800 border border-gray-700 hover:border-gray-500 transition ${colorClass}`}
      title="Click to rename speaker"
    >
      {displayName}
      {mapping?.confirmedName && <span className="text-gray-600 ml-1 text-[9px]">({providerLabel})</span>}
      <span className="text-gray-600 ml-1.5 text-[9px]">✏</span>
    </button>
  );
}

// ── Evidence item ──────────────────────────────────────────────────────────────
function EvidenceItem({
  item, segments, onNavigateToTranscript, children,
}: {
  item: GroundedSummaryItem;
  segments: TranscriptSegment[] | undefined;
  onNavigateToTranscript: (segmentId: string) => void;
  children?: React.ReactNode;
}) {
  const statusCfg = {
    supported:           { cls: "text-green-500",  label: "✓" },
    partially_supported: { cls: "text-yellow-500", label: "~" },
    needs_review:        { cls: "text-yellow-400", label: "?" },
    unsupported:         { cls: "text-red-400",    label: "✗" },
  }[item.verificationStatus] ?? { cls: "text-gray-500", label: "?" };

  return (
    <div className="flex items-start gap-2 mb-3 last:mb-0">
      <span className={`mt-1 text-[11px] flex-shrink-0 ${statusCfg.cls}`} title={item.verificationStatus}>
        {statusCfg.label}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-200 leading-relaxed">{item.text}</p>
        {children && <div className="flex flex-col mt-1">{children}</div>}
        {/* Evidence chips — click to navigate to Transcript tab */}
        {item.evidenceSegmentIds.length > 0 && (
          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
            {item.evidenceSegmentIds.map(segId => {
              const seg = segments?.find(s => s.segmentId === segId);
              const num = segId.replace(/^S0*/, "") || segId;
              return (
                <button
                  key={segId}
                  onClick={() => onNavigateToTranscript(segId)}
                  title={seg ? `"${seg.translatedText.slice(0, 120)}${seg.translatedText.length > 120 ? "…" : ""}"` : `Go to ${segId}`}
                  className="text-[10px] font-mono text-gray-600 hover:text-blue-400 bg-gray-800 hover:bg-gray-700 px-1.5 py-0.5 rounded transition"
                >
                  [{num}]
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Normalized transcript view ─────────────────────────────────────────────────
function NormalizedTranscriptView({
  segments, speakerMappings, highlightSegmentId, segmentRefs, searchTerm,
}: {
  segments: TranscriptSegment[];
  speakerMappings: MeetingLocalData["speakerMappings"];
  highlightSegmentId: string | null;
  segmentRefs: React.MutableRefObject<{ [id: string]: HTMLDivElement | null }>;
  searchTerm?: string;
}) {
  const speakers = Array.from(new Set(segments.map(s => s.speakerLabel).filter((s): s is string => !!s))).sort();
  const colorMap = Object.fromEntries(speakers.map((sp, i) => [sp, SPEAKER_COLORS[i % SPEAKER_COLORS.length]]));

  const getDisplayName = (label: string) => {
    const mapping = speakerMappings?.find(m => m.providerLabel === label);
    return mapping?.confirmedName ?? label;
  };

  const renderText = (text: string) => {
    if (!searchTerm) return <>{text}</>;
    const idx = text.toLowerCase().indexOf(searchTerm.toLowerCase());
    if (idx < 0) return <>{text}</>;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-yellow-500/30 text-yellow-200 rounded">{text.slice(idx, idx + searchTerm.length)}</mark>
        {text.slice(idx + searchTerm.length)}
      </>
    );
  };

  return (
    <div className="flex flex-col divide-y divide-gray-800">
      {segments.map(seg => {
        const isHighlighted = seg.segmentId === highlightSegmentId;
        return (
          <div
            key={seg.segmentId}
            ref={el => { segmentRefs.current[seg.segmentId] = el; }}
            id={`seg-${seg.segmentId}`}
            className={`flex gap-3 items-start px-5 py-3 transition-colors duration-300 ${
              isHighlighted
                ? "bg-blue-950/40 border-l-2 border-blue-500 -ml-0.5"
                : "hover:bg-gray-800/20"
            }`}
          >
            <span className="text-[10px] font-mono text-gray-600 mt-0.5 flex-shrink-0 w-10 text-right pt-0.5">
              {fmtTime(seg.startSeconds)}
            </span>
            <div className="flex-1 min-w-0">
              {seg.speakerLabel && (
                <div className={`text-xs font-semibold mb-0.5 ${colorMap[seg.speakerLabel] ?? "text-gray-400"}`}>
                  {getDisplayName(seg.speakerLabel)}
                </div>
              )}
              <p className={`text-sm leading-relaxed ${seg.reviewRequired ? "text-yellow-300" : "text-gray-300"}`}>
                {renderText(seg.translatedText)}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[9px] font-mono text-gray-700">{seg.segmentId}</span>
                {seg.reviewRequired && <span className="text-[10px] text-yellow-600">Low confidence</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Legacy diarized transcript ─────────────────────────────────────────────────
function DiarizedTranscript({ segments }: { segments: DiarizationSegment[] }) {
  const speakers = Array.from(new Set(segments.map(s => s.speaker))).sort();
  const colorMap = Object.fromEntries(speakers.map((sp, i) => [sp, SPEAKER_COLORS[i % SPEAKER_COLORS.length]]));

  return (
    <div className="flex flex-col divide-y divide-gray-800">
      {segments.map((seg, i) => (
        <div key={i} className="flex gap-3 items-start px-5 py-3">
          <span className="text-[10px] font-mono text-gray-600 mt-0.5 flex-shrink-0 w-10 text-right">
            {fmtTime(seg.start_time)}
          </span>
          <div className="flex-1 min-w-0">
            <div className={`text-xs font-semibold mb-0.5 ${colorMap[seg.speaker]}`}>
              Speaker {seg.speaker}
            </div>
            <p className="text-gray-300 text-sm leading-relaxed">{seg.translated_text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Summary section wrapper ────────────────────────────────────────────────────
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

// ── Editable list ──────────────────────────────────────────────────────────────
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
        <button key={i} onClick={() => onAdd(s)}
          className="text-left text-xs text-gray-600 hover:text-gray-300 border border-dashed border-gray-800 hover:border-gray-600 rounded-lg px-3 py-2 transition">
          + {s}
        </button>
      ))}
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2 group">
          <span className="text-gray-400 mt-0.5 flex-shrink-0">•</span>
          <span className="text-sm text-gray-300 flex-1">{item}</span>
          <button onClick={() => onRemove(i)}
            className="text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition text-xs flex-shrink-0">×</button>
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
        <button onClick={add} disabled={!text.trim()}
          className="text-xs text-gray-600 hover:text-white disabled:opacity-30 transition">
          Add
        </button>
      </div>
    </div>
  );
}
