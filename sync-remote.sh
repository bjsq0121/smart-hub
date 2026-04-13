#!/bin/bash
# ============================================================
# smart-hub 원격 서버 동기화 스크립트
# SSH로 /home/bang/projects/smart-hub 를 origin/main 최신으로 pull
#
# 사용법:
#   ./sync-remote.sh                    # 기본 호스트 사용
#   ./sync-remote.sh user@your-server   # 호스트 직접 지정
# ============================================================
set -e

REMOTE_HOST="${1:-bang@your-server}"    # ← 실제 SSH 호스트로 수정
REMOTE_DIR="/home/bang/projects/smart-hub"

echo "▶ 원격 서버: ${REMOTE_HOST}"
echo "▶ 원격 경로: ${REMOTE_DIR}"
echo ""

# 1. 원격 상태 확인
echo "[1/3] 원격 상태 확인..."
ssh "${REMOTE_HOST}" "cd ${REMOTE_DIR} && echo 'branch: '$(git branch --show-current) && echo 'HEAD: '$(git rev-parse --short HEAD) && echo 'behind: '$(git rev-list --count HEAD..origin/main 2>/dev/null || echo '?')"

echo ""

# 2. pull
echo "[2/3] git pull origin main..."
ssh "${REMOTE_HOST}" "cd ${REMOTE_DIR} && git fetch origin && git pull origin main --ff-only"

echo ""

# 3. 확인
echo "[3/3] 동기화 후 상태..."
ssh "${REMOTE_HOST}" "cd ${REMOTE_DIR} && echo 'HEAD: '$(git rev-parse --short HEAD) && echo 'log:' && git log --oneline -5"

echo ""
echo "✅ 원격 동기화 완료!"
