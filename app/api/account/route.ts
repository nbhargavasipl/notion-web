import { NextResponse } from "next/server";
import { getSession } from "@/lib/firebase/session";
import { adminAuth, adminDb } from "@/lib/firebase/admin";

export async function DELETE() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Delete meetings subcollection
  const meetingRefs = await adminDb
    .collection("users").doc(user.uid)
    .collection("meetings").listDocuments();
  if (meetingRefs.length > 0) {
    const batch = adminDb.batch();
    meetingRefs.forEach(ref => batch.delete(ref));
    await batch.commit();
  }

  // Delete top-level Firestore docs
  await Promise.all([
    adminDb.collection("users").doc(user.uid).delete(),
    adminDb.collection("api_keys").doc(user.uid).delete(),
  ]);

  // Delete Firebase Auth user
  await adminAuth.deleteUser(user.uid);

  // Delete GCS recordings (best-effort — account deletion succeeds even if this fails)
  try {
    const bucket = process.env.GCS_RECORDINGS_BUCKET;
    if (bucket) {
      const { Storage } = await import('@google-cloud/storage');
      const [files] = await new Storage().bucket(bucket).getFiles({ prefix: `recordings/${user.uid}/` });
      if (files.length > 0) await Promise.all(files.map(f => f.delete()));
    }
  } catch {
    // Non-fatal
  }

  // Clear session cookie
  const res = NextResponse.json({ ok: true });
  res.cookies.set("__session", "", { maxAge: 0, path: "/" });
  return res;
}
