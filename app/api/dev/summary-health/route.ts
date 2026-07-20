import { NextResponse } from "next/server";
import { getServerConfig } from "@/lib/config/server";

/** Dev-only: expose summary provider config for local debugging. Never deployed to production. */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 403 });
  }

  let cfg;
  try {
    cfg = getServerConfig();
  } catch (err: unknown) {
    return NextResponse.json(
      { status: "config_error", error: err instanceof Error ? err.message : String(err) },
      { status: 503 }
    );
  }

  return NextResponse.json({
    status: "ok",
    summaryProvider: cfg.providers.summary,
    claudeModel: cfg.claude.summaryModel,
    anthropicKeyPresent: !!cfg.keys.anthropicApiKey,
    geminiKeyPresent: !!cfg.keys.geminiApiKey,
    allowPaidFallback: cfg.billing.allowPaidFallback,
    appMode: cfg.appMode,
  });
}
