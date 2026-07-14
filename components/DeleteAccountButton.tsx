"use client";
import { useState } from "react";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase/client";

export default function DeleteAccountButton() {
  const [confirming, setConfirming] = useState(false);
  const [deleting,   setDeleting]   = useState(false);
  const [error,      setError]      = useState("");

  const handleDelete = async () => {
    setDeleting(true);
    setError("");
    try {
      const res = await fetch("/api/account", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete account.");
      await signOut(auth);
      localStorage.clear();
      window.location.href = "/login";
    } catch (e) {
      setError((e as Error).message);
      setDeleting(false);
      setConfirming(false);
    }
  };

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="border border-red-800 text-red-400 text-sm font-semibold px-5 py-2 rounded-lg hover:bg-red-950 transition"
      >
        Delete my account
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-red-300">
        This will permanently delete your account, all meeting data, and transcripts. This cannot be undone.
      </p>
      {error && <p className="text-red-400 text-sm">{error}</p>}
      <div className="flex gap-3">
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-5 py-2 rounded-lg transition disabled:opacity-50"
        >
          {deleting ? "Deleting…" : "Yes, delete everything"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={deleting}
          className="border border-gray-700 text-gray-400 text-sm font-semibold px-5 py-2 rounded-lg hover:bg-gray-800 transition disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
