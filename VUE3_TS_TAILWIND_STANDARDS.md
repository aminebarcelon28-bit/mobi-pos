# Vue 3 + TypeScript + Tailwind CSS — Engineering Standards & Edge-Case Bible

> Deep-research standards for building production Vue 3 applications with TypeScript and Tailwind CSS v4 — the stack rules, the type-level hard parts, the styling architecture, and every recurring edge case (reactivity loss, watch traps, template type limits, dynamic-class failures, scoped-style conflicts, CSP interactions) with the fix for each.

**Version:** 1.0
**Last reviewed for currency:** September 2026 (all versions and behaviors verified against current releases — see Appendix A)
**Convention:** `MUST` = non-negotiable. `SHOULD` = strong default; deviating requires a stated reason. `MAY` = discretionary.
**Relationship to other standards:** This document specializes the parent `DEVELOPMENT_STANDARDS.md` (which governs clean code, testing, security, and AI-agent execution universally). Where both speak, the parent wins on universal concerns and this document wins on Vue/TypeScript/Tailwind specifics. §13 bridges to `TAURI_V2_POS_STANDARDS.md` for the desktop-embedding case.

**Verified stack baseline (September 2026):**

| Layer | Current stable | Notes |
|---|---|---|
| Vue | 3.5.x | 3.6 is in RC with Vapor Mode feature-complete but unstable and **opt-in only** — do not ship it yet (Appendix A) |
| Vite | 8.x | Ships Rolldown (Rust bundler) + Oxc + Lightning CSS by default |
| TypeScript | 6.0.x / 7.0.x | 6.0 is the final JS-based compiler; 7.0 is the native (Go) port. Verify `vue-tsc`/Volar compatibility before moving to 7.x |
| Tailwind CSS | 4.3.x | CSS-first configuration; no `tailwind.config.js` by default |
| Pinia | 4.x | Vue 3 only; v3→v4 was mostly technical breaking changes |
| VueUse | 14.x | Requires Vue 3.5+ |
| Vitest | 5.x | Browser Mode stable; built-in Trace View |
| ESLint / eslint-plugin-vue | 9.x flat / 10.11.x | Flat config is the default and the only supported path going forward |

---

## Table of Contents

