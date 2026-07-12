import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const repoRoot = new URL("../", import.meta.url);

function createDomConstructor() {
  return function DomConstructor() {};
}

function runPolyfillsWithLegacyGaps() {
  const source = readFileSync(new URL("js/runtime/polyfills.js", repoRoot), "utf8");
  const context = {
    console,
    Element: createDomConstructor(),
    HTMLElement: createDomConstructor()
  };

  vm.createContext(context);
  vm.runInContext(`
    Object.getOwnPropertyDescriptors = undefined;
    Promise.prototype.finally = undefined;
    Promise.allSettled = undefined;
    Array.prototype.flat = undefined;
    Array.prototype.flatMap = undefined;
    String.prototype.replaceAll = undefined;
    String.prototype.padStart = undefined;
    String.prototype.padEnd = undefined;
    String.prototype.trimStart = undefined;
    String.prototype.trimEnd = undefined;
    try {
      Object.defineProperty(RegExp.prototype, "flags", {
        value: undefined,
        configurable: true,
        writable: true
      });
    } catch (_) {}
    URLSearchParams = undefined;
    Uint8Array.prototype.forEach = undefined;
  `, context);
  vm.runInContext(source, context);
  return context;
}

test("legacy WebOS polyfills install APIs missing from Chrome 38", async () => {
  const context = runPolyfillsWithLegacyGaps();

  assert.equal(vm.runInContext("typeof Object.getOwnPropertyDescriptors", context), "function");
  assert.deepEqual(
    Array.from(vm.runInContext("Object.keys(Object.getOwnPropertyDescriptors({ a: 1 }))", context)),
    ["a"]
  );

  assert.equal(vm.runInContext("typeof Promise.prototype.finally", context), "function");
  assert.equal(
    await vm.runInContext("Promise.resolve('ok').finally(function () {}).then(function (value) { return value; })", context),
    "ok"
  );

  assert.equal(vm.runInContext("typeof Uint8Array.prototype.forEach", context), "function");
  assert.deepEqual(
    Array.from(vm.runInContext("var seen = []; new Uint8Array([1, 2, 3]).forEach(function (value) { seen.push(value); }); seen", context)),
    [1, 2, 3]
  );

  assert.equal(vm.runInContext("'7'.padStart(3, '0')", context), "007");
  assert.equal(vm.runInContext("'7'.padEnd(3, '0')", context), "700");
  assert.equal(vm.runInContext("'a-b-c'.replaceAll(/-/, '+')", context), "a+b+c");

  assert.equal(vm.runInContext("typeof URLSearchParams", context), "function");
  assert.equal(vm.runInContext("new URLSearchParams('?a=1&b=two+words').get('b')", context), "two words");
  assert.equal(vm.runInContext("var params = new URLSearchParams({ q: 'nuvio tv', page: 2 }); params.set('page', 3); params.toString()", context), "q=nuvio+tv&page=3");
});
