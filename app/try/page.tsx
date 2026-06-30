import Link from 'next/link'
import TryTranscribe from '@/components/TryTranscribe'

export default function TryPage() {
  return (
    <main className="min-h-screen bg-black text-white">
      {/* Top bar */}
      <nav className="border-b border-gray-800 px-8 py-4 flex items-center justify-between">
        <span className="font-bold tracking-tight">Notion</span>
        <div className="flex gap-3">
          <Link href="/login"
            className="text-gray-400 hover:text-white text-sm transition px-3 py-1.5">
            Sign in
          </Link>
          <Link href="/signup"
            className="bg-white text-black text-sm font-semibold px-4 py-1.5 rounded-lg hover:bg-gray-100 transition">
            Get started free
          </Link>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-8 py-12">
        {/* Hero */}
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold mb-3">Try Notion for free</h1>
          <p className="text-gray-400 text-lg max-w-xl mx-auto">
            Upload any audio in an Indian language — get the original transcript
            and English translation instantly. No account needed.
          </p>
        </div>

        {/* What's included */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <h2 className="font-semibold mb-4 text-white">Free trial includes</h2>
            <ul className="flex flex-col gap-3">
              {[
                "Up to 30 seconds of audio per upload",
                "Automatic language detection",
                "8 Indian languages: Hindi, Tamil, Telugu, Kannada, Malayalam, Bengali, Gujarati, Marathi",
                "Translation to English or any other language",
                "Confidence score",
              ].map((item) => (
                <li key={item} className="flex gap-3 text-sm text-gray-300">
                  <span className="text-green-400 mt-0.5">✓</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <h2 className="font-semibold mb-4 text-white">With a free account you get</h2>
            <ul className="flex flex-col gap-3">
              {[
                "Unlimited audio length",
                "60 minutes / month included",
                "Full transcript history",
                "Your own API key",
                "Desktop app for Mac, Windows & Linux",
                "Live meeting capture (coming soon)",
              ].map((item) => (
                <li key={item} className="flex gap-3 text-sm text-gray-300">
                  <span className="text-blue-400 mt-0.5">→</span>
                  {item}
                </li>
              ))}
            </ul>
            <Link href="/signup"
              className="mt-5 inline-block bg-white text-black text-sm font-semibold px-5 py-2 rounded-lg hover:bg-gray-100 transition">
              Create free account
            </Link>
          </div>
        </div>

        {/* How it works */}
        <div className="mb-10">
          <h2 className="font-semibold mb-4">How it works</h2>
          <div className="grid md:grid-cols-3 gap-4">
            {[
              { step: "1", title: "Upload audio", desc: "Select a WAV, MP3, M4A, OGG or FLAC file up to 3 MB (≈ 30 seconds)." },
              { step: "2", title: "Auto-detect language", desc: "The AI identifies which of 8 Indian languages is spoken — no need to set it manually." },
              { step: "3", title: "Get transcripts", desc: "See the original transcript alongside the English (or your chosen language) translation side by side." },
            ].map((s) => (
              <div key={s.step} className="bg-gray-900 rounded-xl p-5 border border-gray-800">
                <div className="text-2xl font-bold text-gray-600 mb-2">{s.step}</div>
                <div className="font-medium mb-1">{s.title}</div>
                <div className="text-gray-500 text-sm">{s.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Upload widget */}
        <div className="bg-gray-900 rounded-2xl p-8 border border-gray-800">
          <div className="flex items-center justify-between mb-6">
            <h2 className="font-semibold">Upload your audio</h2>
            <span className="text-xs bg-gray-800 text-gray-400 px-3 py-1 rounded-full">
              Free trial · 30 s limit
            </span>
          </div>
          <TryTranscribe apiRoute="/api/try" />
        </div>

        {/* Bottom CTA */}
        <div className="text-center mt-12">
          <p className="text-gray-500 text-sm mb-3">
            Like what you see? Create a free account for unlimited transcriptions.
          </p>
          <Link href="/signup"
            className="bg-white text-black font-semibold px-6 py-2.5 rounded-lg hover:bg-gray-100 transition text-sm">
            Get started free
          </Link>
        </div>
      </div>
    </main>
  )
}
