import { NextResponse } from 'next/server'

const MAX_BYTES = 3 * 1024 * 1024 // 3 MB ≈ 30 s for most formats

export async function POST(request: Request) {
  const apiUrl = process.env.TRANSCRIPTION_API_URL
  const apiKey = process.env.TRANSCRIPTION_MASTER_KEY

  if (!apiUrl || !apiKey) {
    return NextResponse.json({ error: 'Service not configured' }, { status: 503 })
  }

  const formData = await request.formData()
  const file     = formData.get('file') as File | null

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Free trial limit: file must be under 3 MB (≈ 30 seconds). Please trim your audio or sign up for unlimited access.` },
      { status: 413 }
    )
  }

  const upstream = await fetch(`${apiUrl.replace(/\/$/, '')}/?target_language=en`, {
    method:  'POST',
    headers: { 'X-API-Key': apiKey },
    body:    formData,
  })

  const data = await upstream.json()
  return NextResponse.json(data, { status: upstream.status })
}
