import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center px-6">
      <div className="max-w-2xl w-full text-center">
        <h1 className="text-5xl font-bold mb-6 tracking-tight">Notion</h1>
        <p className="text-xl text-gray-400 mb-10 leading-relaxed">
          AI-powered audio transcription for Indian languages.
          Upload a recording or transcribe live meetings — get an instant
          transcript in the original language and English.
        </p>
        <div className="flex gap-4 justify-center">
          <Link
            href="/signup"
            className="bg-white text-black px-8 py-3 rounded-lg font-semibold text-base hover:bg-gray-100 transition"
          >
            Get started free
          </Link>
          <Link
            href="/login"
            className="border border-gray-700 text-white px-8 py-3 rounded-lg font-semibold text-base hover:bg-gray-900 transition"
          >
            Sign in
          </Link>
        </div>
        <p className="text-gray-600 text-sm mt-10">
          Supports Hindi · Tamil · Telugu · Marathi · Gujarati · Bengali · Kannada · Malayalam
        </p>
      </div>
    </main>
  );
}
