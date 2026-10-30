import { autocompletion, closeBrackets, closeBracketsKeymap, completeFromList } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { type Diagnostic, linter, lintGutter, lintKeymap } from '@codemirror/lint';
import { EditorState, type Extension, type Text } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { type RefObject, useEffect, useRef } from 'react';
import { api } from '@/api/http';
import type { ScenarioCheck, ScenarioDiagnostic } from '@/api/types';
import { dslParser, KEYWORDS } from '@/lib/dsl';
import { cn } from '@/lib/utils';

/** Debounce of the server-side check after the last keystroke. */
export const CHECK_DELAY_MS = 400;

const language = StreamLanguage.define(dslParser);

/*
 * Syntax colors reuse the console's tokens: keywords in ink, strings in the CSMS-direction green, OCPP actions and
 * enum values in the station-direction blue, comments muted. Nothing here borrows a status or violation hue.
 */
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--foreground)', fontWeight: '650' },
  { tag: t.comment, color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: t.string, color: 'var(--in)' },
  { tag: t.special(t.string), color: 'var(--in)', fontWeight: '650' },
  { tag: [t.number, t.unit, t.atom], color: 'var(--st-finishing)' },
  { tag: t.typeName, color: 'var(--out)' },
  { tag: t.propertyName, color: 'var(--muted-foreground)' },
  { tag: [t.bracket, t.punctuation], color: 'var(--muted-foreground)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--card)', color: 'var(--card-foreground)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--foreground)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-gutters': {
    backgroundColor: 'var(--panel)',
    color: 'var(--muted-foreground)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--accent) 45%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--accent)', color: 'var(--foreground)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklab, var(--ring) 28%, transparent) !important',
  },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent)', outline: '1px solid var(--border)' },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--violation)',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px',
  },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--st-suspendedev)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
  },
  '.cm-tooltip-lint': { fontFamily: 'var(--font-sans)', fontSize: '12px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--violation)' },
  '.cm-diagnostic-warning': { borderLeft: '3px solid var(--st-suspendedev)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-foreground)',
  },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
});

/** A 1-based line/column from the server to a document offset, clamped to the document. */
export function toOffset(doc: Text, line: number, col: number): number {
  const l = doc.line(Math.min(Math.max(line, 1), doc.lines));
  return Math.min(l.from + Math.max(col, 1) - 1, l.to);
}

export function toDiagnostics(doc: Text, ds: ScenarioDiagnostic[]): Diagnostic[] {
  return ds.map((d) => {
    const from = toOffset(doc, d.line, d.col);
    const to = Math.max(from, toOffset(doc, d.endLine, d.endCol));
    return { from, to, severity: d.severity, message: d.message, source: 'wattsim check' };
  });
}

export function ScenarioEditor({
  docKey,
  initial,
  onChange,
  onCheck,
  words,
  viewRef,
  onSave,
  className,
}: {
  /** A new key replaces the document (another scenario loaded); edits within one key keep undo history. */
  docKey: string;
  initial: string;
  onChange: (text: string) => void;
  /** Every server check result, or the error that stopped it. */
  onCheck?: (r: ScenarioCheck | Error) => void;
  /** Extra completions (OCPP action names). */
  words: readonly string[];
  viewRef?: RefObject<EditorView | null>;
  onSave?: () => void;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  // Callbacks change every render; the editor reads the latest through refs instead of being rebuilt.
  const cb = useRef({ onChange, onCheck, onSave });
  cb.current = { onChange, onCheck, onSave };
  const wordsKey = words.join(' ');
  // The text under the current key, so a rebuild for new completions keeps the edits.
  const last = useRef<{ key: string; text: string } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt only for a new document or completion list
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const completions = [
      ...[...KEYWORDS].map((label) => ({ label, type: 'keyword' })),
      ...words.map((label) => ({ label, type: 'type' })),
    ];
    const check = linter(
      async (view) => {
        const doc = view.state.doc;
        try {
          const r = await api.checkScenario(doc.toString());
          cb.current.onCheck?.(r);
          // The document moved on while the request was out: the next lint pass covers it.
          if (view.state.doc !== doc) return [];
          return toDiagnostics(doc, r.diagnostics);
        } catch (e) {
          cb.current.onCheck?.(e instanceof Error ? e : new Error(String(e)));
          return [];
        }
      },
      { delay: CHECK_DELAY_MS },
    );
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      indentOnInput(),
      indentUnit.of('  '),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      language,
      syntaxHighlighting(highlight),
      autocompletion({ override: [completeFromList(completions)] }),
      check,
      lintGutter(),
      theme,
      placeholder('wattsim 1\n\nstation "CP-1" { … }'),
      EditorView.lineWrapping,
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            cb.current.onSave?.();
            return true;
          },
        },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...lintKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        const text = u.state.doc.toString();
        last.current = { key: docKey, text };
        cb.current.onChange(text);
      }),
      EditorView.contentAttributes.of({ 'aria-label': 'Scenario source' }),
    ];
    const doc = last.current?.key === docKey ? last.current.text : initial;
    last.current = { key: docKey, text: doc };
    const view = new EditorView({ state: EditorState.create({ doc, extensions }), parent: el });
    if (viewRef) viewRef.current = view;
    return () => {
      if (viewRef) viewRef.current = null;
      view.destroy();
    };
  }, [docKey, wordsKey]);

  return <div ref={host} className={cn('min-h-0 overflow-hidden', className)} />;
}

/** Replace the whole document as one undoable change, keeping the cursor near where it was. */
export function replaceDoc(view: EditorView, text: string): void {
  const head = Math.min(view.state.selection.main.head, text.length);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: head } });
}
