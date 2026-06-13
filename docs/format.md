# Stereoframe Markup v0

선언적 3D 씬을 기술하는 커스텀 엘리먼트 어휘. 런타임(`stereoframe.js`)이 마크업을 three.js 씬으로 컴파일하고, 매 프레임을 시간 `t`(초)의 순수 함수로 렌더한다.

## 두 가지 호스트 모드

**독립 모드(기본)** — stereoframe CLI가 자체 프로토콜을 구동한다:

```bash
stereoframe init my-video && cd my-video && stereoframe render
```

런타임은 `window.__stereoframe = { ready, duration, width, height, seek }`를 노출하고, CLI 렌더러(Puppeteer + ffmpeg)는 `ready === true`(모든 GLB/HDRI 로드 + 셰이더 컴파일 완료)를 기다린 뒤 `seek(frame/fps)` → CDP 스크린샷 → ffmpeg 파이프로 mp4를 만든다. `.clip[data-start]` 요소의 가시성도 런타임이 직접 t의 함수로 구동한다. `?sf-preview` 쿼리로 브라우저 루프 재생.

**HyperFrames 임베드 모드** — 페이지에 `[data-composition-id]` 루트가 있으면 자동 전환: `hf-seek` 이벤트를 따르고, 에셋 준비 전까지 `window.__hf`를 게이트한다(DOMContentLoaded는 모듈 TLA를 기다리지 않으므로 — 실측). DOM 클립/타임라인은 HyperFrames가 소유한다.

두 모드 모두 로드는 **인라인 모듈 스크립트**로:

```html
<script type="module">
  import "./assets/stereoframe.js";
</script>
```

> 임베드 모드에서 `<script type="module" src="...">` 형태는 쓰지 말 것 — HyperFrames
> 번들러가 상대경로 `script[src]`를 일반 스크립트로 인라인하면서 모듈 문맥이 깨진다.

## 엘리먼트

### `<sf-scene>` — 씬 루트 (= 샷)

**멀티샷**: 페이지에 sf-scene을 여러 개 두면 각각이 시간 구간 샷이 된다. 전체 영상 길이 = max(start + duration). 샷 안의 `sf-animate`는 **샷-로컬 시간**(샷 시작 = 0초)으로 작성한다. 비가시 샷은 렌더가 스킵되며(모든 상태가 t의 순수 함수라 안전), 캔버스 z순서 = 문서 순서이므로 샷을 시간 순서대로 배치하면 크로스페이드가 자연히 위에 얹힌다. DOM 클립(`.clip[data-start]`)은 **전역 시간**을 유지한다.

| 속성 | 기본값 | 설명 |
|---|---|---|
| `start` | 0 | 샷 시작(전역 초). 단일 씬은 생략 — 기존 동작 그대로 |
| `duration` | (필수) | 샷 길이(초). 임베드 모드에선 루트의 `data-duration` 상속 가능 |
| `transition` | cut | `cut` \| `crossfade` — 샷 도입부 전환 |
| `transition-duration` | 0.6 | 크로스페이드 길이(초). 이전 샷의 duration이 `start + transition-duration`까지 덮어야 페이드 중 아래가 비지 않는다 |
| `environment` | — | HDRI 경로(.hdr). PBR 환경광/반사. PMREM 처리됨 |
| `background` | transparent | `#hex` 색, `transparent`, 또는 `environment`(HDRI를 배경으로) |
| `exposure` | 1 | 톤매핑 노출 |
| `tone-mapping` | aces | `aces` 또는 `none` |
| `width`/`height` | 1920/1080 | 캔버스 크기 (임베드 모드: 컴포지션 루트의 `data-width/height` 상속) |

캔버스는 sf-scene의 첫 자식으로 자동 삽입된다. 레이어링은 일반 CSS로 제어.

### `<sf-camera>`

