import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(resolve(root, 'src/components/ui/DialogBehavior.tsx'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function setup(initialOverflow = '') {
  let effect, synchronize, dialogs = [];
  const document = {
    body: { style: { overflow: initialOverflow } },
    activeElement: null,
    querySelectorAll: () => dialogs,
    addEventListener() {}, removeEventListener() {},
  };
  class Element {
    isConnected = true;
    getClientRects() { return [1]; }
    querySelectorAll() { return []; }
    contains(element) { return element === this; }
    focus() { document.activeElement = this; }
  }
  const trigger = new Element();
  trigger.focus();
  const exports = {};
  runInNewContext(compiled, {
    exports, require: () => ({ useEffect: (callback) => { effect = callback; } }),
    document, HTMLElement: Element, Element,
    window: { addEventListener() {}, removeEventListener() {} },
    MutationObserver: class {
      constructor(callback) { synchronize = callback; }
      observe() {} disconnect() {}
    },
  });
  exports.DialogBehavior();
  let cleanup = effect();
  return {
    document, trigger, dialog: () => new Element(),
    show(next) { dialogs = next; synchronize(); },
    cleanup: () => cleanup(),
    remount() { cleanup(); cleanup = effect(); },
  };
}

test('closing a room dialog restores page scrolling and focus', () => {
  const ui = setup();
  ui.show([ui.dialog()]);
  assert.equal(ui.document.body.style.overflow, 'hidden');
  ui.show([]);
  assert.equal(ui.document.body.style.overflow, '');
  assert.equal(ui.document.activeElement, ui.trigger);
  ui.cleanup();
});

test('nested dialogs retain the lock until the last dialog closes', () => {
  const ui = setup('auto');
  const tool = ui.dialog(), nested = ui.dialog();
  ui.show([tool]);
  ui.show([tool, nested]);
  ui.show([tool]);
  assert.equal(ui.document.body.style.overflow, 'hidden');
  ui.show([]);
  assert.equal(ui.document.body.style.overflow, 'auto');
  ui.cleanup();
});

test('navigation and StrictMode cleanup release the lock', () => {
  const ui = setup();
  ui.show([ui.dialog()]);
  ui.remount();
  assert.equal(ui.document.body.style.overflow, 'hidden');
  ui.show([]);
  assert.equal(ui.document.body.style.overflow, '');
  ui.show([ui.dialog()]);
  ui.cleanup();
  assert.equal(ui.document.body.style.overflow, '');
});

test('pages cannot compete with the shared body scroll lock', () => {
  const src = resolve(root, 'src');
  const owners = readdirSync(src, { recursive: true }).filter((path) => /\.tsx?$/.test(path)
    && /document\.body\.style\.overflow\s*=/.test(readFileSync(resolve(src, path), 'utf8')));
  assert.deepEqual(owners.map((path) => path.replaceAll('\\', '/')), ['components/ui/DialogBehavior.tsx']);
});
