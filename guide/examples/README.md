# TypeScript 실습: 작은 서비스 색인하기

이 실습은 API 키 없이 구조 그래프를 만들고 검색·호출 추적·drift 검사를 수행한다.

## 1. 저장소 개발 환경 준비

Graft 저장소 루트에서 실행한다.

```bash
npm ci
npm run build
```

## 2. 예제 프로젝트 그래프 만들기

```bash
npm run cli -- build guide/examples/sample-project
npm run cli -- map guide/examples/sample-project
```

예상 결과에는 `src/auth.ts`, `src/store.ts`, `src/app.ts`와 `login`, `findUser`, `handleLogin` symbol 및 call/import edge가 나타난다.

## 3. 질문별 도구 선택

```bash
npm run cli -- ask "Where is a password checked?" guide/examples/sample-project
npm run cli -- skeleton src/auth.ts guide/examples/sample-project
npm run cli -- callers login guide/examples/sample-project -d 2
npm run cli -- grep "Unauthorized" guide/examples/sample-project --fixed
```

`ask`는 자연어 관련성, `skeleton`은 API, `callers`는 파급 범위, `grep`은 모든 text hit를 확인한다.

## 4. graph JSON을 TypeScript로 읽기

```bash
npx tsx guide/examples/inspect-graph.ts \
  guide/examples/sample-project/graft/.graph/wiring.json
```

예제는 schema 전체를 재정의하지 않고 학습에 필요한 최소 구조만 type으로 선언하고, in-degree가 높은 symbol을 출력한다. 외부 입력이므로 optional field와 배열 여부를 확인한다.

## 5. drift 실습

`sample-project/src/app.ts`의 호출을 변경한 뒤 다음을 실행한다.

```bash
npm run cli -- check guide/examples/sample-project
npm run cli -- build guide/examples/sample-project
npm run cli -- check guide/examples/sample-project
```

첫 check는 종료 코드 1로 drift를 보고하고, rebuild 뒤 check는 통과해야 한다. 실습이 끝난 뒤 source 변경은 되돌린다. 생성된 `graft/`는 `.gitignore` 대상이다.

## 6. 심화 과제

1. `auditLogin` 함수를 추가하고 `callers` edge가 어떻게 변하는지 본다.
2. 같은 이름의 `findUser` method를 다른 class에 추가해 receiver binding을 비교한다.
3. `--deep`을 로컬 모델 endpoint에 연결하고 구조 graph와 summary/crux 결과를 비교한다.
4. `graft viz guide/examples/sample-project`에서 edge 방향과 outline을 확인한다.
