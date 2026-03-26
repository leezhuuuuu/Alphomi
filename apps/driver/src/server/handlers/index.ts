import { BrowserSession } from '../core/session';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ScopeHint, ToolExecutionResult, StoredVisualInspection, VisualInspectionPageState } from '../../types/protocol';
import { TOOLS, ToolName } from '../../common/tools';
import { loadConfigFromYaml } from '../../common/config';
import { v4 as uuidv4 } from 'uuid';
import { marked } from 'marked';
import { createHash } from 'crypto';
import { setRenderDoc } from '../render_store';
import { inspectVisualCandidates } from '../core/visual_inspector';
import { askVisualQuestion } from '../core/visual_qa';

loadConfigFromYaml('driver');

const AUTO_SNAPSHOT_FULL = process.env.AUTO_SNAPSHOT_FULL === 'true';
const DEFAULT_SNAPSHOT_FULL = process.env.DEFAULT_SNAPSHOT_FULL === 'true';
const DEFAULT_NEW_TAB_URL = process.env.NEW_TAB_URL || 'https://www.google.com';
const CODE_INPUT_VERIFY_RETRIES = 2;
const CODE_INPUT_VERIFY_SETTLE_MS = 120;
const POINT_VERIFY_TIMEOUT_MS = 1500;
const POINT_VERIFY_POLL_MS = 150;
const NORMALIZED_COORDINATE_MAX = 1000;

type InputKind = 'normal' | 'code';
type FocusTarget = { kind: 'locator'; locator: any } | { kind: 'point'; xCss: number; yCss: number };
type InteractionState = {
  url: string;
  title: string;
  activeTag: string;
  activeRole: string;
  activeValueHash: string;
  bodyTextHash: string;
};
type PointResolution = {
  xCss: number;
  yCss: number;
  viewport: VisualInspectionPageState;
};

// 统一处理函数签名
type Handler = (session: BrowserSession, args: any) => Promise<ToolExecutionResult>;

const normalizeLineEndings = (value: string | null | undefined): string => (value ?? '').replace(/\r\n/g, '\n');
const normalizeActionText = (value: string | null | undefined): string => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
const SUBMIT_ACTION_LABELS = new Set([
  'post',
  'save',
  'submit',
  'confirm',
  'apply',
  'create',
  'update',
  'publish',
  'send',
  'done',
  'ok',
]);
const COMPOSER_TRIGGER_ACTION_LABELS = new Set(['reply', 'edit', 'comment', 'respond']);

const previewText = (value: string, max = 120): string => {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
};

const snapshotLooksUnchanged = (snapshot: string | null | undefined): boolean =>
  typeof snapshot === 'string' && snapshot.includes('# Snapshot Unchanged');

const formatScopedSubmitCandidates = (candidates: string[] | null | undefined): string => {
  if (!candidates || candidates.length === 0) {
    return '';
  }
  return `; local submit candidates: ${candidates.join(', ')}`;
};

const compactScopeHint = (scopeHint: ScopeHint | null | undefined): ScopeHint | null => {
  if (!scopeHint) {
    return null;
  }

  const nextActionHints = scopeHint.nextActionHints?.filter((candidate) => !!candidate.descriptor) || [];
  const nearbyConfusers = scopeHint.nearbyConfusers?.filter((candidate) => !!candidate.descriptor) || [];
  const contextAnchors = scopeHint.contextAnchors?.filter((anchor) => anchor.trim().length > 0) || [];
  const submitCandidates = scopeHint.submitCandidates?.filter((candidate) => candidate.trim().length > 0) || [];

  return {
    scopeId: scopeHint.scopeId,
    scopeKind: scopeHint.scopeKind,
    scopeDescriptor: scopeHint.scopeDescriptor,
    inputDescriptor: scopeHint.inputDescriptor,
    submitCandidates: submitCandidates.length > 0 ? submitCandidates : undefined,
    contextAnchors: contextAnchors.length > 0 ? contextAnchors : undefined,
    resolvedTarget: scopeHint.resolvedTarget,
    nextActionHints: nextActionHints.length > 0 ? nextActionHints : undefined,
    nearbyConfusers: nearbyConfusers.length > 0 ? nearbyConfusers : undefined,
  };
};

const formatScopeHintText = (scopeHint: ScopeHint | null | undefined): string => {
  const compact = compactScopeHint(scopeHint);
  if (!compact) {
    return '';
  }

  return `\nScope hint:\n${JSON.stringify(compact, null, 2)}`;
};

const resolveInputKind = (requestedKind: unknown, element: unknown, recipe: any): InputKind => {
  if (requestedKind === 'normal' || requestedKind === 'code') {
    return requestedKind;
  }

  const hint = [
    typeof element === 'string' ? element : '',
    typeof recipe?.name === 'string' ? recipe.name : '',
    typeof recipe?.role === 'string' ? recipe.role : '',
    typeof recipe?.description === 'string' ? recipe.description : '',
  ].join(' ').toLowerCase();

  if (
    hint.includes('code') ||
    hint.includes('editor') ||
    hint.includes('monaco') ||
    hint.includes('codemirror') ||
    hint.includes('代码')
  ) {
    return 'code';
  }

  return 'normal';
};

const valuesMatch = (actual: string, expected: string): boolean => normalizeLineEndings(actual) === normalizeLineEndings(expected);

const toJsonResult = (payload: unknown): string => JSON.stringify(payload);

const sha1 = (value: string): string => createHash('sha1').update(value).digest('hex');

type VisualQuestionImageInput = {
  url: string;
};

const FILE_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);
const isDataImageUrl = (value: string): boolean => /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);

const resolveImageMimeType = (filePath: string): string => {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = FILE_IMAGE_MIME_TYPES[extension];
  if (!mimeType) {
    throw new Error(`UNSUPPORTED_IMAGE_REF: Unsupported image file extension "${extension || '(none)'}"`);
  }
  return mimeType;
};

const resolveVisualQuestionImageRef = async (imageRef: string): Promise<VisualQuestionImageInput> => {
  const normalized = imageRef.trim();
  if (!normalized) {
    throw new Error('INVALID_VISUAL_QA_REQUEST: imageRefs cannot contain empty strings');
  }

  if (isHttpUrl(normalized) || isDataImageUrl(normalized)) {
    return { url: normalized };
  }

  const filePath = normalized.startsWith('file://') ? fileURLToPath(normalized) : normalized;
  if (!path.isAbsolute(filePath)) {
    throw new Error(
      `UNSUPPORTED_IMAGE_REF: "${imageRef}" must be an HTTP(S) URL, a data URL, or an absolute local image path`,
    );
  }

  const mimeType = resolveImageMimeType(filePath);
  const fileBuffer = await fs.readFile(filePath);
  return {
    url: `data:${mimeType};base64,${fileBuffer.toString('base64')}`,
  };
};

const focusTarget = async (session: BrowserSession, target: FocusTarget): Promise<void> => {
  if (target.kind === 'locator') {
    try {
      await target.locator.click({ timeout: 2000 });
    } catch {
      await target.locator.click({ force: true, timeout: 4000 });
    }
  } else {
    const page = session.getPage();
    await page.mouse.move(target.xCss, target.yCss);
    await page.mouse.click(target.xCss, target.yCss);
  }
  await session.getPage().waitForTimeout(30);
};

