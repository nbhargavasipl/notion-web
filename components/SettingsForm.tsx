"use client";
import { useState } from "react";
import { updateProfile } from "firebase/auth";
import { auth } from "@/lib/firebase/client";

export default function SettingsForm({ name: initialName, email }: { name: string; email: string }) {
  const [name,   setName]   = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [error,  setError]  = useState("");

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
    </section>
  );
}
