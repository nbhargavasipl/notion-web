import { initializeApp, getApps } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

if (!getApps().length) {
  initializeApp({
    // FIREBASE_PROJECT_ID is preferred (server-only). Falls back to the public var
    // which is safe since project ID is not a secret, but the dedicated var is cleaner.
    projectId: process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  })
}

export const adminAuth = getAuth()
export const adminDb   = getFirestore()
