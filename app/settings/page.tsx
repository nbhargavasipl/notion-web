export default function SettingsPage() {
  return (
    <main className="min-h-screen bg-black text-white p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold mb-8">Settings</h1>

        <div className="flex flex-col gap-6">
          {/* Profile */}
          <section className="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <h2 className="font-semibold mb-4">Profile</h2>
            <div className="flex flex-col gap-4">
              <div>
                <label className="text-sm text-gray-400 block mb-1">Name</label>
                <input className="w-full bg-black border border-gray-800 rounded-lg px-4 py-2.5 text-white text-sm outline-none" placeholder="Your name" />
              </div>
              <div>
                <label className="text-sm text-gray-400 block mb-1">Email</label>
                <input className="w-full bg-black border border-gray-800 rounded-lg px-4 py-2.5 text-gray-500 text-sm outline-none" disabled placeholder="you@example.com" />
              </div>
              <button className="bg-white text-black text-sm font-semibold px-5 py-2 rounded-lg hover:bg-gray-100 transition self-start">
                Save changes
              </button>
            </div>
          </section>

          {/* Plan */}
          <section className="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <h2 className="font-semibold mb-1">Plan</h2>
            <p className="text-gray-500 text-sm mb-4">Free — 60 minutes / month</p>
            <button className="border border-gray-700 text-white text-sm font-semibold px-5 py-2 rounded-lg hover:bg-gray-800 transition">
              Upgrade to Pro
            </button>
          </section>

          {/* Danger */}
          <section className="bg-gray-900 rounded-xl p-6 border border-red-900">
            <h2 className="font-semibold mb-1 text-red-400">Delete account</h2>
            <p className="text-gray-500 text-sm mb-4">
              Permanently delete your account and all transcription data.
            </p>
            <button className="border border-red-800 text-red-400 text-sm font-semibold px-5 py-2 rounded-lg hover:bg-red-950 transition">
              Delete my account
            </button>
          </section>
        </div>
      </div>
    </main>
  );
}
