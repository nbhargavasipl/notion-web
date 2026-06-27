"use server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";

function generateApiKey(): string {
  return "sk-" + randomBytes(24).toString("base64url");
}

export async function rotateApiKey(userId: string): Promise<string | null> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user || user.id !== userId) return null;

  const newKey = generateApiKey();

  // Use service role to bypass RLS for delete+insert atomicity
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  await admin.from("api_keys").delete().eq("user_id", userId);
  const { error } = await admin.from("api_keys").insert({
    user_id: userId,
    key: newKey,
    name: "Default",
  });

  return error ? null : newKey;
}
