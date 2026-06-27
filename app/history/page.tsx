export default function HistoryPage() {
  return (
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
          <div className="divide-y divide-gray-800">
            {/* Placeholder rows — will be populated from API */}
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="px-6 py-4 flex items-center gap-6 animate-pulse">
                <div className="h-4 bg-gray-800 rounded w-40" />
                <div className="h-4 bg-gray-800 rounded w-16" />
                <div className="h-4 bg-gray-800 rounded w-24 ml-auto" />
              </div>
            ))}
          </div>
          <div className="px-6 py-8 text-center text-gray-600 text-sm">
            Transcript history will load here once auth is connected.
          </div>
        </div>
      </div>
    </main>
  );
}
