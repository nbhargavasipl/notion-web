# MOSAIC — Project Handoff Document

> Last updated: July 2026
> Status: Active development — Web app working, Desktop app partially implemented

---

## What Is MOSAIC

MOSAIC is a **meeting intelligence platform**. It connects to your Google Calendar, shows today's meetings, lets you record any meeting (capturing both your voice and all participants via system audio), and generates a structured English transcript + summary. It also works for ad-hoc meetings that aren't on your calendar.

---

## Repository Structure

```
/Users/nidhibhargava/Documents/GitHub/MOSAIC/
├── MOSAIC-Web/        ← Next.js 14 web app (primary, working)
├── MOSAIC-App/        ← Tauri 2 + React desktop app (in progress)
├── MOSAIC-Transcript/ ← Cloud Run transcription service (deployed)
└── HANDOFF.md         ← this file
```

---

## MOSAIC-Web (Primary App)

### Tech Stack

| Layer        | Technology                                        |
|--------------|---------------------------------------------------|
| Framework    | Next.js 14 (App Router)                           |
| Auth         | Firebase Authentication — Google Sign-In only     |
| Database     | Firebase Firestore (users, API keys)              |
| Session      | Firebase Admin SDK session cookies (`__session`)  |
| Styling      | Tailwind CSS                                      |
| Calendar     | Google Calendar API v3 (client-side fetch)        |
| Transcription| Cloud Run service (asia-south1)                   |
| Storage      | localStorage (meeting notes, agenda, transcripts) |

### How to Run

```bash
cd "/Users/nidhibhargava/Documents/GitHub/MOSAIC/MOSAIC-Web"
npm install
npm run dev
# Starts on port 3000 (falls back to 3001/3002/3003 if in use)
```

### Environment Variables (`.env.local`)

```env
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSyBDcZLJcVh1p2kJ38XlrnxkL-ll021m3Gk
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=speech-to-text-api-eos.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=speech-to-text-api-eos
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json
TRANSCRIPTION_API_URL=https://speech-transcriber-222316825536.asia-south1.run.app
TRANSCRIPTION_MASTER_KEY=testkey123
```

- `sa-key.json` is the Firebase service account key — lives at `/Users/nidhibhargava/Documents/GitHub/notion-web/sa-key.json`
- `GOOGLE_APPLICATION_CREDENTIALS` is server-side only (Firebase Admin SDK)
- `NEXT_PUBLIC_*` vars are exposed to the browser

### Firebase Project

- **Project ID:** `speech-to-text-api-eos`
- **Project Number:** `222316825536`
- **OAuth Client ID:** `222316825536-vs5qu3ob08jfvalh96goe8q92b0al3jj.apps.googleusercontent.com`
- **Auth domain:** `speech-to-text-api-eos.firebaseapp.com`
- **Authorized domains:** `localhost`, `speech-to-text-api-eos.firebaseapp.com`
- **Google APIs enabled:** Firebase Auth, Firestore, Google Calendar API

---

## Authentication Flow

1. User hits `/login` → clicks "Continue with Google"
2. `signInWithPopup` fires with Google provider + `calendar.readonly` scope
3. Access token stored in `localStorage` as both `googleAccessToken` and `googleCalendarToken`
4. ID token sent to `POST /api/session` → server creates Firebase session cookie (`__session`, 14-day expiry)
5. Middleware (`middleware.ts`) protects `/dashboard`, `/history`, `/settings` — redirects to `/login` if no cookie
6. `/meetings` route is **not** in the middleware protected list — it checks session inside the page component

**Important:** `calendar.readonly` is a sensitive OAuth scope. It must be:
- Listed in the OAuth consent screen scopes in Google Cloud Console
- The app is currently in "Testing" mode — only test users can sign in

---

## Calendar Sync

- Token read from `localStorage.googleCalendarToken` on the Meetings page
- Calls `GET https://www.googleapis.com/calendar/v3/calendars/primary/events` directly from the browser
- Filters events with `start.dateTime` (drops all-day events)
- Polls every 60 seconds
- Platform detection: `hangoutLink` → Google Meet, URL matching for Teams/Zoom/Webex

