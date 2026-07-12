(function() {
  if (typeof globalThis === "object") return;
  Object.defineProperty(Object.prototype, "__magic__", {
    get: function() { return this; },
    configurable: true
  });
  __magic__.globalThis = __magic__;
  delete Object.prototype.__magic__;
}());

// polyfills for older browsers
if (!Element.prototype.matches) {
  Element.prototype.matches =
    Element.prototype.msMatchesSelector ||
    Element.prototype.webkitMatchesSelector;
}

if (!Element.prototype.closest) {
  Element.prototype.closest = function (s) {
    var el = this;
    do {
      if (Element.prototype.matches.call(el, s)) return el;
      el = el.parentElement || el.parentNode;
    } while (el !== null && el.nodeType === 1);
    return null;
  };
}

// polyfill for Object.fromEntries
if (!Object.fromEntries) {
  Object.fromEntries = function fromEntries(entries) {
    var result = {};
    if (!entries) return result;

    var arr = Array.isArray(entries) ? entries : Array.from(entries);
    for (var i = 0; i < arr.length; i++) {
      var entry = arr[i];
      if (entry && entry.length >= 2) {
        result[entry[0]] = entry[1];
      }
    }
    return result;
  };
}

if (!Object.getOwnPropertyDescriptors) {
  Object.getOwnPropertyDescriptors = function getOwnPropertyDescriptors(value) {
    var object = Object(value);
    var descriptors = {};

    Object.getOwnPropertyNames(object).forEach(function (name) {
      descriptors[name] = Object.getOwnPropertyDescriptor(object, name);
    });

    if (typeof Object.getOwnPropertySymbols === "function") {
      Object.getOwnPropertySymbols(object).forEach(function (symbol) {
        descriptors[symbol] = Object.getOwnPropertyDescriptor(object, symbol);
      });
    }

    return descriptors;
  };
}

if (!Promise.prototype.finally) {
  Object.defineProperty(Promise.prototype, "finally", {
    value: function finallyPolyfill(onFinally) {
      var callback = typeof onFinally === "function" ? onFinally : function identity() {};
      var P = this.constructor || Promise;
      return this.then(
        function onResolved(value) {
          return P.resolve(callback()).then(function returnValue() {
            return value;
          });
        },
        function onRejected(reason) {
          return P.resolve(callback()).then(function throwReason() {
            throw reason;
          });
        }
      );
    },
    configurable: true,
    writable: true
  });
}

if (!Promise.allSettled) {
  Promise.allSettled = function allSettled(iterable) {
    return Promise.all(Array.from(iterable || [], function mapPromise(entry) {
      return Promise.resolve(entry).then(
        function onFulfilled(value) {
          return {
            status: "fulfilled",
            value: value
          };
        },
        function onRejected(reason) {
          return {
            status: "rejected",
            reason: reason
          };
        }
      );
    }));
  };
}

if (!Array.prototype.flat) {
  Object.defineProperty(Array.prototype, "flat", {
    value: function flat(depth) {
      var maxDepth = depth === undefined ? 1 : Number(depth);
      if (!Number.isFinite(maxDepth) || maxDepth < 0) {
        maxDepth = 0;
      }
      var flattenInto = function flattenInto(source, target, currentDepth) {
        for (var index = 0; index < source.length; index += 1) {
          if (!(index in source)) {
            continue;
          }
          var value = source[index];
          if (Array.isArray(value) && currentDepth > 0) {
            flattenInto(value, target, currentDepth - 1);
          } else {
            target.push(value);
          }
        }
        return target;
      };
      return flattenInto(this, [], Math.floor(maxDepth));
    },
    configurable: true,
    writable: true
  });
}

if (!Array.prototype.flatMap) {
  Object.defineProperty(Array.prototype, "flatMap", {
    value: function flatMap(callback, thisArg) {
      var mapped = [];
      for (var index = 0; index < this.length; index += 1) {
        if (!(index in this)) {
          continue;
        }
        var item = callback.call(thisArg, this[index], index, this);
        if (Array.isArray(item)) {
          mapped.push.apply(mapped, item);
        } else {
          mapped.push(item);
        }
      }
      return mapped;
    },
    configurable: true,
    writable: true
  });
}

