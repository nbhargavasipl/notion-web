import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AppNav from "@/components/AppNav";
import ApiKeyCard from "@/components/ApiKeyCard";

export default async function DashboardPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: keyRow } = await supabase
    .from("api_keys")
    .select("key")
    .eq("user_id", user.id)
    .single();

  const name: string = user.user_metadata?.name ?? user.email ?? "User";

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

          {keyRow?.key ? (
            <ApiKeyCard initialKey={keyRow.key} userId={user.id} />
          ) : (
            <div className="bg-gray-900 rounded-xl p-6 border border-gray-800 mb-6">
              <h2 className="font-semibold mb-1">Your API Key</h2>
              <p className="text-gray-500 text-sm">
                API key not found. If you just signed up, refresh this page.
              </p>
            </div>
          )}

          <div className="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <h2 className="font-semibold mb-1">Desktop App</h2>
            <p className="text-gray-500 text-sm mb-4">
              Download the desktop app to transcribe audio files and live meetings.
            </p>
            <div className="flex gap-3 flex-wrap">
              {["macOS", "Windows", "Linux"].map((os) => (
                <button
                  key={os}
                  className="bg-white text-black text-sm font-semibold px-5 py-2 rounded-lg hover:bg-gray-100 transition"
                >
                  Download for {os}
                </button>
              ))}
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
