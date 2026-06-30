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

  const formData   = await request.formData()
  const targetLang = formData.get('target_language') as string || 'en'

  const upstream = await fetch(`${apiUrl.replace(/\/$/, '')}/?target_language=${targetLang}`, {
    method:  'POST',
    headers: { 'X-API-Key': apiKey },
    body:    formData,
  })

  const data = await upstream.json()
  return NextResponse.json(data, { status: upstream.status })
}