const readCurrentInputText = async (
  session: BrowserSession,
  locator: any | null,
  inputKind: InputKind,
): Promise<string> => {
  const page = session.getPage();

  if (inputKind === 'code') {
    const monacoValue = await page.evaluate(() => {
      const monaco = (window as any).monaco;
      const getEditors = monaco?.editor?.getEditors;
      if (typeof getEditors !== 'function') {
        return null;
      }
      const editors = getEditors.call(monaco.editor);
      if (!Array.isArray(editors) || editors.length === 0) {
        return null;
      }
      const active = document.activeElement;
      const focused = editors.find((editor: any) => typeof editor?.hasTextFocus === 'function' && editor.hasTextFocus())
        || editors.find((editor: any) => {
          const dom = typeof editor?.getDomNode === 'function' ? editor.getDomNode() : null;
          return !!dom && !!active && (dom === active || dom.contains(active));
        });
      if (!focused) {
        return null;
      }
      const model = typeof focused?.getModel === 'function' ? focused.getModel() : null;
      const value = typeof model?.getValue === 'function' ? model.getValue() : null;
      return typeof value === 'string' ? value : null;
    }).catch(() => null);

    if (typeof monacoValue === 'string') {
      return monacoValue;
    }
  }

  if (locator) {
    const inputValue = await locator.inputValue({ timeout: 500 }).catch(() => null);
    if (typeof inputValue === 'string') {
      return inputValue;
    }
  }

  if (locator) {
    const locatorValue = await locator.evaluate((node: Element) => {
      const el = node as HTMLElement & { value?: unknown };
      if (typeof el.value === 'string') {
        return el.value;
      }

      const textarea = el.matches('textarea') ? (el as HTMLTextAreaElement) : (el.querySelector('textarea') as HTMLTextAreaElement | null);
      if (textarea && typeof textarea.value === 'string') {
        return textarea.value;
      }

      if (el.isContentEditable) {
        return el.innerText || el.textContent || '';
      }

      return el.textContent || '';
    }).catch(() => null);

    if (typeof locatorValue === 'string') {
      return locatorValue;
    }
  }

  const activeValue = await page.evaluate(() => {
    const active = document.activeElement as (HTMLElement & { value?: unknown }) | null;
    if (!active) {
      return '';
    }
    if (typeof active.value === 'string') {
      return active.value;
    }
    if (active.isContentEditable) {
      return active.innerText || active.textContent || '';
    }
    const textarea = active.querySelector?.('textarea') as HTMLTextAreaElement | null;
    if (textarea && typeof textarea.value === 'string') {
      return textarea.value;
    }
    return active.textContent || '';
  }).catch(() => '');

  return typeof activeValue === 'string' ? activeValue : '';
};

const trySetMonacoValue = async (
  session: BrowserSession,
  target: FocusTarget,
  text: string,
): Promise<{ ok: boolean; reason: string }> => {
  const page = session.getPage();
  await focusTarget(session, target);

  const result = await page.evaluate((nextText: string) => {
    const monaco = (window as any).monaco;
    const getEditors = monaco?.editor?.getEditors;
    if (typeof getEditors !== 'function') {
      return { ok: false, reason: 'monaco_not_found' };
    }

    const editors = getEditors.call(monaco.editor);
    if (!Array.isArray(editors) || editors.length === 0) {
      return { ok: false, reason: 'monaco_no_editor' };
    }

    const active = document.activeElement;
    const editor = editors.find((ed: any) => typeof ed?.hasTextFocus === 'function' && ed.hasTextFocus())
      || editors.find((ed: any) => {
        const dom = typeof ed?.getDomNode === 'function' ? ed.getDomNode() : null;
        return !!dom && !!active && (dom === active || dom.contains(active));
      });
    if (!editor) {
      return { ok: false, reason: 'monaco_no_focused_editor' };
    }

    try {
      const model = typeof editor.getModel === 'function' ? editor.getModel() : null;
      if (!model || typeof model.setValue !== 'function') {
        return { ok: false, reason: 'monaco_model_unavailable' };
      }
      model.setValue(nextText);
      if (typeof editor.focus === 'function') {
        editor.focus();
      }
      if (typeof editor.pushUndoStop === 'function') {
        editor.pushUndoStop();
      }
      return { ok: true, reason: 'ok' };
    } catch (error: any) {
      return { ok: false, reason: String(error?.message || error || 'monaco_set_failed') };
    }
  }, text).catch(() => ({ ok: false, reason: 'monaco_eval_failed' }));

  return result;
};

const tryPasteCodeText = async (
  session: BrowserSession,
  target: FocusTarget,
  text: string,
): Promise<{ ok: boolean; reason: string }> => {
  const page = session.getPage();
  await focusTarget(session, target);

  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');

  const copied = await page.evaluate(async (nextText: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        return false;
      }
      await navigator.clipboard.writeText(nextText);
      return true;
    } catch {
      return false;
    }
  }, text).catch(() => false);

  if (!copied) {
    return { ok: false, reason: 'clipboard_write_failed' };
  }

  await page.keyboard.press('ControlOrMeta+V');
  return { ok: true, reason: 'ok' };
};

const tryInsertCodeText = async (
  session: BrowserSession,
  target: FocusTarget,
  text: string,
): Promise<{ ok: boolean; reason: string }> => {
  const page = session.getPage();
  await focusTarget(session, target);

  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  if (text.length > 0) {
    await page.keyboard.insertText(text);
  }

  return { ok: true, reason: 'ok' };
};

const clearAndInsertCodeText = async (session: BrowserSession, target: FocusTarget, text: string): Promise<void> => {
  const expected = normalizeLineEndings(text);
  const strategies: Array<{
    name: string;
    run: () => Promise<{ ok: boolean; reason: string }>;
  }> = [
    { name: 'monaco.setValue', run: () => trySetMonacoValue(session, target, text) },
    { name: 'clipboard.paste', run: () => tryPasteCodeText(session, target, text) },
    { name: 'keyboard.insertText', run: () => tryInsertCodeText(session, target, text) },
  ];

  for (let attempt = 1; attempt <= CODE_INPUT_VERIFY_RETRIES; attempt++) {
    for (const strategy of strategies) {
      const writeResult = await strategy.run();
      if (!writeResult.ok) {
        console.warn(
          `[Handler] Code input strategy skipped/failed (attempt=${attempt}/${CODE_INPUT_VERIFY_RETRIES}, strategy=${strategy.name}, reason=${writeResult.reason}).`,
        );
        continue;
      }

      const actual = normalizeLineEndings(await readCurrentInputText(session, target.kind === 'locator' ? target.locator : null, 'code'));
      if (valuesMatch(actual, expected)) {
        console.log(
          `[Handler] Code input verification passed (attempt=${attempt}/${CODE_INPUT_VERIFY_RETRIES}, strategy=${strategy.name}, len=${expected.length}).`,
        );
        return;
      }

      console.warn(
        `[Handler] Code input verification mismatch (attempt=${attempt}/${CODE_INPUT_VERIFY_RETRIES}, strategy=${strategy.name}, expected_len=${expected.length}, actual_len=${actual.length}).`,
      );
    }

    if (attempt < CODE_INPUT_VERIFY_RETRIES) {
      await session.getPage().waitForTimeout(CODE_INPUT_VERIFY_SETTLE_MS);
    }
  }

  const finalActual = normalizeLineEndings(
    await readCurrentInputText(session, target.kind === 'locator' ? target.locator : null, 'code'),
  );
  throw new Error(
    `Code input verification failed: expected_len=${expected.length}, actual_len=${finalActual.length}, expected_preview="${previewText(expected)}", actual_preview="${previewText(finalActual)}"`,
  );
};

