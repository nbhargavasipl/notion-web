import { NextResponse } from 'next/server'
import { adminAuth, adminDb } from '@/lib/firebase/admin'
import { randomBytes } from 'crypto'

const SESSION_MS = 60 * 60 * 24 * 14 * 1000 // 14 days

function generateApiKey() {
  return 'sk-' + randomBytes(24).toString('base64url')
}

export async function POST(request: Request) {
  const { idToken, name } = await request.json()

  let decoded
  try {
    decoded = await adminAuth.verifyIdToken(idToken)
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  // Provision user data on first sign-in
  const userRef = adminDb.collection('users').doc(decoded.uid)
  const userDoc = await userRef.get()
  if (!userDoc.exists) {
    const apiKey = generateApiKey()
    await Promise.all([
      userRef.set({
        name:  name || decoded.name || '',
        email: decoded.email || '',
        createdAt: new Date(),
      }),
      adminDb.collection('api_keys').doc(decoded.uid).set({
        key:  apiKey,
        name: 'Default',
        createdAt: new Date(),
      }),
    ])
  }

  const sessionCookie = await adminAuth.createSessionCookie(idToken, {
    expiresIn: SESSION_MS,
  })

  const res = NextResponse.json({ ok: true })
  res.cookies.set('__session', sessionCookie, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   SESSION_MS / 1000,
    path:     '/',
  })
  return res
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.delete('__session')
  return res
}
