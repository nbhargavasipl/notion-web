import { NextResponse } from 'next/server'
import { Storage } from '@google-cloud/storage'
import { getSession } from '@/lib/firebase/session'
import { getServerConfig } from '@/lib/config/server'

const storage = new Storage()

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const bucket = getServerConfig().keys.gcsBucket
  if (!bucket) return NextResponse.json({ error: 'GCS not configured' }, { status: 503 })

  let meetingId: string, chunkIndex: number, mimeType: string
  try {
    const body = await request.json() as { meetingId: string; chunkIndex: number; mimeType: string }
    meetingId = body.meetingId
    chunkIndex = body.chunkIndex
    mimeType   = body.mimeType || 'audio/webm'
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!meetingId || typeof chunkIndex !== 'number' || chunkIndex < 0) {
    return NextResponse.json({ error: 'Invalid params' }, { status: 400 })
  }

  const gcsPath = `recordings/${session.uid}/${meetingId}/chunk-${chunkIndex}.webm`
  const [uploadUrl] = await storage.bucket(bucket).file(gcsPath).getSignedUrl({
    version:     'v4',
    action:      'write',
    expires:     Date.now() + 15 * 60 * 1000,
    contentType: mimeType,
  })

  return NextResponse.json({ uploadUrl, gcsPath })
}
