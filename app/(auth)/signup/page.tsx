"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import { auth } from "@/lib/firebase/client";

export default function SignupPage() {
  const router  = useRouter();
  const [name,     setName]     = useState("");
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(credential.user, { displayName: name });

      const idToken = await credential.user.getIdToken();
      const res = await fetch("/api/session", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ idToken, name }),
      });
      if (!res.ok) throw new Error("session");

      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      const code = (err as { code?: string }).code
      const msg =
        code === "auth/email-already-in-use"
          ? "An account with that email already exists."
          : code === "auth/weak-password"
          ? "Password must be at least 6 characters."
          : "Something went wrong. Please try again.";
      setError(msg);
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-bold mb-2">Create account</h1>
        <p className="text-gray-500 mb-8 text-sm">Start transcribing in minutes</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="text-sm text-gray-400 block mb-1">Name</label>
            <input
              type="text" required value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 text-white text-sm outline-none focus:border-gray-600"
              placeholder="Your name"
            />
          </div>
          <div>
            <label className="text-sm text-gray-400 block mb-1">Email</label>
            <input
              type="email" required value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 text-white text-sm outline-none focus:border-gray-600"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="text-sm text-gray-400 block mb-1">Password</label>
            <input
              type="password" required value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 text-white text-sm outline-none focus:border-gray-600"
              placeholder="Min. 6 characters"
              minLength={6}
            />
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <button
            type="submit" disabled={loading}
            className="bg-white text-black rounded-lg py-2.5 font-semibold text-sm hover:bg-gray-100 transition mt-2 disabled:opacity-50"
          >
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>

        <p className="text-gray-600 text-sm text-center mt-6">
          Already have an account?{" "}
          <Link href="/login" className="text-white hover:underline">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
