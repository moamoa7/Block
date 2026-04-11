// ==UserScript==
// @name         hi098123 Anti-Anti-AdBlock
// @match        *://t.hi098123.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const _origFnToString = Function.prototype.toString;
  const _nativeRegistry = new WeakMap();
  const markNative = (fn, name) => {
    _nativeRegistry.set(fn, name);
    return fn;
  };

  Function.prototype.toString = markNative(function toString() {
    if (_nativeRegistry.has(this))
      return `function ${_nativeRegistry.get(this)}() { [native code] }`;
    return _origFnToString.call(this);
  }, 'toString');
  _nativeRegistry.set(_origFnToString, 'toString');

  const BIND_PROPS = new Set([
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__'
  ]);

  const _safeCallerTrap = markNative(function caller() {
    'use strict';
    throw new TypeError(
      "'caller' and 'arguments' are restricted function properties"
    );
  }, 'caller');

  function makeHandler(fnName, origFn) {
    return {
      apply: (t, ctx, args) => Reflect.apply(t, ctx, args),
      get(t, p, r) {
        if (p === 'toString')
          return markNative(function toString() {
            return `function ${fnName}() { [native code] }`;
          }, 'toString');
        if (p === 'name') return fnName;
        if (p === 'caller' || p === 'arguments') return _safeCallerTrap;
        if (BIND_PROPS.has(p)) {
          const m = Function.prototype[p];
          return typeof m === 'function'
            ? markNative(m.bind(origFn), p)
            : undefined;
        }
        return Reflect.get(t, p, r);
      }
    };
  }

  function cloakFunc(fn, thisArg, fnName) {
    const targetFn = thisArg === undefined ? fn : fn.bind(thisArg);
    const proxied = new Proxy(targetFn, makeHandler(fnName, fn));
    markNative(proxied, fnName);
    if (thisArg !== undefined) markNative(targetFn, fnName);
    return proxied;
  }

  const AD_NULL = new Set(['ins', '.hi___', '.tabad']);

  const _origQS = document.querySelector.bind(document);
  Object.defineProperty(document, 'querySelector', {
    get: () =>
      cloakFunc(
        function querySelector(sel) {
          if (typeof sel === 'string' && AD_NULL.has(sel)) return null;
          return _origQS(sel);
        },
        document,
        'querySelector'
      ),
    configurable: true,
    enumerable: true
  });

  const _aswiftRe = /^(?:aswift_|google_esf)/;
  const _origQSA = document.querySelectorAll.bind(document);
  Object.defineProperty(document, 'querySelectorAll', {
    get: () =>
      cloakFunc(
        function querySelectorAll(sel) {
          const result = _origQSA(sel);
          if (sel !== 'iframe') return result;
          return Array.from(result).filter((el) => !_aswiftRe.test(el.id));
        },
        document,
        'querySelectorAll'
      ),
    configurable: true,
    enumerable: true
  });

  const _origIndexOf = String.prototype.indexOf;
  Object.defineProperty(String.prototype, 'indexOf', {
    get: () =>
      cloakFunc(
        function indexOf(searchString, position) {
          if (searchString.includes('ht=')) {
            return 1;
          }
          return _origIndexOf.call(this, searchString, position);
        },
        undefined,
        'indexOf'
      ),
    configurable: true,
    enumerable: true
  });
})();
