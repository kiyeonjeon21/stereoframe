# Stereoframe 기반 조사: AI-Programmable 3D Video on Three.js

조사일: 2026-06-12. Hyperframes(HTML→결정론적 비디오)가 2D 모션그래픽에서 한 일을 three.js 기반 3D로 확장하기 위한 기반 조사.

---

## 1. Hyperframes 모델 분해 (우리가 복제해야 할 설계)

Hyperframes(heygen-com/hyperframes, Apache-2.0, ~27k stars, v0.6.93)의 핵심 설계:

| 레이어 | 구현 | 핵심 아이디어 |
|---|---|---|
| 저작 포맷 | 플레인 HTML + data 속성 (`data-composition-id`, `data-start`, `data-duration`, `data-track-index`) | LLM이 가장 많이 학습한 매체(HTML)를 그대로 사용 |
| 애니메이션 | GSAP 타임라인 (`window.__timelines[id]`) — 선언 구조(HTML)와 분리된 2-레이어 | "스크립트로 미디어 play/pause/seek 금지" — 프레임워크가 관리 |
| 시간 모델 | `frame = floor(time × fps)`, `t = frame / fps` 정수 연산 | 벽시계 완전 배제 → 결정론 |
| Frame Adapter | `{ id, init, getDurationFrames, seekFrame(frame), destroy }` — 멱등 seek, 임의 순서 seek 보장 | 임의 런타임(GSAP/Anime/Lottie/CSS/**Three.js**)을 seek 가능하게 통합 |
| 캡처 | chrome-headless-shell + CDP `HeadlessExperimental.beginFrame` (`--deterministic-mode`), Docker 모드에서 바이트 동일 출력 | 컴포지터 루프를 직접 구동 |
| 인코딩 | FFmpeg (CRF 프리셋), PNG/alpha, ProRes 4444/VP9/GIF/HDR10 | |
| 파라미터화 | `data-composition-variables` + `data-variable-values` → 배치/개인화 렌더 | |
| 에이전트 UX | 비대화형 CLI(`init/preview/render/lint/validate/inspect`), `/hyperframes` 스킬, 자연어→설정 어휘 테이블("bouncy"→`back.out`), lint→validate→render 루프 | |
| 카탈로그 | 80+ 블록 (거의 전부 2D; 3D는 셰이더 트랜지션·디바이스 목업 수준) | |

**중요 발견 1 — Hyperframes에는 이미 Three.js frame adapter가 있다.** `hf-seek` 이벤트 + `window.__hfThreeTime` 글로벌로 결정론적 시간을 전달하고, 사용자가 그 시간으로 transform/AnimationMixer를 갱신하는 방식. 그러나 이는 얇은 escape hatch일 뿐: 3D 어휘(카메라 무브, 라이팅 리그, GLTF 스테이징)가 전무하고 카탈로그에 실질적 3D 블록이 없다.

**중요 발견 2 — HTML-in-Canvas 가이드는 이미 three.js를 사용한다.** `<canvas layoutsubtree>` + `ctx.drawElementImage()`로 DOM을 `THREE.CanvasTexture`로 캡처해 셰이더 효과를 입힘. 즉 Hyperframes 진영도 3D 방향으로 확장 중이지만 "DOM을 3D로 가져오기" 수준이며, "3D 씬 자체를 1급 시민으로" 만드는 것은 비어 있다.

---

## 2. 시장 공백 분석 (2026-06 기준)

| 프로젝트 | 상태 | 3D 비디오 관점의 한계 |
|---|---|---|
| **Remotion + @remotion/three** | 활발 (v4.0.471) | 유료 라이선스(4인 이상 ~$25/dev/mo), React 종속, GL 경로 취약(ANGLE 메모리릭, Lambda는 SwiftShader CPU 폴백). AI 스토리(llms.txt, Claude skills)는 업계 최고 — 벤치마크 대상 |
| **Theatre.js** | 사실상 중단 (마지막 릴리스 2023-08) | 시퀀서/에디터일 뿐, 렌더·내보내기 파이프라인 없음 |
| **Motion Canvas** | 방치됨 (2024-08 이후; 포크 Revideo도 반휴면) | 2D 전용. 제너레이터 기반 시간 모델은 참고 가치 |
| **A-Frame** | 유지되나 느림 (v1.7.1, 2025-04) | 선언적 HTML 3D가 LLM에 통한다는 증거. 그러나 wall-clock 런타임, seek/내보내기 없음 |
| **R3F/drei/Threlte** | 활발 | 인터랙티브 런타임. `useFrame`=벽시계, 자체 비디오 파이프라인 없음 |
| **Blender bpy (+MCP)** | AI 통합 폭발 중 (blender-mcp 16k+ stars, 공식 MCP 서버) | 무겁고 비웹, 느린 렌더. MCP들은 대화형 코파일럿이지 재현 가능한 render 파이프라인이 아님 |
| **Needle/PlayCanvas/Spline** | 활발 | 프로그래매틱 비디오 내보내기 없음 (Spline은 GUI 전용 유료 렌더) |
| **JSON 비디오 API (Shotstack 등)** | 활발 | 2D 레이어 합성, 씬그래프 3D 아님 |

**비어 있는 교집합 = stereoframe의 포지셔닝:**

1. 오픈소스(Apache/MIT) + 3D 네이티브 + 결정론적 frame-seek 비디오 프레임워크는 **존재하지 않는다**.
2. LLM 친화적 선언 포맷(HTML/JSON)으로 **씬그래프 + 카메라 + 타임라인**을 기술하는 표준이 없다 (A-Frame의 마크업 × Hyperframes의 타임라인 결합은 미점유).
3. 비디오용 **3D 블록 카탈로그**(제품 턴테이블, 카메라 리그, 라이팅 프리셋, GLTF 클립 플레이어)가 없다.
4. **3D 인지 lint/validate 루프**(에셋 프리로드 검사, frustum 포함 검사, 시간 순수성 검사)가 없다.
5. 헤드리스 GPU/WebGPU 캡처는 업계 전체의 미해결 문제 — 풀면 해자(moat)가 된다.

---

## 3. Three.js 기술 기반 (r184, 2026-04)

### 3.1 버전/문서 현황
- 현재 릴리스 **r184** (npm `three@0.184.0`). 릴리스 주기는 월간→6~8주로 둔화.
- WebGL1 지원 r163에서 제거. `three/webgpu`, `three/tsl` 엔트리는 r167부터. WebGPURenderer는 아직 기본 아님(WebGL2 폴백 내장).
- **`THREE.Clock`은 r183에서 deprecated** (→ `Timer`). 우리 파이프라인에서는 둘 다 우회하고 `t = frame/fps`를 순수 입력으로 사용.
- **공식 llms.txt 존재** (r183~): `threejs.org/docs/llms.txt`(5KB, LLM 지침 포함 — import map, 버전 핀, WebGL vs WebGPU 선택), `llms-full.txt`(126KB). 모든 API 페이지가 `.html.md`로 마크다운 제공. Context7 인덱싱됨. → 에이전트 스킬 구축에 바로 활용 가능.
- LLM의 three.js 코드 실패 모드 = **버전 churn** (r152 컬러 매니지먼트, r155 라이팅 단위, `examples/js`→`jsm`→`three/addons` 경로 혼용, 제거된 `Geometry`). 완화책: 버전 핀 + 시스템 프롬프트 치트시트 + import 경로를 모델이 선택하지 못하게 강제.

### 3.2 시간 제어 (seekFrame 구현의 핵심)
- **AnimationMixer.setTime(t)** = "전부 0으로 리셋 후 update(t) 한 번" 구현. 평범한 루프 클립에는 멱등. 단:
  - `fadeIn/fadeOut/crossFadeTo/warp`는 절대 mixer 시간에 앵커된 인터폴런트라 역방향 seek에서 깨짐 → **가중치는 `setEffectiveWeight(f(t))`로 매 프레임 명시 설정**.
  - `LoopOnce`+`clampWhenFinished`는 끝을 지나면 paused/disabled 되어 이후 seek에서 되살아나지 않음 → 매 seek 전 `reset()` 또는 paused/enabled 복구.
  - `paused` 액션은 setTime 후 첫 프레임으로 스냅 → seek 파이프라인에서 `paused` 사용 금지.
  - timeScale은 seek 값에 이중 적용 → 전부 1로 고정하고 속도는 t에 베이크.
  - r184에 "Fix timeScale reversal jump" 포함 — r184 이상 핀 권장. 마지막 프레임은 `min(t, duration-1e-6)`.
- **GSAP**: `gsap.ticker.remove(gsap.updateRoot)` 후 `gsap.updateRoot(t)` 또는 paused 타임라인에 `tl.seek(t, false)` — 완전 결정론. **GSAP은 2025-04부터 전 플러그인 무료**(Webflow 인수).
- **TSL/WebGPU 함정**: 내장 `time`/`deltaTime` 노드는 `performance.now()` 기반(NodeFrame)이고 오버라이드 불가 → 자체 `uniform(0)`을 만들어 `u.value = t` 설정.
- **셰이더**: 관례적 `uTime` 유니폼은 본질적으로 seek 가능. EffectComposer는 **반드시 `composer.render(1/fps)`** 호출(인자 생략 시 내부 wall-clock Clock 사용).

### 3.3 캡처 & 인코딩
- 픽셀 추출: `preserveDrawingBuffer` 불필요 — render와 **같은 태스크에서 동기 캡처**하면 됨. 정밀 경로는 `WebGLRenderTarget` + `readRenderTargetPixelsAsync`(r165+, PBO+fence 비동기, RGBA/alpha 그대로; 행 상하반전 주의).
- 인브라우저 인코딩: WebCodecs `VideoEncoder`(Chrome 94+/FF 130+/Safari 26+) + **mediabunny**(mp4-muxer/webm-muxer를 대체한 통합 라이브러리, `CanvasSource.add(timestamp)` 패턴). 단 **알파는 사실상 인코딩 불가**(H.264 알파 없음, VP9 알파 encode 미지원 다수) → 투명 비디오는 raw RGBA → ffmpeg(`yuva420p` VP9 / ProRes 4444) 경로 필수. 인코더 비트스트림은 머신 간 재현 불가 → 결정론 보장은 "프레임 픽셀"까지, 인코딩은 ffmpeg 핀으로.
- CDP 캡처(Hyperframes/Remotion 방식): `Page.captureScreenshot`(단순, PNG 알파) 또는 `HeadlessExperimental.beginFrame`(최강 결정론, 단 **chrome-headless-shell 전용, Linux/Windows; macOS 불안정**).

### 3.4 헤드리스 & 머신 간 결정론
- **GPU 경로는 어떤 것도 머신 간 비트 동일 불가** (GL 스펙이 구현 간 변동 허용: MSAA 샘플 위치, 텍스처 필터 정밀도, FMA 융합, 래스터화 허용오차).
- 실용 레시피 = Hyperframes Docker 모드와 동일: **고정 linux/amd64 이미지 + 핀된 chrome-headless-shell + SwiftShader** (`--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader`) + `--deterministic-mode --enable-begin-frame-control --run-all-compositor-stages-before-draw`. 주의: **Chrome 137+는 SwiftShader 자동 폴백 제거** — 플래그 명시 필수. 아키텍처(x86 vs ARM) 간 비트 동일성은 보장 안 됨(Reactor JIT가 SSE/NEON/FMA에 따라 다른 코드 생성).
- 로컬 개발 = GPU 가속(빠름, 근사 결정론) / CI·프로덕션 = SwiftShader Docker(비트 동일) 이원화가 업계 표준 절충.
- headless-gl(npm `gl`)은 v9(ANGLE 기반, 실험적 WebGL2)로 부활했으나 DOM 없음 — 보조 경로. WebGPU 헤드리스(Dawn-node)는 2026 중반 기준 신뢰할 수 없음.

### 3.5 결정론 체크리스트 (lint 규칙의 원천)
1. 모든 상태를 `t = frame/fps`의 순수 함수로; `Date.now`/`performance.now`/rAF 타임스탬프 금지.
2. 프레임 0 전에 전체 로드: `loadAsync` + `LoadingManager.onLoad` + **`renderer.compileAsync(scene, camera)`** + troika `sync()` 대기, 폰트 로컬 번들(troika 기본 폰트는 CDN 페치!).
3. `Math.random` → mulberry32 시드 패치 (프레임별 `seed = base ^ frame`으로 seek 가능하게). `MathUtils.seededRandom`은 이미 Mulberry32(비트 정확).
4. 순차 상태 패스 금지/격리: AfterimagePass, TAA(accumulate), FilmPass 누적, GlitchPass(내부 Math.random + 프레임 카운터). 안전: **SSAARenderPass**(프레임 내 지터, 무상태), UnrealBloom, FXAA/SMAA.
5. `antialias: false` + SSAA/FXAA (컨텍스트 MSAA는 드라이버 의존), anisotropy 1, KTX2는 디바이스별 트랜스코드 타깃이라 머신 간 결정론 깨짐 — 타깃 강제 또는 회피.
6. 비디오 텍스처: `video.currentTime` seek은 프레임 부정확 → WebCodecs 디코드→canvas 텍스처 (Remotion `useOffthreadVideoTexture` 패턴).
7. 물리: **Rapier** `@dimforge/rapier3d-deterministic`(WASM, 크로스 플랫폼 결정론) + 고정 `world.timestep = 1/fps`. 시뮬레이션은 본질적으로 순차 → **베이크**(전체 시뮬 1회 실행→프레임별 transform 기록) 후 seek 가능한 데이터로 구동. 파티클도 동일: 우선은 무상태 해석적 파티클(`pos = f(seed_i, t)` 버텍스 셰이더).
8. three.js/Chrome/ffmpeg/폰트 전부 버전 핀.

---

## 4. AI 친화적 3D 표현 (저작 포맷 설계)

### 4.1 포맷 후보 평가
- **토큰 효율/디프 용이성/LLM 유창성**: 커스텀 HTML 속성 DSL ≈ A-Frame > R3F JSX > .usda > raw three.js 코드 > three.js JSON format 4 > glTF JSON > KHR_interactivity 그래프.
- glTF/GLB = **에셋** 포맷(공식 validator 있음), 저작 포맷 아님(지오메트리가 바이너리). USD는 영감(프림 계층, 레이어/오버라이드, 시간 샘플)이지 브라우저 런타임 부재. three.js JSON format 4는 UUID 교차 참조 때문에 LLM이 정합성을 깨기 쉬움.
- A-Frame이 증명: HTML 엔티티-컴포넌트는 LLM이 잘 쓴다. 단 A-Frame 자체는 런타임(렌더 루프) 포함이라 그대로 못 씀 — **마크업 패턴만 차용**하고 seek 가능한 자체 런타임으로 해석.
- 연구 문헌의 일관된 교훈: **"LLM은 의미론/제약을 제안하고, 결정론적 솔버/런타임이 수학을 한다"** (SceneCraft, Holodeck, LLMR, 3D-GPT).

### 4.2 애니메이션 고도(altitude)
- 정답은 2-레이어: **의미론적 동사 + 파라미터 + 명명된 easing** ("orbit camera around #hero, radius 5, 3s, power2.inOut" / "bounce-in #logo at 1.2s")을 GSAP 타임라인/키프레임으로 결정론 컴파일. raw `tl.to()` escape hatch 유지.
- 근거: MoVer(GSAP 모션그래픽 검증 DSL) — 1차 생성 정확도 58.8% → 검증-수정 루프로 **93.6%**. LAMP — 시네마토그래피 동사(pan/tilt/truck/orbit/zoom)를 3D 궤적으로 결정론 컴파일. Keyframer — 반복적 자연어 정제 + 속성별 분해 프롬프트 선호.
- raw 키프레임 JSON은 저장/디프용이지 저작용이 아님.

### 4.3 에이전트 검증 루프 (계측된 효과)
1. **실행+traceback 피드백**: 실행 가능성 70.2% → 97.4% (3DCodeBench).
2. **씬그래프 어서션**(프로그램적, 렌더 불필요): `Box3.setFromObject`(바운드/교차/부유 객체), `Frustum.intersectsBox`("X가 화면에 보이는가"), 레이캐스트 차폐, 라이트/머티리얼/NaN 검사. → `stereoframe lint`의 핵심.
3. **MoVer식 시간 어서션**: "t=3s에 #logo가 프레임 안, scale=1" 같은 선언적 술어를 프레임 평가. 58.8→93.6%.
4. **스크린샷→VLM 비평 루프**: 정준 3~4앵글 + 실제 샷 카메라 렌더를 VLM에 제출. 저렴한 자동 프록시: SigLIP-2 유사도(인간 선호와 r=0.964).
5. 렌더러 자체가 검증기를 겸함: 결정론 캡처 파이프라인이 있으면 **검증 렌더러 = 프로덕션 렌더러** (아키텍처 절약).
6. AST 기반 API 존재 lint(핀된 three.js 타입 선언 대조)로 환각 API 차단.

### 4.4 에셋 전략
- 1순위 **프로시저럴**: three.js 프리미티브 + Extrude/Lathe/Tube + `three-bvh-csg`. 모션그래픽 수요의 대부분 커버, 에셋 파이프라인 0.
- **Poly Haven API**(CC0, api.polyhaven.com): HDRI가 "한 방에 룩 개선"하는 최고 레버리지 에셋. 에이전트가 직접 페치 가능.
- 생성 3D(2026): Meshy(API/엔터프라이즈), Tripo(속도), TRELLIS 2(오픈소스 품질), Hunyuan3D(자가 호스팅). 전부 GLB 출력. **Sketchfab API는 Fab 전환으로 사용 금지**. Kenney CC0는 큐레이션 로컬 라이브러리로.
- 모든 외부 에셋은 GLB로 정규화 + glTF-Validator 검사 + 렌더 전 프리로드 강제.

---

## 5. 아키텍처 제안

### 전략 선택: Hyperframes 위에 얹을 것인가, 독립할 것인가

**권장: 1단계는 Hyperframes 확장 레이어, 2단계에 독립 판단.**

근거: Hyperframes는 Apache-2.0이고, 가장 어려운 인프라(BeginFrame 결정론 캡처, Docker 패리티, ffmpeg/오디오/HDR, CLI/Studio/lint 골격)를 이미 제공한다. Frame Adapter v0 계약(`seekFrame`)은 우리가 필요한 정확한 통합 지점이다. 차별화 가치는 인프라 재발명이 아니라 **3D 어휘 + 3D lint + 3D 블록**에 있다.

### 제안 스택 (stereoframe)

```
┌─ 저작 레이어: 선언적 3D 마크업 (A-Frame 패턴, 자체 해석)
│   <sf-scene environment="studio" camera-fov="35">
│     <sf-model src="product.glb" position="0 0 0" data-start="0"/>
│     <sf-camera-move verb="orbit" target="#product" radius="4"
│                     from="0deg" to="270deg" data-start="30" data-duration="90"
│                     ease="power2.inOut"/>
│     <sf-text value="Introducing" anchor="top" data-start="15" enter="bounce-in"/>
│   </sf-scene>
│
├─ 컴파일 레이어: 마크업 → three.js 씬그래프 + GSAP 마스터 타임라인
│   · 동사 라이브러리 (orbit/dolly/truck/reveal/turntable/bounce-in …)
│   · easing 어휘 = GSAP 명명 easing 그대로
│   · escape hatch: <script type="sf-timeline"> raw GSAP/three.js
│
├─ 런타임 레이어: Hyperframes Frame Adapter 구현
│   seekFrame(frame): t = frame/fps →
│     gsap.updateRoot(t) → mixer.setTime(t)(가중치 명시) →
│     uniforms.uTime.value = t → composer.render(1/fps)
│   · 프리로드 게이트 (loadAsync + compileAsync + troika sync)
│   · 시드 RNG (mulberry32, frame-keyed)
│   · 물리/파티클은 베이크 또는 무상태 해석형만
│
├─ 검증 레이어: stereoframe lint / validate
│   · 정적: API 존재(AST), 마크업 스키마, 에셋 존재/GLB validator
│   · 런타임: 프리로드 완료, NaN transform, Box3/Frustum 어서션,
│     MoVer식 시간 술어, 시간 순수성(벽시계 호출 탐지)
│   · 시각: 정준 앵글 스크린샷 → VLM 비평 (옵션)
│
├─ 렌더 레이어: Hyperframes engine/producer 그대로
│   (chrome-headless-shell BeginFrame, SwiftShader Docker, ffmpeg)
│
└─ 에이전트 레이어: llms.txt + 스킬 + 블록 카탈로그
    · three.js 공식 llms.txt/.html.md 재활용, 버전 핀 치트시트
    · 3D 블록: 제품 턴테이블, 디바이스 목업, 로고 리빌, 카메라 리그,
      라이팅 프리셋(스튜디오/선셋/네온), 파티클 프리셋, GLTF 클립 플레이어
    · 자연어→설정 어휘 테이블 (Hyperframes prompting 가이드 패턴)
```

### 핀 정책 (재현성의 토대)
- three.js **r184+** (애니메이션 seek 수정 포함), chrome-headless-shell 버전 핀, ffmpeg 핀, 폰트 번들, linux/amd64 Docker.
- WebGLRenderer 우선 (WebGPU 헤드리스는 2026 중반 기준 미성숙; TSL은 자체 time 유니폼 전제로 후순위 추적).

### 검증된 수치가 말하는 우선순위
1. 실행 피드백 루프 (70→97%) — CLI validate가 traceback을 구조화해 반환.
2. 시간/공간 어서션 (59→94%) — lint에 MoVer식 술어 내장.
3. 의미론적 동사 레이어 — LLM이 키프레임 수학이 아닌 의도를 쓰게.
4. 블록 카탈로그 — Hyperframes 성장의 실증된 동력.

---

## 6. 리스크

- **Hyperframes Frame Adapter는 v0(실험적)** — v1 전 breaking change 가능. 어댑터 경계를 얇게 유지해 격리.
- **HeyGen이 직접 3D를 1급으로 올릴 가능성** — HTML-in-Canvas 가이드가 그 방향의 신호. 빠르게 움직이고, 기여(upstream) 전략도 병행 고려.
- macOS 로컬에서 BeginFrame 불안정 → 로컬은 스크린샷 모드, CI는 Docker (Hyperframes와 동일한 절충).
- 알파 비디오는 WebCodecs로 불가 — raw RGBA→ffmpeg 경로 유지 필요.
- 머신 간 비트 동일성은 동일 아키텍처 한정 (Apple Silicon vs x86 혼합 시 amd64 에뮬레이션 강제).

## 7. 핵심 출처

- Hyperframes: https://hyperframes.mintlify.app (frame-adapters, determinism, prompting, rendering, hyperframes-vs-remotion), https://github.com/heygen-com/hyperframes
- three.js: https://threejs.org/docs/llms.txt, Migration Guide(wiki), r183/r184 릴리스 노트, AnimationMixer.setTime PR #17504, NodeFrame.js(TSL time)
- Remotion: remotion.dev/docs/three, /gl-options, /ai/system-prompt, /license
- 결정론 캡처: alexey-pelykh.com(puppeteer-capture), replit.com/blog/browsers-dont-want-to-be-cameras, CDP HeadlessExperimental/Emulation, Chromium SwiftShader 문서, SwiftShader 폴백 제거(Chrome 137)
- 연구: MoVer(2502.13372), LAMP(2512.03619), 3DCodeBench(2606.01057), SceneCraft, Holodeck, LLMR, Keyframer
- 도구: mediabunny.dev, rapier.rs/determinism, troika-three-text, three-bvh-csg, api.polyhaven.com
