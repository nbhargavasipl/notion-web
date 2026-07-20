#!/usr/bin/env bash
set -euo pipefail

PROJECT=mosaic-502711
REGION=asia-south1
SERVICE=mosaic-web
SA=273588842399-compute@developer.gserviceaccount.com

# Runtime env vars (injected by Cloud Run at container start)
# NEXT_PUBLIC_* vars are in .env.production and baked into the image at build time
RUNTIME_TRANSCRIPTION_API_URL="${TRANSCRIPTION_API_URL:-https://speech-transcriber-273588842399.asia-south1.run.app}"
RUNTIME_TRANSCRIPTION_MASTER_KEY="${TRANSCRIPTION_MASTER_KEY:?TRANSCRIPTION_MASTER_KEY env var is not set — export it before deploying}"
# export GEMINI_API_KEY=<your-key>   (required for translation)
RUNTIME_GEMINI_API_KEY="${GEMINI_API_KEY:?GEMINI_API_KEY env var is not set — export it before deploying}"
# export ANTHROPIC_API_KEY=<your-key>  (required for summary)
RUNTIME_ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY env var is not set — export it before deploying}"
RUNTIME_GCS_BUCKET=mosaic-recordings-mosaic-502711

echo "==> Deploying $SERVICE to Cloud Run ($REGION) ..."
gcloud run deploy "$SERVICE" \
  --source . \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --project="$PROJECT" \
  --service-account="$SA" \
  --set-env-vars="\
MOSAIC_APP_MODE=production,\
TRANSCRIPTION_PROVIDER=google_speech,\
TRANSLATION_PROVIDER=gemini,\
SUMMARY_PROVIDER=claude,\
ALLOW_PAID_FALLBACK=false,\
TRANSCRIPTION_API_URL=${RUNTIME_TRANSCRIPTION_API_URL},\
TRANSCRIPTION_MASTER_KEY=${RUNTIME_TRANSCRIPTION_MASTER_KEY},\
GEMINI_API_KEY=${RUNTIME_GEMINI_API_KEY},\
ANTHROPIC_API_KEY=${RUNTIME_ANTHROPIC_API_KEY},\
GCS_RECORDINGS_BUCKET=${RUNTIME_GCS_BUCKET}"

echo ""
echo "==> Deploy complete. Service URL:"
gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT" \
  --format="value(status.url)"
