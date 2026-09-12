# Development Standards & AI Agent Execution Rules

> Universal engineering standards for clean, performant, well-architected code — and the non-negotiable execution constraints that any AI coding agent (Claude, Copilot, Cursor, Codex, Windsurf, or otherwise) must follow when reading from or writing to this codebase.

**Last reviewed for currency:** September 2026
**Convention:** `MUST` = non-negotiable. `SHOULD` = strong default; deviating requires a stated reason. `MAY` = discretionary.

---

## Table of Contents

- [0. AI Agent Execution Checklist (Read First)](#0-ai-agent-execution-checklist-read-first)
- [1. Clean Code & Maintainability](#1-clean-code--maintainability)
- [2. Performance & Optimization](#2-performance--optimization)
- [3. Software Architecture & Structure](#3-software-architecture--structure)
- [4. AI Agent Guardrails (Execution Constraints)](#4-ai-agent-guardrails-execution-constraints)
- [Appendix A: Condensed Cheat Sheet](#appendix-a-condensed-cheat-sheet)
- [Appendix B: Compatibility With Other Agent Config Formats](#appendix-b-compatibility-with-other-agent-config-formats)

---

## 0. AI Agent Execution Checklist (Read First)

Any AI agent modifying code in this project **MUST** run through this list before writing a single line, and again before returning a result. This is the load-bearing section — the rest of the document is reference detail for the rules below.

**Before you start:**
1. ☐ Read the actual files you're about to touch, plus their immediate neighbors — never patch from memory or assumption.
2. ☐ Identify the *smallest* set of files and lines that satisfy the request. Bigger is not more thorough; bigger is more risk.
3. ☐ If the request is ambiguous, state the assumption you're proceeding under in one line rather than guessing silently or blocking on a question you don't need to ask (§4.6).

**While working:**
4. ☐ Match the existing naming, style, and patterns already in the file — do not impose a new personal style mid-codebase.
5. ☐ Zero placeholders. No `// TODO`, no `// rest of the code`, no stub bodies. Every function you touch ships complete (§4.1).
6. ☐ Validate and type-check everything crossing a boundary you write to (§3.2).
7. ☐ Don't reformat, rename, or "clean up" code outside the scope of the request (§4.3).

**Before you return the result:**
8. ☐ Confirm every import, package, and API you referenced actually exists in this project's ecosystem — never a hallucinated dependency (§4.4).
9. ☐ Trace at least one happy path and one edge case (empty, null, zero, max, concurrent) by hand.
10. ☐ Re-read your own output once as a skeptical reviewer seeing it cold, not as its confident author.
11. ☐ Summarize *what* changed and *why*, especially for any non-obvious decision or tradeoff (§4.6).

---

## 1. Clean Code & Maintainability

### 1.1 Naming Conventions

Names are the primary documentation of intent. A correct but badly named variable is a bug waiting for the next reader.

| Element | Convention | Example |
|---|---|---|
| Variables & functions | `camelCase` (JS/TS/Java/Swift) or `snake_case` (Python/Rust/Ruby) | `getUserById`, `get_user_by_id` |
| Classes, types, interfaces | `PascalCase` | `UserRepository`, `OrderStatus` |
| Constants | `UPPER_SNAKE_CASE` | `MAX_RETRY_COUNT` |
| Booleans | `is` / `has` / `can` / `should` prefix | `isActive`, `hasPermission`, `canRetry` |
| Private/internal members | Leading underscore or language-native modifier | `_cache`, `private readonly cache` |
| Files & directories | `kebab-case`, or match the framework's convention | `user-profile.service.ts` |

**Rules:**
- Function names are verbs or verb phrases (`calculateTotal`); variable names are nouns (`orderTotal`).
- Avoid single-letter names outside of tiny, obvious scopes (loop counters `i`/`j` in a 3-line loop are fine; anywhere else, name it).
- Avoid ambiguous generic names: `data`, `temp`, `info`, `handleStuff`, `obj`, `manager` (when it manages nothing specific).
- Avoid abbreviations that aren't universally understood (`usrCfg` → `userConfig`).
- The length of a name should scale with its scope: short names for tight local scopes, descriptive names for anything with wider visibility.

```javascript
// ❌ Don't
const d = new Date();
function proc(x) { return x.filter(i => i.s === 1); }
let flag = chk(u);

// ✅ Do
const createdAt = new Date();
function getActiveItems(items) { return items.filter(item => item.status === STATUS_ACTIVE); }
let isEligibleForDiscount = checkUserEligibility(user);
```

### 1.2 Function Design

- **Single responsibility:** a function does one thing at one level of abstraction. If you need "and" to describe it ("validates and saves and emails"), split it.
- **Length:** ~40 lines is a soft ceiling, not a hard rule — it's a signal to check whether the function has taken on more than one job.
- **Parameters:** 3 or fewer positional parameters. Beyond that, use a single options/parameters object so call sites stay readable and order-independent.
- **Nesting/complexity:** prefer guard clauses and early returns over deeply nested conditionals (see §3.4).
- **Side effects:** make them obvious from the name and signature (`saveUser` mutates state; `calculateTotal` should not).

```javascript
// ❌ Don't: one function doing validation, calculation, persistence, and notification
function processOrder(order) {
  if (!order.items || order.items.length === 0) throw new Error('empty order');
  let total = 0;
  for (const item of order.items) total += item.price * item.qty;
  if (order.coupon) total *= 0.9;
  db.save({ ...order, total });
  emailService.send(order.customerEmail, 'Order confirmed');
  return total;
}

// ✅ Do: each function has one job; the orchestrator reads like a summary
function validateOrder(order) { /* ... */ }
function calculateOrderTotal(order) { /* ... */ }
function applyDiscount(total, coupon) { /* ... */ }

function placeOrder(order) {
  validateOrder(order);
  const total = applyDiscount(calculateOrderTotal(order), order.coupon);
  orderRepository.save({ ...order, total });
  notificationService.sendOrderConfirmation(order);
  return total;
}
```

### 1.3 File & Module Sizing

- Treat ~300–400 lines per file as a soft ceiling — a prompt to ask "does this file have more than one reason to change?" rather than a rule enforced by a line counter.
- Each file should have one clear primary export or responsibility.
- Organize by **feature/domain** ("colocate what changes together": `orders/OrderList.tsx`, `orders/orders.api.ts`, `orders/orders.test.ts`) rather than by **technical type** (`components/`, `services/`, `tests/` as top-level buckets) once a project grows past a small size — this keeps related changes in one place instead of scattered across parallel directory trees.

### 1.4 Modular Design

- **High cohesion, low coupling:** things that change together live together; things that change independently should be free to do so without touching each other.
- Expose a minimal, deliberate public interface per module (an `index`/barrel export, `__all__`, explicit `export`) and keep everything else private to the module.
- Depend on **abstractions at module boundaries**, not on another module's internals — reaching into another module's private files to grab a helper function is a coupling bug, not a shortcut.

### 1.5 Core Design Principles

| Principle | Core Idea | Violation Smell |
|---|---|---|
| **S** — Single Responsibility | A class/module has one reason to change | A "God class" that validates, persists, formats, and emails |
| **O** — Open/Closed | Open for extension, closed for modification | A `switch` on a `type` field that needs a new case every time a feature is added |
| **L** — Liskov Substitution | A subtype must be usable anywhere its base type is, without breaking correctness | An override that throws or no-ops behavior the base type promises callers |
| **I** — Interface Segregation | Many small, specific interfaces beat one large one | Implementers forced to stub out methods they don't use |
| **D** — Dependency Inversion | Depend on abstractions, not concrete implementations | A service class that directly `new`s a specific database driver instead of receiving an interface |
| **DRY** | Every piece of knowledge has one authoritative representation | The same business rule (e.g., a tax calculation) hardcoded in three places |
| **KISS** | Prefer the simplest design that actually solves the problem | Unnecessary abstraction layers or "clever" one-liners nobody can review at a glance |
| **YAGNI** | Don't build for a hypothetical future requirement | A configurable plugin architecture built for a feature with exactly one implementation |
| **Law of Demeter** | Only talk to your immediate collaborators | Chains like `order.getCustomer().getAddress().getCountry().getCode()` |

These principles remain the industry baseline for object-oriented and modular design — three decades on, they're still what a pull-request review comes back to when a design "feels wrong" but the code technically works.

```typescript
// ❌ Don't: reaching through objects (Law of Demeter violation)
const countryCode = order.getCustomer().getAddress().getCountry().getCode();

// ✅ Do: ask the immediate collaborator; let it delegate internally
const countryCode = order.getShippingCountryCode();
```

```typescript
// ❌ Don't: high-level module hardwired to a concrete implementation (violates DIP)
class OrderService {
  private db = new PostgresDatabase(); // tightly coupled, hard to test or swap
}

// ✅ Do: depend on an abstraction; inject the implementation
interface OrderRepository { save(order: Order): Promise<void>; }

class OrderService {
  constructor(private repository: OrderRepository) {}
}
```

### 1.6 Self-Documenting Code vs. Comments

**Rule of thumb:** code explains *what*; comments explain *why*.

- **Don't** comment what the code already says clearly.
- **Do** comment: non-obvious business rules, the reason a workaround exists (link the ticket), why a "wrong-looking" approach was deliberately chosen, or the intent behind a dense regex/algorithm.
- Delete commented-out dead code — git history is the archive; the file body is not.

```javascript
// ❌ Don't — restates the code, adds no information
// increment i by 1
i++;

// loop through all users
for (const user of users) { ... }

// ✅ Do — explains a non-obvious "why"
// Stripe requires amounts in the smallest currency unit (cents), not dollars.
const amountInCents = Math.round(price * 100);

// Retrying with backoff: upstream rate-limits bursts over 5 req/s (see INFRA-2291).
await retryWithBackoff(() => fetchInventory(sku));
```

---

## 2. Performance & Optimization

### 2.1 Algorithmic Efficiency

| Notation | Name | Typical Example |
|---|---|---|
| O(1) | Constant | Hash map / dictionary lookup |
| O(log n) | Logarithmic | Binary search, balanced tree lookup |
| O(n) | Linear | A single pass over a collection |
| O(n log n) | Linearithmic | Efficient comparison sort (merge/quick/tim) |
| O(n²) | Quadratic | Nested loop over the same collection |
| O(2ⁿ) | Exponential | Naive recursive subset/Fibonacci without memoization |

**Rule:** default to O(n) or better on any hot path over unbounded or user-controlled input. O(n²)+ isn't automatically forbidden — it's fine on small, bounded `n` — but it's a required call-out in review when the input size isn't provably small.

```javascript
// ❌ Don't: O(n²) — .includes() re-scans the growing array on every iteration
const unique = [];
for (const item of items) {
  if (!unique.includes(item)) unique.push(item);
}

// ✅ Do: O(n) — a Set gives O(1) average-case membership checks
const unique = [...new Set(items)];
```

### 2.2 Memory Management & Leak Prevention

- **Pair every acquire with a release**, ideally via a construct that guarantees it runs even on error: `try/finally`, a context manager (`with` in Python), `using` (C#), `defer` (Go), or a component's teardown/`dispose` lifecycle hook.
- **Bound every cache.** An in-memory `Map` that only grows is a memory leak with a hit rate — use an LRU or TTL eviction policy, not an implicit "it'll be fine."
- Remove event listeners, timers, subscriptions, and observers when the owning object is destroyed — this is the single most common leak source in long-lived UI applications.
- Use weak references (`WeakMap`/`WeakRef`) for caches keyed by objects whose lifecycle you don't own.
- Watch for closures that capture large objects (or DOM nodes) longer than necessary.

```javascript
// ❌ Don't: listener outlives the widget; the element and its closure leak forever
class Widget {
  constructor(el) {
    window.addEventListener('resize', () => this.reflow(el));
  }
}

// ✅ Do: symmetric setup and teardown
class Widget {
  constructor(el) {
    this.onResize = () => this.reflow(el);
    window.addEventListener('resize', this.onResize);
  }
  destroy() {
    window.removeEventListener('resize', this.onResize);
  }
}
```

### 2.3 Database & Network Optimization

- **Never issue a query inside a loop.** This is the #1 real-world performance bug (the "N+1 problem"): 1 query to fetch a list, then N more for each item's related data. Fix it with a join, an ORM's eager-loading (`prefetch_related`, `.includes`, `select_related`), or a batched `WHERE id IN (...)` lookup.
- **Paginate or stream** large result sets — never fetch an entire table "just in case" you need it.
- **Fetch only needed fields** (explicit column lists, GraphQL field selection, partial REST responses) instead of over-fetching by default.
- **Cache with an explicit invalidation strategy** (TTL or event-based). An unbounded cache is just a memory leak wearing a performance-feature costume.
- **Debounce/throttle** high-frequency, user-triggered requests (search-as-you-type, scroll, resize).
- **Reuse connections** via pooling instead of opening a new one per request.

```python
# ❌ Don't: 1 query for authors + N queries for each author's books
authors = Author.objects.all()
for author in authors:
    print(author.books.all())  # hits the database on every iteration

# ✅ Do: eager-load the relationship — total queries stay constant regardless of N
authors = Author.objects.prefetch_related('books').all()
for author in authors:
    print(author.books.all())  # already loaded in memory
```

> No exceptions worth taking: "it's only a few items," "the query is fast," and "we'll cache it later" are the three most common — and most invalid — justifications for a query in a loop. Data grows; the pattern doesn't scale with it.

### 2.4 Dynamic vs. Static Loading

- **Lazy-load** anything not required for the critical path: route-based code splitting, dynamic `import()`, deferred below-the-fold assets.
- **Eager-load** only what's needed for first meaningful render or first response.
- **Tree-shake:** import the specific function you need (`import debounce from 'lodash/debounce'`), not an entire library namespace, so bundlers can eliminate the rest.

### 2.5 Concurrency, Async Execution & Non-Blocking I/O

- Anything touching the network, disk, or another process **MUST** be async/non-blocking — never block an event loop or UI thread waiting on I/O.
- Prefer **structured concurrency** (`Promise.all` / `asyncio.gather` & `TaskGroup` / Kotlin `coroutineScope` / Go's goroutines+channels) over manually managed threads or ad hoc callbacks: a child task's lifetime should be bound to its parent scope, and an error in one branch should propagate rather than vanish silently.
- Every promise/future/task **MUST** have its rejection or error handled — no unhandled rejections, and no swallowed exceptions in "fire-and-forget" calls.
- Guard shared mutable state explicitly (locks, atomics, actor/message-passing) — or better, avoid sharing mutable state across concurrent units entirely.
- Add timeouts and cancellation to anything that can hang: network calls, subprocess execution, long-running queries.

```javascript
// ❌ Don't: sequential awaits force three independent calls to run one after another
const user = await fetchUser(id);
const orders = await fetchOrders(id);
const invoices = await fetchInvoices(id);

// ✅ Do: independent requests run concurrently, bounded by one structured call
const [user, orders, invoices] = await Promise.all([
  fetchUser(id),
  fetchOrders(id),
  fetchInvoices(id),
]);
```

---

## 3. Software Architecture & Structure

### 3.1 Separation of Concerns

Typical layering (names vary by stack, the boundary is what matters):

`Presentation / UI` → `Application / Business Logic` → `Domain` → `Data Access / Infrastructure`

- UI components render state and dispatch intents. They **do not** contain business rules or call a database/API client directly — they call a service, hook, or controller.
- Business logic doesn't know about HTTP, SQL, or the DOM. It operates on plain domain objects, which is what makes it unit-testable without spinning up a framework.
- Data access sits behind a repository/service interface, so swapping databases or adding a cache doesn't ripple into business logic.

**Architecture-scale note (2026 industry consensus):** default to a well-modularized single deployable unit — a **modular monolith** with strictly enforced internal module boundaries and no cross-module database access — until a specific, demonstrated need (independent scaling, independent deploy cadence, genuine team-autonomy boundaries) justifies extracting a service. Industry surveys have shown a large share of teams that adopted microservices early are now consolidating back into modular monoliths, because splitting preemptively trades a tangled-code problem for a harder distributed-systems problem (network partitions, eventual consistency, cross-service tracing) before the organization actually needed those tradeoffs. Extract a service when you have outgrown the monolith, not in anticipation of outgrowing it.

### 3.2 Type Safety & Boundary Validation

- Enable strict type-checking wherever the language supports it (TypeScript `strict: true`, `mypy`/`pyright` for Python, etc.). Escape hatches (`any`, `# type: ignore`) are allowed only in narrow, explicitly commented exceptions.
- Compile-time types describe shape; they say nothing about data your program didn't produce itself. **Parse and validate all external input** — API request bodies, query params, environment variables, third-party responses, file uploads — against a schema at the exact point it enters the system. Don't just cast it and hope.
- Once data is validated at the boundary, treat it as trusted for the rest of the call — don't re-validate the same object at every layer down the stack.
- Never trust client-side validation alone; it's a UX convenience, not a security control. Re-validate server-side.

```typescript
// ❌ Don't: trusting the shape of external data with a cast, not a check
function createUser(req: Request) {
  const body = req.body as { email: string; age: number };
  db.users.insert(body);
}

// ✅ Do: parse and validate at the boundary; the compiler and the runtime agree
const CreateUserSchema = z.object({
  email: z.string().email(),
  age: z.number().int().min(0).max(150),
});

function createUser(req: Request) {
  const body = CreateUserSchema.parse(req.body); // throws a clear, structured error if invalid
  db.users.insert(body);
}
```

### 3.3 Error Handling Strategy

- Distinguish **programmer errors** (bugs — broken invariants, invalid internal state) from **operational errors** (expected failures — a timeout, bad user input, a third-party outage). Fail fast and loud on the former; handle the latter gracefully with a defined recovery path.
- Use typed/custom error classes carrying context (what failed, relevant IDs) — not bare strings.
- **Never swallow an error silently.** An empty `catch` block is a bug factory. At minimum, log with context; usually also re-throw, return a typed failure, or surface it to the user.
- Handle errors close to where you have enough context to act, and keep one centralized boundary (global handler / middleware / error boundary) to catch what falls through.
- Don't use exceptions for expected control flow (e.g., "not found" in a lookup that's expected to sometimes miss) — return an explicit result or optional type instead.

```javascript
// ❌ Don't: silent failure, no context, error type discarded
try {
  await chargeCard(order);
} catch (e) {
  console.log('error');
}

// ✅ Do: typed error, contextual logging, explicit handling path
try {
  await chargeCard(order);
} catch (error) {
  if (error instanceof CardDeclinedError) {
    return { status: 'declined', reason: error.reason };
  }
  logger.error('Payment charge failed', { orderId: order.id, error });
  throw new PaymentProcessingError(order.id, { cause: error });
}
```

### 3.4 Defensive Programming

- Use **guard clauses** to handle invalid or edge cases first and return early, instead of nesting the happy path inside multiple `if` blocks.
- Treat `null` / `undefined` / `None` as something to check for explicitly at boundaries, not something to assume away.
- Validate preconditions of non-trivial functions. Use assertions for states that should be provably impossible, so they fail loudly instead of corrupting data silently downstream.
- Defensive code should surface bugs faster, not hide them — a blanket `try/catch` that swallows everything removes the exact signal you need to find the problem.

```javascript
// ❌ Don't: happy path buried three levels deep
function getDiscount(user) {
  if (user) {
    if (user.subscription) {
      if (user.subscription.active) {
        return user.subscription.discountRate;
      }
    }
  }
  return 0;
}

// ✅ Do: guard clauses, flat and readable
function getDiscount(user) {
  if (!user?.subscription?.active) return 0;
  return user.subscription.discountRate;
}
```

### 3.5 Immutability & State Management

- Default to immutable data; make mutability an explicit, deliberate choice (`const` by default, `readonly` / `Object.freeze` / `final` / frozen dataclasses where the language offers them).
- Don't mutate function parameters or shared objects — return new values instead. This keeps data flow traceable and eliminates an entire class of "who changed this, and when" bugs.
- Keep state changes explicit and centralized (single source of truth per piece of state, unidirectional data flow) rather than scattering mutable globals that many call sites write to.

```javascript
// ❌ Don't: mutates an object the caller still holds a reference to
function addItem(cart, item) {
  cart.items.push(item);
  return cart;
}

// ✅ Do: return a new object; the caller's original reference is untouched
function addItem(cart, item) {
  return { ...cart, items: [...cart.items, item] };
}
```

---

## 4. AI Agent Guardrails (Execution Constraints)

This section is written directly to any AI coding agent operating on this repository. It is enforced in addition to, not instead of, Sections 1–3.

### 4.1 Zero Tolerance for Incomplete Code ("Slop")

Confident-but-incomplete AI output is a recognized failure mode with its own tooling now built specifically to catch it. Never produce any of the following in code you present as a finished change:

| Category | Forbidden Examples |
|---|---|
| Placeholder comments | `// TODO: implement this`, `# FIXME later`, `/* placeholder */` |
| Elisions | `// ... rest of the code remains the same`, `// same as before`, `// add more cases as needed`, `// etc.` |
| Stub bodies | Empty function bodies, `throw new Error('Not implemented')`, `pass  # implement later`, `todo!()` |
| Hedged or deferred logic | "This should work for most cases," "assumes valid input," "for now, just use..." |
| Fabricated completeness | Truncating a file, class, or function while implying the change is done |

**Rule:** if a function is in scope for the change, it ships complete and runnable — or you state explicitly and specifically what's missing and why (e.g., genuinely blocked on a missing credential or an unanswered design question). You never simulate completeness to make an output *look* finished.

### 4.2 Context Discipline

- More context is not automatically better. An agent handed a large, unfocused context window can perform *worse* than one handed a small, targeted one — retrieve what the current task needs, not the entire repository.
- Prefer a small number of durable, high-signal instruction files (this file, or a root-level `AGENTS.md`/`CLAUDE.md`) over duplicating rules across many tool-specific configs.
- Document stable domain concepts and capabilities in project instructions — not brittle specifics like exact file paths or line numbers, which drift and will mislead a future session. Rediscover current structure by reading the code rather than trusting a stale map.
- In a long session, summarize or offload completed sub-tasks rather than dragging the full history forward indefinitely.

### 4.3 Surgical Edits & Minimal Diffs

- Read the actual file(s) before editing — never patch blind from assumption or a similar-looking file elsewhere.
- Change only what the request requires. Don't reformat, rename, reorder imports, or "clean up" unrelated code in the same diff — bundling unrelated changes hides the real change and creates unnecessary review burden and merge conflicts.
- Match the codebase's existing style, naming, and idioms, even where you would personally choose differently. Consistency beats individual preference.
- Preserve existing comments, license headers, and structure unless they're incorrect or the user explicitly asked for them to change.
- Treat public/exported interfaces as contracts. If a change must break one, say so explicitly — never silently change a signature other code depends on.

### 4.4 Verification Protocol — Before Returning Any Code

Non-negotiable, in order:

1. **Compiles/parses/typechecks cleanly** — mentally trace it if you cannot execute it directly.
2. **No hallucinated dependencies** — every import, package, and API call referenced actually exists in this project's ecosystem. An invented package name that someone installs unverified is a real supply-chain risk (known in the industry as "slopsquatting"); this is treated as a correctness bug, not a style nitpick.
3. **Edge cases traced by hand** — at minimum: empty input, null/undefined, zero, maximum size, and concurrent access where relevant.
4. **Tests reflect the change** — new or changed behavior is covered, and existing tests would still pass.
5. **Scope discipline** — the diff matches the request exactly: nothing extra changed, nothing requested left out.
6. **No secrets or environment-specific values** hardcoded into the change.
7. **Adversarial self-review** — read the output once more as a skeptical reviewer encountering it cold, not as its author. Fluent and confident is not the same thing as correct; AI-generated code is reviewed *more* carefully than average specifically because its confident tone otherwise disarms reviewers.

### 4.5 Workflow: Research → Plan → Implement → Verify

For anything beyond a trivial, single-line change, prefer this loop over jumping straight to code:

1. **Research** — read the relevant files, existing patterns, and tests before proposing anything.
2. **Plan** — state the intended approach and the files you expect to touch; for larger changes, surface the plan before editing.
3. **Implement** — make the smallest correct change that satisfies the plan.
4. **Verify** — run through §4.4 before presenting the result.

This mirrors how experienced engineers actually work, and it avoids the most common agentic failure mode: confidently reorganizing a codebase around a misunderstanding formed in the first few seconds of the task.

### 4.6 Communication Protocol

- When a requirement is ambiguous, state the assumption you're proceeding under in one line rather than silently guessing — or stalling entirely on a question that doesn't need to block progress.
- Flag meaningful tradeoffs (performance vs. readability, a breaking change, a new dependency) instead of deciding unilaterally and staying quiet about it.
- Summarize *what* changed and *why* in plain terms. The diff already shows *what* — your summary earns its place by explaining *why*, especially for any non-obvious decision.

---

## Appendix A: Condensed Cheat Sheet

| Area | Do | Don't |
|---|---|---|
| Naming | Descriptive, role-revealing names | `data`, `temp`, `handleStuff`, single letters outside tiny scopes |
| Functions | One responsibility, ≤~40 lines, ≤3 params | Multi-purpose functions, long positional parameter lists |
| Comments | Explain *why*; document non-obvious rules | Restate *what* the code already says; leave dead code commented out |
| Loops + DB | Batch/join/eager-load once | Query inside a loop (N+1) |
| Caching | Bounded (TTL/LRU) with clear invalidation | Unbounded global caches |
| Async | `Promise.all`/structured concurrency; handle every rejection | Sequential awaits for independent work; unhandled rejections |
| Errors | Typed errors, handled or logged with context | Empty `catch` blocks; exceptions used for expected control flow |
| Input | Validate/parse at every system boundary | Cast external data and assume it's correct |
| State | Immutable by default; return new values | Mutate shared objects or function parameters in place |
| Architecture | Modular monolith by default; extract services when justified | Microservices from day one "for scale" with no demonstrated need |
| AI output | Complete, runnable, verified code every time | Placeholders, stubs, "rest of the code," hallucinated packages |
| Edits | Smallest correct diff; match existing style | Drive-by refactors bundled into an unrelated change |

---

## Appendix B: Compatibility With Other Agent Config Formats

This file is written to double as project context for any AI coding agent, regardless of tool. If your toolchain uses a different convention:

- **`AGENTS.md`** — an open, tool-agnostic Markdown standard (now stewarded by the Agentic AI Foundation under the Linux Foundation) read by Cursor, GitHub Copilot, OpenAI Codex, Google Jules, Aider, Windsurf, Zed, and others. If this project has one, it should be the single source of truth; this file's rules can be copied there or referenced from it.
- **`CLAUDE.md`**, **`.cursorrules`**, **`.windsurfrules`** — tool-specific files. Prefer pointing them at this file (or at `AGENTS.md`) rather than duplicating rules in multiple places, since duplicated rules drift out of sync as the project evolves.

Whichever file an agent reads first, the content and priority of the rules should be identical.
