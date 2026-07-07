import { redirect } from "next/navigation";
import { getSession } from "@/lib/firebase/session";
import AppNav from "@/components/AppNav";
import { adminDb } from "@/lib/firebase/admin";
import MeetingWorkspace from "@/components/meeting/MeetingWorkspace";

export default async function MeetingDetailPage({ params }: { params: { id: string } }) {
  const user = await getSession();
  if (!user) redirect("/login");

  const userDoc = await adminDb.collection("users").doc(user.uid).get();
  const name: string = userDoc.data()?.name || user.email || "User";

  return (
    <>
      <AppNav userName={name} />
      <MeetingWorkspace eventId={decodeURIComponent(params.id)} />
    </>
  );
}
