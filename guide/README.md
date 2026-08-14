# Graft 한국어 학습 가이드

Graft를 처음 설치하는 단계부터 tree-sitter 그래프, MCP·hook 통합, 성능과 확장 설계까지 학습하는 안내서다.

## 학습 순서

1. [설치와 첫 그래프](01_getting_started.md)
2. [핵심 구조와 검색 흐름](02_core_concepts.md)
3. [고급 운영·확장·디버깅](03_advanced.md)
4. [TypeScript 실습](examples/README.md)

## 한눈에 보기

```text
source files
  ├─ tree-sitter/LSP → symbol + typed edge → graft/.graph/wiring.json
  └─ 선택적 LLM deep pass → summary/crux + concept → graft/*.md
                                         ↓
       ask · skeleton · callers · grep · map · MCP · viz · agent hooks
```

기본 구조 그래프는 API 키가 필요 없다. LLM이 파일과 심볼의 의미를 요약하는 `build --deep`에만 provider 설정이 필요하다. `graft/`는 로컬 재생성 캐시이므로 commit하지 않는 현재 정책을 따른다.

## 저장소 구조

| 경로 | 역할 |
|---|---|
| `src/cli.ts` | Commander 기반 CLI와 option 연결 |
| `src/engine.ts`, `src/index.ts` | 공개 TypeScript API |
| `src/graph/` | tree-sitter 추출, binding·edge 해석, 저장·검색·traversal |
| `src/context/` | Markdown context node 생성과 freshness 검사 |
| `src/ask/` | query fusion과 GraphRank 검색 |
| `src/hosts/` | agent 감지, instruction/MCP/hook 설치 계획 |
| `src/claude/` | Claude Code skill·hook·statusline 통합 |
| `src/mcp/` | MCP server와 여섯 도구 |
| `src/ai/` | provider-neutral LLM adapter와 summary/synthesis |
| `src/viz/`, `viewer/` | 그래프 조립·서빙과 browser viewer |
| `test/` | `node:test` 기반 단위·통합·회귀 테스트 |

## 어떤 명령을 쓸까?

| 질문 | 명령 |
|---|---|
| 저장소 전체 구조는? | `graft map` |
| 이 task와 관련된 코드는? | `graft ask "..."` |
| 이 파일의 API만 빠르게 볼까? | `graft skeleton file.ts` |
| 이 symbol을 바꾸면 어디가 영향받나? | `graft callers symbol -d 2` |
| 이 문자열/패턴이 있는 모든 곳은? | `graft grep "regex"` |
| 그래프가 코드와 같은가? | `graft check` |
| 눈으로 관계를 탐색할까? | `graft viz` |

## 원문과 번역

- [원본 README](../README.md)
- [한국어 README](../README_kor.md)

## 기여 전 체크

- `npm run build`
- `npm test`
- 새 CLI option의 help, dry-run, 오류 exit code 검증
- parser 변경 시 지원 언어 fixture와 Windows/POSIX path 테스트
- host wiring 변경 시 저장소 밖 쓰기와 idempotency 테스트
- `git diff --check`
