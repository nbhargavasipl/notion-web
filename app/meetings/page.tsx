import { redirect } from "next/navigation";
import { getSession } from "@/lib/firebase/session";
import { adminDb } from "@/lib/firebase/admin";
import AppNav from "@/components/AppNav";
import MeetingsView from "@/components/MeetingsView";

export default async function MeetingsPage() {
  const user = await getSession();
  if (!user) redirect("/login");

  const userDoc = await adminDb.collection("users").doc(user.uid).get();
  const name: string = userDoc.data()?.name || user.email || "User";

  return (
    <>
      <AppNav userName={name} />
      <main className="min-h-screen bg-black text-white p-8">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-2xl font-bold mb-2">Meetings</h1>
          <p className="text-gray-500 text-sm mb-8">
            Your calendar syncs automatically. Click Record on any meeting to capture audio and get an English transcript.
          </p>
          <MeetingsView />
        </div>
      </main>
    </>
  );
}