const clearAndInsertFocusedNormalText = async (
  session: BrowserSession,
  target: FocusTarget,
  text: string,
): Promise<void> => {
  const expected = normalizeLineEndings(text);
  const page = session.getPage();

  for (let attempt = 1; attempt <= CODE_INPUT_VERIFY_RETRIES; attempt++) {
    await focusTarget(session, target);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    if (text.length > 0) {
      await page.keyboard.insertText(text);
    }

    const actual = normalizeLineEndings(await readCurrentInputText(session, null, 'normal'));
    if (valuesMatch(actual, expected)) {
      return;
    }

    if (attempt < CODE_INPUT_VERIFY_RETRIES) {
      await page.waitForTimeout(CODE_INPUT_VERIFY_SETTLE_MS);
    }
  }

  const finalActual = normalizeLineEndings(await readCurrentInputText(session, null, 'normal'));
  throw new Error(
    `Normal input verification failed: expected_len=${expected.length}, actual_len=${finalActual.length}, expected_preview="${previewText(expected)}", actual_preview="${previewText(finalActual)}"`,
  );
};

const getFocusedTargetInfo = async (session: BrowserSession): Promise<{
  isEditable: boolean;
  hint: string;
  descriptor: string;
}> => {
  const page = session.getPage();
  return await page.evaluate(() => {
    const active = document.activeElement as (HTMLElement & { value?: unknown; type?: string }) | null;
    const tagName = active?.tagName?.toLowerCase() || '';
    const role = active?.getAttribute?.('role') || '';
    const ariaLabel = active?.getAttribute?.('aria-label') || '';
    const placeholder = active?.getAttribute?.('placeholder') || '';
    const className = typeof active?.className === 'string' ? active.className : '';
    const inputType = typeof active?.type === 'string' ? active.type.toLowerCase() : '';

    const monaco = (window as any).monaco;
    const monacoFocused = (() => {
      try {
        const getEditors = monaco?.editor?.getEditors;
        if (typeof getEditors !== 'function') return false;
        const editors = getEditors.call(monaco.editor);
        return Array.isArray(editors) && editors.some((editor: any) => typeof editor?.hasTextFocus === 'function' && editor.hasTextFocus());
      } catch {
        return false;
      }
    })();

    const inputEditable = tagName === 'textarea'
      || (tagName === 'input' && !['button', 'checkbox', 'radio', 'submit', 'reset', 'file'].includes(inputType))
      || role === 'textbox'
      || !!active?.isContentEditable;

    const descriptor = [tagName || 'unknown', role, ariaLabel, placeholder].filter(Boolean).join(' ').trim() || 'focused element';
    return {
      isEditable: inputEditable || monacoFocused,
      hint: [tagName, role, ariaLabel, placeholder, className].filter(Boolean).join(' '),
      descriptor,
    };
  }).catch(() => ({
    isEditable: false,
    hint: '',
    descriptor: 'focused element',
  }));
};

const normalizeHintText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
};

