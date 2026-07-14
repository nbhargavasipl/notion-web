"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Google auth is the only sign-in method — signup and login are the same flow.
export default function SignupPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/login"); }, [router]);
  return null;
}
