import { NextResponse } from 'next/server'
import { getSession } from '@/lib/firebase/session'

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const apiUrl  = process.env.TRANSCRIPTION_API_URL
  const apiKey  = process.env.TRANSCRIPTION_MASTER_KEY

  if (!apiUrl || !apiKey) {
    return NextResponse.json(
      { error: 'Transcription service not configured' },
      { status: 503 }
    )
  }

  const formData = await request.formData()

  // Diarization (SpeakerDiarizationConfig) is incompatible with the Chirp 2 model —
  // sending it causes the Speech API to return INTERNAL_ERROR. Keep it off.
  const upstream = await fetch(
    `${apiUrl.replace(/\/$/, '')}/?target_language=en`,
    { method: 'POST', headers: { 'X-API-Key': apiKey }, body: formData }
  )

  let data: unknown
  try {
    data = await upstream.json()
  } catch {
    return NextResponse.json(
      { success: false, error: `Transcription service error (HTTP ${upstream.status})` },
      { status: 502 }
    )
  }
  return NextResponse.json(data, { status: upstream.status })
}