| 속성 | 기본값 | 설명 |
|---|---|---|
| `fov` | 35 | 수직 화각(도) |
| `position` | `0 1 5` | `x y z` |
| `look-at` | — | `#id`(매 프레임 추적) 또는 `x y z` |
| `look-at-offset` | `0 0 0` | 객체 look-at 시 시선 지점 오프셋(예: 캐릭터 몸통 높이 `0 0.7 0`) |

### `<sf-model>` — GLB/GLTF

| 속성 | 설명 |
|---|---|
| `src` | GLB 경로(로컬 필수 — 렌더 중 원격 fetch 금지) |
| `id` | `#id` 참조용 |
| `position`/`rotation`/`scale` | `x y z`(rotation은 도 단위), scale은 단일값 허용 |
| `clip` | 초기 재생 클립 이름(기본: 첫 번째 클립). 다른 클립은 가중치 0으로 대기 |

모든 클립은 항상 재생 상태(가중치만 제어)로 두고 `mixer.setTime(t)`로 시킹한다(timeScale 1 고정). 클립 전환은 `crossfade-clip` 동사로 — 가중치가 t의 순수 함수가 되어 임의 시킹이 안전하다.

### `<sf-particles>` — 무상태 해석적 파티클

모든 입자 위치가 `f(시드 속성, t)`의 닫힌식으로 셰이더에서 계산된다. 시뮬레이션 스텝이 없어 임의 순서 시킹에 안전하고, 시드(mulberry32)가 같으면 모든 렌더에서 비트 동일하다.

| 속성 | 기본값 | 설명 |
|---|---|---|
| `preset` | fountain | `fountain`(분수/스파크), `snow`(낙하+흔들림), `dust`(부유 입자) |
| `count` | 500 | 입자 수 |
| `seed` | 1 | PRNG 시드 — 바꾸면 다른 배치 |
| `color`/`size`/`opacity` | #ffffff / 0.08 / 0.9 | |
| `position` | `0 0 0` | 이미터/볼륨 중심 |
| `area` | `6 4 6` | snow/dust 볼륨 크기 |
| `speed`/`spread`/`gravity`/`life` | 3 / 25 / 4 / 2.5 | fountain 전용 |
| `amplitude` | 0.4 | dust 이동 반경 |

블렌딩: fountain/dust는 additive, snow는 normal.

### `<sf-mesh>` — 프로시저럴 지오메트리

| 속성 | 기본값 | 설명 |
|---|---|---|
| `geometry` | box | `box` `sphere` `plane` `cylinder` `torus` `icosahedron` `rounded-box`(args: `w h d 모서리반경`) |
| `args` | 지오메트리별 | 공백 구분 수치 (box: `w h d`, cylinder: `rTop rBottom h`, …) |
| `material` | standard | `standard` \| `physical` \| `glass`(transmission 프리셋: transmission 1, thickness 0.4, clearcoat 1, roughness 0.08) |
| `color` | #ffffff | 기본색 (glass에선 틴트) |
| `metalness`/`roughness` | 0 / 0.5 | |
| `transmission`/`thickness`/`ior`/`clearcoat`/`clearcoat-roughness`/`dispersion` | 프리셋별 | physical/glass 노브 — 명시하면 프리셋 덮어씀 |
| `emissive`/`emissive-intensity` | #000 / 1 | 자체 발광(유리 뒤 글로우 연출에 유용) |
| `env-map-intensity` | 1 | 환경맵 반사 강도 |
| `position`/`rotation`/`scale` | | transform |

유리 연출 팁: transmission은 "뒤에 있는 것"을 굴절시키므로 배경이 순흑이면 유리도 검게 보인다. 뒤에 emissive 글로우 플레이트/구를 배치하고 environment HDRI를 켜면 유리감이 산다.

### `<sf-swarm>` — 종이 조각 → 타이포 안무 (블록)

캔버스에 래스터한 텍스트에서 타깃 포인트를 샘플링하고, 시드 산란 위치에서 stagger로 집결하는 InstancedMesh. 매 프레임 모든 인스턴스 행렬을 t만으로 재계산 — 임의 시킹 안전, 시드 고정 시 비트 동일.

