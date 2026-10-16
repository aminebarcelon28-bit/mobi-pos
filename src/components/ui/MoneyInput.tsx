// src/components/ui/MoneyInput.tsx — FINAL HANDOFF v3.1 (supersedes v3 + v2 reference)
// ---------------------------------------------------------------------------
// Option B (decoupled unit adornment) + defense-in-depth.
// v3 incorporates the handoff-pack blockers:
//   P0-1  Separate baselineRef (session baseline, anchored at focus) from
//         committedRef (dedupe anchor). Invalid blur NOW emits
//         onChangeMinor(baselineRef.current) — BUG-MONEY-06/07 rollback
//         semantics restored ("9500.abc" reverts to the pre-session value,
//         NOT to the last live-committed 9500).
//   P0-2  maxLength={16} restored (boundary Rule 1b greps for the literal).
//   P1    import "../../utils/money" (repo has no @ alias);
//         units memoized over a module-level DEFAULT_PASTE_TOKENS
//         (a per-render default array would destabilize the idle effect);
//         live aria-invalid restored (input-hardening :212,239,260,288
//         assert aria-invalid=true MID-TYPE);
//         aria-label fallback 'Montant (DA)' kept when no label;
//         onClear is EMPTY-ONLY and fires at BLUR (commit-time) — the
//         current repo contract (MoneyInput.tsx:185-189), keeping the
//         ProductEditorModal optional-field semantics byte-identical.
//
// v3.1 BUILD ADAPTATIONS (workspace-agent findings, all applied):
//   A1  import type { InputHTMLAttributes } — no UMD-global React
//       reference; survives verbatimModuleSyntax under tsc -b.
//   A2  onClear moved back to blur-time (owner decision confirmed).
//   A3  selectOnFocus uses requestAnimationFrame: mobile keyboards can
//       undo a synchronous select() during focus; one frame later it sticks.
//   A4  preParse EXTRACTED to src/utils/preparse.ts (node --experimental-
//       strip-types cannot import .tsx — JSX is not type-strippable), and
//       re-exported below for convenience.
//
// OWNER DECISIONS: D-1 live-commit + Enter→blur (preventDefault);
// D-2 className fused ON the <input> as `money-input__field ${className}`;
// D-3 AGENTS.md-compliant names, label dedupe ("… (DA)" not re-suffixed).
//
// DOM INVARIANTS — the live region MUST remain (a) a direct child of
// .money-input-container and (b) a following-sibling of .money-input__control,
// and the unit span must NEVER carry aria-live. These three facts keep BOTH
// existing echo-locator families working UNCHANGED:
//   xpath=../following-sibling::span[@aria-live="polite"]   (input-hardening)
//   xpath=../../span[@aria-live="polite"]                   (tradein suites)
// Do not "simplify" the nesting without re-running those suites.
//
// FROZEN: src/utils/money.ts, src-tauri/src/money.rs (byte-identical).
// Accessors: Money.fromUserInput(x).toMinor(); Money.fromMinor(n).format().
// ---------------------------------------------------------------------------

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type FocusEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import type { InputHTMLAttributes } from "react"; // A1: type-only named import — no UMD-global namespace reference
import { Money } from "../../utils/money"; // no @ alias in this repo
import { preParse } from "../../utils/preparse"; // A4: imported, not defined locally

export { preParse }; // re-export: tests / boundary scripts import from here

/* ------------------------------------------------------------------ *
 * escapeRegExp stays local: used by the aria-label unit-dedup below.
 * (preParse itself now lives in src/utils/preparse.ts — see A4. The
 * Arabic-separator prohibition travels with it: money.ts:101-139 owns
 * all digit/separator tolerance; a client-side ٬ (U+066C, THOUSANDS)
 * remap would corrupt "٢٬٠٠٠" (2000 DA) into 2.000 (2 DA).)
 * ------------------------------------------------------------------ */

const DEFAULT_PASTE_TOKENS = ["DZD", "دج"] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Idle display: format() minus the unit (money.ts stays frozen). */
function editableEcho(minor: number, units: readonly string[]): string {
  return preParse(Money.fromMinor(minor).format(), units) || "0.00";
}

/* ------------------------------------------------------------------ *
 * Props — "type" omitted & pinned in render; ref redeclared (the Omit
 * chain drops it under React 19 ref-as-prop).
 * ------------------------------------------------------------------ */

