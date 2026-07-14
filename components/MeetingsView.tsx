"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { signInWithPopup, GoogleAuthProvider } from "firebase/auth";
import { auth, createGoogleProvider } from "@/lib/firebase/client";
import {
  CalendarEvent, fetchUpcomingMeetings, detectPlatform,
  fmtEventTime, fmtDuration, isOngoing, isUpcoming,
} from "@/lib/googleCalendar";

const PLATFORM_COLORS: Record<string, string> = {
  "Google Meet":     "#4ade80",
  "Microsoft Teams": "#818cf8",
  "Zoom":            "#60a5fa",
  "Webex":           "#f59e0b",
};

function statusBadge(event: CalendarEvent) {
  if (isOngoing(event))  return { label: "Live",     cls: "bg-green-500/20 text-green-400 border border-green-500/30" };
  if (isUpcoming(event)) return { label: "Starting", cls: "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30" };
  const start = new Date(event.start.dateTime!).getTime();
  if (start > Date.now()) return { label: "Upcoming", cls: "bg-gray-800 text-gray-400 border border-gray-700" };
  return { label: "Completed", cls: "bg-gray-800 text-gray-500 border border-gray-700" };
}

function avatarInitials(email: string, name?: string): string {
  if (name) return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return email.slice(0, 2).toUpperCase();
}

