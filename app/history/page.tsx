import { redirect } from "next/navigation";
import { getSession } from "@/lib/firebase/session";
import { adminDb } from "@/lib/firebase/admin";
import AppNav from "@/components/AppNav";
import HistoryView from "@/components/HistoryView";

export default async function HistoryPage() {
  const user = await getSession();
  if (!user) redirect("/login");

  const userDoc = await adminDb.collection("users").doc(user.uid).get();
  const name: string = userDoc.data()?.name || user.email || "User";

  return (
    <>
      <AppNav userName={name} />
      <main className="min-h-screen bg-black text-white p-8">
        <div className="max-w-5xl mx-auto">
          <h1 className="text-2xl font-bold mb-8">Meeting History</h1>
          <HistoryView />
        </div>
      </main>
    </>
  );
}