const collectInputHints = (elementHint: unknown, recipe: any): string[] => {
  const candidates = [
    normalizeHintText(elementHint),
    normalizeHintText(recipe?.name),
    normalizeHintText(recipe?.label),
    normalizeHintText(recipe?.placeholder),
  ];
  const deduped = new Set<string>();
  for (const raw of candidates) {
    if (!raw) continue;
    deduped.add(raw);
    // 常见 UI 文本会带描述，例如 "Comment reply textbox"，保留精简前缀作为二级候选。
    const simplified = raw
      .replace(/\b(textbox|input|field)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (simplified.length >= 2) {
      deduped.add(simplified);
    }
    for (const token of raw.split(/\s+/)) {
      const normalizedToken = token.trim();
      if (normalizedToken.length >= 4) {
        deduped.add(normalizedToken);
      }
    }
  }
  return Array.from(deduped);
};

const collectActionHints = (actionHint: unknown, recipe: any): string[] => {
  const candidates = [
    normalizeHintText(actionHint),
    normalizeHintText(recipe?.name),
    normalizeHintText(recipe?.label),
    normalizeHintText(recipe?.text),
  ];
  const deduped = new Set<string>();
  for (const raw of candidates) {
    if (!raw) continue;
    deduped.add(raw);
    const simplified = raw
      .replace(/\b(button|link|menuitem|icon|item|to|for|the|a|an)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (simplified.length >= 2) {
      deduped.add(simplified);
    }
  }
  return Array.from(deduped);
};

const containsActionKeyword = (text: string, keywords: Set<string>): boolean =>
  Array.from(keywords).some((keyword) => text === keyword || text.includes(keyword));

const resolveScopedActionTargetName = (
  actionName: string | undefined,
  scopedCandidates: string[],
): string | null => {
  const normalizedName = normalizeActionText(actionName);
  if (!normalizedName) {
    return null;
  }

  for (const candidate of scopedCandidates) {
    const normalizedCandidate = normalizeActionText(candidate);
    if (!normalizedCandidate) continue;
    if (
      normalizedName === normalizedCandidate ||
      normalizedName.includes(normalizedCandidate) ||
      normalizedCandidate.includes(normalizedName)
    ) {
      return candidate;
    }
  }

  if (containsActionKeyword(normalizedName, SUBMIT_ACTION_LABELS) && scopedCandidates.length === 1) {
    return scopedCandidates[0];
  }

  return null;
};

const inspectLocatorEditability = async (
  locator: any,
): Promise<{ editable: boolean; descriptor: string; reason: string }> => {
  try {
    const info = await locator.evaluate((node: Element) => {
      const el = node as HTMLElement & {
        disabled?: boolean;
        readOnly?: boolean;
        type?: string;
      };
      const tagName = (el.tagName || '').toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const type = ((el as HTMLInputElement).type || '').toLowerCase();
      const ariaLabel = el.getAttribute('aria-label') || '';
      const placeholder = el.getAttribute('placeholder') || '';

      const isTextInput =
        tagName === 'input' &&
        !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'image', 'range', 'color'].includes(type);
      const isTextArea = tagName === 'textarea';
      const isEditableRole = role === 'textbox' || role === 'searchbox';
      const isContentEditable = !!el.isContentEditable;
      const disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true';
      const readOnly =
        !!el.readOnly ||
        el.getAttribute('readonly') !== null ||
        el.getAttribute('aria-readonly') === 'true';

      const editable = (isTextInput || isTextArea || isEditableRole || isContentEditable) && !disabled && !readOnly;
      const descriptor = [tagName || 'unknown', role, ariaLabel, placeholder].filter(Boolean).join(' ').trim() || 'element';
      return {
        editable,
        descriptor,
        reason: editable ? 'ok' : `non_editable(tag=${tagName}, role=${role}, type=${type}, disabled=${disabled}, readonly=${readOnly})`,
      };
    });
    return {
      editable: !!info?.editable,
      descriptor: String(info?.descriptor || 'element'),
      reason: String(info?.reason || 'non_editable'),
    };
  } catch (error) {
    return {
      editable: false,
      descriptor: 'unresolved element',
      reason: `inspect_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

const inspectLocatorActionTarget = async (
  locator: any,
): Promise<{ descriptor: string; role: string; name: string; submitLike: boolean; interactive: boolean }> => {
  try {
    const info = await locator.evaluate((node: Element) => {
      const element = node as HTMLElement & {
        type?: string;
        value?: string;
      };
      const tagName = (element.tagName || '').toLowerCase();
      const role = (element.getAttribute('role') || '').toLowerCase();
      const type = ((element as HTMLInputElement).type || '').toLowerCase();
      const label =
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.innerText ||
        element.textContent ||
        element.value ||
        '';
      const normalizedLabel = String(label || '').replace(/\s+/g, ' ').trim();
      const descriptor = [tagName || 'unknown', role, normalizedLabel].filter(Boolean).join(' ').trim() || 'element';
      const submitLike =
        tagName === 'button' ||
        (tagName === 'input' && (type === 'submit' || type === 'button')) ||
        (role === 'button' &&
          /^(post|save|submit|confirm|apply|create|update|publish|send|done|ok|continue|next)$/i.test(normalizedLabel));
      const interactive =
        ['button', 'a', 'input', 'textarea', 'select', 'option'].includes(tagName) ||
        ['button', 'link', 'menuitem', 'option', 'tab', 'checkbox', 'radio', 'switch'].includes(role) ||
        element.tabIndex >= 0;

      return {
        descriptor,
        role: role || tagName,
        name: normalizedLabel,
        submitLike,
        interactive,
      };
    });
    return {
      descriptor: String(info?.descriptor || 'element'),
      role: String(info?.role || ''),
      name: String(info?.name || ''),
      submitLike: !!info?.submitLike,
      interactive: !!info?.interactive,
    };
  } catch (error) {
    return {
      descriptor: `unresolved element (${error instanceof Error ? error.message : String(error)})`,
      role: '',
      name: '',
      submitLike: false,
      interactive: false,
    };
  }
};

const resolveEditableLocatorForInput = async (
  session: BrowserSession,
  {
    locator,
    recipe,
    elementHint,
  }: {
    locator: any;
    recipe: any;
    elementHint: unknown;
  },
): Promise<any> => {
  const current = await inspectLocatorEditability(locator);
  if (current.editable) {
    return locator;
  }

  const hints = collectInputHints(elementHint, recipe);
  const scopedLocator = await session.resolveScopedEditableLocator(hints);
  if (scopedLocator) {
    const scopedState = await inspectLocatorEditability(scopedLocator);
    if (scopedState.editable) {
      console.warn(`[Handler] Recovered editable input target from scoped action context: ${scopedState.descriptor}`);
      return scopedLocator;
    }
  }

  const page = session.getPage();
  const fallbackCandidates: any[] = [];
  for (const hint of hints) {
    fallbackCandidates.push(page.getByRole('textbox', { name: hint, exact: true }).first());
    fallbackCandidates.push(page.getByRole('textbox', { name: hint }).first());
    fallbackCandidates.push(page.getByLabel(hint, { exact: true }).first());
    fallbackCandidates.push(page.getByLabel(hint).first());
    fallbackCandidates.push(page.getByPlaceholder(hint, { exact: true }).first());
    fallbackCandidates.push(page.getByPlaceholder(hint).first());
  }
  for (const candidate of fallbackCandidates) {
    try {
      const count = await candidate.count();
      if (count <= 0) continue;
      const state = await inspectLocatorEditability(candidate);
      if (state.editable) {
        console.warn(`[Handler] Recovered editable input target via fallback: ${state.descriptor}`);
        return candidate;
      }
    } catch {
      continue;
    }
  }

  const hintText = hints.slice(0, 3).join(' | ') || 'n/a';
  throw new Error(`INPUT_TARGET_NOT_EDITABLE: ${current.reason}; ref_hint=${hintText}; resolved=${current.descriptor}`);
};

const shouldPreferScopedAction = (
  actionName: string | undefined,
  role: string | undefined,
  scopedCandidates: string[],
): boolean => {
  const normalizedName = normalizeActionText(actionName);
  if (!normalizedName) {
    return false;
  }

  if (resolveScopedActionTargetName(actionName, scopedCandidates)) {
    return true;
  }

  const normalizedRole = normalizeActionText(role);
  if (normalizedRole && !['button', 'link', 'menuitem', 'generic'].includes(normalizedRole)) {
    return false;
  }

  return containsActionKeyword(normalizedName, SUBMIT_ACTION_LABELS);
};

const captureInteractionState = async (session: BrowserSession): Promise<InteractionState> => {
  const page = session.getPage();
  const fallbackUrl = page.url();
  const raw = await page.evaluate(() => {
    const active = document.activeElement as (HTMLElement & { value?: unknown }) | null;
    const activeText = (() => {
      if (!active) return '';
      if (typeof active.value === 'string') return active.value;
      if (active.isContentEditable) return active.innerText || active.textContent || '';
      return active.textContent || '';
    })();

    return {
      url: window.location.href,
      title: document.title || '',
      activeTag: active?.tagName?.toLowerCase() || '',
      activeRole: active?.getAttribute?.('role') || '',
      activeValue: String(activeText || '').slice(0, 4000),
      bodyText: String(document.body?.innerText || '').slice(0, 12000),
    };
  }).catch(() => ({
    url: fallbackUrl,
    title: '',
    activeTag: '',
    activeRole: '',
    activeValue: '',
    bodyText: '',
  }));

  return {
    url: raw.url || fallbackUrl,
    title: raw.title,
    activeTag: raw.activeTag,
    activeRole: raw.activeRole,
    activeValueHash: sha1(raw.activeValue),
    bodyTextHash: sha1(raw.bodyText),
  };
};

const diffInteractionSignals = (before: InteractionState, after: InteractionState): string[] => {
  const signals: string[] = [];
  if (before.url !== after.url) signals.push('url_changed');
  if (before.title !== after.title) signals.push('title_changed');
  if (before.activeTag !== after.activeTag || before.activeRole !== after.activeRole) signals.push('active_element_changed');
  if (before.activeValueHash !== after.activeValueHash) signals.push('active_value_changed');
  if (before.bodyTextHash !== after.bodyTextHash) signals.push('page_text_changed');
  return signals;
};

const hasMeaningfulSignals = (signals: string[], allowFocusOnly: boolean): boolean => {
  if (signals.length === 0) return false;
  if (allowFocusOnly) return true;
  return signals.some((signal) => signal !== 'active_element_changed');
};

const verifyInteractionChange = async (
  session: BrowserSession,
  beforeState: InteractionState,
  options: { allowFocusOnly?: boolean } = {},
) => {
  const page = session.getPage();
  const deadline = Date.now() + POINT_VERIFY_TIMEOUT_MS;
  const allowFocusOnly = options.allowFocusOnly === true;

  while (true) {
    const afterState = await captureInteractionState(session);
    const signals = diffInteractionSignals(beforeState, afterState);
    if (hasMeaningfulSignals(signals, allowFocusOnly)) {
      return { result: 'confirmed' as const, signals };
    }

    if (Date.now() >= deadline) {
      return { result: 'unconfirmed' as const, signals: [] as string[] };
    }

    await page.waitForTimeout(POINT_VERIFY_POLL_MS);
  }
};

const resolveNormalizedPoint = async (session: BrowserSession, x: number, y: number): Promise<PointResolution> => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('INVALID_NORMALIZED_POINT: coordinates must be finite numbers');
  }
  if (x < 0 || x > NORMALIZED_COORDINATE_MAX || y < 0 || y > NORMALIZED_COORDINATE_MAX) {
    throw new Error('INVALID_NORMALIZED_POINT: coordinates must be in [0, 1000]');
  }

  const viewport = await session.getViewportState();
  if (viewport.widthCssPx <= 0 || viewport.heightCssPx <= 0) {
    throw new Error('POINT_OUT_OF_VIEWPORT: viewport size is unavailable');
  }

  const xCss = Math.min(
    Math.max(0, viewport.widthCssPx - 1),
    Math.max(0, Math.round((x / NORMALIZED_COORDINATE_MAX) * viewport.widthCssPx)),
  );
  const yCss = Math.min(
    Math.max(0, viewport.heightCssPx - 1),
    Math.max(0, Math.round((y / NORMALIZED_COORDINATE_MAX) * viewport.heightCssPx)),
  );

  return { xCss, yCss, viewport };
};

const assertInspectionFresh = async (session: BrowserSession, inspection: StoredVisualInspection): Promise<VisualInspectionPageState> => {
  const currentState = await session.getViewportState();
  const mismatches: string[] = [];

  if (currentState.url !== inspection.pageState.url) mismatches.push('url_changed');
  if (currentState.widthCssPx !== inspection.pageState.widthCssPx || currentState.heightCssPx !== inspection.pageState.heightCssPx) {
    mismatches.push('viewport_changed');
  }
  if (currentState.scrollX !== inspection.pageState.scrollX || currentState.scrollY !== inspection.pageState.scrollY) {
    mismatches.push('scroll_changed');
  }
  if (
    inspection.pageState.tabId !== null &&
    currentState.tabId !== null &&
    inspection.pageState.tabId !== currentState.tabId
  ) {
    mismatches.push('tab_changed');
  }

  if (mismatches.length > 0) {
    throw new Error(`INSPECTION_STALE: Page state changed since visual inspection (${mismatches.join(', ')})`);
  }

  return currentState;
};

export const ToolHandlers: Partial<Record<ToolName, Handler>> = {
  
  // 1. Navigate
  browser_navigate: async (session, { url }) => {
    // 激活当前页面
    await session.activate();
    await session.clearScopedActionContext();

    // 自动补全协议头 (修复版)
    let targetUrl = url;

    // 检查是否已经是 http/https/file 开头
    const hasProtocol = targetUrl.startsWith('http://') ||
                        targetUrl.startsWith('https://') ||
                        targetUrl.startsWith('file://'); // 新增对 file:// 的支持

    if (!hasProtocol) {
      // 只有在真的没有协议头时，才默认补 https
      targetUrl = 'https://' + targetUrl;
    }

    await session.getPage().goto(targetUrl);
    // 每次操作后自动快照，符合 MCP 习惯
    let snapshot = await session.captureSnapshot(AUTO_SNAPSHOT_FULL);
    if (snapshotLooksUnchanged(snapshot)) {
      snapshot = await session.captureSnapshot(true, { forceFullSnapshot: true });
    }
    return {
        result: `Navigated to ${targetUrl}`,
        snapshot,
        code: `await page.goto('${targetUrl}');`
    };
  },

  // 2. Click
  browser_click: async (session, { ref, element, button, doubleClick, modifiers }) => {
    // 激活当前页面
    await session.activate();
    const recipe = session.getLocatorRecipe(ref);
    const scopedContext = session.getScopedActionContext();
    const actionHints = collectActionHints(element, recipe);
    const primaryActionHint = actionHints[0] || recipe?.name || '';
    const scopedActionTarget =
      scopedContext ? resolveScopedActionTargetName(primaryActionHint, scopedContext.submitCandidates) : null;
    let locator = await session.getLocator(ref);
    let usedScopedLocator = false;
    let emittedScopeHint: ScopeHint | null = null;

    if (
      scopedContext &&
      shouldPreferScopedAction(primaryActionHint, recipe?.role, scopedContext.submitCandidates)
    ) {
      const scopedLocator = await session.resolveScopedActionLocator(scopedActionTarget || primaryActionHint || '', recipe?.role);
      if (scopedLocator) {
        locator = scopedLocator;
        usedScopedLocator = true;
        console.log(
          `[Handler] Re-routed click ${ref} into scoped action target for ${scopedContext.inputDescriptor}: ${recipe?.name || '(unnamed)'}`
        );
      }
    }

    const submitLikeRequest =
      !!scopedContext &&
      (containsActionKeyword(normalizeActionText(primaryActionHint), SUBMIT_ACTION_LABELS) || !!scopedActionTarget);
    if (submitLikeRequest) {
      const actionTarget = await inspectLocatorActionTarget(locator);
      if (!actionTarget.submitLike) {
        const scopedLocator = await session.resolveScopedActionLocator(
          scopedActionTarget || primaryActionHint || '',
          recipe?.role
        );
        if (scopedLocator) {
          locator = scopedLocator;
          usedScopedLocator = true;
          console.warn(
            `[Handler] Re-routed submit-like click ${ref} after semantic mismatch (${actionTarget.descriptor})`
          );
        } else {
          throw new Error(
            `CLICK_TARGET_SEMANTIC_MISMATCH: requested submit-like action "${primaryActionHint}" but resolved ${actionTarget.descriptor}`
          );
        }
      }
    }

    const options = {
      button,
      modifiers,
      clickCount: doubleClick ? 2 : 1,
      timeout: 3000 // 🟢 默认只等 3秒，快速试错
    };

    try {
      // 1. 尝试标准点击 (模拟真实用户)
      console.log(`[Handler] Clicking ${ref} (Standard)...`);
      await locator.click(options);
    } catch (error: any) {
      const msg = error.message || '';
      // 2. 如果是超时或遮挡，尝试强制点击
      if (msg.includes('Timeout') || msg.includes('obscured')) {
        console.warn(`[Handler] Standard click failed for ${ref}, retrying with force: true`);
        await locator.click({ ...options, force: true, timeout: 5000 });
      } else {
        // 其他错误 (如 detatched) 直接抛出
        throw error;
      }
    }

    const rememberTriggeredScope =
      !submitLikeRequest &&
      containsActionKeyword(normalizeActionText(primaryActionHint), COMPOSER_TRIGGER_ACTION_LABELS);
    if (rememberTriggeredScope) {
      await session.getPage().waitForTimeout(120);
      emittedScopeHint = compactScopeHint(await session.rememberActionScopeFromTrigger(locator));
    }

    if (usedScopedLocator && submitLikeRequest) {
      await session.clearScopedActionContext();
    }

    const snapshot = await session.captureSnapshot(AUTO_SNAPSHOT_FULL);
    return {
        result: usedScopedLocator
          ? `Clicked ${ref} using local action scope for ${scopedContext?.inputDescriptor || 'recent input'}${formatScopeHintText(emittedScopeHint)}`
          : `Clicked ${ref}${formatScopeHintText(emittedScopeHint)}`,
        snapshot,
        scopeHint: emittedScopeHint || undefined,
        code: `await locator.click();` // 简化代码展示
    };
  },

  // 3. Type
  browser_type: async (session, { ref, element, text, submit, inputKind }) => {

    // 激活当前页面
    await session.activate();

    let locator = await session.getLocator(ref);
    const recipe = session.getLocatorRecipe(ref);
    const resolvedInputKind = resolveInputKind(inputKind, element, recipe);
    let actualInputDescriptor: string | null = null;
    let scopedContext = null;
    let submitVerification:
      | {
          result: 'confirmed' | 'unconfirmed';
          signals: string[];
        }
      | null = null;
    console.log(`[Handler] browser_type called for ref: ${ref}, inputKind=${resolvedInputKind}`);

    if (text !== undefined) {
      if (resolvedInputKind === 'code') {
        console.log('[Handler] Executing code input strategy: click -> selectAll -> clear -> insertText -> verify');
        await clearAndInsertCodeText(session, { kind: 'locator', locator }, text);
        console.log('[Handler] Code input and verification complete.');
      } else {
        locator = await resolveEditableLocatorForInput(session, {
          locator,
          recipe,
          elementHint: element,
        });
        actualInputDescriptor = (await inspectLocatorEditability(locator)).descriptor;
        console.log(`[Handler] Executing locator.fill('${previewText(text)}')...`);
        await locator.fill(text, { force: true });
        await session.getPage().waitForTimeout(80);
        scopedContext = await session.rememberInputScope(locator);
        console.log(`[Handler] Fill complete.`);
      }
    }

    if (submit) {
      if (resolvedInputKind !== 'code') {
        locator = await resolveEditableLocatorForInput(session, {
          locator,
          recipe,
          elementHint: element,
        });
      }
      const beforeSubmitState = await captureInteractionState(session);
      console.log(`[Handler] Pressing 'Enter'...`);
      // 优先在元素上按回车，如果元素没了(比如填完跳转了)，则在页面上按
      try {
          await locator.press('Enter');
      } catch (e) {
          await session.getPage().keyboard.press('Enter');
      }
      submitVerification = await verifyInteractionChange(session, beforeSubmitState);
      await session.clearScopedActionContext();
      console.log(`[Handler] 'Enter' pressed.`);
    }

    // ... snapshot ...
    const snapshot = await session.captureSnapshot(AUTO_SNAPSHOT_FULL);
    const scopeHint = compactScopeHint(scopedContext);
    const submitResultText = submit
      ? submitVerification?.result === 'confirmed'
        ? '；Enter 后检测到页面或焦点变化'
        : '；Enter 已发送，但暂未检测到明显变化'
      : '';
    return {
        result: text !== undefined
          ? `Typed "${previewText(text)}" into ${ref} (${resolvedInputKind})${actualInputDescriptor ? ` -> ${actualInputDescriptor}` : ''}${formatScopedSubmitCandidates(scopedContext?.submitCandidates)}${submitResultText}${formatScopeHintText(scopeHint)}`
          : `Pressed Enter on ${ref}${submitResultText}`,
        snapshot,
        scopeHint: scopeHint || undefined,
    };
  },

  // 4. Snapshot (纯读取)
  browser_snapshot: async (session, { full, forceFullSnapshot }) => {
    // 如果 AI 没传参，使用默认配置。
    // 注意：当调用方显式传 full=true 时，应该返回完整快照而非 Delta，
    // 否则会出现“full 参数看起来未生效”的体验问题。
    const explicitFullRequested = full === true;
    const forceComplete = forceFullSnapshot === true || explicitFullRequested;
    const useFull = (full ?? DEFAULT_SNAPSHOT_FULL) || forceComplete;
    
    let snapshot = await session.captureSnapshot(useFull, { forceFullSnapshot: forceComplete });
    if (!forceComplete && snapshotLooksUnchanged(snapshot)) {
      snapshot = await session.captureSnapshot(true, { forceFullSnapshot: true });
    }
    const tabs = await session.getTabsInfo();
    
    // 构造 Tabs 概览
    let tabsYaml = `# Browser Tabs\n`;
    tabs.forEach(t => {
       const marker = t.isActive ? ' [ACTIVE]' : '';
       tabsYaml += `- Tab ${t.index}: "${t.title}" (${t.url})${marker}\n`;
    });
    tabsYaml += `\n# Current Page Content\n`;
    
    return {
        result: `Snapshot captured`,
        snapshot: tabsYaml + snapshot
    };
  },
  
  // 5. Screenshot (二进制)
  browser_take_screenshot: async (session, { fullPage }) => {
    await session.activate();
    const buffer = await session.getPage().screenshot({ fullPage });
    return {
        result: `Screenshot taken`,
        base64: buffer.toString('base64') // 特殊字段，Adapter 需要处理它
    };
  },

  // 6. Fill Form (增强版)
  browser_fill_form: async (session, { fields }) => {
    // 激活当前页面
    await session.activate();
    
    const results: string[] = [];
    const scopeHints: ScopeHint[] = [];
    
    for (const field of fields) {
      const locator = await session.getLocator(field.ref);
      const recipe = session.getLocatorRecipe(field.ref); // 获取 ref 对应的原始节点信息
      
      // 智能判断填充方式
      if (recipe?.role === 'checkbox' || recipe?.role === 'switch') {
        // Checkbox 处理
        const shouldCheck = field.value.toLowerCase() === 'true';
        if (shouldCheck) {
          await locator.check();
          results.push(`Checked ${field.ref}`);
        } else {
          await locator.uncheck();
          results.push(`Unchecked ${field.ref}`);
        }
      } else if (recipe?.role === 'combobox' || recipe?.role === 'listbox') {
        // Select 处理
        await locator.selectOption({ label: field.value }).catch(() =>
          locator.selectOption({ value: field.value })
        );
        results.push(`Selected "${field.value}" in ${field.ref}`);
      } else {
        // 文本输入 (默认)
        const editableLocator = await resolveEditableLocatorForInput(session, {
          locator,
          recipe,
          elementHint: recipe?.name,
        });
        const editableState = await inspectLocatorEditability(editableLocator);
        await editableLocator.fill(field.value);
        await session.getPage().waitForTimeout(80);
        const scopedContext = await session.rememberInputScope(editableLocator);
        const scopeHint = compactScopeHint(scopedContext);
        if (scopeHint) {
          scopeHints.push(scopeHint);
        }
        results.push(
          `Filled "${field.value}" into ${field.ref} -> ${editableState.descriptor}${formatScopedSubmitCandidates(scopedContext?.submitCandidates)}${formatScopeHintText(scopeHint)}`
        );
      }
    }

    const snapshot = await session.captureSnapshot(AUTO_SNAPSHOT_FULL);
    return {
        result: results.join('\n'),
        snapshot,
        scopeHints: scopeHints.length > 0 ? scopeHints : undefined,
    };
  },

  // 7. Tab 管理
  browser_tabs: async (session, { action, index, url }) => {
    const pages = session.getContentPages();
    
    if (action === 'list') {
      const tabs = await session.getTabsInfo();
      const tabsInfo = tabs.map(t => {
        const marker = t.isActive ? ' *ACTIVE*' : '';
        return `[${t.index}] ${t.title} (${t.url})${marker}`;
      });
      return {
        result: `Open Tabs:\n${tabsInfo.join('\n')}`,
        // 不强制快照，节省资源
      };
    }

    if (action === 'new') {
      await session.clearScopedActionContext();
      const targetUrl = url || DEFAULT_NEW_TAB_URL;
      if (session.isAttachedSession()) {
        const page = session.getPage();
        await page.evaluate((openUrl) => {
          window.open(openUrl, '_blank');
        }, targetUrl);
        return { result: `Requested new tab via Electron and opened ${targetUrl}` };
      }
      const context = session.getPage().context();
      const newPage = await context.newPage();
      await newPage.goto(targetUrl);
      return { result: `Created new tab and opened ${targetUrl}` };
    }

    // 对于 select 和 close，需要 index
    if (index === undefined || index < 0 || index >= pages.length) {
      throw new Error(`Invalid tab index: ${index}. Total tabs: ${pages.length}`);
    }

    const targetPage = pages[index];

    if (action === 'select') {
      await session.clearScopedActionContext();
      await session.switchToPageByReference(targetPage);
      await session.activate();
      return {
        result: `Switched to tab ${index}`,
        snapshot: await session.captureSnapshot(AUTO_SNAPSHOT_FULL)
      };
    }

    if (action === 'close') {
      await session.clearScopedActionContext();
      await targetPage.close();
      return { result: `Closed tab ${index}` };
    }

    throw new Error(`Unknown action: ${action}`);
  },

  browser_render_markdown: async (session, { markdown, title, theme }) => {
    await session.activate();
    const id = uuidv4();
    const safeTitle = title || 'Markdown Preview';
    const html = await marked.parse(markdown || '') as string;
    setRenderDoc({
      id,
      title: safeTitle,
      markdown: markdown || '',
      html,
      theme,
      createdAt: Date.now(),
    });

    const port = process.env.PORT || '13000';
    const renderUrl = `http://127.0.0.1:${port}/render/md/${id}`;

    if (session.isAttachedSession()) {
      const page = session.getPage();
      await page.evaluate((openUrl) => {
        window.open(openUrl, '_blank');
      }, renderUrl);
      return { result: `Opened render tab via Electron: ${renderUrl}` };
    }

    const context = session.getPage().context();
    const newPage = await context.newPage();
    await newPage.goto(renderUrl);
    return { result: `Created render tab and opened ${renderUrl}` };
  },

  browser_inspect_visual: async (session, { targetName, includeState, contextHint }) => {
    await session.activate();

    const page = session.getPage();
    const screenshotBuffer = await page.screenshot({ type: 'png' });
    const inspectionId = uuidv4();
    const normalizedIncludeState = includeState === true;
    const screenshotBase64 = screenshotBuffer.toString('base64');
    const pageState = await session.getViewportState();

    const visualResult = await inspectVisualCandidates({
      screenshotBase64,
      targetName,
      includeState: normalizedIncludeState,
      contextHint,
    });

    const inspection: StoredVisualInspection = {
      inspectionId,
      createdAt: Date.now(),
      targetName,
      contextHint,
      includeState: normalizedIncludeState,
      screenshotSha1: createHash('sha1').update(screenshotBuffer).digest('hex'),
      pageState,
      candidates: visualResult.candidates,
    };
    session.storeVisualInspection(inspection);

    return {
      result: toJsonResult({
        status: visualResult.candidates.length > 0 ? 'success' : 'not_found',
        inspectionId,
        targetName,
        viewport: {
          coordSpace: 'normalized_0_1000',
          scope: 'current_viewport',
          widthCssPx: pageState.widthCssPx,
          heightCssPx: pageState.heightCssPx,
          scrollX: pageState.scrollX,
          scrollY: pageState.scrollY,
          url: pageState.url,
        },
        candidateCount: visualResult.candidates.length,
        candidates: visualResult.candidates,
        includeState: normalizedIncludeState,
        model: visualResult.model,
        tracePath: visualResult.tracePath,
      }),
    };
  },

  browser_ask_visual: async (session, { question, answerMode, captureScope, imageRefs, contextHint }) => {
    await session.activate();

    const normalizedRefs = Array.isArray(imageRefs)
      ? Array.from(new Set(imageRefs.filter((item) => typeof item === 'string' && item.trim().length > 0)))
      : [];
    const normalizedCaptureScope = captureScope === 'full_page' ? 'full_page' : captureScope === 'viewport' ? 'viewport' : undefined;

    if (!normalizedCaptureScope && normalizedRefs.length === 0) {
      throw new Error('INVALID_VISUAL_QA_REQUEST: Provide captureScope, imageRefs, or both');
    }

    const images: VisualQuestionImageInput[] = [];

    if (normalizedCaptureScope) {
      const screenshotBuffer = await session
        .getPage()
        .screenshot({ type: 'png', fullPage: normalizedCaptureScope === 'full_page' });
      images.push({
        url: `data:image/png;base64,${screenshotBuffer.toString('base64')}`,
      });
    }

    for (const imageRef of normalizedRefs) {
      images.push(await resolveVisualQuestionImageRef(imageRef));
    }

    const visualResult = await askVisualQuestion({
      question,
      answerMode,
      images,
      contextHint,
      captureScope: normalizedCaptureScope,
      imageRefs: normalizedRefs,
    });

    return {
      result: toJsonResult({
        status: 'success',
        answer: visualResult.answer,
        model: visualResult.model,
        tracePath: visualResult.tracePath,
      }),
    };
  },

  browser_click_point: async (session, { inspectionId, x, y }) => {
    await session.activate();

    const inspection = session.getVisualInspection(inspectionId);
    if (!inspection) {
      throw new Error(`INSPECTION_NOT_FOUND: No visual inspection found for "${inspectionId}"`);
    }

    await assertInspectionFresh(session, inspection);

    const { xCss, yCss } = await resolveNormalizedPoint(session, x, y);
    const beforeState = await captureInteractionState(session);
    const page = session.getPage();

    await page.mouse.move(xCss, yCss);
    await page.mouse.click(xCss, yCss);

    const verification = await verifyInteractionChange(session, beforeState);
    const snapshot = await session.captureSnapshot(AUTO_SNAPSHOT_FULL);
    const success = verification.result === 'confirmed';

    return {
      result: toJsonResult({
        status: success ? 'success' : 'failed',
        errorCode: success ? undefined : 'CLICK_UNCONFIRMED',
        action: 'click',
        inspectionId,
        point: { x, y },
        resolvedPoint: { xCss, yCss },
        verification,
      }),
      snapshot,
    };
  },

  browser_type_point: async (session, { inspectionId, x, y, text, submit, inputKind }) => {
    await session.activate();

    if (text === undefined && !submit) {
      throw new Error('INVALID_TYPE_POINT_REQUEST: provide text or set submit=true');
    }

    const inspection = session.getVisualInspection(inspectionId);
    if (!inspection) {
      throw new Error(`INSPECTION_NOT_FOUND: No visual inspection found for "${inspectionId}"`);
    }

    await assertInspectionFresh(session, inspection);

    const { xCss, yCss } = await resolveNormalizedPoint(session, x, y);
    const target: FocusTarget = { kind: 'point', xCss, yCss };

    await focusTarget(session, target);
    const focusedInfo = await getFocusedTargetInfo(session);
    if (!focusedInfo.isEditable) {
      throw new Error(`TARGET_NOT_EDITABLE: ${focusedInfo.descriptor}`);
    }

    const resolvedInputKind = resolveInputKind(inputKind, focusedInfo.hint, null);
    let typedMatch: boolean | null = null;

    if (text !== undefined) {
      if (resolvedInputKind === 'code') {
        await clearAndInsertCodeText(session, target, text);
      } else {
        await clearAndInsertFocusedNormalText(session, target, text);
      }
      const actual = normalizeLineEndings(await readCurrentInputText(session, null, resolvedInputKind));
      typedMatch = valuesMatch(actual, normalizeLineEndings(text));
    }

    let submitVerification:
      | {
          result: 'confirmed' | 'unconfirmed';
          signals: string[];
        }
      | null = null;
    if (submit) {
      const beforeSubmitState = await captureInteractionState(session);
      await session.getPage().keyboard.press('Enter');
      submitVerification = await verifyInteractionChange(session, beforeSubmitState);
    }

    const success = submit
      ? typedMatch !== false && submitVerification?.result === 'confirmed'
      : text === undefined || typedMatch === true;

    const snapshot = await session.captureSnapshot(AUTO_SNAPSHOT_FULL);
    return {
      result: toJsonResult({
        status: success ? 'success' : 'failed',
        errorCode: success ? undefined : 'TYPE_UNCONFIRMED',
        action: 'type',
        inspectionId,
        point: { x, y },
        resolvedPoint: { xCss, yCss },
        inputKind: resolvedInputKind,
        verification: {
          textConfirmed: typedMatch,
          submitResult: submitVerification?.result,
          signals: submitVerification?.signals || [],
        },
      }),
      snapshot,
    };
  },

  // 8. JS 执行
  browser_evaluate: async (session, { function: script, ref }) => {
    await session.activate();
    const page = session.getPage();
    let result;

    if (ref) {
      // 如果指定了元素，就在元素上下文执行
      const locator = await session.getLocator(ref);
      // Playwright 的 evaluate 可以接受参数
      // 注意：这里我们假设 script 是一个函数体字符串，或者就是一个表达式
      // 官方 MCP 定义 script 为 "() => window.location.href" 这种格式
      // 我们利用 eval 或者 new Function 可能会有作用域问题，
      // 最稳妥的是直接传给 page.evaluate。
      
      // 这里的实现比较 tricky，因为从 JSON 传过来的是字符串。
      // 我们尝试将其包裹为函数执行。
      result = await locator.evaluate((el, scriptStr) => {
         // 在浏览器端执行
         // eslint-disable-next-line no-new-func
         const fn = new Function('element', `return (${scriptStr})(element)`);
         return fn(el);
      }, script);
    } else {
      // 在页面上下文执行
      result = await page.evaluate((scriptStr) => {
         // eslint-disable-next-line no-new-func
         const fn = new Function(`return (${scriptStr})()`);
         return fn();
      }, script);
    }

    return {
      result: JSON.stringify(result),
      // 只有操作可能会改变页面时才截图，evaluate 不一定需要，视情况而定
      // 这里为了保险，暂不截图，除非用户显式要求 snapshot
    };
  },

  // 9. 智能等待
  browser_wait_for: async (session, { time, text, textGone }) => {
    const page = session.getPage();
    
    if (time) {
      // 纯等待时间 (秒转毫秒)
      await page.waitForTimeout(time * 1000);
      return { result: `Waited for ${time} seconds` };
    }

    if (text) {
      // 等待文本出现
      await page.getByText(text).first().waitFor({ state: 'visible', timeout: 30000 }); // 默认 30s
      return {
        result: `Text "${text}" appeared`,
        snapshot: await session.captureSnapshot(AUTO_SNAPSHOT_FULL)
      };
    }

    if (textGone) {
      // 等待文本消失
      await page.getByText(textGone).first().waitFor({ state: 'hidden', timeout: 30000 });
      return {
        result: `Text "${textGone}" disappeared`,
        snapshot: await session.captureSnapshot(AUTO_SNAPSHOT_FULL)
      };
    }

    throw new Error('browser_wait_for requires time, text, or textGone');
  },

  // 10. 控制台日志获取
  browser_console_messages: async (session, { onlyErrors }) => {
    let logs = session.getConsoleLogs();
    if (onlyErrors) {
      logs = logs.filter(l => l.startsWith('[error]'));
    }
    return { result: logs.join('\n') || 'No console messages' };
  },

  // 11. 悬停操作
  browser_hover: async (session, { ref }) => {
    // 激活当前页面
    await session.activate();
    
    const locator = await session.getLocator(ref);
    await locator.hover({ timeout: 3000 });
    
    const snapshot = await session.captureSnapshot(AUTO_SNAPSHOT_FULL);
    return {
        result: `Hovered over ${ref}`,
        snapshot
    };
  },

  // 12. 对话框处理预设
  browser_handle_dialog: async (session, { accept, promptText }) => {
    session.setNextDialogAction({ accept, promptText });
    return {
      result: `Next dialog will be ${accept ? 'accepted' : 'dismissed'}${promptText ? ` with text: "${promptText}"` : ''}`
    };
  },

  // 13. 拖拽操作
  browser_drag: async (session, { startElement, startRef, endElement, endRef }) => {
    // 激活当前页面
    await session.activate();
    
    const source = await session.getLocator(startRef);
    const target = await session.getLocator(endRef);
    
    await source.dragTo(target);
    
    return {
      result: `Dragged ${startElement || startRef} to ${endElement || endRef}`,
      snapshot: await session.captureSnapshot(AUTO_SNAPSHOT_FULL)
    };
  },

  // 14. 验证元素可见
  browser_verify_element_visible: async (session, { role, name }) => {
    const page = session.getPage();
    let locator;
    if (role && name) {
      locator = page.getByRole(role as any, { name }).first();
    } else if (role) {
      locator = page.getByRole(role as any).first();
    } else {
      throw new Error('Must provide role or name');
    }

    try {
      await locator.waitFor({ state: 'visible', timeout: 5000 });
      return { result: 'Element is visible' };
    } catch {
      throw new Error('Element is NOT visible');
    }
  },

  // 15. 验证文本可见
  browser_verify_text_visible: async (session, { text }) => {
    const page = session.getPage();
    try {
      await page.getByText(text).first().waitFor({ state: 'visible', timeout: 5000 });
      return { result: `Text "${text}" is visible` };
    } catch {
      throw new Error(`Text "${text}" is NOT visible`);
    }
  },
  
  // 16. 验证列表项
  browser_verify_list_visible: async (session, { ref, items }) => {
    const locator = await session.getLocator(ref);
    const content = await locator.textContent();
    
    const missing = items.filter((item: string) => !content?.includes(item));
    
    if (missing.length > 0) {
      throw new Error(`List is missing items: ${missing.join(', ')}`);
    }
    return { result: 'All list items are visible' };
  },

  // 17. 网络请求日志
  browser_network_requests: async (session) => {
    const logs = session.getNetworkLogs();
    return { result: logs.join('\n') || 'No network activity recorded' };
  },

  // 18. 后退
  browser_navigate_back: async (session) => {
    await session.clearScopedActionContext();
    await session.getPage().goBack();
    return {
      result: 'Navigated back',
      snapshot: await session.captureSnapshot(AUTO_SNAPSHOT_FULL)
    };
  },

  // 19. 关闭当前页面
  browser_close: async (session) => {
    await session.clearScopedActionContext();
    await session.getPage().close();
    return { result: 'Closed current page' };
  },

  // 20. 调整窗口大小
  browser_resize: async (session, { width, height }) => {
    await session.getPage().setViewportSize({ width, height });
    return { result: `Resized viewport to ${width}x${height}` };
  },

  // 21. 键盘按键
  browser_press_key: async (session, { key }) => {
    await session.activate();
    await session.getPage().keyboard.press(key);
    return {
      result: `Pressed key: ${key}`,
      snapshot: await session.captureSnapshot(AUTO_SNAPSHOT_FULL)
    };
  },

  // 22. 下拉选择 (独立工具)
  browser_select_option: async (session, { ref, values }) => {
    await session.activate();
    const locator = await session.getLocator(ref);
    await locator.selectOption(values);
    return {
      result: `Selected options: ${values.join(', ')}`,
      snapshot: await session.captureSnapshot(AUTO_SNAPSHOT_FULL)
    };
  },

  // 23. 文件上传
  browser_file_upload: async (session, { paths }) => {
    await session.activate();
    // 注意：如果未提供 paths，可能是取消上传，这里简化为只处理上传
    if (paths && paths.length > 0) {
      // 官方工具定义中没有 ref 参数，所以我们假设 AI 已经点击了文件上传按钮
      // 我们需要等待文件选择器事件
      const page = session.getPage();
      
      // 设置文件选择器处理器
      const fileChooserPromise = page.waitForEvent('filechooser');
      
      // 等待文件选择器出现
      const fileChooser = await fileChooserPromise;
      
      // 设置文件
      await fileChooser.setFiles(paths);
      
      return { result: `Uploaded files: ${paths.join(', ')}` };
    }
    return { result: 'No files provided' };
  },
  
  // 24. 保存 PDF (仅 Headless 模式支持很好)
  browser_pdf_save: async (session, { filename }) => {
    // 只有 Chromium Headless 支持 PDF
    try {
      const buffer = await session.getPage().pdf({ format: 'A4' });
      // 实际应用中可能需要把 buffer 存文件或者返回 base64
      // 这里简单返回 base64 供预览
      return {
        result: `PDF generated (${buffer.length} bytes)`,
        base64: buffer.toString('base64')
      };
    } catch (e: any) {
      return { result: `PDF generation failed: ${e.message} (Note: PDF only works in Headless Chrome)` };
    }
  },
};
