"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/history", label: "History" },
  { href: "/settings", label: "Settings" },
];

export default function AppNav({ userName }: { userName?: string }) {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <nav className="border-b border-gray-800 bg-black px-8 py-4 flex items-center justify-between">
      <div className="flex items-center gap-6">
        <span className="font-bold text-white tracking-tight">Notion</span>
        <div className="flex gap-1">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`px-3 py-1.5 rounded-lg text-sm transition ${
                pathname.startsWith(l.href)
                  ? "bg-gray-800 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-4">
        {userName && <span className="text-gray-500 text-sm">{userName}</span>}
        <button
          onClick={handleLogout}
          className="text-gray-500 hover:text-white text-sm transition"
        >
          Sign out
        </button>
      </div>
    </nav>
  );
}
