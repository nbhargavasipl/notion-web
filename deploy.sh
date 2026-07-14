#!/usr/bin/env bash
set -euo pipefail

PROJECT=speech-to-text-api-eos
REGION=asia-south1
SERVICE=mosaic-web
SA=222316825536-compute@developer.gserviceaccount.com

# Runtime env vars (injected by Cloud Run at container start)
# NEXT_PUBLIC_* vars are in .env.production and baked into the image at build time
RUNTIME_TRANSCRIPTION_API_URL=https://speech-transcriber-222316825536.asia-south1.run.app
RUNTIME_TRANSCRIPTION_MASTER_KEY=testkey123
RUNTIME_GEMINI_API_KEY=AIzaSyCYSz-lRQhJF6TkvbqXKLAaF15xjQ7cvhE
RUNTIME_GCS_BUCKET=mosaic-recordings-speech-to-text-api-eos

echo "==> Deploying $SERVICE to Cloud Run ($REGION) ..."
gcloud run deploy "$SERVICE" \
  --source . \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --project="$PROJECT" \
  --service-account="$SA" \
  --set-env-vars="\
TRANSCRIPTION_API_URL=${RUNTIME_TRANSCRIPTION_API_URL},\
TRANSCRIPTION_MASTER_KEY=${RUNTIME_TRANSCRIPTION_MASTER_KEY},\
GEMINI_API_KEY=${RUNTIME_GEMINI_API_KEY},\
GCS_RECORDINGS_BUCKET=${RUNTIME_GCS_BUCKET}"

echo ""
echo "==> Deploy complete. Service URL:"
gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT" \
  --format="value(status.url)"
