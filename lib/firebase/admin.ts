import { initializeApp, getApps } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

if (!getApps().length) {
  initializeApp({
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    // On Cloud Run, ADC picks up the attached service account automatically.
    // Locally: set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
  })
}

export const adminAuth = getAuth()
export const adminDb   = getFirestore()