| 속성 | 기본값 | 설명 |
|---|---|---|
| `text` | STEREOFRAME | `\|`로 줄바꿈 |
| `font` | 900 140px sans-serif | 캔버스 폰트 문자열 |
| `count`/`seed` | 1500 / 1 | 조각 수 / PRNG 시드 |
| `size` | 0.12 | 조각 기준 크기(월드) |
| `width` | 12 | 텍스트 월드 폭(높이는 비율 자동) |
| `palette` | 회색+적색 4색 | 쉼표 구분 색 목록 |
| `scatter` | width 기반 | 산란 볼륨 `x y z` |
| `start`/`duration`/`stagger`/`ease` | 0.5 / 3.5 / 0.5 / power3.inOut | 안무 타이밍 |
| `mode` | gather | `gather`(산란→집결) \| `disperse`(역재생) |
| `position` | 0 0 0 | 텍스트 중심 |

### `<sf-light>`

프리셋: `preset="studio"`(키+림+앰비언트), `soft`, `sunset`.
또는 단일 라이트: `type="directional|ambient|hemisphere|point"` + `color`/`intensity`/`position`.

### `<sf-sky>` — 물리 대기 돔 (블록)

three.js Sky 애드온. 순수 셰이더(에셋·시간의존 없음 — 본질적으로 결정론적).

| 속성 | 기본값 | 설명 |
|---|---|---|
| `elevation`/`azimuth` | 15 / 180 | 태양 고도/방위(도). 2–15도 = 골든아워 |
| `turbidity`/`rayleigh` | 10 / 2 | 대기 혼탁도/산란 |
| `mie-coefficient`/`mie-directional-g` | 0.005 / 0.8 | 미 산란 |
| `scale` | 2000 | 돔 크기 — `sf-camera far`보다 작게 |

`<sf-scene exposure="0.55">` 정도로 노출을 낮추면 자연스럽다. sf-sky의 태양 방향은 같은 씬의 sf-ocean 하이라이트에 자동 연결된다.

### `<sf-ocean>` — 물 평면 (블록)

three.js Water 애드온(반사/굴절/태양 글린트). `stereoframe add ocean`으로 노멀맵(`assets/waternormals.jpg`) 설치. 셰이더 time 유니폼은 seek 루프에서 `t × speed`로 설정 — 임의 순서 시킹 안전.

| 속성 | 기본값 | 설명 |
|---|---|---|
| `size` | 2000 | 평면 크기 — `sf-camera far`를 충분히 크게(예: 5000) |
| `color` | #001e0f | 물 색 |
| `speed` | 1 | 물결 속도 배율 |
| `distortion-scale` | 3.7 | 왜곡 강도 |
| `normals` | assets/waternormals.jpg | 노멀맵 경로 |
| `sun-direction`/`sun-color` | 0.7 0.6 0.3 / #ffffff | sf-sky 있으면 자동 대체 |

### `<sf-animate>` — 의미론적 동사

공통 속성: `target`(`camera` 또는 `#id`), `verb`, `start`(초, 기본 0), `duration`(초), `ease`.

> 주의: 동사 타이밍은 **`start`/`duration`** (무접두사)이다. `data-start`/`data-duration`은
> HyperFrames의 클립 타이밍 속성이므로 sf-animate에 쓰지 않는다.