---

## Meeting Workspace

Every meeting (calendar or ad-hoc) opens at `/meetings/[id]`.

### Calendar meetings
- `id` = Google Calendar event ID
- Event data fetched fresh from Calendar API + cached in `localStorage` as `mosaic_event_{id}`

### Ad-hoc / Quick recordings
- `id` = `quick-{timestamp}` (generated on click)
- No calendar event — workspace shows editable title field
- Jumps straight to Recording tab

### Local Data Storage

All meeting workspace data is stored in `localStorage` under `mosaic_meeting_{eventId}`:

```typescript
{
  eventId, title?,        // identity
  meetingType,            // dropdown: General / Standup / Client / etc.
  purpose, objectives, expectedOutcomes,   // overview fields
  agenda: AgendaItem[],   // { id, text, completed, notes }
  notes,                  // free-text, auto-saved
  actionItems,            // { id, text, owner, completed }
  openQuestions,          // string[]
  risks,                  // string[]
  recording,              // RecordingResult | null
  timeline,               // TimelineEvent[]
  isPinned, tags,
}
```

**Data is browser-local only.** No Firestore sync yet. Clearing browser data loses everything.

### Workspace Tabs

| Tab        | What it does                                                    |
|------------|-----------------------------------------------------------------|
| Overview   | Purpose, objectives, expected outcomes, attendees, details      |
| Agenda     | Add/reorder/complete items; expand with notes; convert to action |
| Notes      | Free-text, auto-save, word count                                |
| Recording  | Start/stop; mic + system audio; transcript upload               |
| Summary    | Structured view: exec summary, discussion, actions, Q&A, risks  |
| Timeline   | Chronological event log of everything that happened             |

---

## Recording & Transcription

### How recording works

1. `getUserMedia({ audio: true })` — captures microphone (local voice)
2. `getDisplayMedia({ video: true, audio: true })` — user picks a tab/window; captures system audio (remote participants)
3. Both streams mixed via **Web Audio API** (`AudioContext` → `createMediaStreamDestination`)
4. Mixed stream recorded by `MediaRecorder` (webm/opus)
5. On stop → audio blob POSTed to `/api/transcribe`
6. `/api/transcribe` proxies to the Cloud Run transcription service
7. Service auto-detects language (supports 8 Indian languages + English), translates to English
8. Result stored in `localStorage` as part of meeting data

### Audio modes
- **Full audio** (green badge) = mic + meeting tab audio — captures everyone
- **Mic only** (yellow badge) = user cancelled screen share — only local voice

### Transcription service
- URL: `https://speech-transcriber-222316825536.asia-south1.run.app`
- Auth: `X-API-Key` header with master key
- Request: multipart form with `file` field
- Response: `{ success, input_language, translated_transcript, confidence, low_confidence }`
- Source code: `/Users/nidhibhargava/Documents/GitHub/Notion/Main.py` (Cloud Run function)

---

## Key Files — MOSAIC-Web

```
app/
  (auth)/login/page.tsx      ← Google sign-in page (popup, calendar scope)
  (auth)/signup/page.tsx     ← Redirects to /login
  api/session/route.ts       ← POST: create session cookie; DELETE: sign out
  api/transcribe/route.ts    ← Proxies audio to Cloud Run transcription service
  dashboard/page.tsx         ← Dashboard with stats + meetings preview
  meetings/page.tsx          ← Meeting list (calendar-synced)
  meetings/[id]/page.tsx     ← Meeting workspace wrapper (server component)

components/
  AppNav.tsx                 ← Top navigation bar
  MeetingsView.tsx           ← Calendar meeting cards + Quick Record button
  meeting/
    MeetingWorkspace.tsx     ← Full meeting workspace (all 6 tabs, recording logic)

lib/
  firebase/
    client.ts                ← Firebase client init, createGoogleProvider (+ calendar scope)
    admin.ts                 ← Firebase Admin SDK (server-side)
    session.ts               ← Read + verify session cookie
  googleCalendar.ts          ← fetchUpcomingMeetings, fetchCalendarEvent, helpers
  meetingStorage.ts          ← localStorage CRUD, parseSummary, data types

middleware.ts                ← Route protection (redirects unauthenticated users)
```