export default function MeetingsView() {
  const router = useRouter();
  const [events,      setEvents]      = useState<CalendarEvent[]>([]);
  const [syncing,     setSyncing]     = useState(true);
  const [syncError,   setSyncError]   = useState<string | null>(null);
  const [token,       setToken]       = useState<string | null>(null);
  const [refreshing,  setRefreshing]  = useState(false);
  const [tokenExpired, setTokenExpired] = useState(false);

  useEffect(() => {
    const t      = localStorage.getItem("googleCalendarToken");
    const expiry = Number(localStorage.getItem("googleCalendarTokenExpiry") || "0");
    setToken(t);

    if (!t) { setSyncing(false); return; }

    if (expiry && Date.now() > expiry) {
      setTokenExpired(true);
      setSyncing(false);
      return;
    }

    syncCalendar(t);
    const id = setInterval(() => {
      const exp = Number(localStorage.getItem("googleCalendarTokenExpiry") || "0");
      if (exp && Date.now() > exp) {
        setTokenExpired(true);
        clearInterval(id);
      } else {
        syncCalendar(t);
      }
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const syncCalendar = async (t: string) => {
    setSyncing(true);
    try {
      const list = await fetchUpcomingMeetings(t);
      setEvents(list);
      setSyncError(null);
      setTokenExpired(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "TOKEN_EXPIRED") {
        setTokenExpired(true);
      } else {
        setSyncError(msg);
      }
    } finally {
      setSyncing(false);
    }
  };

  const handleRefreshToken = async () => {
    setRefreshing(true);
    try {
      const result = await signInWithPopup(auth, createGoogleProvider());
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        localStorage.setItem("googleCalendarToken", credential.accessToken);
        localStorage.setItem("googleCalendarTokenExpiry", String(Date.now() + 3540 * 1000));
        setToken(credential.accessToken);
        setTokenExpired(false);
        await syncCalendar(credential.accessToken);
      }
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code !== "auth/popup-closed-by-user") {
        setSyncError("Could not refresh calendar access. Please sign out and sign in again.");
      }
    } finally {
      setRefreshing(false);
    }
  };

  const openWorkspace = (event: CalendarEvent) => {
    localStorage.setItem(`mosaic_event_${event.id}`, JSON.stringify(event));
    router.push(`/meetings/${encodeURIComponent(event.id)}`);
  };

  if (!token) {
    return (
      <div className="bg-gray-900 rounded-xl p-8 border border-gray-800 text-center text-gray-500 text-sm">
        Sign out and sign in again to grant calendar access.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm text-gray-500">
          {syncing ? "Syncing calendar…" : `${events.length} meeting${events.length !== 1 ? "s" : ""} today`}
        </span>
        <div className="flex items-center gap-3">
          {token && (
            <button
              onClick={() => syncCalendar(token)}
              className="text-xs text-gray-600 hover:text-gray-400 transition"
            >
              Refresh
            </button>
          )}
          <button
            onClick={() => {
              const id = `quick-${Date.now()}`;
              router.push(`/meetings/${id}`);
            }}
            className="flex items-center gap-1.5 text-xs bg-red-600 hover:bg-red-500 text-white font-medium px-3 py-1.5 rounded-lg transition"
          >
            ⏺ Quick Record
          </button>
        </div>
      </div>

      {tokenExpired && (
        <div className="bg-yellow-950/40 border border-yellow-800/40 rounded-lg px-4 py-3 text-yellow-400 text-sm flex items-center justify-between gap-4">
          <span>Calendar access expired.</span>
          <button
            onClick={handleRefreshToken}
            disabled={refreshing}
            className="text-yellow-300 font-semibold text-xs underline underline-offset-2 hover:text-yellow-200 transition disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh now"}
          </button>
        </div>
      )}

      {syncError && !tokenExpired && (
        <div className="bg-red-950/40 border border-red-800/40 rounded-lg px-4 py-3 text-red-400 text-sm">
          {syncError}
        </div>
      )}

      {events.length === 0 && !syncing && (
        <div className="bg-gray-900 rounded-xl p-10 border border-gray-800 text-center">
          <div className="text-4xl mb-3">📅</div>
          <p className="text-gray-400 font-medium">No meetings today</p>
          <p className="text-gray-600 text-sm mt-1">Your calendar is clear for today.</p>
        </div>
      )}

      {events.map(event => {
        const platform = detectPlatform(event);
        const badge    = statusBadge(event);
        const color    = PLATFORM_COLORS[platform] ?? "#888";
        const attendees = event.attendees ?? [];

        return (
          <div
            key={event.id}
            onClick={() => openWorkspace(event)}
            className="group bg-gray-900 border border-gray-800 rounded-xl p-5 cursor-pointer hover:border-gray-700 hover:bg-gray-900/80 transition-all"
          >
            <div className="flex items-start justify-between gap-4">
              {/* Left: info */}
              <div className="flex items-start gap-4 min-w-0">
                {/* Status line */}
                <div className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
                  isOngoing(event)  ? "bg-green-400 animate-pulse" :
                  isUpcoming(event) ? "bg-yellow-400" : "bg-gray-700"
                }`} />

                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-semibold text-white truncate">{event.summary}</span>
                    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${badge.cls}`}>
                      {badge.label}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                    <span>{fmtEventTime(event)}</span>
                    <span>·</span>
                    <span>{fmtDuration(event)}</span>
                    <span>·</span>
                    <span style={{ color }}>{platform}</span>
                    {event.organizer?.displayName && (
                      <>
                        <span>·</span>
                        <span>{event.organizer.displayName}</span>
                      </>
                    )}
                  </div>

                  {/* Attendee avatars */}
                  {attendees.length > 0 && (
                    <div className="flex items-center gap-1 mt-2.5">
                      {attendees.slice(0, 5).map((a, i) => (
                        <div
                          key={i}
                          title={a.displayName ?? a.email}
                          className="w-6 h-6 rounded-full bg-gray-700 border border-gray-800 flex items-center justify-center text-[9px] font-bold text-gray-300 -ml-1 first:ml-0"
                        >
                          {avatarInitials(a.email, a.displayName)}
                        </div>
                      ))}
                      {attendees.length > 5 && (
                        <span className="text-[10px] text-gray-600 ml-1">+{attendees.length - 5}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Right: open arrow */}
              <div className="flex items-center gap-2 flex-shrink-0">
                {event.hangoutLink && (
                  <a
                    href={event.hangoutLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="text-xs text-blue-400 hover:underline hidden group-hover:block"
                  >
                    Join
                  </a>
                )}
                <span className="text-gray-700 group-hover:text-gray-400 transition text-sm">→</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
