# 03. 고급 운영·확장·디버깅

## 대규모 저장소 운영

먼저 구조 build로 파일 수, symbol 수, edge 수와 시간을 측정한다. deep pass는 provider 비용과 rate limit을 고려해 concurrency를 조절하고 cache reuse를 유지한다. 모노레포는 `--in scope/`로 검색 범위를 제한하면 관련성 경쟁과 출력 token을 줄일 수 있다.

CI에서는 `build`가 아닌 `check`를 사용해 drift를 검출하는 정책과, 로컬 cache를 commit하지 않는 현재 프로젝트 정책을 일치시킨다. graph directory를 바꾸면 `GRAFT_DIR`과 agent wiring이 같은 경로를 보는지 확인한다.

## 보안과 개인정보

- Tier 1은 로컬에서 동작한다.
- `--deep`은 코드 내용이 설정한 provider로 전송될 수 있다.
- 민감 저장소에서는 provider 보존 정책과 endpoint를 검토하거나 로컬 OpenAI-compatible server를 사용한다.
- `.env`, API key, 생성 transcript를 commit하지 않는다.
- `init --dry-run`으로 user-level Codex 설정 등 저장소 밖 변경을 확인한다.
- MCP server는 프로젝트 root와 context path 경계를 벗어나지 않는지 테스트한다.

## 새 언어 추가

범용 tier 언어는 grammar 등록, 확장자 매핑, query file, symbol kind normalization, fixture가 필요하다. 고정밀 tier는 import와 scope, cross-file binding, receiver method 해석까지 설계한다. 다음 경우를 포함한다.

- 같은 이름의 symbol이 여러 scope에 존재
- alias import와 relative path
- method/constructor binding
- anonymous·nested declaration
- UTF-16 source와 Windows/POSIX 경로
- 중복 추출과 unsupported extension

## 새 CLI/MCP 기능 추가

core 로직을 I/O와 분리해 순수 함수로 먼저 구현한다. CLI formatter와 JSON output, MCP schema는 같은 core result를 변환하도록 한다. argument validation, exit code, empty graph, stale graph, monorepo scope를 테스트한다. 자동 refresh를 사용하는 명령과 drift만 보고해야 하는 `check`의 차이를 보존한다.

## 디버깅 순서

1. `node --version`이 20 이상인지 확인한다.
2. `graft build --no-reuse`로 cache 문제를 분리한다.
3. `graft check --json`으로 stale file을 확인한다.
4. `graft map`에서 언어·file·symbol 수가 예상과 같은지 본다.
5. 누락 edge는 `callers`, exhaustive `grep`, 필요하면 `--lsp`로 비교한다.
6. deep 실패는 provider, model ID, base URL, key와 rate limit을 분리한다.
7. host 문제는 `init --dry-run --no-global` 출력과 실제 marker block을 비교한다.

## 테스트와 성능 회귀

```bash
npm ci
npm run build
npm test
```

테스트는 Node 내장 `node:test`와 수작업 fixture를 주로 사용한다. 그래프 품질은 node/edge 수만 늘리는 방향이 아니라 잘못된 binding과 중복 edge가 줄었는지 함께 평가한다. benchmark에는 모델, 저장소 commit, cold/warm cache, task, 반복 수, token·비용 계산식을 기록한다.

## 기여 흐름

작은 회귀 테스트로 현재 실패를 고정하고 core를 수정한 뒤 전체 build/test를 실행한다. user-level 설정을 건드리는 변경은 실제 home을 사용하지 않는 임시 경로 fixture로 검증한다. 문서의 명령, `.env.example`, CLI help, TypeScript public type이 함께 일치하는지 확인한다.
