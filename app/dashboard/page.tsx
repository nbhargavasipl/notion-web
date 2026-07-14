import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/firebase/session";
import { adminDb } from "@/lib/firebase/admin";
import AppNav from "@/components/AppNav";
import ApiKeyCard from "@/components/ApiKeyCard";
import MeetingsView from "@/components/MeetingsView";

export default async function DashboardPage() {
  const user = await getSession();
  if (!user) redirect("/login");

  const keyDoc = await adminDb.collection("api_keys").doc(user.uid).get();
  const apiKey = keyDoc.data()?.key as string | undefined;

  const userDoc = await adminDb.collection("users").doc(user.uid).get();
  const name: string = userDoc.data()?.name || user.email || "User";

  return (
    <>
      <AppNav userName={name} />
      <main className="min-h-screen bg-black text-white p-8">
        <div className="max-w-5xl mx-auto">
          <h1 className="text-2xl font-bold mb-8">Dashboard</h1>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
            {[
              { label: "Total Jobs",        value: "—" },
              { label: "Completed",         value: "—" },
              { label: "Minutes Used",      value: "—" },
              { label: "Free Minutes Left", value: "60" },
            ].map((s) => (
              <div key={s.label} className="bg-gray-900 rounded-xl p-5 border border-gray-800">
                <div className="text-2xl font-bold mb-1">{s.value}</div>
                <div className="text-gray-500 text-sm">{s.label}</div>
              </div>
            ))}
          </div>

          {apiKey ? (
            <ApiKeyCard initialKey={apiKey} />
          ) : (
            <div className="bg-gray-900 rounded-xl p-6 border border-gray-800 mb-6">
              <h2 className="font-semibold mb-1">Your API Key</h2>
              <p className="text-gray-500 text-sm">No key found — try refreshing.</p>
            </div>
          )}

          {/* Today's meetings */}
          <div className="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold">Today&apos;s Meetings</h2>
              <Link href="/meetings" className="text-gray-500 hover:text-white text-xs transition">
                View all →
              </Link>
            </div>
            <MeetingsView />
          </div>
        </div>
      </main>
    </>
  );
}
