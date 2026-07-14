"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { MeetingLocalData, saveMeetingData, listLocalMeetingIds, loadMeetingData } from "@/lib/meetingStorage";
import { auth } from "@/lib/firebase/client";
import { listMeetingsFromFirestore } from "@/lib/firestoreSync";

function fmtDate(ts: number) {
  return new Date(ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function meetingTitle(m: MeetingLocalData) {
  if (m.title) return m.title;
  if (m.eventId.startsWith("quick-")) return "Quick Recording";
  return "Meeting";
}

export default function HistoryView() {
  const router = useRouter();
  const [meetings, setMeetings] = useState<MeetingLocalData[]>([]);
  const [search,   setSearch]   = useState("");
  const [loaded,   setLoaded]   = useState(false);

  useEffect(() => {
    const uid = auth.currentUser?.uid;

    if (!uid) {
      // Not signed in — localStorage only
      const cached = listLocalMeetingIds().map(id => loadMeetingData(id));
      setMeetings(cached.sort((a, b) => b.createdAt - a.createdAt));
      setLoaded(true);
      return;
    }

    // Firestore is primary for history
    listMeetingsFromFirestore(uid)
      .then(remote => {
        // Update localStorage cache for offline use
        remote.forEach(r => saveMeetingData(r));
        setMeetings(remote); // already sorted by createdAt desc from Firestore query
      })
      .catch(() => {
        // Offline fallback: read from localStorage cache
        const cached = listLocalMeetingIds().map(id => loadMeetingData(id));
        setMeetings(cached.sort((a, b) => b.createdAt - a.createdAt));
      })
      .finally(() => setLoaded(true));
  }, []);

  const filtered = search.trim()
    ? meetings.filter(m => {
        const q = search.toLowerCase();
        return (
          meetingTitle(m).toLowerCase().includes(q) ||
          m.recording?.translated_transcript?.toLowerCase().includes(q) ||
          m.notes.toLowerCase().includes(q) ||
          m.tags.some(t => t.toLowerCase().includes(q))
        );
      })
    : meetings;

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-800 flex justify-between items-center">
        <span className="text-sm text-gray-400">
          {loaded ? `${meetings.length} meeting${meetings.length !== 1 ? "s" : ""}` : "Loading…"}
        </span>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-black border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white outline-none w-56 focus:border-gray-600 transition"
          placeholder="Search transcripts…"
        />
      </div>

      {/* List */}
      {loaded && filtered.length === 0 ? (
        <div className="px-6 py-12 text-center text-gray-600 text-sm">
          {search
            ? "No meetings match your search."
            : "No recorded meetings yet. Open a meeting and hit record."}
        </div>
      ) : (
        <div className="divide-y divide-gray-800">
          {filtered.map(m => (
            <div
              key={m.eventId}
              onClick={() => router.push(`/meetings/${encodeURIComponent(m.eventId)}`)}
              className="px-6 py-4 hover:bg-gray-800/50 cursor-pointer transition-colors group"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  {/* Title row */}
                  <div className="flex items-center gap-2 flex-wrap mb-0.5">
                    <span className="font-medium text-white truncate">{meetingTitle(m)}</span>
                    {m.recording && (
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/25 flex-shrink-0">
                        Transcribed
                      </span>
                    )}
                    {m.isPinned && (
                      <span className="text-[10px] text-yellow-500 flex-shrink-0">📌</span>
                    )}
                  </div>

                  {/* Meta row */}
                  <div className="flex items-center gap-2 text-xs text-gray-500 flex-wrap mb-1.5">
                    <span>{fmtDate(m.createdAt)}</span>
                    {m.meetingType && m.meetingType !== "General" && (
                      <>
                        <span>·</span>
                        <span>{m.meetingType}</span>
                      </>
                    )}
                    {m.recording?.input_language && m.recording.input_language !== "en" && (
                      <>
                        <span>·</span>
                        <span className="uppercase">{m.recording.input_language}</span>
                      </>
                    )}
                  </div>

                  {/* Transcript preview */}
                  {m.recording?.translated_transcript && (
                    <p className="text-xs text-gray-600 line-clamp-2 leading-relaxed">
                      {m.recording.translated_transcript.slice(0, 240)}
                    </p>
                  )}

                  {/* Tags */}
                  {m.tags.length > 0 && (
                    <div className="flex gap-1 mt-2 flex-wrap">
                      {m.tags.map(t => (
                        <span key={t} className="text-[10px] bg-gray-800 border border-gray-700 text-gray-400 px-2 py-0.5 rounded-full">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <span className="text-gray-700 group-hover:text-gray-400 transition text-sm flex-shrink-0 mt-0.5">→</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
