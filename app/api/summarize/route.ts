import { NextResponse } from 'next/server'
import { getSession } from '@/lib/firebase/session'
import { GoogleGenerativeAI } from '@google/generative-ai'

interface Segment { speaker: string; translated_text: string }

function buildTranscriptText(transcript: string, segments?: Segment[]): string {
  if (segments && segments.length > 0) {
    return segments.map(s => `Speaker ${s.speaker}: ${s.translated_text}`).join('\n')
  }
  return transcript
}

const PROMPT = (transcriptText: string, hasSpeakers: boolean) => `
You are a meeting analyst. Analyze this meeting transcript and return a JSON object with exactly this structure:

{
  "execSummary": "2-3 sentence executive summary of the meeting",
  "topics": ["topic 1 discussed", "topic 2 discussed"],
  "actions": ["action item 1 (with speaker/owner if identifiable)", "action item 2"],
  "questions": ["open question 1", "open question 2"],
  "risks": ["risk or concern 1", "risk or concern 2"]
}

Rules:
- execSummary: concise paragraph summarizing key outcomes
- topics: main discussion areas (2-5 items)
- actions: concrete next steps${hasSpeakers ? ', attribute to the speaker who committed (e.g. "Speaker 1 will...")' : ' with owners if mentioned'} (may be empty [])
- questions: unresolved questions raised (may be empty [])
- risks: blockers, concerns, or dependencies (may be empty [])
- Return ONLY valid JSON, no markdown, no explanation

Transcript:
${transcriptText}
`.trim()

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'Gemini API key not configured' }, { status: 503 })
  }

  const body = await request.json() as { transcript: string; segments?: Segment[] }
  if (!body.transcript?.trim()) {
    return NextResponse.json({ error: 'transcript is required' }, { status: 400 })
  }

  const hasSpeakers = !!(body.segments && body.segments.length > 0)
  const transcriptText = buildTranscriptText(body.transcript, body.segments)

  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' })

  try {
    const result = await model.generateContent(PROMPT(transcriptText, hasSpeakers))
    const text = result.response.text().trim()
    const json = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
    const summary = JSON.parse(json)
    return NextResponse.json(summary)
  } catch (e: unknown) {
    const msg: string = e instanceof Error ? e.message : ''
    const friendly = msg.includes('prepayment') || msg.includes('credits')
      ? 'Gemini API credits depleted — top up at aistudio.google.com'
      : msg.includes('quota') || msg.includes('429')
      ? 'Gemini API rate limit hit — try again in a moment'
      : msg || 'Failed to generate summary'
    return NextResponse.json({ error: friendly }, { status: 502 })
  }
}
