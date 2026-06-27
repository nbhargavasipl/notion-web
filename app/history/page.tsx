import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AppNav from "@/components/AppNav";

export default async function HistoryPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const name: string = user.user_metadata?.name ?? user.email ?? "User";

  return (
    <>
      <AppNav userName={name} />
      <main className="min-h-screen bg-black text-white p-8">
        <div className="max-w-5xl mx-auto">
          <h1 className="text-2xl font-bold mb-8">Transcript History</h1>
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-800 flex justify-between items-center">
              <span className="text-sm text-gray-400">All transcriptions</span>
              <input
                className="bg-black border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white outline-none w-56"
                placeholder="Search transcripts…"
              />
            </div>
            <div className="px-6 py-12 text-center text-gray-600 text-sm">
              Your transcription history will appear here. Use the desktop app to start transcribing.
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
