# 01. 설치와 첫 그래프

## 요구 사항

- Node.js 20 이상
- npm 또는 `npx`
- 분석할 Git 저장소
- deep 의미 계층을 사용할 때만 LLM provider key

## 안전하게 설치 계획 보기

`init`은 agent instruction, MCP와 hook 설정을 쓸 수 있으므로 먼저 dry-run을 권장한다.

```bash
npx @nanonets/graft init --dry-run
npx @nanonets/graft init --agents agents --no-global
```

두 번째 명령은 `AGENTS.md` 계열 host를 연결하되 사용자 수준 `~/.codex/` 쓰기는 생략한다. 실제 목적에 맞게 agent ID를 선택한다.

## API 키 없는 구조 그래프

```bash
npx @nanonets/graft build .
npx @nanonets/graft map .
npx @nanonets/graft ask "Where is authentication validated?" .
npx @nanonets/graft check .
```

기본 build는 tree-sitter만 사용한다. `.env`가 없어도 된다. 생성된 `graft/`는 `.gitignore`에 추가되는 로컬 캐시다.

## deep 의미 그래프

```bash
cp .env.example .env
# .env에서 provider/key/model/base URL을 설정
npx @nanonets/graft build --deep .
```

필수 값은 provider에 따라 다르다.

```dotenv
GRAFT_PROVIDER=openai
GRAFT_API_KEY=YOUR_KEY
GRAFT_MODEL=gpt-4o-mini
# OpenAI-compatible 대체 endpoint일 때만 설정
# GRAFT_BASE_URL=http://localhost:11434/v1
```

Anthropic native API면 `GRAFT_PROVIDER=anthropic`, 해당 key와 model ID를 사용한다. `.env`는 secret이므로 commit하지 않는다.

## 첫 질의의 선택 기준

```bash
graft map
graft skeleton src/cli.ts
graft callers buildGraph --direction out -d 2
graft grep "GRAFT_API_KEY" --fixed
graft ask "How does an edit refresh the graph?"
```

처음에는 `map`으로 hub를 찾고, `skeleton`으로 API 표면을 좁힌 뒤 `callers`로 흐름과 blast radius를 확인한다. 개념형 질문은 `ask`, 누락 없는 패턴 검색은 `grep`을 사용한다.

## 실습 프로젝트

[examples/README.md](examples/README.md)의 작은 TypeScript 서비스로 build→map→ask→callers→drift 검사를 순서대로 수행한다.
