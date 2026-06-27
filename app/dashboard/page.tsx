export default function DashboardPage() {
  return (
    <main className="min-h-screen bg-black text-white p-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-8">Dashboard</h1>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          {[
            { label: "Total Jobs",       value: "—" },
            { label: "Completed",        value: "—" },
            { label: "Minutes Used",     value: "—" },
            { label: "Free Minutes Left",value: "60" },
          ].map((s) => (
            <div key={s.label} className="bg-gray-900 rounded-xl p-5 border border-gray-800">
              <div className="text-2xl font-bold mb-1">{s.value}</div>
              <div className="text-gray-500 text-sm">{s.label}</div>
            </div>
          ))}
        </div>

        {/* API Key */}
        <div className="bg-gray-900 rounded-xl p-6 border border-gray-800 mb-6">
          <h2 className="font-semibold mb-1">Your API Key</h2>
          <p className="text-gray-500 text-sm mb-4">
            Use this key in the desktop app Settings screen.
          </p>
          <div className="flex gap-3 items-center">
            <code className="flex-1 bg-black border border-gray-800 rounded-lg px-4 py-2.5 text-sm text-gray-400 font-mono truncate">
              sk-••••••••••••••••••••••••••••••••
            </code>
            <button className="bg-gray-800 hover:bg-gray-700 text-white text-sm px-4 py-2.5 rounded-lg transition">
              Reveal
            </button>
            <button className="bg-gray-800 hover:bg-gray-700 text-white text-sm px-4 py-2.5 rounded-lg transition">
              Copy
            </button>
          </div>
        </div>

        {/* Download CTA */}
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
  );
}
