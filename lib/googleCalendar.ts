export interface CalendarAttendee {
  email: string;
  displayName?: string;
  responseStatus?: 'accepted' | 'declined' | 'tentative' | 'needsAction';
  self?: boolean;
  organizer?: boolean;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end:   { dateTime?: string; date?: string };
  hangoutLink?: string;
  description?: string;
  location?: string;
  attendees?: CalendarAttendee[];
  organizer?: { email: string; displayName?: string };
  conferenceData?: { entryPoints?: { uri: string; entryPointType: string }[] };
}

export async function fetchUpcomingMeetings(accessToken: string): Promise<CalendarEvent[]> {
  const now      = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    timeMin:      now.toISOString(),
    timeMax:      tomorrow.toISOString(),
    singleEvents: 'true',
    orderBy:      'startTime',
    maxResults:   '20',
  });

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );


  if (res.status === 401) throw new Error('TOKEN_EXPIRED');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = body?.error?.message ?? 'unknown';
    if (res.status === 403 && msg.toLowerCase().includes('insufficient')) throw new Error('SCOPE_MISSING');
    throw new Error(`Calendar API ${res.status}: ${msg}`);
  }

  const data = await res.json();
  return ((data.items || []) as CalendarEvent[]).filter(e => e.start?.dateTime);
}

export async function fetchCalendarEvent(accessToken: string, eventId: string): Promise<CalendarEvent | null> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;
  return res.json();
}

export function detectPlatform(event: CalendarEvent): string {
  if (event.hangoutLink) return 'Google Meet';
  const text = `${event.description ?? ''} ${event.location ?? ''}`.toLowerCase();
  if (text.includes('teams.microsoft.com')) return 'Microsoft Teams';
  if (text.includes('zoom.us'))             return 'Zoom';
  if (text.includes('webex.com'))           return 'Webex';
  return 'Meeting';
}

export function fmtEventTime(event: CalendarEvent): string {
  const dt = event.start.dateTime;
  if (!dt) return '';
  return new Date(dt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtDuration(event: CalendarEvent): string {
  const start = new Date(event.start.dateTime!).getTime();
  const end   = new Date(event.end.dateTime!).getTime();
  const mins  = Math.round((end - start) / 60_000);
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60 ? `${mins % 60}m` : ''}`.trim() : `${mins}m`;
}

export function isOngoing(event: CalendarEvent): boolean {
  if (!event.start.dateTime || !event.end.dateTime) return false;
  const now   = Date.now();
  return now >= new Date(event.start.dateTime).getTime() && now <= new Date(event.end.dateTime).getTime();
}

export function isUpcoming(event: CalendarEvent): boolean {
  if (!event.start.dateTime) return false;
  const start = new Date(event.start.dateTime).getTime();
  const now   = Date.now();
  return start > now && start - now < 30 * 60_000; // within 30 min
}
