import { doc, setDoc, getDoc, deleteDoc, collection, getDocs, query, orderBy } from 'firebase/firestore'
import { db } from './firebase/client'
import type { MeetingLocalData } from './meetingStorage'

function meetingRef(uid: string, eventId: string) {
  return doc(db, 'users', uid, 'meetings', eventId)
}

export async function syncMeetingToFirestore(uid: string, data: MeetingLocalData): Promise<void> {
  await setDoc(meetingRef(uid, data.eventId), { ...data, _syncedAt: Date.now() }, { merge: true })
}

export async function loadMeetingFromFirestore(uid: string, eventId: string): Promise<MeetingLocalData | null> {
  const snap = await getDoc(meetingRef(uid, eventId))
  if (!snap.exists()) return null
  const data = snap.data() as MeetingLocalData & { _syncedAt?: unknown }
  delete data._syncedAt
  return data as MeetingLocalData
}

export async function deleteMeetingFromFirestore(uid: string, eventId: string): Promise<void> {
  await deleteDoc(meetingRef(uid, eventId))
}

export async function listMeetingsFromFirestore(uid: string): Promise<MeetingLocalData[]> {
  const q = query(collection(db, 'users', uid, 'meetings'), orderBy('createdAt', 'desc'))
  const snap = await getDocs(q)
  return snap.docs.map(d => {
    const data = d.data() as MeetingLocalData & { _syncedAt?: unknown }
    delete data._syncedAt
    return data as MeetingLocalData
  })
}
