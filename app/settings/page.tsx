import { redirect } from "next/navigation";
import { getSession } from "@/lib/firebase/session";
import { adminDb } from "@/lib/firebase/admin";
import AppNav from "@/components/AppNav";
import SettingsForm from "@/components/SettingsForm";
import DeleteAccountButton from "@/components/DeleteAccountButton";

export default async function SettingsPage() {
  const user = await getSession();
  if (!user) redirect("/login");

  const userDoc = await adminDb.collection("users").doc(user.uid).get();
  const name:  string = userDoc.data()?.name  || "";
  const email: string = userDoc.data()?.email || user.email || "";

  return (
    <>
      <AppNav userName={name || email} />
      <main className="min-h-screen bg-black text-white p-8">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-2xl font-bold mb-8">Settings</h1>
          <div className="flex flex-col gap-6">
            <SettingsForm name={name} email={email} />

            <section className="bg-gray-900 rounded-xl p-6 border border-gray-800">
              <h2 className="font-semibold mb-1">Plan</h2>
              <p className="text-gray-500 text-sm mb-4">Free — 60 minutes / month</p>
              <button className="border border-gray-700 text-white text-sm font-semibold px-5 py-2 rounded-lg hover:bg-gray-800 transition">
                Upgrade to Pro
              </button>
            </section>

            <section className="bg-gray-900 rounded-xl p-6 border border-red-900">
              <h2 className="font-semibold mb-1 text-red-400">Delete account</h2>
              <p className="text-gray-500 text-sm mb-4">
                Permanently delete your account and all transcription data.
              </p>
              <DeleteAccountButton />
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