---

## Known Issues & Limitations

| Issue | Detail |
|-------|--------|
| localStorage only | Meeting data not synced to cloud — lost if browser data cleared or on another device |
| `calendar.readonly` unverified | App is in Google "Testing" mode — only manually added test users can sign in |
| System audio on macOS | `getDisplayMedia` captures tab audio only (not system-wide). User must share the specific meeting tab and check "Share tab audio" |
| Token expiry | Google access token (~1hr). On expiry, calendar sync fails with "TOKEN_EXPIRED". User must sign out and back in |
| `NEXT_PUBLIC_FIREBASE_APP_ID` missing | Not set in `.env.local` — Firebase works without it for basic auth but may be needed for some services |
| Meetings page not in middleware | `/meetings` is protected inside the page component, not middleware — slight inconsistency |

---

## Pending / Next Steps

- [ ] **Firestore sync** — save meeting notes, agenda, transcripts to Firestore so data survives across devices
- [ ] **Token refresh** — auto-refresh Google OAuth token instead of requiring re-login
- [ ] **Desktop app** — complete MOSAIC-App (Tauri 2 + React). Auth code exists in `src/screens/Meeting.tsx`, needs testing
- [ ] **Meeting history page** — `/history` route exists but is empty
- [ ] **Google OAuth verification** — submit app for Google verification to lift the `calendar.readonly` scope restriction (required for production)
- [ ] **Summary AI enhancement** — current summary parsing is heuristic (sentence-splitting). Replace with a real LLM call for structured output
- [ ] **Push notifications** — notify user when a meeting is starting

---

## MOSAIC-App (Desktop — Tauri 2)

**Location:** `/Users/nidhibhargava/Documents/GitHub/MOSAIC/MOSAIC-App/`

**Status:** Partially implemented. Compiles but auth/calendar features not fully tested.

**Stack:** Tauri 2 + React (Vite) + TypeScript

**Key files:**
- `src/screens/Meeting.tsx` — main screen with Google auth + calendar polling + meeting overlay
- `src/lib/firebase.ts` — Firebase init for Vite (`import.meta.env.VITE_*`)
- `src/lib/googleCalendar.ts` — same Calendar API helpers as web
- `src-tauri/src/lib.rs` — system tray, hide-to-tray on close, `show_window` command
- `.env` — `VITE_FIREBASE_*` variables

**To run:**
```bash
cd "/Users/nidhibhargava/Documents/GitHub/MOSAIC/MOSAIC-App"
npm install
npm run tauri dev
```

**System tray:** Window hides to tray instead of closing. Open/Quit menu in tray icon. Meeting start overlay fires automatically when a calendar event begins.

---

## MOSAIC-Transcript (Cloud Run Service)

**Location:** `/Users/nidhibhargava/Documents/GitHub/MOSAIC/MOSAIC-Transcript/`

**Deployed at:** `https://speech-transcriber-222316825536.asia-south1.run.app`

**What it does:** Accepts audio file upload (LINEAR16 WAV preferred, also handles webm), auto-detects language among 8 Indian languages + English via Google Cloud Speech-to-Text, translates to English via Google Cloud Translation.

**To redeploy:**
```bash
cd "/Users/nidhibhargava/Documents/GitHub/MOSAIC/MOSAIC-Transcript"
gcloud builds submit --config cloudbuild.yaml
```

---

## Quick Reference

| Thing | Value |
|-------|-------|
| Web app (local) | http://localhost:3001 (or 3000) |
| Firebase console | console.firebase.google.com → project `speech-to-text-api-eos` |
| GCP console | console.cloud.google.com → project `speech-to-text-api-eos` |
| Transcription API | https://speech-transcriber-222316825536.asia-south1.run.app |
| Service account | 222316825536-compute@developer.gserviceaccount.com |
| OAuth client | 222316825536-vs5qu3ob08jfvalh96goe8q92b0al3jj.apps.googleusercontent.com |
