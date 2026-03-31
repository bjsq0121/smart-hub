# 🌐 Smart Hub

> 최저가 비교 · 일자별 뉴스 요약 · 아파트 실거래가 조회를 한 곳에서 제공하는 통합 웹 서비스

---

## 📌 주요 기능

### 🔍 최저가 비교
- **네이버 쇼핑**과 **다나와**를 동시에 검색하여 최저가 상품 비교
- 가격 순 자동 정렬 및 가격 차이 안내
- 상품 이미지, 판매처, 바로가기 링크 제공
- 최근 검색어 기록 저장 (localStorage)

### 📰 일자별 뉴스 요약
- **네이버 뉴스 API** 연동으로 날짜별 헤드라인 뉴스 조회
- 카테고리 필터: `전체` `정치` `경제` `사회` `문화/연예` `스포츠` `IT/과학`
- 날짜 선택기로 원하는 날짜의 뉴스 탐색
- 기사 제목, 요약, 발행 시간, 원문 링크 제공

### 🏠 아파트 실거래가
- **국토교통부 실거래가 공개 API** 연동
- 전국 17개 시도 · 시군구 선택 조회
- 동 필터 드롭다운 (조회 후 자동 생성) + 아파트명 실시간 검색
- 최고가 · 최저가 · 평균가 요약 카드 제공
- 거래금액 · 계약일 · 전용면적 · 층수 기준 정렬

---

## 🛠 기술 스택

| 구분 | 기술 |
|------|------|
| Backend | Python, FastAPI, Uvicorn |
| Frontend | Vanilla HTML/CSS/JavaScript |
| API | 네이버 쇼핑 API, 네이버 뉴스 API, 국토교통부 실거래가 API |
| 스크래핑 | Requests, BeautifulSoup (다나와) |

---

## ⚙️ 설치 및 실행

### 1. 패키지 설치
```bash
pip install fastapi uvicorn requests python-dotenv beautifulsoup4
```

### 2. 환경변수 설정
프로젝트 루트에 `.env` 파일 생성:
```
NAVER_CLIENT_ID=your_client_id
NAVER_CLIENT_SECRET=your_client_secret
MOLIT_API_KEY=your_molit_api_key
```

- 네이버 API: https://developers.naver.com 에서 **쇼핑**, **뉴스 검색** 애플리케이션 등록 후 발급
- 국토교통부 API: https://www.data.go.kr 에서 **아파트매매 실거래 자료** 활용 신청 후 발급

### 3. 서버 실행
```bash
uvicorn app:app --reload
```

### 4. 접속
브라우저에서 http://localhost:8000 접속

---

## 📁 프로젝트 구조

```
smart-hub/
├── app.py              # FastAPI 서버 (라우팅 및 API 처리)
├── price_search.py     # 네이버 쇼핑 가격 검색 모듈
├── naver_shopping.py   # 네이버 쇼핑 API 연동
├── danawa_scraper.py   # 다나와 가격 스크래핑
├── index.html          # 프론트엔드 (단일 페이지, 3탭 구성)
├── .env                # 환경변수 (git 제외)
└── .gitignore
```

---

## 📸 화면 구성

- 상단 탭으로 **최저가 비교** / **일자별 뉴스 요약** / **아파트 실거래가** 전환
- 다크 테마 UI
