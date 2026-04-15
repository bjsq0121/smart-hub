#!/bin/bash
# ============================================================
# smart-hub 배포 스크립트
# 사용법: ./deploy.sh YOUR_GCP_PROJECT_ID
# ============================================================

set -e

# .env 자동 로드 (이미 export된 값이 있으면 그대로 둠 — 쉘 export 우선)
ENV_FILE="$(dirname "$0")/.env"
if [ -f "$ENV_FILE" ]; then
  echo "▶ .env 로드: $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "⚠️  .env 없음 — 쉘에 export된 변수만 사용"
fi

# 필수 env 사전 검증 (빈 값 주입 방지)
REQUIRED_ENVS=(KIS_APP_KEY KIS_APP_SECRET KIS_ACCOUNT_NO KIS_ACCOUNT_PROD NAVER_CLIENT_ID NAVER_CLIENT_SECRET MOLIT_API_KEY TELEGRAM_TOKEN TELEGRAM_CHAT_ID WEBHOOK_SECRET)
MISSING=()
for v in "${REQUIRED_ENVS[@]}"; do
  if [ -z "${!v}" ]; then MISSING+=("$v"); fi
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "❌ 다음 env 변수가 비어 있습니다 (배포 중단):"
  printf '   - %s\n' "${MISSING[@]}"
  echo "   .env 파일에 추가하거나 쉘에서 export 후 다시 실행하세요."
  exit 1
fi

PROJECT_ID=${1:-$(gcloud config get-value project)}
REGION="asia-northeast3"
SERVICE_NAME="smart-hub-api"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

echo "▶ GCP 프로젝트: ${PROJECT_ID}"
echo "▶ 리전: ${REGION}"
echo ""

# 1. public/ 정적 자산 최신화 (index.html + static/*)
echo "[1/5] public/ 동기화 (index.html + static/)..."
cp index.html public/index.html
rsync -a --delete static/ public/static/

# 2. Docker 이미지 빌드 & 푸시
echo "[2/5] Docker 이미지 빌드 및 푸시..."
gcloud builds submit --tag "${IMAGE}" --project "${PROJECT_ID}"

# 3. Cloud Run 배포 (GCP_PROJECT 주입으로 Vertex AI 사용 가능)
echo "[3/5] Cloud Run 배포..."
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300 \
  --set-env-vars "NAVER_CLIENT_ID=${NAVER_CLIENT_ID},NAVER_CLIENT_SECRET=${NAVER_CLIENT_SECRET},MOLIT_API_KEY=${MOLIT_API_KEY},GCP_PROJECT=${PROJECT_ID},TELEGRAM_TOKEN=${TELEGRAM_TOKEN},TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID},WEBHOOK_SECRET=${WEBHOOK_SECRET},KIS_APP_KEY=${KIS_APP_KEY},KIS_APP_SECRET=${KIS_APP_SECRET},KIS_ACCOUNT_NO=${KIS_ACCOUNT_NO},KIS_ACCOUNT_PROD=${KIS_ACCOUNT_PROD:-01}" \
  --min-instances=1 \
  --project "${PROJECT_ID}"

# 4. Cloud Run 서비스 계정에 Vertex AI 권한 부여
echo "[4/5] Vertex AI IAM 권한 부여..."
SA_EMAIL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --format "value(spec.template.spec.serviceAccountName)")

# 서비스 계정이 기본값(compute)이면 자동 감지
if [ -z "${SA_EMAIL}" ]; then
  PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")
  SA_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi

echo "   서비스 계정: ${SA_EMAIL}"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/aiplatform.user" \
  --quiet

# 5. Firebase Hosting 배포
echo "[5/5] Firebase Hosting 배포..."
firebase deploy --only hosting --project "${PROJECT_ID}"

echo ""
echo "✅ 배포 완료!"
echo "   Firebase URL: https://${PROJECT_ID}.web.app"
