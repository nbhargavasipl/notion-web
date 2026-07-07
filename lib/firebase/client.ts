import { initializeApp, getApps } from 'firebase/app'
import { getAuth, GoogleAuthProvider } from 'firebase/auth'

const firebaseConfig = {
  apiKey:     process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId:  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  ...(process.env.NEXT_PUBLIC_FIREBASE_APP_ID
    ? { appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID }
    : {}),
}

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0]

export const auth = getAuth(app)

export function createGoogleProvider() {
  const provider = new GoogleAuthProvider()
  provider.addScope('https://www.googleapis.com/auth/calendar.readonly')
  provider.setCustomParameters({ access_type: 'offline', prompt: 'consent' })
  return provider
}

export default app
