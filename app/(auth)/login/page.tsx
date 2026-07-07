"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithPopup, GoogleAuthProvider } from "firebase/auth";
import { auth, createGoogleProvider } from "@/lib/firebase/client";

export default function LoginPage() {
  const router  = useRouter();
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(false);

  const handleGoogle = async () => {
    setError("");
    setLoading(true);
    try {
      const result     = await signInWithPopup(auth, createGoogleProvider());
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        localStorage.setItem("googleAccessToken", credential.accessToken);
        localStorage.setItem("googleCalendarToken", credential.accessToken);
      }
      const idToken = await result.user.getIdToken();

      const res = await fetch("/api/session", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ idToken }),
      });
      if (!res.ok) throw new Error("session");

      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        setLoading(false);
        return;
      }
      setError(`Sign-in failed: ${code || (err as Error).message}`);
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-bold mb-2">Sign in to MOSAIC</h1>
        <p className="text-gray-500 mb-10 text-sm">Use your Google account to continue</p>

        <button
          onClick={handleGoogle}
          disabled={loading}
          className="w-full flex items-center justify-center gap-3 bg-white text-black rounded-lg py-3 font-semibold text-sm hover:bg-gray-100 transition disabled:opacity-50"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
            <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/>
            <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
            <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
          </svg>
          {loading ? "Signing in…" : "Continue with Google"}
        </button>

        {error && <p className="text-red-400 text-sm text-center mt-4">{error}</p>}
      </div>
    </main>
  );
}
