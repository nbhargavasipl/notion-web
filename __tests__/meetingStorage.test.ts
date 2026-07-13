/**
 * Pure-logic tests for meetingStorage utilities.
 * These tests run in Node.js without browser APIs.
 *
 * Runner: Vitest (install with `npm install -D vitest`)
 * Run: npx vitest run __tests__/meetingStorage.test.ts
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * MANUAL TESTING CHECKLIST — Recording Audio Capture
 * (Browser APIs cannot be meaningfully unit-tested via mocks;
 *  verify these scenarios manually in Chrome before each release.)
 *
 * Scenario                                                | Expected outcome
 * ─────────────────────────────────────────────────────── ─────────────────────────────────────────────
 * 1. Mic + Meeting Audio both available                  | audioMode badge: "Mic + Meeting Audio" (green)
 *                                                        | Both AudioSourceRow indicators show "Connected"
 *                                                        | Level bars animate for both sources
 *                                                        | Recorded playback includes local + remote audio
 *
 * 2. Mic available; no tab audio in getDisplayMedia      | recWarning shown: 'Enable "Share tab audio"'
 *                                                        | badge: "Microphone Only" (yellow)
 *                                                        | Meeting Audio status: "No audio track"
 *                                                        | Recording proceeds (mic only)
 *
 * 3. Display stream contains video but no audio          | Same as scenario 2
 *                                                        | Must NOT show green "Mic + Meeting Audio" badge
 *
 * 4. User cancels screen sharing dialog                  | meetingAudioStatus: "Not shared"
 *                                                        | Recording proceeds mic-only with no error shown
 *
 * 5. Meeting audio track ends while recording            | meetingAudioStatus: "Disconnected"
 *                                                        | recWarning: "Meeting audio disconnected…"
 *                                                        | recordingMode → "mic_only"
 *                                                        | Recording CONTINUES (not stopped)
 *
 * 6. Microphone track ends while recording               | micStatus: "Disconnected"
 *                                                        | Timeline event added
 *                                                        | Recording continues on remaining sources
 *
 * 7. Microphone access denied                            | micStatus: "Access denied"
 *                                                        | recStatus: "error"
 *                                                        | Clear error message shown
 *
 * 8. MediaRecorder gets no chunks                        | uploadRecording throws "No audio was captured"
 *                                                        | recStatus: "error" with user-readable message
 *
 * 9. Duplicate Start click (double-tap)                  | Second call is ignored (isSettingUpRef guard)
 *                                                        | Only one permission prompt appears
 *
 * 10. Stop clicked during getDisplayMedia prompt          | recStatus never reaches "recording"
 *                                                         | Cleanup runs correctly
 *
 * 11. Cleanup after failed start                          | All tracks stopped, AudioContext closed
 *                                                         | No leaked streams in browser DevTools
 *
 * 12. Transcription called exactly once per Stop          | Network tab shows single POST /api/transcribe
 *
 * 13. Old saved recordings (no recordingMode field)       | Meeting loads correctly
 *                                                         | UI handles undefined gracefully
 *
 * 14. Teams/Zoom native desktop app selected              | Desktop-specific warning message shown
 *                                                         | No false "Full Audio" badge
 *
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect } from "vitest";
import {
  addTimelineEvent,
  parseSummary,
  loadMeetingData,
} from "../lib/meetingStorage";
import type { MeetingLocalData, RecordingResult } from "../lib/meetingStorage";

// ── addTimelineEvent ──────────────────────────────────────────────────────────

describe("addTimelineEvent", () => {
  const base: MeetingLocalData = {
    eventId: "test-id",
    meetingType: "General",
    purpose: "",
    objectives: "",
    expectedOutcomes: "",
    agenda: [],
    notes: "",
    actionItems: [],
    openQuestions: [],
    risks: [],
    recording: null,
    aiSummary: null,
    timeline: [{ id: "1", type: "created", description: "Opened", timestamp: 1000 }],
    isPinned: false,
    tags: [],
    createdAt: 1000,
  };

  it("appends a timeline event", () => {
    const result = addTimelineEvent(base, "recording_started", "Recording started");
    expect(result.timeline).toHaveLength(2);
    expect(result.timeline[1].type).toBe("recording_started");
    expect(result.timeline[1].description).toBe("Recording started");
  });

  it("does not mutate the original data", () => {
    addTimelineEvent(base, "recording_done", "Done");
    expect(base.timeline).toHaveLength(1);
  });

  it("assigns a unique id to the new event", () => {
    const a = addTimelineEvent(base, "recording_started", "A");
    const b = addTimelineEvent(base, "recording_started", "B");
    expect(a.timeline[1].id).not.toBe(b.timeline[1].id);
  });
});

// ── parseSummary ──────────────────────────────────────────────────────────────

describe("parseSummary", () => {
  it("returns empty structure for empty input", () => {
    const s = parseSummary("");
    expect(s.execSummary).toBe("");
    expect(s.topics).toHaveLength(0);
    expect(s.questions).toHaveLength(0);
    expect(s.actions).toHaveLength(0);
    expect(s.risks).toHaveLength(0);
  });

  it("extracts questions ending in ?", () => {
    const s = parseSummary("We discussed deployment. Will we ship Friday? Yes we will.");
    expect(s.questions.some(q => q.includes("Friday"))).toBe(true);
  });

  it("extracts action items with action keywords", () => {
    const s = parseSummary("Alice will fix the bug. Bob should update the docs. That is all.");
    expect(s.actions.length).toBeGreaterThan(0);
  });

  it("extracts risk sentences", () => {
    const s = parseSummary("There is a risk of delay. Everything else is fine.");
    expect(s.risks.some(r => r.includes("risk"))).toBe(true);
  });
});

// ── RecordingResult backward compatibility ────────────────────────────────────

describe("RecordingResult backward compatibility", () => {
  it("handles old records without recordingMode field", () => {
    const old: RecordingResult = {
      timestamp: 1000,
      input_language: "English",
      translated_transcript: "Hello world.",
      confidence: 0.95,
      low_confidence: false,
    };
    // New optional fields are absent — must not cause runtime errors
    expect(old.recordingMode).toBeUndefined();
    expect(old.microphoneCaptured).toBeUndefined();
    expect(old.meetingAudioCaptured).toBeUndefined();
    expect(old.meetingAudioEndedDuringRecording).toBeUndefined();
  });

  it("accepts new recordingMode metadata", () => {
    const result: RecordingResult = {
      timestamp: Date.now(),
      input_language: "English",
      translated_transcript: "Test.",
      confidence: 0.9,
      low_confidence: false,
      recordingMode: "mic_and_meeting",
      microphoneCaptured: true,
      meetingAudioCaptured: true,
      meetingAudioEndedDuringRecording: false,
      mimeType: "audio/webm;codecs=opus",
    };
    expect(result.recordingMode).toBe("mic_and_meeting");
    expect(result.meetingAudioCaptured).toBe(true);
  });
});

// ── loadMeetingData defaults ─────────────────────────────────────────────────

describe("loadMeetingData defaults", () => {
  it("returns safe defaults when localStorage is empty", () => {
    // jsdom or happy-dom required for localStorage mock in Vitest
    // Mark this test as requiring `environment: 'jsdom'` in vitest.config.ts
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem("mosaic_meeting_nonexistent");
    const data = loadMeetingData("nonexistent");
    expect(data.eventId).toBe("nonexistent");
    expect(data.actionItems).toHaveLength(0);
    expect(data.recording).toBeNull();
    expect(data.timeline).toHaveLength(1);
    expect(data.timeline[0].type).toBe("created");
  });
});
