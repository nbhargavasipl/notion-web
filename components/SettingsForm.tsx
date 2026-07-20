"use client";
import { useState, useEffect } from "react";
import { updateProfile } from "firebase/auth";
import { auth } from "@/lib/firebase/client";

const TRANSLATION_KEY = "mosaic_translation_enabled";

export default function SettingsForm({ name: initialName, email }: { name: string; email: string }) {
  const [name,        setName]        = useState(initialName);
  const [saving,      setSaving]      = useState(false);
  const [saved,       setSaved]       = useState(false);
  const [error,       setError]       = useState("");
  const [translation, setTranslation] = useState(false);

  useEffect(() => {
    setTranslation(localStorage.getItem(TRANSLATION_KEY) === "true");
  }, []);

  const toggleTranslation = (enabled: boolean) => {
    setTranslation(enabled);
    localStorage.setItem(TRANSLATION_KEY, String(enabled));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");

    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Not signed in");
      await updateProfile(user, { displayName: name });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bg-gray-900 rounded-xl p-6 border border-gray-800">
      <h2 className="font-semibold mb-4">Profile</h2>
      <form onSubmit={handleSave} className="flex flex-col gap-4">
        <div>
          <label className="text-sm text-gray-400 block mb-1">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)}
            className="w-full bg-black border border-gray-800 rounded-lg px-4 py-2.5 text-white text-sm outline-none focus:border-gray-600"
            placeholder="Your name" />
        </div>
        <div>
          <label className="text-sm text-gray-400 block mb-1">Email</label>
          <input value={email} disabled
            className="w-full bg-black border border-gray-800 rounded-lg px-4 py-2.5 text-gray-500 text-sm outline-none" />
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button type="submit" disabled={saving}
          className="bg-white text-black text-sm font-semibold px-5 py-2 rounded-lg hover:bg-gray-100 transition self-start disabled:opacity-50">
          {saving ? "Saving…" : saved ? "Saved!" : "Save changes"}
        </button>
      </form>

      <div className="mt-8 pt-6 border-t border-gray-800">
        <h3 className="text-sm font-semibold mb-1">Processing Preferences</h3>
        <p className="text-xs text-gray-500 mb-4">Controls how recordings are processed. Changes apply to new recordings only.</p>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Translate to English</p>
            <p className="text-xs text-gray-500 mt-0.5">
              When off, transcription and summary use the original language. When on, audio is translated to English before summarisation.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={translation}
            onClick={() => toggleTranslation(!translation)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
              translation ? "bg-white" : "bg-gray-700"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-black shadow transition-transform ${
                translation ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-3">
          {translation ? "Translation on — audio will be translated to English." : "Translation off — summaries use original language text."}
        </p>
      </div>
    </section>
  );
}