export interface MoneyInputProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "value" | "defaultValue" | "onChange" | "aria-label" | "type"
  > {
  /** Controlled baseline, integer minor units. */
  valueMinor: number;
  /** D-1: fires on every parseable keystroke; on invalid blur the session
   *  baseline is re-emitted (P0-1 rollback). */
  onChangeMinor: (minor: number) => void;
  /** Visible-label text, verbatim; " — DA" appended only if unit absent. */
  label?: string;
  /** EMPTY-ONLY clear signal, fired at BLUR (commit-time) — repo contract. */
  onClear?: () => void;
  /** Select-all on focus (POS type-over). Anchor before first live commit. */
  selectOnFocus?: boolean;
  /** Currency unit for the non-editable adornment. Default "DA". */
  unit?: string;
  /** Extra trailing tokens stripped from pasted text. */
  pasteTokens?: readonly string[];
  /** Container classes (className itself lands on the <input> — D-2). */
  wrapperClassName?: string;
  /** React 19 ref-as-prop; forwarded to the inner <input>. */
  ref?: Ref<HTMLInputElement>;
}

export function MoneyInput({
  valueMinor,
  onChangeMinor,
  label,
  onClear,
  selectOnFocus = false,
  unit = "DA",
  pasteTokens = DEFAULT_PASTE_TOKENS,
  wrapperClassName,
  ref,
  className,
  onFocus,
  onBlur,
  onKeyDown,
  ...rest // id, data-testid, placeholder, disabled, maxLength(!) — Rule 1b
          // requires the LITERAL maxLength={16} below, which overrides any
          // consumer-passed value by design.
}: MoneyInputProps) {
  const units = useMemo(() => [unit, ...pasteTokens], [unit, pasteTokens]);
  const liveId = useId() + "-live";

  const localRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  /** P0-1: rollback target — anchored at focus, updated only when idle. */
  const baselineRef = useRef(valueMinor);
  /** P0-1: dedupe anchor for onChangeMinor — advances with each emit. */
  const committedRef = useRef(valueMinor);

  const [focused, setFocused] = useState(false);
  const [buffer, setBuffer] = useState<string>(() => editableEcho(valueMinor, units));
  const [rejected, setRejected] = useState(false);
  const [invalid, setInvalid] = useState(false); // live, mid-type (P1)

  const setRef = (node: HTMLInputElement | null) => {
    localRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) (ref as { current: HTMLInputElement | null }).current = node;
  };

  // Idle-only prop → buffer sync (the clobber guard). A parent re-render
  // mid-typing (totals recalc, store subscription) must never overwrite the
  // caret. Display normalization happens exclusively here.
  useEffect(() => {
    if (focused) return;
    baselineRef.current = valueMinor;
    committedRef.current = valueMinor;
    setBuffer(editableEcho(valueMinor, units));
  }, [valueMinor, focused, units]);

  /** preParse + the frozen parser. null ⇒ uncommittable. Never throws. */
  const tryParse = (raw: string): number | null => {
    try {
      return Money.fromUserInput(preParse(raw, units)).toMinor();
    } catch {
      return null;
    }
  };

  /** D-1 live pipeline — runs on every keystroke (unless composing). */
  const runLivePipeline = (raw: string) => {    const cleaned = preParse(raw, units).trim();
    if (cleaned === "") {
      // Empty mid-edit = clear gesture in progress, not garbage; the clear
      // signal fires at blur (A2). Live commit stays silent here.
      setInvalid(false);
      return;
    }
    const minor = tryParse(raw);
    setInvalid(minor === null); // live aria-invalid (input-hardening :212+)
    if (minor !== null && minor !== committedRef.current) {
      committedRef.current = minor;
      onChangeMinor(minor);
    }
  };

  /* ------------- event handlers (consumer first, ours after) ------------- */

  const handleFocus = (e: FocusEvent<HTMLInputElement>) => {
    onFocus?.(e);
    if (e.defaultPrevented) return;
    baselineRef.current = valueMinor; // P0-1: anchor BEFORE first live commit
    committedRef.current = valueMinor; // defensive sync if parent transformed
    setFocused(true);
    setRejected(false);
    setInvalid(false);
    // A3: rAF, not sync — mobile keyboards can undo a synchronous select().
    if (selectOnFocus) requestAnimationFrame(() => localRef.current?.select());
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    setBuffer(e.target.value); // verbatim mirror — NEVER rewritten while typing
    setRejected(false);
    if (!composingRef.current) runLivePipeline(e.target.value);
  };

  // IME protocol (Arabic): composition text is provisional — mirror verbatim
  // (rewriting mid-composition is what breaks IMEs), parse once it settles.
  const handleCompositionStart = () => {
    composingRef.current = true;
  };

  const handleCompositionEnd = (e: CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    runLivePipeline(e.currentTarget.value);
  };

  const commit = () => {
    const cleaned = preParse(buffer, units).trim();
    if (cleaned === "") {
      // A2: cleared field → onClear at blur (repo contract). With no onClear
      // handler this is a silent baseline resync via the idle effect.
      if (onClear) onClear();
      setRejected(false);
    } else {
      const minor = tryParse(buffer);
      if (minor === null) {
        // P0-1 / BUG-MONEY-06/07: ACTIVE rollback to the session baseline.
        if (committedRef.current !== baselineRef.current) {
          onChangeMinor(baselineRef.current);
          committedRef.current = baselineRef.current;
        }
        setRejected(true); // "Saisie rejetée – montant inchangé"
      } else {
        if (minor !== committedRef.current) {
          committedRef.current = minor;
          onChangeMinor(minor);
        }
        setRejected(false);
      }
    }
    setInvalid(false);
    setFocused(false); // idle effect restores/normalizes the display
  };

  const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
    onBlur?.(e);
    if (e.defaultPrevented) return;
    commit();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e); // consumer sees Enter first
    if (e.key !== "Enter" || e.defaultPrevented || composingRef.current) return;
    e.preventDefault(); // never let a half-committed field submit the modal
    e.currentTarget.blur(); // SINGLE commit path: the blur handler
  };

  /* ------------------------------- render ------------------------------- */

  // C-2 entry-echo norm: while editing, a parseable buffer shows its canonical
  // interpretation live ("12." → "= 12.00 DA") so a grouping mis-parse is
  // VISIBLE before commit. Idle buffers stay quiet (as before — the old
  // display-suffixed text never parsed); rejections never carry an amount.
  const echoMinor = tryParse(buffer);
  const showEcho = focused && !rejected && echoMinor !== null;

  // D-3 / WCAG 2.5.3: aria-label starts with the visible label verbatim;
  // the unit is appended only when the visible text doesn't already end
  // with "(DA)" or "DA". Fallback preserves the current :150 default.
  const unitMentioned = label
    ? new RegExp(`(?:\\(${escapeRegExp(unit)}\\)|${escapeRegExp(unit)})\\s*$`, "i").test(label)
    : false;

  return (
    <div className={`money-input-container${wrapperClassName ? " " + wrapperClassName : ""}`}>
      <div className="money-input__control">
        <input
          {...rest}
          ref={setRef}
          className={`money-input__field${className ? " " + className : ""}`}
          type="text" /* pinned: type="number" spins/wheel-edits/"1e5" */
          inputMode="decimal" /* numeric keypad on touch POS */
          dir="ltr" /* digit runs stay LTR under RTL locales */
          autoComplete="off"
          spellCheck={false}
          maxLength={16} /* P0-2: Rule 1b literal — do not remove */
          value={buffer}
          onFocus={handleFocus}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          aria-label={label ? (unitMentioned ? label : `${label} — ${unit}`) : "Montant (DA)"}
          aria-invalid={invalid || rejected || undefined}
          aria-describedby={rejected ? liveId : undefined}
        />
        {/* NEVER give this span aria-live — it is a following-sibling of the
            input and would collide with the echo locator families. */}
        <span aria-hidden="true" className="money-input__unit">
          {unit}
        </span>
      </div>
      {/* DOM INVARIANT: direct child of the container + following-sibling of
          __control — 7 locators depend on span[@aria-live="polite"] here. */}
      <span id={liveId} aria-live="polite" className="money-input__live">
        {rejected ? (
          <span role="alert" className="money-input__error">
            Saisie rejetée – montant inchangé
          </span>
        ) : showEcho ? (
          <span className="money-input__echo">= <bdi dir="ltr">{Money.fromMinor(echoMinor).format()}</bdi></span>
        ) : null}
      </span>
    </div>
  );
}
