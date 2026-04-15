# Smart Hub

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

## 하네스: Smart Hub 풀스택 빌드

**목표:** FastAPI + Firestore + Vanilla JS 경계면 버그를 조기에 잡으며 피처를 한 워크플로우로 완성.

**트리거:** 풀스택 피처 추가·시그널 파이프라인 확장·대시보드 신규 섹션·ingest kind 추가·이전 피처 보완/수정/재실행 요청 시 `smart-hub-feature` 스킬을 사용하라. 단순 질문·단일 버그 조사·단순 문구 수정은 직접 응답 가능.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-04-15 | 초기 구성 (4인 팀 + 오케스트레이터) | 전체 | - |
| 2026-04-15 | 실데이터 선확인 규칙 추가 | data-architect.md, firestore-schema 스킬 | heartbeat 초회 실행에서 source 추정 오류(`system-heart`→실제 `system-heartbeat-001`) 발생. 메모리/코드 추정보다 Firestore 실샘플을 먼저 확인하도록 강제 |
| 2026-04-15 | heartbeat 이슈 맥락 업데이트 | data-architect.md, firestore-schema 스킬 | 정체 원인 규명(n8n 워크플로 정지)과 가시화 완료 반영 |
