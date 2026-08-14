# 02. 핵심 구조와 검색 흐름

## Tier 1: 구조 그래프

파일 언어를 판별하고 tree-sitter AST에서 file, function, class, method, type node를 추출한다. import, call, extends, implements 같은 관계는 typed edge가 된다. TypeScript·Python·Go·Java는 scope-aware extractor가 cross-file binding을 풀고, 다른 지원 언어는 범용 extractor로 symbol과 name-resolved call을 만든다.

그래프에는 source path, span, signature, export 여부, body hash, origin과 summary 상태가 기록된다. content hash cache는 변경되지 않은 파일을 재사용한다. optional LSP 단계는 receiver type 같은 정적 정보가 필요한 edge를 `lsp_resolved` confidence로 보강한다.

## Tier 2: 의미 계층

`--deep`은 각 파일을 요약하고 관련 파일을 subsystem·API·concept node로 묶는다. 심볼에는 한 줄 summary와 핵심 코드 crux가 붙는다. 사용자 provider로 호출하며 body hash 기준으로 캐시되므로 바뀐 부분만 다시 요약한다.

구조 자동 갱신은 deep pass를 몰래 실행하지 않는다. 비용이 발생할 수 있는 LLM 작업은 사용자가 명시적으로 `--deep`을 실행할 때만 수행한다.

## 질의 처리

- `ask`: lexical relevance와 graph coupling을 융합해 관련 concept·symbol을 순위화한다.
- `map`: in-degree를 바탕으로 directory hub와 전역 hotspot을 제한된 token으로 보여준다.
- `grep`: 정규식 hit를 enclosing symbol로 묶고 결합도로 정렬한다.
- `skeleton`: body를 제외한 signature로 파일 API를 압축한다.
- `callers`: incoming edge가 영향받는 곳, `--direction out`이 symbol의 의존 대상을 보여준다.

단순 text match만 신뢰하지 않고 symbol 경계와 edge 방향을 함께 사용한다는 점이 핵심이다.

## freshness

질의 명령은 현재 fingerprint와 마지막 build를 비교하고 변경이 있으면 Tier 1만 증분 갱신한다. `check`는 자동 수정하지 않고 drift를 보고하며 CI에서 실패 exit code로 사용할 수 있다.

```yaml
- run: npx @nanonets/graft check .
```

mtime 신뢰가 곤란한 환경은 `GRAFT_REFRESH=hash`를 사용한다. freeze된 snapshot을 그대로 질의할 때만 `--no-refresh`를 사용한다.

## MCP와 host wiring

`src/hosts/plan.ts`가 어떤 파일을 쓸지 계획하고, host별 instruction·MCP·hook writer가 적용한다. 중요한 불변식은 다음과 같다.

- 비대화형 init은 명시 옵션 없이는 쓰지 않는다.
- dry-run은 실제 write와 같은 계획을 보여준다.
- 기존 사용자 내용은 marker block 바깥에서 보존한다.
- 반복 실행해도 중복되지 않아야 한다.
- `--no-global`은 저장소 밖 write만 차단한다.

MCP 도구는 CLI와 같은 그래프 core를 사용하므로 shell 없이 agent가 find, API, call trace, regex, repo map, freshness를 호출할 수 있다.

## viewer

서버가 현재 context와 code graph를 조립해 내장 정적 viewer에 제공한다. D3 force layout에서 node type, 연결도, edge verb와 방향을 표현한다. viewer는 분석 결과를 새로 계산하는 engine이 아니라 생성된 그래프를 탐색하는 UI다.
