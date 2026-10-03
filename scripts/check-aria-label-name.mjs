#!/usr/bin/env node
/**
 * WCAG 2.5.3 (Label in Name) static gate.
 *
 * Binding rule (AGENTS.md § "Accessibility & locators"): an
 * interactive element's aria-label must BEGIN with — and therefore
 * contain — its visible text. Playwright locators and voice-control
 * engines resolve controls by accessible name, so a label that
 * replaces the visible text with a synonym ("Créer un bon de
 * commande…" on a button showing "Créer PO") breaks both WCAG 2.5.3
 * and getByRole('button', { name: /<visibleText>/i }) locators.
 *
 * This gate scans every .tsx file under src/ with the
 * flags every <button>/<a>/[role="button"] that has BOTH an
 * aria-label AND static visible text (>2 chars) where the visible
 * text is not a case-insensitive substring of any static chunk of
 * the aria-label expression. Ternary branches and template-literal
 * chunks all count, so state-aware labels
 * (detailsOpen ? `Masquer lignes de …` : `Voir détails de …`)
 * pass by construction.
 *
 * Sanctioned exceptions (by construction — no suppression comments):
 *  - icon-only controls (no visible text) — descriptive label only.
 *  - glyph-only controls (every variant ≤2 chars: ⌫, ‹, ✕, digits) —
 *    the glyph node must be aria-hidden with a descriptive label.
 *  - elements without aria-label (accessible name derives from content).
 *  - <input> fields: the visible <label> is a sibling, not a child —
 *    association is dataflow beyond JSX children and is covered by the
 *    Playwright suites instead.
 *
 * No ESLint/eslint-plugin-jsx-a11y in this repo (linter is oxlint,
 * which has no a11y rule set; the plugin itself ships no 2.5.3 rule),
 * so this standalone gate is the enforcement point.
 *
 * Usage: node scripts/check-aria-label-name.mjs (wired into test:boundaries)
 * Exit: 0 = clean, 1 = violation(s) found
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const INTERACTIVE_TAGS = new Set(['button', 'a']);
/** Shortest visible string treated as a real label (glyphs/digits are ≤2). */
const MIN_VARIANT_LEN = 3;

function collectTsx(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) collectTsx(p, out);
    else if (e.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * Static string chunks of an expression: string literals, template
 * literal chunks, and every branch of ternaries / logical operators.
 */
function stringChunks(node, out = []) {
  if (!node) return out;
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      out.push(node.text);
      break;
    case ts.SyntaxKind.TemplateExpression: {
      out.push(node.head.text);
      for (const span of node.templateSpans) {
        stringChunks(span.expression, out);
        out.push(span.literal.text);
      }
      break;
    }
    case ts.SyntaxKind.ConditionalExpression:
      stringChunks(node.whenTrue, out);
      stringChunks(node.whenFalse, out);
      break;
    case ts.SyntaxKind.BinaryExpression:
      if (
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken
      ) {
        stringChunks(node.left, out);
        stringChunks(node.right, out);
      }
      break;
    case ts.SyntaxKind.ParenthesizedExpression:
      stringChunks(node.expression, out);
      break;
    default:
      break;
  }
  return out;
}

/** Visible text variants of a JSX subtree: JSXText plus static string
 *  literals from expression children (ternaries, templates). */
function visibleVariants(node, out = []) {
  if (!node) return out;
  switch (node.kind) {
    case ts.SyntaxKind.JsxText: {
      const t = node.text.replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
      break;
    }
    case ts.SyntaxKind.JsxExpression:
      stringChunks(node.expression, out);
      break;
    case ts.SyntaxKind.JsxElement:
      for (const c of node.children) visibleVariants(c, out);
      break;
    default:
      break;
  }
  return out;
}

function tagNameText(tagName) {
  return ts.isIdentifier(tagName) ? tagName.text : '';
}

function checkElement(tagName, attrs, children, pos, sf, rel) {
  const tag = tagNameText(tagName);
  let role = null;
  let labelChunks = [];
  for (const attr of attrs) {
    if (!ts.isJsxAttribute(attr)) continue;
    const name = attr.name.text;
    const init = attr.initializer;
    if (name === 'role' && init && ts.isStringLiteral(init)) role = init.text;
    if (name === 'aria-label' && init) {
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
        labelChunks = [init.text];
      } else if (ts.isJsxExpression(init)) {
        labelChunks = stringChunks(init.expression);
      }
    }
  }
  const interactive = INTERACTIVE_TAGS.has(tag) || role === 'button';
  if (!interactive || labelChunks.length === 0) return;

  const raw = [];
  for (const c of children) visibleVariants(c, raw);
  const variants = [...new Set(raw.map((v) => v.replace(/\s+/g, ' ').trim()))].filter(
    (v) => v.length >= MIN_VARIANT_LEN,
  );
  if (variants.length === 0) return; // icon-only / glyph-only / fully dynamic

  const chunks = labelChunks.map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (chunks.length === 0) return;

  for (const v of variants) {
    const contained = chunks.some((c) => c.toLowerCase().includes(v.toLowerCase()));
    if (!contained) {
      const { line } = sf.getLineAndCharacterOfPosition(pos);
      console.error(
        `  [FAIL] ${rel}:${line + 1} <${tag}> visible "${v}" not contained in aria-label [${chunks.join(' | ')}]`,
      );
      violations += 1;
      break; // one report per element
    }
  }
}

let violations = 0;
const files = collectTsx(SRC);
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rel = file.slice(ROOT.length + 1);
  const walk = (node) => {
    if (ts.isJsxElement(node)) {
      checkElement(
        node.openingElement.tagName,
        node.openingElement.attributes.properties,
        node.children,
        node.pos,
        sf,
        rel,
      );
      for (const c of node.children) walk(c);
    } else if (ts.isJsxSelfClosingElement(node)) {
      checkElement(node.tagName, node.attributes.properties, [], node.pos, sf, rel);
    } else {
      ts.forEachChild(node, walk);
    }
  };
  walk(sf);
}

console.log('MOBIPOS — WCAG 2.5.3 LABEL-IN-NAME GATE');
console.log(`scanned ${files.length} .tsx files under src/`);
if (violations > 0) {
  console.error(`\n${violations} Label-in-Name violation(s): aria-label must contain the visible text.`);
  process.exit(1);
}
console.log('  [PASS] every labeled interactive control contains its visible text');