- [0. Fast-Start Checklist (Read First)](#0-fast-start-checklist-read-first)
- [1. Project Setup & Architecture](#1-project-setup--architecture)
- [2. Reactivity: Rules, Traps & Escape Hatches](#2-reactivity-rules-traps--escape-hatches)
- [3. Components, Templates & Events](#3-components-templates--events)
- [4. TypeScript Hard Parts](#4-typescript-hard-parts)
- [5. Composables & State Management](#5-composables--state-management)
- [6. Tailwind CSS v4 Architecture](#6-tailwind-css-v4-architecture)
- [7. Styling Patterns & Edge Cases](#7-styling-patterns--edge-cases)
- [8. Forms & User Input Edge Cases](#8-forms--user-input-edge-cases)
- [9. Performance Engineering](#9-performance-engineering)
- [10. Testing Standards](#10-testing-standards)
- [11. Tooling, Lint & CI/CD](#11-tooling-lint--cicd)
- [12. Security](#12-security)
- [13. Vue Inside Tauri (Desktop Bridge)](#13-vue-inside-tauri-desktop-bridge)
- [14. The Edge-Case Compendium](#14-the-edge-case-compendium)
- [15. Enforcement & Automation](#15-enforcement--automation)
- [Appendix A: Version Matrix & Verified Baseline (September 2026)](#appendix-a-version-matrix--verified-baseline-september-2026)
- [Appendix B: Migration Hotlists](#appendix-b-migration-hotlists)
- [Appendix C: Document Governance & Exception Process](#appendix-c-document-governance--exception-process)

---

## 0. Fast-Start Checklist (Read First)

Run through this list before writing a single line in a Vue 3 + TS + Tailwind codebase, and again before returning a result. Every item links to the section that explains it. The parent document's §0 checklist (read files first, smallest diff, zero placeholders, no hallucinated dependencies) still applies in full — this list adds the stack-specific traps.

**Before you start:**
1. ☐ Confirm the Vue version is 3.5+ before using reactive props destructure, `useTemplateRef`, `useId`, or `onWatcherCleanup` — all are 3.5 features (§2.3, §4.4).
2. ☐ Confirm the Tailwind major version. v4 has **no config file by default**, uses `@import "tailwindcss"`, renames a dozen utilities, and moves `!important` to a suffix. A v3 mental model on a v4 codebase produces silently broken styles (§6.4).
3. ☐ Locate the design tokens (`@theme` block in `src/assets/main.css`) and the `cn()` helper before inventing new colors or class-composition patterns (§6.2, §7.1).
4. ☐ Identify how state flows: props down / events up, which Pinia stores exist, which composables are shared. Never invent a parallel mechanism (§5).

**While working:**
5. ☐ Every `ref` access in script uses `.value`; every template ref is typed as `Ref<T | null>` unless using `useTemplateRef` (§4.4).
6. ☐ Never destructure a `reactive()` object or a store without `toRefs()`/`storeToRefs()` — the destructured copies are dead snapshots (§2.3, §5.4).
7. ☐ Tailwind class names are always complete literal strings. `bg-${color}-500` compiles to nothing (§7.3).
8. ☐ No TypeScript-only syntax (`as`, `!`, `satisfies`) inside template expressions — precompute in script (§4.2).
9. ☐ Any watcher with an async callback handles the stale-result race via `onCleanup` (§2.6).
10. ☐ Any timer, global listener, or observer created outside `setup()` context is registered for disposal via `onScopeDispose` (§5.2, §9.5).

**Before you return the result:**
11. ☐ `vue-tsc --noEmit` passes with the project's strict tsconfig — template expressions included (§4.1).
12. ☐ No `any` that you introduced; DOM event targets are narrowed, not asserted blindly (§4.6).
13. ☐ No dynamic class fragments in the diff; conditional styling goes through `cn()`/variant maps (§7.1–§7.3).
14. ☐ Scoped styles that `@apply` Tailwind utilities include the `@reference` import, or don't `@apply` at all (§7.5).
15. ☐ `v-html` appears nowhere unless paired with DOMPurify (or an approved sanitizer) — and never with untrusted input (§12.1).
16. ☐ Re-read the component as a whole: does any computed mutate state? Does any watch feed its own source? Both are infinite-loop factories (§2.4, §14.1).

---

## 1. Project Setup & Architecture

### 1.1 Scaffolding & Toolchain Baseline

**MUST** scaffold new projects with the official generator so compiler, lint, and type-check wiring matches the ecosystem's tested defaults:

```bash
pnpm create vue@latest my-app   # select: TypeScript, Router, Pinia, Vitest, ESLint, Prettier
pnpm add tailwindcss @tailwindcss/vite   # Tailwind is not in the generator's prompts — add it explicitly
```

```ts
// vite.config.ts — the three plugins every app in this org ships
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
})
```

```css
/* src/assets/main.css — the single Tailwind entry point; imported once in main.ts */
@import "tailwindcss";
```

**Rules:**
- **MUST** use the `@tailwindcss/vite` plugin (not the PostCSS setup) on Vite projects — it is the reference integration and an order of magnitude faster.
- **MUST NOT** create a `tailwind.config.js` in a v4 project. Configuration lives in CSS (`@theme`, `@source`, `@custom-variant`, `@plugin`) — see §6. A legacy `@config "tailwind.config.js"` bridge exists only for migration (§6.6, Appendix B).
- **SHOULD** run Node 22 LTS (minimum 20.19) and pnpm as the package manager; commit `pnpm-lock.yaml` and install with `--frozen-lockfile` in CI.
- **MAY** adopt `vue-tsc --build` (project-references mode) exactly as generated by `create-vue`; if you simplify, keep a single `typecheck` script that gates CI (§11.3).

### 1.2 Directory & Naming Conventions

One responsibility per directory; naming is load-bearing because KeepAlive matching, auto-imports, and store conventions all read file names (§3.5, §5.4).

```
src/
├── assets/main.css          # Tailwind entry: @theme tokens, @source rules, base layer
├── components/
│   ├── ui/                  # primitives, App-prefixed: AppButton.vue, AppInput.vue
│   └── checkout/            # feature components, PascalCase: CheckoutSummary.vue
├── composables/             # one composable per file, camelCase: useCartTotals.ts
├── directives/              # vFocus.ts — registered centrally in main.ts
├── lib/                     # framework-agnostic glue: cn.ts, ipc.ts, sanitize.ts
├── router/index.ts          # route records + navigation guards
├── stores/                  # Pinia, one domain per file: cart.ts, session.ts
├── types/                   # domain types + InjectionKeys: cart.ts, injection-keys.ts
├── utils/                   # pure functions, zero Vue imports: money.ts, dates.ts
├── views/                   # route-level components: CheckoutView.vue
├── App.vue
└── main.ts                  # app creation, plugin + directive registration
```

**Rules:**
- Components **MUST** be PascalCase files. UI primitives **MUST** carry an `App` prefix so `<AppButton>` vs third-party `<Button>` never collides in templates.
- Composables **MUST** be named `useThing` and export exactly one composable per file.
- `utils/` **MUST** stay Vue-free (pure, trivially testable). Anything touching refs or lifecycle belongs in `composables/`.
- KeepAlive `include`/`exclude` matches the component's **inferred filename-derived name**, so filename casing is not cosmetic — see §3.5 for the trap.

### 1.3 TypeScript Configuration Profile

The generated `tsconfig.app.json` is the floor, not the ceiling. The profile below is the org baseline; deviations require a stated reason.

| Flag | Value | Rationale |
|---|---|---|
| `strict` | `true` | Non-negotiable. Includes `strictNullChecks` — the difference between a caught bug and a 2 a.m. page |
| `noUncheckedIndexedAccess` | `true` | `arr[i]` becomes `T \| undefined`. Index-and-accumulate bugs (totals, lookups) are the most common POS-class defect this catches |
| `verbatimModuleSyntax` | `true` | Forces `import type` discipline; plays correctly with Vite/Rolldown tree-shaking and `isolatedModules` |
| `moduleResolution` | `"bundler"` | Matches how Vite actually resolves specifiers; enables extensionless imports |
| `skipLibCheck` | `true` | Pragmatic: don't type-check the world's `node_modules` `.d.ts` |
| `types` | `["vite/client"]` | Types `import.meta.env`, assets, and HMR APIs |
| `paths` | `@/* → ./src/*` | Kills `../../../` imports; absolute aliases survive refactors |

```json
{
  "scripts": {
    "dev": "vite",
    "build": "pnpm typecheck && vite build",
    "typecheck": "vue-tsc --noEmit -p tsconfig.app.json",
    "lint": "eslint . --fix",
    "test:unit": "vitest run --coverage",
    "format": "prettier --write src/"
  }
}
```

### 1.4 Import Hygiene

- **MUST** import app code through the `@/` alias only. Absolute-from-root specifiers (`/src/...`) work in `vite dev` but break under packaged/`file://` loading — the classic blank-screen-in-Tauri bug (§13.1, §14.5).
- **MUST** separate `import type` from value imports when `verbatimModuleSyntax` is on; the compiler error is the teacher, don't fight it.
- **SHOULD** keep each `.vue` import list ordered: Vue core → third-party → stores/composables → sibling components → assets. Stable order makes review diffs readable and matches the ESLint import plugin baseline.

### 1.5 Environment Variables

Vite exposes only `VITE_`-prefixed variables on `import.meta.env`, **inlined at build time** — they are compile-time constants, not runtime configuration.

```ts
// src/env.d.ts — typed, and the ONLY place import.meta.env is declared
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string
  readonly VITE_ENABLE_ANALYTICS: 'true' | 'false'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

**Rules:**
- **MUST NOT** put secrets in any `VITE_` variable — every character ships to the client bundle (§12.5).
- **MUST NOT** add a blanket `declare module '*.vue'` shim with an `any` default export. It silences real type errors in `.ts` files that import components; `vue-tsc` provides the real types (§4.1).
- **SHOULD** treat env values as strings and validate/coerce them once at startup (a `parseEnv()` in `lib/`), not sprinkle `=== 'true'` comparisons through the codebase.
- Runtime-switchable configuration (feature flags for a packaged desktop app) **MUST** come from a config file or backend, not env vars — the build-time inlining makes post-build switching impossible (§13.3).

---

## 2. Reactivity: Rules, Traps & Escape Hatches

Vue's reactivity is the reason the framework exists, and the source of its most disorienting bugs. The rules below are behavioral contracts — violating any of them compiles fine and fails at runtime.

### 2.1 `ref` vs `reactive` — The Decision Rule

- **SHOULD** default to `ref()` for all state. `reactive()` is reserved for grouped state where wholesale replacement never happens.
- **MUST NOT** reassign a `reactive()` variable (`state = reactive({...})`): every reference captured earlier — watchers, child components, composables — still points at the old proxy and goes permanently stale. If the object's identity must change, hold it in a `ref` and replace `.value`.
- **MUST** remember `reactive()` deep-converts at assignment: `reactive(state).items = bigArray` makes every item a tracked proxy. For large data that is render-only, that conversion is pure overhead — see §2.7.
- **MAY** use `reactive()` for form objects (many fields mutated granularly, never replaced) — that is its best case.

### 2.2 The Unwrapping Rules (and the Array/Map Caveat)

Ref unwrapping follows precise rules; misreading them is a top-five Vue bug generator:

1. `ref`s nested in a `reactive()` object unwrap on property access: `reactive({ count: ref(0) }).count === 0`.
2. **Caveat — verified current behavior:** refs accessed as **elements of a reactive array** or as **values in a reactive `Map`** are **not unwrapped** — `.value` is required. `reactive([ref('x')])[0]` is the ref itself, not `'x'`. Don't fight this; don't nest refs inside reactive arrays/Maps at all.
3. Unwrapping happens in templates (top-level refs only) and in `reactive()` contexts — **never** in plain script code or when the ref is an intermediate property of a non-reactive object.
4. `shallowRef`/`shallowReactive` never unwrap and never deep-track — that is their purpose.

**MUST** treat "ref inside reactive array/Map needs `.value`" as a design smell and restructure (`ref<Item[]>([])` holding plain items) rather than sprinkle `.value` accessors.

### 2.3 Losing Reactivity — Destructure, Spread, Escape

Reactivity is lost by *copying a value out of its reactive container*. Every one of these compiles silently:

```ts
// ❌ Don't: three silent reactivity killers
const { items } = state            // destructuring reactive() — items is a snapshot-in-use trap
const copy = { ...state.obj }      // spread — copy mutations never render
function renderTotal(list) {…}     // passing state.obj.items (plain array value) is fine,
renderTotal(state.items)           // but the callee mutating it mutates source — surprising write paths

// ✅ Do: keep the reactive linkage explicit
const items = toRef(state, 'items')            // writes go back through the link
const { items: itemsRef } = toRefs(state)      // bulk destructuring of reactive groups
const copy = structuredClone(toRaw(state.obj)) // deliberate snapshot, clearly named as one
```

**Vue 3.5 changed one case — know which one:** destructuring **props** is now reactive by default. `const { count = 0 } = defineProps<{ count?: number }>()` compiles back to `props.count` accesses, so it updates on parent changes, and defaults work inline. Two hard limits remain:

- Aliased destructuring (`const { count: c } = props`) is **not** transformed — it silently loses reactivity. Never alias.
- The destructured binding is only reactive *within this component*. Passing `count` (a plain value at that point) to a composable or child prop freezes it. Pass `toRef(() => props.count)` instead.

**SHOULD** still use `toRefs(props)` / `toRef(() => props.x)` at composable boundaries — it works on every 3.x version and makes the reactive link visible in the signature.

### 2.4 `computed` — Rules and the Two Classic Traps

- **MUST NOT** mutate reactive state inside a computed. Side effects break caching semantics, trigger dev warnings, and are the #1 cause of "Maximum recursive updates exceeded".
- **MUST** treat computed results as **read-only**. `computed(() => state.obj)` returns the live reactive object — writing `result.nested = 5` mutates the source through a path that reads like a read. If a computed result must be writable, that is a writable computed (`get`/`set`), written as one.
- **MUST** know what a computed tracks: only reactive values read during evaluation. `Date.now()`, `Math.random()`, module-level mutable variables, and external store snapshots never invalidate it.

```ts
// ❌ Don't: two traps in eight lines
const total = computed(() => {
  state.count++                            // side effect — loop factory
  return state.price * Date.now()          // Date.now() never re-tracks: frozen forever
})

// ✅ Do: pure derivation of reactive inputs
const total = computed(() => state.price * state.quantity)

// ✅ Do: writable computed when v-model targets derived state
const fullName = computed({
  get: () => `${first.value} ${last.value}`.trim(),
  set: (v) => { [first.value, last.value] = v.split(' ') },
})
```

**SHOULD** place expensive derivations (`filter`/`sort` of large lists) in computed, never in methods called from the template — a method re-runs on every render of the component; a computed runs once per dependency change.

### 2.5 `watch` — Source Matrix, Depth, and Flush Timing

The most common "my watcher didn't fire / fired for everything" bugs reduce to this table. Internalize it:

| Source form | Fires on | Does NOT fire on |
|---|---|---|
| `watch(refOfObject, cb)` | `.value` **reassignment** | nested mutation (add `{ deep: true }`) |
| `watch(reactiveObj, cb)` | **any** nested change (implicitly deep) | — (this is the over-firing footgun) |
| `watch(() => state.count, cb)` | `count` changing | anything else — correct granularity |
| `watch(() => state.obj, cb)` | `state.obj` **identity replacement** | nested mutation of `obj` (add `deep: true`) |
| `watch(() => list.value.filter(f), cb)` | any change re-running the getter | nothing — fresh array each pass, fires on all underlying changes |
| `watch([a, b], cb)` | either source, batched | — |

```ts
// ❌ Don't: fires on EVERY nested keystroke of a huge form object
watch(reactiveForm, saveDraft)                    // implicitly deep over 40 fields

// ✅ Do: watch exactly what matters
watch(() => draft.value.id, reload)               // precise primitive
watch(() => settings.value.theme, applyTheme)     // identity of a replaced branch
watch(deepConfig, sync, { deep: true })           // deep only where genuinely needed
```

- **SHOULD** prefer precise getters over `{ deep: true }` on large structures — deep traversal re-reads (and re-tracks) every property on every trigger.
- **MUST** use `flush: 'post'` when the callback reads the DOM (measurements, focus management). The default `pre` flush runs **before** the component re-renders — reading the DOM there sees the *old* tree, another classic silent bug.
- **MUST NOT** use `flush: 'sync'` casually; it fires per mutation, defeating batching and enabling accidental infinite loops.
- `watchEffect` tracks only what its callback reads **synchronously** — dependency tracking stops at the first `await`. Dependencies read after an `await` are invisible. Split async logic into an explicit `watch` when this matters.

### 2.6 Async Watchers — The Stale-Result Race

Any watcher that kicks off async work and then writes results back has a race unless the previous run is cancelled. This is the search-as-you-type / load-record-by-id bug:

```ts
// ❌ Don't: slow response #1 lands after fast response #2 — UI shows the wrong data
watch(query, async (q) => {
  const results = await api.search(q)
  results.value = results          // stale write, unguarded
})

// ✅ Do: cancel-on-next-run via onCleanup (also exported as onWatcherCleanup in 3.5)
watch(query, async (q, _, onCleanup) => {
  const ac = new AbortController()
  onCleanup(() => ac.abort())              // runs before the next invocation
  results.value = await api.search(q, { signal: ac.signal })
})
```

**MUST** add `onCleanup` to every async watcher; **MUST** propagate `AbortSignal` to the fetch layer so cancellation is real, not cosmetic.

### 2.7 Shallow Reactivity, `markRaw`, and Escape Hatches

- **SHOULD** hold large render-only datasets in `shallowRef` and replace wholesale: `rows.value = newRows`. Deep-tracking 10,000 proxies costs; replacing identity costs nothing.
- **MUST** call `triggerRef(shallowRef)` after in-place mutation of a shallow ref's value — nothing else will schedule a re-render.
- **MUST** wrap non-plain-object instances you store in reactive state with `markRaw` — class instances from three.js, map/chart libraries, WebSocket clients, router views. Otherwise Vue deep-proxies them (breaks identity-sensitive libs) and logs "Vue received a reactive object which was made reactive" style warnings. `markRaw` at creation, not at assignment time.
- **MAY** use `customRef` for debounced inputs (§8.4) and `effectScope` for grouped disposal (§5.2).

### 2.8 Batching and `nextTick`

Vue batches: N synchronous mutations in one tick produce one re-render. Consequences:

- **MUST NOT** interleave `await nextTick()` between mutations "to be safe" — it fragments batching into N renders, the opposite of the intent.
- **MUST** `await nextTick()` before asserting on the DOM (tests, §10) — updates are scheduled, not synchronous.
- **MAY** rely on mutation coalescing for animation-free state churn; it is the framework's default and a genuine performance feature.

---

## 3. Components, Templates & Events

### 3.1 Macro Discipline — `defineProps`, `defineEmits`, `defineSlots`, `defineOptions`

- **MUST** use the type-only forms; the runtime `props: {...}` object form is legacy for non-setup components only.
- **MUST** use the named-tuple `defineEmits` syntax (Vue 3.3+): `defineEmits<{ select: [item: Item]; change: [id: number] }>()`. The call-signature form still works but reads worse and misorders in review.
- **SHOULD** type slots when they take props: `defineSlots<{ item(props: { row: Row }): any }>()`.
- **MUST** give explicit names to components that interact with `KeepAlive` or devtools traces: `defineOptions({ name: 'CheckoutView' })` (§3.5).
- Props can import shared types since 3.3 — **SHOULD** import the canonical domain type rather than redeclaring a drift-prone local copy.
- **MUST NOT** declare `modelValue` in `defineProps`/`defineEmits` manually when using `defineModel` — the macro declares both.

### 3.2 `v-model` and `defineModel`

```vue
<script setup lang="ts">
// primary model with a default
const title = defineModel<string>({ default: '' })

// named model (parent: v-model:quantity="qty") with modifier-aware transform
const [quantity, quantityModifiers] = defineModel<number>('quantity', {
  get: (v) => v ?? 0,
  set: (v) => (quantityModifiers.number ? Math.round(Number(v)) : (v ?? 0)),
})
</script>
```

- **MUST** use `defineModel` for two-way bindings on custom components — manual `modelValue` prop + `update:modelValue` emit is the pre-3.4 pattern and double the code.
- **MUST** handle the awkward value types the compiler won't fix for you: `.number` on an empty input yields `''`, not a number — normalize in the `set` transform or a watcher, never in the template.
- **MUST** emit kebab-cased named models' parent-side usage as `v-model:quantity`; custom component event names **SHOULD** stay camelCase internally (`update:modelValue`) — templates accept kebab listeners, and mixing conventions in one codebase is how `update:model-value` vs `update:modelValue` bugs are born.
- **MAY** keep multiple `v-model`s per component, but more than two usually means the component wants a single options object + change event instead.

### 3.3 Attribute Fallthrough — The "My Classes Disappeared" Bug

In Vue 3, `$attrs` contains `class`, `style`, and **all listeners** (there is no `$listeners` anymore). Single-root components merge them onto the root automatically; multi-root components drop them with a warning.

```vue
<!-- ❌ Don't: multi-root component — class="mt-4" and @click from the parent vanish -->
<template>
  <header class="card-header">{{ title }}</header>
  <div class="card-body"><slot /></div>
</template>

<!-- ✅ Do: designate exactly one receiver with inheritAttrs -->
<script setup lang="ts">
defineOptions({ inheritAttrs: false })  // we forward, not merge
</script>
<template>
  <header class="card-header">{{ title }}</header>
  <div class="card-body" v-bind="$attrs"><slot /></div>
</template>
```

- **MUST** set `inheritAttrs: false` + explicit `v-bind="$attrs"` when the intended receiver is not the root (wrapping inputs, button components with an inner element).
- **MUST** check fallthrough when a component root already binds `class` — Vue merges parent and child classes on single roots; that merge is what makes `<AppButton class="w-full">` work for free (§7.4).
- **SHOULD** treat "listener lands on root unexpectedly" as a design signal: if the component should not be clickable, declare `defineEmits` for the events it owns — declared emits stop falling through.

### 3.4 Keys, `v-for`/`v-if`, and Child Refs

- **MUST** key `v-for` by a stable business identifier. Index keys with `unshift`/`splice`/`sort` produce wrong-row patches: input state, focus, and transitions attach to the wrong items. If a list has no natural id, generate one at load and keep it for the session.
- **MUST NOT** put `v-if` and `v-for` on the same element. Vue 3 evaluates `v-if` **before** `v-for` (the precedence flipped from Vue 2) — the condition cannot see the iteration variable, and the lint error is protecting you. Compute the filtered list in a `computed`.
- **MUST** place `v-for` keys on the `<template>` element itself when wrapping multiple children (Vue 2 put them on children — migrated code silently breaks).
- **SHOULD** reach for `v-memo="[row.id, row.selected]"` on expensive rows and `v-once` for truly static subtrees; both trade staleness for speed and deserve a comment saying what was sacrificed.
- **MUST** use `defineExpose` to open a deliberate API to parent template refs — `<script setup>` components are closed by default, and `InstanceType<typeof Child>` types only what you expose (§4.4).

### 3.5 Dynamic Components and `KeepAlive` Name Matching

- `<component :is="comp">` with an **imported component object** is the default pattern; string names only resolve globally registered components.
- **MUST** give `KeepAlive`-managed components an explicit `defineOptions({ name })`. The fallback name is **derived from the SFC filename, case-sensitively** — `checkout-view.vue` and `CheckoutView.vue` produce different names, and `include: ['CheckoutView']` silently excludes the wrong one. This is the single most common KeepAlive "it doesn't cache" report.
- **MUST** `watch(() => route.params.id, …)` (or use `onBeforeRouteUpdate`) when the same route component serves different ids — param-only navigation reuses the component instance and **does not re-run setup**.
- **MUST** set `:max` on `KeepAlive` caches of unbounded route components — LRU eviction beats a slow memory leak.
- `defineAsyncComponent` **SHOULD** be the lazy-loading default (loading/error/delay states inline); `Suspense` is for genuinely coordinated async subtrees (§3.7).

### 3.6 `<Transition>` / `<TransitionGroup>` Traps

- **MUST** give swap targets distinct `key`s: transitioning between the same tag without different keys patches in place and **no transition runs**.
- **MUST** use `mode="out-in"` when entering/leaving elements would overlap or fight for layout.
- **MUST** add the move class on `TransitionGroup` children (`name="list"` → style `list-move`) — reorders without it teleport instead of animating.
- Transition classes are applied to the child's **root** element; nested-element effects need descendant selectors, and under `<style scoped>` that means `:deep()` (§7.4).
- **SHOULD** prefer CSS-driven transitions with utility classes and keep JS hooks (`@before-leave` + `done()`) for FLIP-style or measurement-driven work — forgetting `done()` hangs the transition forever.

```vue
<!-- ✅ Do: utility-class transitions — Tailwind does the CSS, Vue does the timing -->
<Transition
  enter-active-class="transition duration-150 ease-out"
  enter-from-class="opacity-0 translate-y-1"
  enter-to-class="opacity-100 translate-y-0"
  leave-active-class="transition duration-100 ease-in"
  leave-from-class="opacity-100"
  leave-to-class="opacity-0"
>
  <UserMenu v-if="open" />
</Transition>
```

### 3.7 Teleport and Suspense

- **MUST** verify the `to` target exists before mount with `Teleport` — a selector matching nothing throws. Vue 3.5's `defer` attribute waits for the app to render first; prefer it over `nextTick` hacks for app-mounted overlays.
- **MUST** guard teleported overlays for stacking contexts: a parent `transform`/`filter` creates a containing block that defeats `position: fixed` children — teleports to `body` escape it, in-place overlays do not.
- `Suspense` requires an async `setup()` (any top-level `await` in `<script setup>`); lifecycle timing inside suspended components differs from normal components, and combining Suspense + KeepAlive + router views is a documented edge zone. **SHOULD** limit Suspense to deliberate, tested uses; default to `defineAsyncComponent` + skeleton UI.
- **MUST** handle errors from suspended async setup with `onErrorCaptured` / `app.config.errorHandler` — they do not surface as unhandled promise rejections where you expect them (§12.5 in the parent doc).

### 3.8 `provide` / `inject` — Typed Keys, One-Way by Contract

```ts
// types/injection-keys.ts — the only place these live
import type { InjectionKey, Ref } from 'vue'
import type { CartApi } from '@/types/cart'
export const CartKey: InjectionKey<CartApi> = Symbol('cart')
```

```ts
// provider — readonly enforces one-way flow with dev warnings on child writes
provide(CartKey, readonly(cartApi))

// consumer — undefined is part of the type; handle it
const cart = inject(CartKey)            // CartApi | undefined
const cart = inject(CartKey, noopCart)  // or provide a default
```

- **MUST** use `Symbol` values typed as `InjectionKey<T>` — string keys collide across features and carry no type information.
- **MUST** handle `undefined` from `inject` (the type says so; the runtime enforces it) or pass a default.
- **SHOULD** provide `readonly(...)` state so children that try to mutate get a dev warning instead of silent two-way coupling.
- **MUST** call `provide`/`inject` synchronously in setup — conditional or delayed injection does not exist, and trying it is the "injection can only be used inside setup" error.

### 3.9 Vue 2 → Vue 3 Removed API Table

Migrated codebases keep resurrecting these. All are gone in Vue 3:

| Vue 2 pattern | Vue 3 replacement | Section |
|---|---|---|
| `$listeners` | merged into `$attrs` (listeners are attributes) | §3.3 |
| `@event.native` | declared `defineEmits`; undeclared events fall through | §3.1 |
| `{{ price \| money }}` filters | computed or method `{{ money(price) }}` | — |
| `$on` / `$off` / `$once` event bus | `mitt` for legacy shapes; prefer provide/inject + callbacks | §3.8 |
| `Vue.set` / `Vue.delete` | direct assignment / `delete` — proxies track both | §2 |
| `$children` | template ref + `defineExpose` | §3.4 |
| `:prop.sync` | `v-model:prop` / `defineModel('prop')` | §3.2 |
| `functional: true` components | plain functions (rarely justified) | — |

---

## 4. TypeScript Hard Parts

Vue + TypeScript works excellently — through a specific pipeline and with specific limits. The rules below are where the illusion breaks and the real error messages start.

### 4.1 The Type-Checking Pipeline

- **MUST** type-check with `vue-tsc --noEmit`, never plain `tsc` — only vue-tsc understands `.vue` SFCs **and type-checks template expressions**. Plain `tsc` on a Vue project produces false confidence.
- **SHOULD** enable strict template checking in `tsconfig.json`:

```json
{
  "vueCompilerOptions": {
    "strictTemplates": true
  }
}
```

This promotes template expression/type mismatches (wrong prop types, untyped `$event`, bad slot props) from silent to compile errors. Expect a one-time cleanup pass when enabling it on a legacy codebase; the steady-state noise is near zero and the bugs it catches are real.
- **MUST** gate CI on the typecheck script (§11.3) — editors catch most of this, but editors lie about which files are open and which are stale.

### 4.2 Template Expressions Are Not TypeScript

Template expressions are type-checked, but **TypeScript-only syntax is not available inside them**. No `as` casts, no `!` non-null assertions, no `satisfies`, no generic instantiation:

```vue
<script setup lang="ts">
import type { LineItem } from '@/types/cart'
const props = defineProps<{ lines: LineItem[] }>()

// ✅ Do: precompute in script — type narrowing happens here
const taxable = computed(() => props.lines.filter((l) => !l.exempt))
const taxBase = computed(() => taxable.value.reduce((s, l) => s + l.price * l.qty, 0))

function onQtyInput(e: InputEvent) {
  const target = e.target as HTMLInputElement   // casts live in script, not templates
  const parsed = Number(target.value)
  if (Number.isFinite(parsed)) qty.value = parsed
}
</script>

<template>
  <!-- ❌ Don't: TS syntax in templates — compile error or silently untyped -->
  <!-- {{ (lines[0] as LineItem).price }}  ·  {{ lines[0]!.price }} -->

  <!-- ✅ Do: expression-only -->
  <span v-if="taxBase > 0">{{ taxBase }}</span>
  <input @input="onQtyInput">
</template>
```

**MUST** move any narrowing/casting into `computed`/methods in `<script setup>`; the template stays a thin, type-clean view. This single rule eliminates the majority of "how do I cast in the template" workarounds people invent.

### 4.3 The `UnwrapRef` Wart — Interfaces vs Type Aliases

`ref()` and `reactive()` return `UnwrapRef<T>`-derived types — conditional types that deep-unwrap nested refs. Their structural matching has a documented quirk: **structurally identical `interface` and `type` declarations do not behave the same** — an open `interface` can fail the conditional match that a closed `type` alias passes, producing "Type 'X' is not assignable to `UnwrapRef<...>`" errors (or silently lost types) in generic code.

Practical rules that make the wart vanish:

- **SHOULD** declare reactive state shapes as `type` aliases or inline literals, not `interface`, when they feed `ref()`/`reactive()`/composables.
- **MUST NOT** nest `Ref<...>` fields inside state interfaces — unwrap the shape at the boundary instead (`ref<CartState>` where `CartState` contains plain values).
- **SHOULD** reach for `shallowRef<HeavyShape>()` for reference-heavy structures — `ShallowRef<T>` skips deep unwrapping entirely, sidestepping the conditional-type maze.

### 4.4 Template Refs and Component Instance Types

```ts
import { useTemplateRef } from 'vue'

// Vue 3.5+ — the preferred form; typed by generic, null handled internally
const inputEl = useTemplateRef<HTMLInputElement>('qty-input')

// The universal fallback (works on every 3.x) — the union includes null, always
const listEl = ref<HTMLUListElement | null>(null)

// Component refs: type from the component definition, see only what's exposed
import CheckoutPanel from '@/components/checkout/CheckoutPanel.vue'
const panel = useTemplateRef<InstanceType<typeof CheckoutPanel>>('panel')
```

- **MUST** type template refs with `| null` (or use `useTemplateRef`) — refs are null until mount, and `ref<HTMLInputElement>(null)` lying about it turns every `.value` access into a runtime roulette.
- **MUST** guard with `if (!el.value) return` in `onMounted`/callbacks instead of `!` assertions — the assertion pushes the failure to a less diagnosable place.
- `InstanceType<typeof Child>` respects `defineExpose`: whatever the child didn't expose isn't in the type — which is the point (§3.4).

### 4.5 Generic Components

```vue
<script setup lang="ts" generic="T extends { id: string }">
const props = defineProps<{ items: T[]; selected?: T }>()
const emit = defineEmits<{ select: [item: T] }>()
</script>
```

- **MUST** use the `generic` attribute on `<script setup>` (Vue 3.3+) for reusable typed lists/selects/tables — consumers get full inference instead of `any`/casts at every call site.
- **SHOULD** constrain generics (`T extends { id: string }`) — unconstrained `generic="T"` reintroduces `any` through the back door.
- **MUST NOT** attempt generic type arguments at call sites in templates (`<DataTable<LineItem>>` is not valid template syntax) — inference from props is the only channel; design prop types so inference is unambiguous.

### 4.6 DOM Event and Element Typing

- `event.target` is `EventTarget | null` — **MUST** narrow to the concrete element (`e.target instanceof HTMLInputElement`) or cast once inside a script handler, never inline in the template.
- Inline handlers get `$event` inferred from the element — with `strictTemplates`, a handler expecting `MouseEvent` bound to `@input` is a compile error. Prefer named script handlers over long inline arrows; they carry the types in one place.
- **SHOULD** read value via `e.currentTarget` when it's the bound element (typed tighter than `target`, and stable during bubbling).

### 4.7 Type Discipline Rules

- `import type` for types-only imports is **mandatory** under `verbatimModuleSyntax`; it also documents whether a module participates in the runtime graph.
- Under `noUncheckedIndexedAccess`, `arr[i]` and `record[key]` yield `T | undefined` — **MUST** handle it (guard, `??`, or `Map.get`) rather than cast it away. For hot keyed lookups **SHOULD** prefer `Map<K, V>` over `Record<K, V>`.
- **SHOULD** model enumerations as `as const` objects, not `enum`: tree-shakeable, no runtime surprises, compatible with `erasableSyntaxOnly`-style strictness, and inferable as literal unions:

```ts
export const OrderStatus = { Draft: 'draft', Paid: 'paid', Refunded: 'refunded' } as const
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus]
```

### 4.8 Error Message → Fix Table

| Error | Actual cause | Fix |
|---|---|---|
| `Cannot use namespace 'Vue' as a type` / `any` `.vue` imports | a `declare module '*.vue'` shim with `any` | delete the shim; rely on vue-tsc (§1.5) |
| `'$event' implicitly has an 'any' type` | inline handler + `strictTemplates` | named typed handler in script (§4.6) |
| `Type 'Ref<X>' is missing X properties` | ref used where value expected | `.value`, or pass the ref intentionally (§2.2) |
| `Type 'X' is not assignable to 'UnwrapRef<…>'` | interface vs alias unwrap quirk | `type` alias / `shallowRef` (§4.3) |
| `defineProps cannot reference locally declared types` (pre-3.3 wording) | old Vue / local non-exported type | upgrade ≥ 3.3; import from `@/types` |
| `'defineProps' is not defined` in a `.ts` file | compiler macros are SFC-only | move code into `.vue`; never import or declare macros |
| `Property 'x' does not exist on type …` after `v-if="obj"` guard in template | narrowing across bindings | precompute branch in script (§4.2) |

---

## 5. Composables & State Management

### 5.1 The Composable Contract

Every `use*` function in `composables/` signs the same contract; reviewers enforce it.

```ts
import { ref, toValue, watch, onScopeDispose, type MaybeRefOrGetter } from 'vue'
import type { Ref } from 'vue'

// ✅ Do: the reference shape of a composable
export function useSearch(filter: MaybeRefOrGetter<string>) {
  const results = ref<string[]>([])
  const isSearching = ref(false)

  // toValue() normalizes ref | getter | plain value — the 3.5 way to accept args
  watch(
    () => toValue(filter).trim(),
    async (q, _, onCleanup) => {
      const ac = new AbortController()
      onCleanup(() => ac.abort())                       // §2.6 race guard
      isSearching.value = true
      try { results.value = await api.search(q, { signal: ac.signal }) }
      finally { isSearching.value = false }
    },
  )

  onScopeDispose(() => console.debug('[useSearch] disposed'))  // cleanup hook point
  return { results, isSearching }                        // refs out; functions optional
}
```

- **MUST** name it `useThing`, accept `MaybeRefOrGetter<T>` for reactive inputs, and normalize with `toValue()` — callers can pass literals, refs, or getters interchangeably.
- **MUST** return an object of **refs and plain functions** (plus any readonly refs). Destructuring a returned plain object of refs is safe — each ref carries its own reactivity (this is the case people wrongly fear after reading §2.3, which is about destructuring `reactive()`/props, not refs).
- **MUST** document in the JSDoc whether it registers lifecycle (requires setup context) or is context-free.
- **MUST** guard browser-only APIs: `if (import.meta.env.SSR) return …` / `typeof window === 'undefined'` early-outs in composables destined for SSR-capable apps.
- **SHOULD** check VueUse (v14+, current line) before hand-rolling: `useLocalStorage`, `useEventListener`, `useDebounceFn`, `useMediaQuery`, `useVirtualList` are solved problems with battle-tested edge cases (IME, visibility, storage events) you will otherwise rediscover one bug at a time.

### 5.2 Scope, Cleanup, and the "Called Outside Setup" Rule

- Lifecycle hooks (`onMounted`, `onUnmounted`, …) and auto-disposing watchers **only work when the composable is called synchronously inside `setup()`**. Called from an event handler or after `await`, Vue logs "onMounted is called when there is no active component instance" and the hook **never fires** — the cleanup you thought you had does not exist, which is a leak, not a warning.
- **MUST NOT** conditionally invoke composables (`if (isAdmin) usePermissions()`) — same failure class, and it breaks the compiler's static reasoning about the setup call graph.
- **MUST** use `onScopeDispose()` for resource cleanup (listeners, observers, timers) in composables — it fires for both component scope and manual `effectScope` usage.
- **MUST** use `effectScope()` when a composable must be startable/stoppable outside a component (event handlers, Web Workers, tests): watchers created inside the scope stop with it; watchers created outside any scope **never stop** — the canonical slow leak in long-lived single-page views.
- Watchers registered inside `setup()` are auto-disposed with the component; this is the only disposal you get for free.

### 5.3 Composable vs Store — Decision Table

| Situation | Use |
|---|---|
| State belongs to one component subtree | local state / `provide`+`inject` |
| Reusable behavior, stateless or per-call state | composable |
| Shared reactive state across routes/components, inspected in devtools, resettable | Pinia store |
| State that must survive route changes without KeepAlive | Pinia store |
| Pure calculation over inputs | `utils/` function (zero Vue imports) |

**MUST NOT** invent a third mechanism (module-scope reactive singletons, event-bus stores, `window.__state`) — every state path in the app should be classifiable into exactly one row above.

### 5.4 Pinia — Setup Stores and the Destructuring Trap

```ts
// stores/cart.ts — setup-store form: full TS inference, composable ergonomics
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { LineItem, Product } from '@/types/cart'

export const useCartStore = defineStore('cart', () => {
  const items = ref<LineItem[]>([])
  const count = computed(() => items.value.length)
  const total = computed(() => items.value.reduce((s, l) => s + l.price * l.qty, 0))

  function add(product: Product, qty = 1) {
    const existing = items.value.find((l) => l.sku === product.sku)
    if (existing) existing.qty += qty
    else items.value.push({ sku: product.sku, price: product.price, qty })
  }
  function clear() { items.value = [] }
  return { items, count, total, add, clear }
})
```

```ts
// ❌ Don't: raw destructuring — count/total become frozen snapshots (§2.3 for props, same physics)
const { items, count, total } = useCartStore()

// ✅ Do: storeToRefs for state & computeds; actions/methods destructure raw
const cart = useCartStore()
const { items, count, total } = storeToRefs(cart)
const { add, clear } = cart
```

- **MUST** use `storeToRefs()` when destructuring state/getters; methods are plain functions and destructure directly. Mixing this up is the single most common Pinia bug — the store *works*, it just never updates the UI again.
- **SHOULD** prefer setup stores over option stores: TypeScript inference is total, code is composable, and there's no `this` typing subtlety.
- **MUST** keep store ids globally unique (`'cart'`, not `'store'`) — duplicate ids silently alias two stores onto one state slot.
- **SHOULD** batch cross-field mutations through `$patch(objOrFn)` — one subscription notification, one devtools entry.
- `$reset()` is not available on setup stores by default — **MUST** implement an explicit `reset()` action instead of reaching for internals.
- **MUST** call `useOtherStore()` inside actions, not at a store's top level, when two stores reference each other (circular instantiation is the failure mode).
- `$subscribe` for persistence hooks; `$onAction` for audit logging — both cheaper than deep-watching `$state` (§2.5).

### 5.5 Persistence, HMR, and SSR Notes

- **SHOULD** persist only what genuinely needs surviving reloads (UI prefs, draft carts) via `pinia-plugin-persistedstate`; sensitive material (tokens, keys) **MUST** go to platform credential storage — in the desktop app that's the OS keychain path defined in `TAURI_V2_POS_STANDARDS.md` §7, never `localStorage`.
- **MUST** follow the Pinia HMR snippet (`import.meta.hot.accept`) in every store file in dev — without it, store edits hot-reload into a Frankenstein of old and new state.
- For SSR (if this codebase ever ships Nuxt-side): stores are module singletons — create the Pinia instance per request and pass it through `app.use(pinia)`; never write request-derived data into store state during module evaluation.

---

## 6. Tailwind CSS v4 Architecture

Tailwind v4 (current line: 4.3.x) is a ground-up rework: configuration moved from JS to CSS, the engine was rewritten in Rust, and a dozen utility names changed. A v3 mental model on a v4 codebase produces *silently missing styles*, which is the failure mode this section exists to prevent.

### 6.1 The CSS-First Entry Point

There is exactly one stylesheet that knows about Tailwind:

```css
/* src/assets/main.css — the single source of styling truth */
@import "tailwindcss";          /* pulls in theme, base, utilities layers */

@plugin "@tailwindcss/forms";   /* JS plugins register via @plugin, not config */

@custom-variant dark (&:where(.dark, .dark *));   /* class-based dark mode (§6.5) */

@theme {                        /* design tokens — every token generates utilities */
  --color-brand-50: oklch(0.97 0.02 264);
  --color-brand-500: oklch(0.55 0.18 264);
  --color-brand-600: oklch(0.48 0.18 264);
  --color-brand-700: oklch(0.41 0.17 264);

  --font-display: "Inter Variable", ui-sans-serif, system-ui, sans-serif;

  --radius-card: 0.875rem;      /* → rounded-card */
  --breakpoint-3xl: 120rem;     /* → 3xl: variants */
}

@layer base {
  :root { color-scheme: light dark; }        /* native controls + scrollbars follow theme */
  body { @apply bg-surface text-ink antialiased; }
}
```

- **MUST** import this file once, in `main.ts`. Any other `.css`/`<style>` block that needs Tailwind context uses `@reference` (§7.5), not a second `@import "tailwindcss"`.
- **MUST** understand the layer stack emitted by that import: `@layer theme, base, components, utilities`. Utilities live *inside* a cascade layer — which flips the specificity intuition Vue developers had from v3 (§7.4).
- **SHOULD** declare brand palettes in `oklch` (v4's native space): opacity shorthand (`bg-brand-600/80`) resolves through `color-mix()`, which behaves predictably in oklch and muddy in hand-picked hex.
- **Browser floor (SHOULD document, not fight):** v4 relies on `@property`, `color-mix()`, and cascade layers — Safari 16.4+, Chrome 111+, Firefox 128+. Below that, utilities silently degrade. Check analytics before promising older support; do not hack around the floor.
- Dynamic scale spacing: v4 derives every spacing multiple from `--spacing` (default `0.25rem`) — `mt-17` and `w-29` are valid without touching any scale. **MUST NOT** pad theme files with redundant spacing/size entries "so the class exists".

### 6.2 Semantic Tokens — Themes Without `dark:` Spam

Utilities reference CSS variables, not resolved values — so overriding a theme variable under a scope switches every utility that uses it. That is the mechanism for themeable semantic tokens:

```css
@theme {
  /* semantic aliases — utilities generated: bg-surface, text-ink, border-hairline */
  --color-surface: var(--color-white);
  --color-ink: var(--color-zinc-900);
  --color-hairline: var(--color-zinc-200);
}

@layer base {
  .dark {
    --color-surface: var(--color-zinc-950);
    --color-ink: var(--color-zinc-100);
    --color-hairline: var(--color-zinc-800);
  }
}
```

- **SHOULD** build the palette as `brand-*` (raw) + semantic aliases (`surface`, `ink`, `hairline`, `muted`, `danger`). Components consume semantics; only `@theme` and `.dark` know raw colors.
- This pattern replaces hundreds of `dark:` variants with one variable flip, and gives runtime theming (flip a class, change `--color-*` on `:root`) without a rebuild.

### 6.3 Source Detection and `@source` Directives

v4 auto-detects content: it scans every file in the project that is not `.gitignore`d (excluding binaries, CSS, and `node_modules`). The failure modes are all boundary cases:

- Classes that exist **only in gitignored files** (generated code, vendored snippets) are never generated. Fix: `@source "../generated/ui"`.
- Classes shipped by a **node_modules package** (a private component library styled with Tailwind classes) are not scanned. Fix: `@source "../node_modules/@acme/ui"`.
- The safelist case — a complete class name that only ever appears assembled at runtime (e.g. toggling `hidden` from JS where the literal string lives in a variable): `@source inline("hidden")`.
- Exclusions (v4.1+): `@source not inline("debug-only-*")` or `@source not "fixtures/"`.
- **MUST** remember what detection can never do: extract `bg-${tone}-500` fragments. The scanner matches candidate *tokens*; template-assembled class names are invisible to it forever (§7.3).

### 6.4 v3 → v4 Breaking Changes That Bite Silently

The upgrade tool handles most renames mechanically; these are the ones that instead produce *quietly different visuals*:

| v3 habit | v4 reality | Symptom if missed |
|---|---|---|
| `shadow` | `shadow-sm` (whole scale shifted: `shadow-sm`→`shadow-xs`) | shadows subtly smaller |
| `rounded` | `rounded-sm` (`rounded-sm`→`rounded-xs`) | radii subtly tighter |
| `blur` / `blur-sm` | `blur-sm` / `blur-xs` | softer/harder blurs |
| `outline-none` | `outline-hidden` (new `outline-none` = `outline-style: none`) | focus rings appear (or vanish) unexpectedly |
| `ring` (3px default) | `ring-3` (default is now 1px) | hairline rings where bold rings were designed |
| `bg-red-500 bg-opacity-50` | `bg-red-500/50` (opacity utilities removed) | opacity silently ignored |
| `!font-bold` (important prefix) | `font-bold!` (suffix) | override never applies |
| default border color `gray-200` | `currentColor` | borders change color with text color |
| `darkMode: 'class'` in config | `@custom-variant dark (&:where(.dark, .dark *))` | dark mode follows OS, not the toggle |
| `content: [...]` in config | automatic + `@source` overrides | (usually fewer problems, not more) |

**MUST** run the official upgrade tool (`npx @tailwindcss/upgrade`) rather than hand-migrating; **MUST** then eyeball surfaces for the table above — the tool rewrites names, but a design built on the old *values* still shifts by one scale step.

### 6.5 Dark Mode Strategy

- **SHOULD** use the class strategy (`@custom-variant dark (&:where(.dark, .dark *))`) plus a persisted toggle, not `prefers-color-scheme` alone — users override their OS for a reason, and a POS UI switching themes mid-shift at sunset is a support ticket.
- **SHOULD** pair it with semantic tokens (§6.2): the `dark:` variant is for genuine structural changes (shadows that invert, glows), not for re-declaring every surface color.
- **MUST** keep the `.dark` class on `<html>` (or the app root for the Tauri webview) and set `color-scheme: light dark` in the base layer so native inputs, scrollbars, and `<select>` popups follow.
- `prefers-reduced-motion` respects **SHOULD** wrap any transition-heavy interactions with `motion-safe:`/`motion-reduce:` variants — accessibility with two tokens, not a media query per component.

### 6.6 `@plugin` and `@config` Directives

- JS plugins (`@tailwindcss/forms`, `@tailwindcss/typography`) load via `@plugin "@tailwindcss/forms";` inside the CSS entry — with options where needed (`@plugin "@tailwindcss/forms" { strategy: class; }`).
- `@config "tailwind.config.js"` exists to load a *legacy* v3 config during migration. **MUST NOT** start new features on the bridge: a config file plus CSS tokens drifts apart silently, and the bridge is a migration-only path. Migrate, then delete.

---

## 7. Styling Patterns & Edge Cases

### 7.1 The `cn()` Helper — One Class-Composition Entry Point

```ts
// lib/cn.ts — the only sanctioned way to compose classes
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(...inputs))
}
```

- **MUST** route all conditional/dynamic class composition through `cn()`. `clsx` handles conditional joining; `tailwind-merge` resolves conflicts (`'px-2 p-4'` → `'p-4'`) so later intents win predictably.
- **MUST NOT** concatenate class strings with template literals + ternaries — no conflict resolution, unreadable diffs, and the exact pattern that leads into the §7.3 dynamic-class trap.
- Vue's automatic parent-class merge (§3.3) **concatenates without resolving conflicts**: a component root with `p-2` and a parent passing `p-4` yields both classes, and the winner is decided by stylesheet order — a coin flip. For primitives designed to accept size overrides, take `class` explicitly (`useAttrs()` or a declared prop with `inheritAttrs: false`) and merge through `cn()`.

### 7.2 Component Variants — `cva` Recipes

```ts
// components/ui/button.styles.ts
import { cva, type VariantProps } from 'class-variance-authority'

export const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-md font-medium transition
   focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500
   disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      intent: {
        primary: 'bg-brand-600 text-white hover:bg-brand-500',
        outline: 'border border-hairline bg-surface text-ink hover:bg-brand-50',
        danger: 'bg-red-600 text-white hover:bg-red-500',
      },
      size: { sm: 'h-8 px-3 text-sm', md: 'h-10 px-4', lg: 'h-12 px-6 text-lg' },
    },
    defaultVariants: { intent: 'primary', size: 'md' },
  },
)

export type ButtonVariant = VariantProps<typeof button>   // typed for consumers
```

```vue
<!-- AppButton.vue — every class is a complete literal; conflicts merge through cn() -->
<script setup lang="ts">
import { button, type ButtonVariant } from './button.styles'
const props = defineProps<{ variant?: ButtonVariant; disabled?: boolean }>()
</script>
<template>
  <button :disabled="disabled" :class="cn(button({ ...props.variant }))">
    <slot />
  </button>
</template>
```

- **SHOULD** use `cva` (or `tailwind-variants`) for any component with ≥2 orthogonal variant axes; it keeps classes static, typed, and tree-shakeable, and `VariantProps` gives consumers autocomplete instead of `string`.
- **MUST** keep variant class values complete literals — the recipe is data, not string assembly.

### 7.3 The Dynamic Class Problem — Tailwind's Law

The Tailwind compiler can only generate utilities for class names it can *see as complete tokens* in source. This is architectural, not a limitation to work around:

```vue
<script setup lang="ts">
// ❌ Don't: compiles to nothing — the token "bg-info-500" never appears in source
const toneClass = (t: string) => `bg-${t}-500 hover:bg-${t}-400`

// ✅ Do: complete literal classes in a lookup — scanner sees every token
const TONE_CLASS = {
  info: 'bg-sky-500 hover:bg-sky-400',
  warn: 'bg-amber-500 hover:bg-amber-400',
  danger: 'bg-red-600 hover:bg-red-500',
} as const
type Tone = keyof typeof TONE_CLASS

const props = withDefaults(defineProps<{ tone?: Tone }>(), { tone: 'info' })
</script>

<template>
  <div :class="TONE_CLASS[props.tone] ?? TONE_CLASS.info">{{ message }}</div>
</template>
```

- **MUST NOT** build class names by string interpolation, ever — not in templates, not in `cn()` calls, not in store getters. It fails silently in production (dev even renders it fine if another component happened to use the class).
- The **only** sanctioned escape hatch is `@source inline("…")` for complete class names that live in runtime data (§6.3).
- **MUST** grep for `` `${`` adjacent to `class`/`bg-`/`text-` during review — this trap is the single most common Tailwind bug report in every codebase, forever.

### 7.4 Scoped Styles vs Utilities — The Cascade-Layer Flip

Two facts that shock developers coming from v3 or Vue 2:

1. **v4 utilities live in `@layer utilities`; your SFC scoped styles are unlayered author CSS. Per the cascade, unlayered styles beat layered ones — *regardless of specificity*.** A scoped `.card { padding: … }` overrides `p-4` on the element even at equal or lower specificity, and a parent cannot win the fight by stacking utilities.
2. **Scoped styles don't touch `v-html` content** — injected nodes carry no scope attribute. Style such content with global utilities on the wrapper, or a `:deep()` selector from the scoped block.

The design consequence — **MUST** build components to be styled *from outside* through class passthrough (single-root fallthrough, §3.3, or explicit `class` prop through `cn()`) instead of hard-scoped looks that parents fight:

```vue
<style scoped>
/* ❌ Don't: parents cannot override this with utilities — unlayered wins (§7.4 fact 1) */
.panel { padding: 1rem; }

/* ✅ Do: if you must scope, accept the override channel and document it */
.panel { border-radius: var(--radius-card); }
:deep(.panel-body p) { margin-block: 0.5rem; }   /* pierce child/v-html boundaries deliberately */
</style>
```

- **MUST** use the current deep syntax `:deep()`, `:slotted()`, `:global()` — the `/deep/`, `>>>`, and `::v-deep` spellings are deprecated/warned.
- **SHOULD** keep `scoped` blocks for structural/tokens concerns and let utilities carry spacing/color/layout — that split keeps override behavior predictable in both directions.

### 7.5 `@apply` in SFC Styles — The `@reference` Requirement

A `<style>` block does not import Tailwind's theme, so `@apply` inside it has no idea what `rounded-card` means — the famous "Cannot apply unknown utility class" error on Vue + v4:

```vue
<!-- CheckoutSummary.vue -->
<style scoped>
@reference "../assets/main.css";   /* pulls theme context WITHOUT re-emitting utilities */

.summary-row { @apply flex items-center justify-between py-2 text-sm text-ink; }
</style>
```

- **MUST** start any SFC `<style>` block that uses `@apply` (or `@theme` tokens) with `@reference` pointing at the main stylesheet — relative path from the SFC.
- **MUST NOT** use `@import "tailwindcss"` in component styles — that duplicates the entire framework per component and double-emits utilities.
- **SHOULD** stay lean with `@apply` even where it works: applied classes are invisible to the prettier class-sorter (§7.7) and to reviewers scanning the template. Best uses: base resets, genuinely repeated composite patterns. Worst uses: replacing what should be variant recipes (§7.2) or wrapper utilities.

### 7.6 `v-bind()` in CSS — Scoped, Reactive, CSP-Sensitive

```vue
<script setup lang="ts">
const progress = ref(0)   // 0–100
</script>
<style scoped>
.meter-bar { width: v-bind('`${progress}%`'); }
</style>
```

- The compiler emits a custom property on the component's nodes and updates it reactively — elegant, and the only way to bind reactive values into pseudo-elements/keyframes.
- **MUST** know the cost model: it becomes an **inline style attribute**, so under strict CSP it requires `style-src-attr` allowances or hashes (§12.4 — real trouble inside Tauri). Prefer utility classes (`:class`/`:style` bindings have the same CSP profile, but classes route around it entirely).
- Expressions in `v-bind()` are evaluated as component-scope JS — keep them trivial; anything complex moves to a `computed` and binds the computed's value.

### 7.7 Class Order Automation

```json
{
  "plugins": ["prettier-plugin-tailwindcss"],
  "tailwindStylesheet": "./src/assets/main.css"
}
```

- **MUST** configure the prettier plugin with `tailwindStylesheet` on v4 (it replaces the v3 `tailwindConfig` option — without it the plugin silently skips sorting).
- Sorted classes end the "which utility comes first" review debates, and make missing/extra utilities visible as single-token diffs. **SHOULD** enable format-on-save via editor + lint-staged (§11.4) so order never reaches the repository.

---

## 8. Forms & User Input Edge Cases

### 8.1 `v-model` Modifiers — What They Actually Do (and Where They Stop)

On native elements: `.lazy` syncs on `change` not `input`; `.trim` strips; `.number` runs `parseFloat` — and **returns the raw string when parsing fails**, so an empty input yields `''`, not a number. Normalize in the model layer (§3.2 `set` transform or a watcher), never with template gymnastics.

On **components**, the modifiers do nothing automatically. `v-model.trim="x"` on your `AppInput` arrives as `modelModifiers.trim === true` — the component implements the behavior or the modifier silently vanishes. With `defineModel`, destructure the modifiers pair (§3.2) and apply them in `get`/`set`.

### 8.2 IME Composition — The East-Asian-Input Bug

Vue's built-in `v-model` on native inputs suppresses updates during IME composition (pinyin/kana/hangul users typing intermediate syllables). The moment you write a custom input component with a manual `@input` handler, **you re-implement that guard or break every IME user**:

```vue
<script setup lang="ts">
const model = defineModel<string>({ default: '' })

function onInput(e: InputEvent) {
  if (e.isComposing) return                       // mid-IME-composition — do not commit
  model.value = (e.currentTarget as HTMLInputElement).value
}
</script>

<template>
  <input :value="model" @input="onInput">
</template>
```

**MUST** check `isComposing` in every custom input handler; **MUST** include one IME-input test (type "nihongo", select candidate) per custom input family. The bug is invisible in Latin-script QA and catastrophic in CJK markets.

### 8.3 Checkboxes, Radios, Selects — Value Semantics

- Checkboxes bound to an **array** collect their `:value` — `<input type="checkbox" v-model="selected" :value="opt">` toggles `opt` in/out of `selected`. Object values are preserved, not stringified.
- Radios and `<option>`s also preserve object `:value`s — but **MUST** pair `<select v-model.number>` with numeric values, or you get `'42'` back as a string and a `===` bug three layers down.
- `true-value` / `false-value` on checkboxes accept any values — including objects — and are the sanctioned way to model tri-state toggles without sentinel booleans.
- **MUST NOT** bind `v-model` to `type="file"` inputs — the value is read-only; use `@change` and read `e.target.files` (`FileList | null`, never an array). Clear by resetting `input.value = ''`, not by mutating a model.
- Nested object models (`v-model="form.customer.address.city"`) create intermediate reactive objects on demand — but **SHOULD** pre-declare the full shape in the store so types and reactivity agree from the first tick.

### 8.4 Async Validation — Debounce, Abort, Settle Exactly Once

The same race as §2.6 wearing a form costume: debounce the request (`useDebounceFn`), abort the previous one (`onCleanup` / AbortController), and reset the validating flag in `finally` — a flag that sticks `true` on an aborted request locks the form's submit button forever.

### 8.5 Controlled vs Uncontrolled Discipline

- **SHOULD** keep all interactive state controlled (model in store/composable) — uncontrolled DOM state and reactive state drift apart, and the reconciliation bugs are brutal.
- **MUST** mark genuinely uncontrolled integrations (rich-text editors, file inputs, third-party widgets) with a comment at the ref: who owns the value, when it syncs, how it resets. Uncontrolled without documentation is "works until it doesn't."

---

## 9. Performance Engineering

### 9.1 What Actually Triggers a Component Re-Render

Four inputs, no more: its own reactive state used in the template changes; its props change identity; its slot content is re-created by the parent; its parent re-renders in a way that doesn't bail out. The exploitable consequences:

- **MUST NOT** pass freshly-created object/array literals as props (`:config="{ rows: 3, tone: 'warn' }"`) — new identity every parent render, child re-renders forever, compiler bail-outs defeated. Hoist constants to script; compute dynamic ones in `computed` (stable identity while inputs are unchanged).
- `:style` object literals are the accepted exception (patched by diffing, not identity).
- **SHOULD** push expensive derivation into `computed` (memoized) rather than template expressions (re-evaluated per render) — the list `filter/sort` belongs in a computed, full stop.
- **MUST NOT** "fix" a slow tree by sprinkling `v-memo` without measuring — `v-memo` trades correctness-by-default for speed; each usage is a cache with manual invalidation semantics that must be argued in review.

```vue
<!-- ✅ Do: large tables — shallow state, whole-array replacement, memoized rows -->
<script setup lang="ts">
const rows = shallowRef<Row[]>([])          // §2.7: no deep proxy over 10k rows
const selected = ref<ReadonlySet<string>>(new Set())

async function load() { rows.value = await api.rows() }   // identity swap re-renders once

const selectedCount = computed(() => selected.value.size)
</script>

<template>
  <Row
    v-for="row in rows"
    :key="row.id"
    v-memo="[row.updatedAt, selected.has(row.id)]"   // re-render only when these change
    :row="row"
    :selected="selected.has(row.id)"
  />
</template>
```

### 9.2 Large Lists — The Escalation Ladder

1. Keys + computed sorting/filtering (§3.4) — always.
2. `shallowRef` state + whole-array replacement (§2.7) — at ~1k rows.
3. `v-memo` per row with explicit dependency arrays — when profiling shows row patching dominates.
4. Virtualization (`useVirtualList` from VueUse, or `vue-virtual-scroller`) — past a few hundred *visible-heights* of content, or >~5k DOM nodes. **MUST** virtualize POS receipt lines, product grids, and log views by default; a 30k-DOM receipt panel is a self-inflicted wound on low-end hardware.

### 9.3 Third-Party Instances — `markRaw` or Bust

Everything in §2.7 applies with extra force to class-instance libraries (maps, charts, editors, WebSocket clients): store them in plain module refs or wrap with `markRaw` at creation. The failure signature is either the "made reactive" dev warning or the third-party lib misbehaving on a proxied `this`. **MUST NOT** `markRaw` objects you *want* reactive — it's a one-way door requiring a fresh object to undo.

### 9.4 Lazy Loading

- **SHOULD** code-split at the route level (dynamic `import()` in route records) — views are the natural chunk boundary; inspect `dist/` chunk sizes in CI output.
- `defineAsyncComponent` for below-the-fold widgets (modals, charts, settings panels) with `loadingComponent` skeletons; `Suspense` only where genuinely coordinated (§3.7).
- **MUST** set `KeepAlive :max` for cached route stacks (§3.5).

### 9.5 The Leak Checklist

Every long-lived SPA leak in a Vue app comes from this table — run it during review of anything registering side effects:

| Registered | Unregistered by |
|---|---|
| `setInterval` / `setTimeout` (persistent) | `clearInterval`/`clearTimeout` in `onScopeDispose` |
| `window`/`document.addEventListener` | `removeEventListener` with the **same function reference** (inline arrows can never be removed) |
| `ResizeObserver` / `IntersectionObserver` / `MutationObserver` | `.disconnect()` |
| third-party instances (chart, map, editor) | the lib's `destroy()`/`dispose()` |
| watchers/effects created outside setup | owning `effectScope.stop()` (§5.2) |
| event-bus subscriptions (`mitt`) | `.off()` with the same handler |
| `URL.createObjectURL` blobs | `.revokeObjectURL()` after load/cancel |

### 9.6 Profiling Discipline

- Vue DevTools' component inspector + timeline for "what re-rendered and why"; `app.config.performance = true` for marks in the browser profiler.
- `onTrack`/`onTrigger` debug options on a specific watcher when you need ground truth on its dependencies — remove them after diagnosis, they are dev-only.
- **SHOULD** assert a bundle-size budget in CI (fail over an agreed KB ceiling on the entry chunk) — performance regressions via dependencies are silent otherwise (§11.3).

---

## 10. Testing Standards

The parent document's §6 (pyramid, naming, flaky policy, coverage philosophy) governs; this section adds the Vue-specific mechanics.

### 10.1 Stack & Configuration

- **MUST** use Vitest (current major 5.x) with `environment: 'jsdom'` (or `happy-dom` for speed where DOM behavior differences don't matter), `@vue/test-utils` for mounting plumbing, and Testing-Library-style queries in the assertions. Tests that find elements by role/label survive refactors; tests that find by wrapper class do not.
- **MUST** gate CI on coverage thresholds that bite (e.g., 80% lines / 70% branches on `src/`) — and exclude `src/components/ui/`-style pass-through wrappers from the denominator rather than writing meaningless snapshot tests to hit the number.
- **MUST NOT** write large DOM snapshots. A `toMatchSnapshot()` on a styled component is a change detector, not a test — it fails on every class reordering (§7.7 sorts classes!) and verifies nothing. Assert behavior and queried content.

### 10.2 Component Tests — Flush, Then Assert

```ts
import { mount, flushPromises } from '@vue/test-utils'
import ReceiptPanel from '@/components/pos/ReceiptPanel.vue'
import { useCartStore } from '@/stores/cart'
import { createPinia, setActivePinia } from 'pinia'

beforeEach(() => setActivePinia(createPinia()))   // fresh store per test

it('renders line-item totals after data resolves', async () => {
  vi.mocked(api.getCart).mockResolvedValue(cartFixture)
  const wrapper = mount(ReceiptPanel, { global: { plugins: [createPinia()] } })

  await flushPromises()                            // settle async setup/watchers
  expect(wrapper.text()).toContain('$12.40')       // user-visible outcome, not DOM shape
})
```

- **MUST** `await flushPromises()` (from `@vue/test-utils`) after any awaited data path before asserting — Vue updates are scheduled (§2.8), and the missing flush is the #1 cause of "works locally, fails in CI" (CI is just slower).
- Pinia: `setActivePinia(createPinia())` per test; `createTestingPinia()` when you need actions stubbed at call sites rather than state fixtures.
- Router: `createRouter` with `createMemoryHistory()` and the real routes, or `vue-router-mock` for push/spy ergonomics — never a `$router` mock object that drifts from the real API.
- Teleported content: stub with `global.stubs: { Teleport: true }` or assert via `document.body` — the wrapper's own tree does not contain it (§3.7).
- Suspense-wrapped async components need a real `<Suspense>` boundary in the test mount, or assertions run before resolution.

### 10.3 Composable Tests — The Harness

```ts
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

// Standard harness: run a composable inside a real component instance
export function withSetup<T>(composable: () => T): { result: T; unmount: () => void } {
  let result!: T
  const owner = defineComponent({
    setup() { result = composable(); return () => h('div') },
  })
  const wrapper = mount(owner)
  return { result, unmount: () => wrapper.unmount() }
}

// Usage — and unmount to assert cleanup (§5.2) actually ran
const { result, unmount } = withSetup(() => useSearch('ni'))
await vi.advanceTimersByTimeAsync(300)
expect(result.results.value).toHaveLength(2)
unmount()                                        // fires onScopeDispose paths
expect(window.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
```

- **MUST** exercise disposal in composable tests — an untested `onScopeDispose` is a future leak hiding behind a green check.
- Fake timers + `advanceTimersByTimeAsync` for debounces; real `await` for genuine promise chains where possible (fake timers and microtasks interact subtly — flush both).

### 10.4 Timing Edges — Transitions and Watchers

- `<Transition>` completes asynchronously; assertions between `enter-from` and settle need `await new Promise(r => setTimeout(r, DURATION))` or fake timers — know which mode the test is in before mixing.
- Watchers with `flush: 'post'` (§2.5) need a `nextTick` before their side effects exist.
- IME input tests (§8.2) simulate via dispatching `compositionstart` → `input` → `compositionend` events; plain `setValue` skips the composition path entirely.

### 10.5 E2E Discipline

- Playwright against `vite preview` (`webServer` config in `playwright.config.ts`); **MUST** tag selectors with the `data-testid` convention and never with Tailwind class chains — class strings are reformatted by tooling (§7.7) and are not a stable contract.
- **SHOULD** cover the money paths only: checkout, payment handoff, sync state transitions. E2E is the most expensive test per assertion; spend it where failures cost revenue.
- Component-visual regression (Vitest Browser Mode / Playwright screenshots) is **MAY** — valuable for the design system (`components/ui/`), noisy for feature pages.

---

## 11. Tooling, Lint & CI/CD

### 11.1 ESLint — Flat Config Baseline

ESLint 9 flat config with `eslint-plugin-vue` (10.x) and the official TS integration is the reference setup — the shape every reviewer should expect:

```ts
// eslint.config.ts
import pluginVue from 'eslint-plugin-vue'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'

export default defineConfigWithVueTs(
  { name: 'app/files', files: ['**/*.{ts,mts,tsx,vue}'] },
  pluginVue.configs['flat/recommended'],
  vueTsConfigs.recommended,
  skipFormatting,                                  // formatting belongs to Prettier
  {
    name: 'app/rules',
    rules: {
      // each of these encodes a MUST from earlier sections
      'vue/no-v-html': 'error',                                   // §12.1
      'vue/no-mutating-props': 'error',                           // §2.3
      'vue/no-side-effects-in-computed-properties': 'error',      // §2.4
      'vue/no-use-v-if-with-v-for': 'error',                      // §3.4
      'vue/no-unused-refs': 'error',                              // §4.4
      'vue/require-explicit-emits': 'error',                      // §3.3
      'vue/component-name-in-template-casing': ['error', 'PascalCase'],
      'vue/define-macros-order': ['error', {
        order: ['defineOptions', 'defineProps', 'defineEmits', 'defineSlots', 'defineModel'],
      }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
)
```

- **Division of labor (MUST):** ESLint owns patterns and hygiene; `vue-tsc` owns types. Do not chase type-aware lint rules inside `.vue` files — the parser plumbing is fragile and duplicates the typecheck gate for twice the configuration cost.
- **SHOULD** add `globalIgnores(['**/dist/**', '**/coverage/**', 'src-tauri/**'])` so generated and non-frontend trees never enter linting.
- The `define-macros-order` rule makes every SFC scan the same way top-to-bottom — cheap consistency that pays in every review.

### 11.2 CI Pipeline — The Four Gates

```yaml
# .github/workflows/ci.yml
name: ci
on:
  push: { branches: [main] }
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4            # reads packageManager from package.json
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint                          # gate 1 — patterns
      - run: pnpm typecheck                    # gate 2 — types incl. templates (§4.1)
      - run: pnpm test:unit                    # gate 3 — behavior + coverage floors
      - run: pnpm build-only                   # gate 4 — the bundle actually builds
      - name: entry-chunk budget (§9.6)
        run: |
          SIZE=$(stat -c %s dist/assets/index-*.js)
          test "$SIZE" -lt 262144              # 256 KB ceiling — set a real number per app
      - uses: actions/upload-artifact@v4
        with: { name: dist, path: dist }

  e2e:                                          # money paths only (§10.5), main only
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm test:e2e
```

- **MUST** keep all four gates blocking on every PR — a red build on any one gate is a broken change, not a follow-up ticket.
- **SHOULD** run dependency updates through Renovate with grouped minor/patch PRs and isolated major PRs; a Vue major, a Vite major, and a Tailwind major arriving in one PR is unreviewable.

### 11.3 Pre-Commit & Editor Experience

```json
{
  "lint-staged": {
    "*.{ts,mts,tsx,vue}": ["eslint --fix", "prettier --write"],
    "*.{css,md,json}": ["prettier --write"]
  }
}
```

- **SHOULD** wire `lint-staged` through `lefthook` (or husky) so lint/format never lands broken; **MUST NOT** run type-checks or tests in pre-commit — they are CI gates (§11.2), and slow hooks get `--no-verify`'d into uselessness within a week.
- **SHOULD** ship `.vscode/extensions.json` recommending the Vue Official (Volar) + ESLint + Tailwind IntelliSense extensions and `editor.formatOnSave` — the editor is the first linter anyone actually reads.

---

## 12. Security

The parent document's §5 (threat models, injection, secrets, supply chain) governs universally. Vue-specific surface below.

### 12.1 `v-html` — Banned Unless Sanitized

```ts
// directives/vSafeHtml.ts — the only sanctioned v-html path
import DOMPurify from 'dompurify'
import type { Directive } from 'vue'

DOMPurify.setConfig({ ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'br', 'p', 'span'], ALLOW_ATTR: ['class'] })

export const vSafeHtml: Directive<HTMLElement, string> = {
  mounted: (el, { value }) => { el.innerHTML = DOMPurify.sanitize(value) },
  updated: (el, { value, oldValue }) => {
    if (value !== oldValue) el.innerHTML = DOMPurify.sanitize(value)
  },
}
```

- **MUST NOT** bind `v-html` to anything influenced by users, APIs, CMS content, or AI output without DOMPurify (or an approved sanitizer) in the chain — `eslint vue/no-v-html` is `error` (§11.1) precisely because the sanitized directive is the exception, not the norm.
- **SHOULD** prefer `v-text` or interpolation everywhere else — Vue escapes both by default; the danger is opt-in only.
- **MUST** keep the allowlist tight enough to review in one screen; every tag added is attack surface someone will exploit eventually.

### 12.2 URL Binding — Kill the `javascript:` Scheme

```ts
// lib/sanitize.ts
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
export function sanitizeUrl(input: string): string {
  try {
    const url = new URL(input, window.location.href)
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : '#'
  } catch { return '#' }
}
```

- **MUST** route every dynamic `:href`/`:src`/`:action` through `sanitizeUrl` — a stored `javascript:…` link is stored XSS one click away.
- **MUST** pair `target="_blank"` with `rel="noopener noreferrer"` on any user-influenced links.
- **MUST NOT** construct image/resource URLs by string concatenation with user fragments — `encodeURIComponent` the fragment or rebuild via `URL` setters.

### 12.3 No Runtime Template Compilation

Bundler builds ship the runtime-only Vue by default — `template` options in component definitions simply don't compile. Keep it that way: **MUST NOT** alias/import the full build (`vue/dist/vue.esm-bundler.js`) to make string templates work. The full build doubles as a template-injection engine the moment any string reaches a `template` option, and it is ~30% heavier. If code "needs" it, it needs a redesign, not an alias.

### 12.4 CSP & Inline Styles — The Tailwind/Vue Interaction

- Tailwind itself is CSP-friendly: compiled utilities are a static stylesheet — `style-src 'self'` suffices.
- The inline-style exceptions are all *reactivity conveniences*: `:style` object bindings, `v-bind()` inside `<style>` (§7.6), and any JS-driven `el.style.x = …` all become style **attributes**, which strict CSP (`style-src` without `'unsafe-inline'`) blocks — and silently: the binding just doesn't apply.
- **MUST** decide the CSP posture before the first styled component, not after packaging: inside Tauri, CSP is declared in `tauri.conf.json` and strict-by-default-philosophy (see `TAURI_V2_POS_STANDARDS.md` §5) — meaning style **attributes** need explicit allowance or the app ships with invisible `:style` bindings.
- **SHOULD** default to class-based styling (§7.1–§7.3) and treat any `:style`/`v-bind()` usage as a documented exception with a comment naming the CSP line it requires.

### 12.5 Env Secrets & Supply Chain

- `VITE_` variables are inlined into the client bundle — **MUST NOT** hold keys, tokens, or partner secrets there (§1.5); anything sensitive belongs behind the API or in platform credential storage (§5.5).
- **MUST** commit lockfiles and install with `--frozen-lockfile`; **SHOULD** enable `pnpm audit --prod` in CI and pnpm's `onlyBuiltDependencies` allowlist so new packages cannot silently run install scripts.
- **MUST** verify package names character-by-character before adding dependencies (slopsquating — see parent §5.5): `vueuse` vs `vue-use`, `tailwind-merge` vs `tailwindmerge` are exactly the kind of typos that end in exfiltrated env files.

---

## 13. Vue Inside Tauri (Desktop Bridge)

This section applies when the Vue app runs inside a Tauri v2 webview (the POS-class desktop case). The full desktop standards — capabilities, IPC security model, SQLite, updater, release pipelines — live in `TAURI_V2_POS_STANDARDS.md`; this is the frontend-side contract with that document.

### 13.1 Vite Config for Tauri

```ts
// vite.config.ts — Tauri-adjusted; keep §1.1's plugins intact
import { defineConfig } from 'vite'

export default defineConfig({
  // plugins: [vue(), tailwindcss()],                     // unchanged
  clearScreen: false,                                    // tauri CLI owns the console
  server: {
    port: 1420,
    strictPort: true,                                    // a drifted port = dev blank-screen
    watch: { ignored: ['**/src-tauri/**'] },             // Rust rebuilds shouldn't HMR-restart Vite
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],                    // expose Tauri-provided build env
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
  },
})
```

- **MUST** keep `strictPort` — the Tauri dev server URL is pinned in `tauri.conf.json`; a port race produces "connection refused" blank windows.
- **MUST** use the `@/` alias for all app imports — root-absolute specifiers (`/src/...`) load in `vite dev` but break under the packaged `tauri://` protocol (§1.4, §14.5).

### 13.2 Typed IPC Surface

```ts
// lib/ipc.ts — the ONLY module allowed to import '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import type { Product, Sale, SyncStatus } from '@/types'

export const ipc = {
  listProducts: () => invoke<Product[]>('list_products'),
  saveSale: (sale: Sale) => invoke<{ id: string }>('save_sale', { sale }),
  syncStatus: () => invoke<SyncStatus>('sync_status'),
}
```

- **MUST** centralize every `invoke` behind typed wrappers — scattered raw `invoke('save_sale')` strings drift from the Rust command signatures with no compiler to catch it. The wrapper layer is the frontend's half of the IPC contract tests (TAURI doc §12).
- **MUST NOT** trust these calls as validation — the Rust side validates and authorizes everything (TAURI doc §4–§5); frontend validation is UX, never security.
- **SHOULD** type event payloads at the `listen()` boundary the same way, with shared types in `types/`.

### 13.3 Web-API Caveats in the Webview

- `localStorage` works but is WebView-ephemeral (clearable, occasionally evicted): **MUST NOT** treat it as durable storage — durable state goes through the SQL/store plugins (TAURI doc §6).
- Runtime-switchable settings (server URL, feature flags) **MUST NOT** ride `VITE_` env vars (§1.5) — read a config file or the backend at startup.
- `window.open`/`fetch`/notifications have Tauri-specific behaviors and permission prompts — route through the corresponding official plugins instead of assuming browser semantics; the capability list decides what is even allowed (TAURI doc §5).

### 13.4 If the Frontend Stack Is Vue

`TAURI_V2_POS_STANDARDS.md` currently specifies React 19 for the POS frontend. Should that decision change to Vue 3 + TS + Tailwind, this document becomes the governing frontend standard: substitute its §2–§8 rules for the Tauri doc's React-side sections, keep every Rust/CI/security/updater section as written, and update both documents' cross-references in the same PR. The bridge points are exactly three: Vite config (§13.1), typed IPC (§13.2), and CSP-styling posture (§12.4).

---

## 14. The Edge-Case Compendium

The rapid-reference index of every recurring failure mode in this stack, grouped by where you'll go looking for the blame. Format: **symptom → root cause → fix** (section reference). This section is the compressed form of the whole document — when a bug bites at 2 a.m., start here.

### 14.1 Reactivity

| Symptom | Root cause | Fix |
|---|---|---|
| Mutating a copy never updates the UI | spread/destructured copies broke the reactive link | mutate the source, or `toRefs`/`toRef` (§2.3) |
| `watch(() => state.obj)` silent on nested changes | getter sources track identity only | `{ deep: true }` or precise getter (§2.5) |
| `watch(reactiveForm)` fires on every keystroke | reactive-object sources are implicitly deep | precise primitive getter (§2.5) |
| UI permanently stuck after reassigning state | `reactive()` reassignment orphaned old proxies | hold in `ref`, replace `.value` (§2.1) |
| A `computed` never refreshes | non-reactive source (`Date.now()`, module var) | derive from reactive inputs only (§2.4) |
| "Maximum recursive updates exceeded" | computed/watcher mutating its own dependencies | remove the side effect (§2.4) |
| Older async result overwrites the newer one | missing cancel-on-next-run | `onCleanup` + `AbortController` (§2.6) |
| Watcher callback reads stale DOM | default `pre` flush runs before render | `flush: 'post'` (§2.5) |
| `.value` needed on a ref inside a reactive array | documented no-unwrap caveat for array/Map positions | don't nest refs in arrays/Maps (§2.2) |
| Destructured store fields never update | `storeToRefs()` skipped | use `storeToRefs` (§5.4) |
| Destructured prop never updates | pre-3.5 code, or aliased destructure | Vue ≥3.5, never alias (§2.3) |

### 14.2 Templates & Components

| Symptom | Root cause | Fix |
|---|---|---|
| `v-if` cannot see the `v-for` variable | Vue 3 flipped precedence: `v-if` runs first | filter in a `computed` (§3.4) |
| Wrong rows patched after `unshift`/`splice`/`sort` | index-based `v-for` keys | stable business-id keys (§3.4) |
| Parent's class/listener vanishes on a component | multi-root fallthrough disabled | `v-bind="$attrs"` on the receiver (§3.3) |
| `KeepAlive` "doesn't cache" | `include` vs filename-derived name (case-sensitive) | `defineOptions({ name })` (§3.5) |
| Route change between `/item/1`→`/item/2` doesn't reload | same component instance is reused | watch `route.params` (§3.5) |
| `<Transition>` never animates | same tag, no distinguishing key | add `key` + `mode="out-in"` (§3.6) |
| `TransitionGroup` reorders teleport | missing `*-move` class | style the move class (§3.6) |
| Parent's `ref` on child has no methods | `<script setup>` is closed by default | `defineExpose` (§3.4) |
| `v-html` content ignores your scoped styles | injected nodes carry no scope attribute | `:deep()` or global utilities (§7.4) |
| "onMounted is called when there is no active component instance" | composable called outside setup / conditionally | call synchronously in setup (§5.2) |

### 14.3 TypeScript

| Symptom | Root cause | Fix |
|---|---|---|
| `as` / `!` rejected inside a template | TS-only syntax is not template syntax | precompute in script (§4.2) |
| `.vue` imports are `any` in `.ts` files | blanket `declare module '*.vue'` shim | delete shim, gate on vue-tsc (§1.5) |
| "not assignable to `UnwrapRef<…>`" | interface-vs-alias unwrap quirk | `type` alias or `shallowRef` (§4.3) |
| `ref(null)` unusable as template ref | too-narrow inferred type | `ref<T \| null>(null)` or `useTemplateRef` (§4.4) |
| `e.target.value` doesn't typecheck | `EventTarget` is generic | narrow/cast once in script (§4.6) |
| `'$event' implicitly has an 'any' type` | inline handler + `strictTemplates` | named typed handler (§4.1) |
| Imported prop type rejected by `defineProps` | Vue < 3.3 limitation | upgrade; import from `@/types` (§3.1) |

### 14.4 Tailwind CSS

| Symptom | Root cause | Fix |
|---|---|---|
| `bg-${tone}-500` renders unstyled | interpolated tokens are invisible to the compiler | literal lookup map / `@source inline` (§7.3, §6.3) |
| "Cannot apply unknown utility class" in `<style>` | scoped styles lack theme context | `@reference "../assets/main.css"` (§7.5) |
| Utility can't override a scoped style | v4 cascade layers: unlayered author CSS wins | class-passthrough design (§7.4) |
| Shadows/radii/blur subtly off after upgrade | v4 renamed the bottom of each scale | rename table + eyeball pass (§6.4) |
| `!important` utility doesn't apply | prefix moved to suffix | `font-bold!` (§6.4) |
| Borders changed color after migration | default border color is `currentColor` | explicit `border-hairline` etc. (§6.4) |
| `dark:` ignores the `.dark` class | v4 defaults to `prefers-color-scheme` | `@custom-variant dark` (§6.5) |
| Styles missing only for generated/vendored components | auto-detection skips gitignored & node_modules | `@source` directives (§6.3) |
| Broken rendering on Safari ≤ 16.3 | below v4's browser floor | document the floor, don't hack (§6.1) |

### 14.5 Build & Environment

| Symptom | Root cause | Fix |
|---|---|---|
| Blank app only when packaged (Tauri / `file://`) | root-absolute `/src/...` imports | `@/` alias everywhere (§1.4, §13.1) |
| Env var undefined at runtime | `VITE_` values are inlined at build time | runtime config file/backend (§1.5, §13.3) |
| Dev window blank with "connection refused" | port race between Vite and Tauri config | `strictPort: true` (§13.1) |
| Class order churn across every diff | prettier plugin not configured for v4 | `tailwindStylesheet` option (§7.7) |
| Editor red, CI green (or the reverse) | different TS/Volar versions than CI | pin tooling; vue-tsc is the single truth (§4.1) |
| Full reloads instead of HMR for store edits | missing Pinia HMR snippet | add `import.meta.hot.accept` block (§5.5) |

---

## 15. Enforcement & Automation

Rules that exist only in prose decay within a sprint. Each MUST in this document maps to a machine check or a named human checkpoint; anything unmapped is either a SHOULD in disguise or a rule waiting to be deleted.

### 15.1 Rule → Tool Map

| MUST (source) | Enforced by |
|---|---|
| No unsanitized `v-html` (§12.1) | `eslint vue/no-v-html: error` (§11.1) |
| No props mutation (§2.3) | `eslint vue/no-mutating-props` |
| No computed side effects (§2.4) | `eslint vue/no-side-effects-in-computed-properties` |
| `v-for` keys, no `v-if`+`v-for` (§3.4) | `eslint vue/require-v-for-key`, `vue/no-use-v-if-with-v-for` |
| Declared emits (§3.3) | `eslint vue/require-explicit-emits` |
| Macro order & casing (§3.1, §11.1) | `eslint vue/define-macros-order`, `vue/component-name-in-template-casing` |
| Templates type-checked (§4.1–§4.2) | `vue-tsc --noEmit` CI gate + `strictTemplates` |
| No dynamic class fragments (§7.3) | CI grep for `` class=`${ `` / `` bg-${ `` patterns + review checklist |
| `@reference` on `@apply` blocks (§7.5) | CI grep: `<style` blocks containing `@apply` must contain `@reference` |
| Deterministic class order (§7.7) | `prettier-plugin-tailwindcss` + lint-staged |
| Composable disposal (§5.2, §9.5) | composable tests assert unmount cleanup (§10.3) |
| Coverage floors (§10.1) | `vitest run --coverage` thresholds in CI |
| Bundle budget (§9.6) | CI `stat` ceiling on entry chunk (§11.2) |
| Lockfile & install hygiene (§12.5) | `--frozen-lockfile` + `pnpm audit --prod` in CI |
| Secrets never in `VITE_` vars (§12.5) | secret-scan step (parent doc §5.4) |

### 15.2 The Reviewer's Vue/Tailwind Checklist

Beyond the parent document's review checklist (§8.3 there), a Vue+TS+Tailwind reviewer confirms:

1. ☐ Every new `ref` in script is accessed via `.value`; template refs typed with `| null` or `useTemplateRef` (§4.4).
2. ☐ No destructuring of `reactive()`/stores without `toRefs`/`storeToRefs` (§2.3, §5.4).
3. ☐ Watchers: right source shape, `onCleanup` on async, `deep`/`post` only where argued (§2.5–§2.6).
4. ☐ New components: `defineOptions` name if KeepAlive-relevant, `defineEmits` declared, attrs strategy deliberate (§3.3, §3.5).
5. ☐ No TS syntax in template expressions; casts live in script with a narrowing story (§4.2, §4.6).
6. ☐ All class names complete literals; variants through `cva`/lookup maps; `cn()` used for composition (§7.1–§7.3).
7. ☐ No new scoped-style vs utility fights; override channels are class passthrough, not specificity (§7.4).
8. ☐ Async work has cancel paths; listeners/timers have disposal paths (§2.6, §9.5).
9. ☐ `v-html`/`:href` bindings trace back to sanitized sources (§12.1–§12.2).
10. ☐ The §14 compendium scan: none of the listed symptoms match the diff's behavior claims.

### 15.3 What Stays Human

Tooling cannot judge: whether a component's prop API is coherent (§3.1), whether a variant recipe expresses the design system (§7.2), whether a `v-memo` dependency list is actually sufficient (§9.1), or whether a `deep` watcher is the honest model of the domain (§2.5). These are review conversations; the automation exists to clear the mechanical noise so those conversations fit in the meeting.

---

## Appendix A: Version Matrix & Verified Baseline (September 2026)

All rows verified by primary-source research in September 2026 (official release notes, changelogs, npm). Pin exact versions in `package.json`; treat this matrix as the floor-plus-context, not a floating `^`.

| Package | Verified line | Notes & adoption posture |
|---|---|---|
| `vue` | 3.5.x stable | Reactive props destructure, `useTemplateRef`, `useId`, `onWatcherCleanup` all stable-and-default |
| `vue` (3.6) | RC as of Sep 2026 | Vapor Mode feature-complete but **opt-in and unstable** — do not ship; re-evaluate at stable |
| `vite` | 8.x (8.0: Mar 2026) | Rolldown+Oxc+Lightning CSS engine; `rolldown-vite` is the v7 stepping stone |
| `typescript` | 6.0.x (final JS-based) / 7.0.x (native port) | On 7.x, verify `vue-tsc`/Volar support in the same upgrade PR — do not decouple the two jumps |
| `tailwindcss` | 4.3.x | CSS-first config; `@tailwindcss/vite` plugin; browser floor Safari 16.4 / Chrome 111 / Firefox 128 |
| `pinia` | 4.x | Vue 3 only; v3→v4 breaking changes mostly technical |
| `vue-router` | 4.x | Watch-params rule (§3.5) applies regardless of minor |
| `@vueuse/core` | 14.x | Requires Vue 3.5+ |
| `vitest` | 5.x (Sep 2026) | Browser Mode stable; Trace View added |
| `eslint-plugin-vue` | 10.11.x | Flat config; `flat/recommended` preset |
| `@vue/eslint-config-typescript` | current | `defineConfigWithVueTs` + `vueTsConfigs` (§11.1 shape) |
| `prettier-plugin-tailwindcss` | current | v4 requires `tailwindStylesheet` (§7.7) |
| `class-variance-authority` / `tailwind-merge` / `clsx` | current | The `cn()` trio (§7.1–§7.2) |

Facts specifically verified during research for this document: refs in reactive arrays/Maps do not unwrap (§2.2 — current official docs caveat); Vue 3.5 enabled reactive props destructure by default; Tailwind v4.1 added `@source not inline()` and v4.3 is current; ESLint 9 flat config is the default path for eslint-plugin-vue 10.x.

---

## Appendix B: Migration Hotlists

### B.1 Vue 2 → Vue 3 (top failure points)

1. Filters → computed/methods (§3.9).
2. `$listeners`/`.native` → `$attrs` merge + declared emits (§3.3).
3. `Vue.set`/`Vue.delete` habits → direct assignment works now (§3.9).
4. `:prop.sync` → `v-model:prop` (§3.2).
5. Event bus (`$on/$off`) → Pinia, provide/inject, or `mitt` (§3.8, §5.3).
6. `key` on `v-for` `<template>` children → key moves to `<template>` itself (§3.4).
7. `v-if`/`v-for` precedence flipped — audit every same-element pair (§3.4).
8. Multi-root components → fallthrough breaks, plan `v-bind="$attrs"` (§3.3).
9. Array index reactivity fears are obsolete — proxies track index writes (§2.2).
10. Functional-component HOCs → composables (§5.1).

### B.2 Tailwind v3 → v4 (top failure points)

1. Delete `tailwind.config.js`; move tokens to `@theme`, sources to `@source`, dark mode to `@custom-variant` (§6).
2. Run `npx @tailwindcss/upgrade`, then hand-audit the §6.4 table (scale shifts, `!` suffix, `currentColor` borders, `ring` width).
3. Swap PostCSS setup for `@tailwindcss/vite` (§1.1).
4. Every SFC `<style>` with `@apply` gets `@reference` (§7.5).
5. Prettier plugin: `tailwindConfig` → `tailwindStylesheet` (§7.7).
6. Re-check `bg-opacity-*`-style compounds → slash shorthand (§6.4).
7. Confirm the browser floor is acceptable before promising legacy support (§6.1).
8. Semantic-token re-platform: `@theme` variables + `.dark` overrides replace config `theme.extend` (§6.2).

---

## Appendix C: Document Governance & Exception Process

- **Precedence** (inherited from the parent document): security > correctness > maintainability > style. When this document and a convenience disagree, the higher concern wins; when this document and `DEVELOPMENT_STANDARDS.md` disagree on a universal concern, the parent wins; on a stack-specific concern, this one wins.
- **Waivers:** any MUST may be waived in writing — in the PR description, with the section number, the reason, and an expiry (≤90 days). Silent waivers are violations.
- **Amendments:** this document is versioned with the codebase; changes land via PR with the changelog row below updated in the same commit.
- **Review cadence:** quarterly, and within two weeks of: a Vue minor ≥3.6 stable, a Vite major, a Tailwind major, or a TypeScript native-compiler line becoming the default.

| Version | Date | Change |
|---|---|---|
| 1.0 | September 2026 | Initial release — deep-research baseline verified against current releases (Appendix A) |
