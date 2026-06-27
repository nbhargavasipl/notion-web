"use server";
import { getSession } from "@/lib/firebase/session";
import { adminDb } from "@/lib/firebase/admin";
import { randomBytes } from "crypto";

function generateApiKey() {
  return "sk-" + randomBytes(24).toString("base64url");
}

export async function rotateApiKey(): Promise<string | null> {
  const user = await getSession();
  if (!user) return null;

  const newKey = generateApiKey();
  await adminDb.collection("api_keys").doc(user.uid).set(
    { key: newKey, updatedAt: new Date() },
    { merge: true }
  );
  return newKey;
}