function installTypedArrayForEachPolyfill(TypedArrayConstructor) {
  if (!TypedArrayConstructor || !TypedArrayConstructor.prototype || typeof TypedArrayConstructor.prototype.forEach === "function") {
    return;
  }

  Object.defineProperty(TypedArrayConstructor.prototype, "forEach", {
    value: function forEachPolyfill(callback, thisArg) {
      if (typeof callback !== "function") {
        throw new TypeError("callback must be a function");
      }
      for (var index = 0; index < this.length; index += 1) {
        callback.call(thisArg, this[index], index, this);
      }
    },
    configurable: true,
    writable: true
  });
}

installTypedArrayForEachPolyfill(globalThis.Int8Array);
installTypedArrayForEachPolyfill(globalThis.Uint8Array);
installTypedArrayForEachPolyfill(globalThis.Uint8ClampedArray);
installTypedArrayForEachPolyfill(globalThis.Int16Array);
installTypedArrayForEachPolyfill(globalThis.Uint16Array);
installTypedArrayForEachPolyfill(globalThis.Int32Array);
installTypedArrayForEachPolyfill(globalThis.Uint32Array);
installTypedArrayForEachPolyfill(globalThis.Float32Array);
installTypedArrayForEachPolyfill(globalThis.Float64Array);

if (!String.prototype.replaceAll) {
  Object.defineProperty(String.prototype, "replaceAll", {
    value: function replaceAll(searchValue, replaceValue) {
      var source = String(this);
      if (searchValue instanceof RegExp) {
        var flags = typeof searchValue.flags === "string" ? searchValue.flags : "";
        if (!flags) {
          flags += searchValue.global ? "g" : "";
          flags += searchValue.ignoreCase ? "i" : "";
          flags += searchValue.multiline ? "m" : "";
        }
        if (flags.indexOf("g") === -1) {
          flags += "g";
        }
        return source.replace(new RegExp(searchValue.source, flags), replaceValue);
      }
      return source.split(String(searchValue)).join(String(replaceValue));
    },
    configurable: true,
    writable: true
  });
}

function installStringPadPolyfill(methodName, padAtStart) {
  if (typeof String.prototype[methodName] === "function") {
    return;
  }

  Object.defineProperty(String.prototype, methodName, {
    value: function stringPadPolyfill(targetLength, padString) {
      var source = String(this);
      var length = targetLength >> 0;
      var fill = padString === undefined ? " " : String(padString);

      if (source.length >= length) {
        return source;
      }

      if (fill === "") {
        fill = " ";
      }

      while (fill.length < length - source.length) {
        fill += fill;
      }

      var padding = fill.slice(0, length - source.length);
      return padAtStart ? padding + source : source + padding;
    },
    configurable: true,
    writable: true
  });
}

installStringPadPolyfill("padStart", true);
installStringPadPolyfill("padEnd", false);

if (!String.prototype.trimStart) {
  Object.defineProperty(String.prototype, "trimStart", {
    value: function trimStartPolyfill() {
      return String(this).replace(/^\s+/, "");
    },
    configurable: true,
    writable: true
  });
}

if (!String.prototype.trimEnd) {
  Object.defineProperty(String.prototype, "trimEnd", {
    value: function trimEndPolyfill() {
      return String(this).replace(/\s+$/, "");
    },
    configurable: true,
    writable: true
  });
}