| verb | 파라미터 (기본값) | 설명 |
|---|---|---|
| `turntable` | `rpm`(6), `axis`(y) | 연속 회전. duration 불필요 |
| `orbit` | `around`(`#id`\|`x y z`, 기본 원점), `radius`(초기 거리), `from`/`to`(도, 기본 초기각→+360°), `height`(초기 상대높이), duration 기본 4 | 중심 주위 호 이동. 카메라에 쓰면 look-at과 조합 |
| `dolly` | `toward`(`#id`\|`x y z`), `distance`(1), duration 기본 1.5 | 대상 방향으로 전진(음수면 후퇴) |
| `move` | `to`(`x y z`, 필수), `from`(기본 초기 위치), duration 기본 2 | 직선 이동 |
| `follow` | `subject`(`#id`), `offset`(`x y z`, 기본 초기 상대 오프셋) | 이동하는 대상을 고정 오프셋으로 추적. 연속. late pass에서 실행되므로 subject의 이동 동사보다 항상 늦게 적용됨 |
| `crossfade-clip` | `from`/`to`(클립 이름, 필수), duration 기본 0.5 | GLB 클립 가중치 크로스페이드 (예: Survey→Run) |
| `camera-path` | `points`(쉼표 구분 `x y z` 목록, 2개 이상), `look`(`ahead`\|`none`, 기본 ahead), duration 기본 8 | 캣멀롬 스플라인 플라이스루. 등호선(arc-length) 보간이라 공간 속도 일정. `look="ahead"`는 진행 방향을 바라봄 — 이때 sf-camera의 `look-at`은 생략할 것(나중에 적용돼 덮어씀). late pass 실행 |
| `bounce-in` | duration 기본 0.6, ease 기본 `back.out` | 스케일 0→원래값 등장 |
| `fade-in` | duration 기본 0.6 | 머티리얼 opacity 0→원래값 |
| `float` | `amplitude`(0.1), `period`(4) | Y축 사인 부유. 연속 |

### Easing 어휘 (GSAP 호환 이름)

`linear` `none`, `power1~4.in/.out/.inOut`, `sine.*`, `expo.*`, `circ.*`, `back.*`, `elastic.out`, `bounce.out`. 미지정 시 `power1.out`(bounce-in은 `back.out`).

## DOM 오버레이 (독립 모드)

- 가시성 창: `class="clip"` + `data-start`/`data-duration`(초) — 런타임이 t의 함수로 visibility를 토글.
- 등장 연출: `fade-in`(`rise` px 옵션 — 아래에서 떠오르며 페이드)과 `bounce-in` 동사가 `#id`가 3D 객체가 아니면 DOM 요소로 폴백해 inline style(opacity/transform)을 구동.
- `sf-animate`는 DOM을 타깃하더라도 `<sf-scene>` 안에 위치해야 한다.

임베드 모드에서는 DOM 클립/애니메이션을 HyperFrames(GSAP 타임라인)가 소유한다.

## Escape hatch

```html
<script type="stereoframe">
  // 에셋 로드 완료 후 1회 실행. sf = { scene, camera, renderer, objects, scenes, onSeek }
  const product = sf.objects.get("product");
  sf.onSeek((t) => {
    product.rotation.z = Math.sin(t * 2) * 0.05;
  });
</script>
```

`onSeek` 콜백 역시 `t`의 순수 함수여야 한다.

## 결정론 규칙

1. 모든 상태는 `t = frame / fps`의 순수 함수. `Date.now()`, `performance.now()`, `requestAnimationFrame` 기반 누적 금지.
2. `Math.random()` 금지(시드 없는 난수는 프레임마다 다른 출력).
3. 에셋은 로컬 파일만. 렌더/시킹 중 네트워크 fetch 금지.
4. 이전 프레임 상태에 의존하는 효과(트레일, 피드백, 물리 스텝) 금지 — 임의 순서 시킹이 가능해야 한다.
5. 렌더러는 `antialias: false`, `pixelRatio 1` 고정(머신 간 결정론).

## 아키텍처 노트

- 시킹 경로: `hf-seek(t)` → 동사 writer들 → `mixer.setTime(t)` → `camera.lookAt` → `renderer.render`. 단일 동기 함수(`seek.ts`).
- HyperFrames 의존부(전역 `__hf`, `hf-seek`)는 `seek.ts` 한 곳에 격리 — 어댑터 계약은 upstream v0(실험적).
- 준비 게이트: 런타임이 `window.__hf`를 프록시로 가려 에셋 로드 완료까지 렌더 엔진의 readiness 폴링(`__hf.duration > 0`)을 지연시킨다. DOMContentLoaded는 모듈 TLA를 기다리지 않으므로(실측) 이 게이트가 필요하다.