if (typeof globalThis.URLSearchParams === "undefined") {
  (function installURLSearchParamsPolyfill() {
    function decode(value) {
      return decodeURIComponent(String(value || "").replace(/\+/g, " "));
    }

    function encode(value) {
      return encodeURIComponent(String(value)).replace(/%20/g, "+");
    }

    function URLSearchParamsPolyfill(init) {
      this._entries = [];

      if (!init) {
        return;
      }

      if (typeof init === "string") {
        var query = init.charAt(0) === "?" ? init.slice(1) : init;
        if (!query) {
          return;
        }
        var pairs = query.split("&");
        for (var pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
          if (!pairs[pairIndex]) {
            continue;
          }
          var separatorIndex = pairs[pairIndex].indexOf("=");
          var name = separatorIndex === -1 ? pairs[pairIndex] : pairs[pairIndex].slice(0, separatorIndex);
          var value = separatorIndex === -1 ? "" : pairs[pairIndex].slice(separatorIndex + 1);
          this.append(decode(name), decode(value));
        }
        return;
      }

      if (typeof init.forEach === "function") {
        var self = this;
        init.forEach(function appendFromForEach(value, name) {
          self.append(name, value);
        });
        return;
      }

      if (Array.isArray(init)) {
        for (var index = 0; index < init.length; index += 1) {
          if (init[index] && init[index].length >= 2) {
            this.append(init[index][0], init[index][1]);
          }
        }
        return;
      }

      if (typeof init === "object") {
        for (var key in init) {
          if (Object.prototype.hasOwnProperty.call(init, key)) {
            this.append(key, init[key]);
          }
        }
      }
    }

    URLSearchParamsPolyfill.prototype.append = function append(name, value) {
      this._entries.push([String(name), String(value)]);
    };

    URLSearchParamsPolyfill.prototype.delete = function deleteParam(name) {
      var key = String(name);
      this._entries = this._entries.filter(function keep(entry) {
        return entry[0] !== key;
      });
    };

    URLSearchParamsPolyfill.prototype.get = function get(name) {
      var key = String(name);
      for (var index = 0; index < this._entries.length; index += 1) {
        if (this._entries[index][0] === key) {
          return this._entries[index][1];
        }
      }
      return null;
    };

    URLSearchParamsPolyfill.prototype.getAll = function getAll(name) {
      var key = String(name);
      return this._entries
        .filter(function keep(entry) {
          return entry[0] === key;
        })
        .map(function toValue(entry) {
          return entry[1];
        });
    };

    URLSearchParamsPolyfill.prototype.has = function has(name) {
      return this.get(name) !== null;
    };

    URLSearchParamsPolyfill.prototype.set = function set(name, value) {
      var key = String(name);
      var nextEntries = [];
      var replaced = false;
      for (var index = 0; index < this._entries.length; index += 1) {
        if (this._entries[index][0] === key) {
          if (!replaced) {
            nextEntries.push([key, String(value)]);
            replaced = true;
          }
        } else {
          nextEntries.push(this._entries[index]);
        }
      }
      if (!replaced) {
        nextEntries.push([key, String(value)]);
      }
      this._entries = nextEntries;
    };

    URLSearchParamsPolyfill.prototype.forEach = function forEach(callback, thisArg) {
      for (var index = 0; index < this._entries.length; index += 1) {
        callback.call(thisArg, this._entries[index][1], this._entries[index][0], this);
      }
    };

    URLSearchParamsPolyfill.prototype.toString = function toString() {
      return this._entries.map(function serialize(entry) {
        return encode(entry[0]) + "=" + encode(entry[1]);
      }).join("&");
    };

    if (typeof Symbol === "function" && Symbol.iterator) {
      URLSearchParamsPolyfill.prototype[Symbol.iterator] = function iterator() {
        var entries = this._entries.slice();
        var index = 0;
        return {
          next: function next() {
            if (index >= entries.length) {
              return { done: true };
            }
            return { done: false, value: entries[index++] };
          }
        };
      };
    }

    globalThis.URLSearchParams = URLSearchParamsPolyfill;
  }());
}

function installElementScrollToPolyfill(target) {
  if (!target || typeof target.scrollTo === "function") {
    return;
  }
  Object.defineProperty(target, "scrollTo", {
    value: function scrollToPolyfill(leftOrOptions, top) {
      if (leftOrOptions && typeof leftOrOptions === "object") {
        if (Object.prototype.hasOwnProperty.call(leftOrOptions, "left")) {
          this.scrollLeft = Number(leftOrOptions.left || 0);
        }
        if (Object.prototype.hasOwnProperty.call(leftOrOptions, "top")) {
          this.scrollTop = Number(leftOrOptions.top || 0);
        }
        return;
      }
      if (typeof leftOrOptions === "number") {
        this.scrollLeft = leftOrOptions;
      }
      if (typeof top === "number") {
        this.scrollTop = top;
      }
    },
    configurable: true,
    writable: true
  });
}

installElementScrollToPolyfill(globalThis.Element && globalThis.Element.prototype);
installElementScrollToPolyfill(globalThis.HTMLElement && globalThis.HTMLElement.prototype);
