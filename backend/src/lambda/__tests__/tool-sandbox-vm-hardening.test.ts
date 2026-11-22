/**
 * H18: Real vm.Script / vm.createContext hardening tests.
 *
 * These test the ACTUAL sandboxExecuteCode implementation from
 * tool-sandbox.ts — NOT a replica. They exercise the real vm.Script code
 * path with escape attempts, timeout enforcement, and size caps.
 *
 * SECURITY NOTE: vm.createContext is an accident guard, not a security
 * boundary. Untrusted tool code requires process isolation (deferred).
 * These tests verify the accident guard works for common escape vectors;
 * they do NOT claim the sandbox is secure against a determined attacker.
 */
import { sandboxExecuteCode } from "../tool-sandbox";

describe("H18 — vm hardening: sandboxExecuteCode (production)", () => {
  it("executes a simple handler and returns output", async () => {
    const code =
      "module.exports = function(inputs) { return { echo: inputs.msg }; };";
    const result = await sandboxExecuteCode(code, { msg: "hello" }, {});
    expect(result.output).toEqual({ echo: "hello" });
  });

  it("executes a handler exported as module.exports.handler", async () => {
    const code =
      "module.exports.handler = function(inputs) { return { ok: true }; };";
    const result = await sandboxExecuteCode(code, {}, {});
    expect(result.output).toEqual({ ok: true });
  });

  it("blocks require() calls", async () => {
    const code = 'module.exports = function() { return require("fs"); };';
    await expect(sandboxExecuteCode(code, {}, {})).rejects.toThrow(
      /require is not allowed/,
    );
  });

  it("blocks direct process access (process is undefined in context)", async () => {
    const code =
      'module.exports = function() { if (typeof process !== "undefined") return process.env; return "blocked"; };';
    const result = await sandboxExecuteCode(code, {}, {});
    expect(result.output).toBe("blocked");
  });

  it("blocks globalThis.process access (globalThis is undefined in context)", async () => {
    const code = `module.exports = function() {
      try {
        if (typeof globalThis !== "undefined" && globalThis && globalThis.process) {
          return globalThis.process.env;
        }
      } catch (e) {
        return "error: " + e.message;
      }
      return "blocked";
    };`;
    const result = await sandboxExecuteCode(code, {}, {});
    // globalThis is undefined in the sandbox, so the typeof check returns
    // "undefined" and the function returns "blocked".
    expect(result.output).toBe("blocked");
  });

  it("blocks constructor chain escape attempt through host-realm objects", async () => {
    // Host-realm objects passed into the vm context (module, exports,
    // __inputs, __creds) have a constructor chain rooted in the HOST's
    // Function, not the sandbox's. `x.constructor.constructor(src)()` on
    // any of them compiles and runs `src` as a HOST-realm function,
    // which can see the real `process` global via closure — regardless
    // of `process: undefined` on the vm context object, because the
    // compiled function never executes inside the vm context at all.
    //
    // This test probes every host-realm object the sandbox exposes and
    // asserts none of them leak a working `process` reference. It also
    // asserts `typeof process === "undefined"` from inside the sandbox's
    // own scope, which was already true and must remain true.
    const code = `module.exports = function(inputs, creds) {
      function probe(obj) {
        try {
          var p = obj.constructor.constructor('return process')();
          return !!(p && p.env);
        } catch (e) {
          return false;
        }
      }
      var results = {
        viaInputs: probe(inputs),
        viaModule: probe(module),
        viaExports: probe(exports),
        viaCreds: creds ? probe(creds) : false,
        processUndefined: typeof process === 'undefined',
      };
      results.leaked = results.viaInputs || results.viaModule ||
        results.viaExports || results.viaCreds;
      return results;
    };`;
    const result = await sandboxExecuteCode(
      code,
      { foo: "bar" },
      { myKey: { token: "abc" } },
    );
    const output = result.output as {
      viaInputs: boolean;
      viaModule: boolean;
      viaExports: boolean;
      viaCreds: boolean;
      processUndefined: boolean;
      leaked: boolean;
    };
    expect(output.processUndefined).toBe(true);
    expect(output.viaInputs).toBe(false);
    expect(output.viaModule).toBe(false);
    expect(output.viaExports).toBe(false);
    expect(output.viaCreds).toBe(false);
    expect(output.leaked).toBe(false);
  });

  it("enforces timeout on infinite loop in handler body", async () => {
    const code = "module.exports = function() { while(true) {} };";
    // Use a short timeout for the test — the invocation-pass vm timeout
    // terminates the synchronous spin-loop.
    await expect(sandboxExecuteCode(code, {}, {}, 100)).rejects.toThrow(
      /Script execution timed out/,
    );
  });

  it("enforces timeout on infinite loop at module level", async () => {
    const code = "while(true) {} module.exports = function() { return 1; };";
    await expect(sandboxExecuteCode(code, {}, {}, 100)).rejects.toThrow(
      /Script execution timed out/,
    );
  });

  it("rejects code exceeding maximum size", async () => {
    const largeCode = "x".repeat(5 * 1024 * 1024 + 1);
    await expect(sandboxExecuteCode(largeCode, {}, {})).rejects.toThrow(
      /exceeds maximum size/,
    );
  });

  it("blocks async escape via unresolved promises (no event loop draining)", async () => {
    // In a vm context, setTimeout/setInterval are not available unless
    // explicitly provided. The sandbox does not provide them, so async
    // escape via timers is blocked.
    const code = `module.exports = function() {
      try {
        if (typeof setTimeout === "undefined") return "no-timers";
        setTimeout(() => {}, 0);
        return "timers-available";
      } catch (e) {
        return "error: " + e.message;
      }
    };`;
    const result = await sandboxExecuteCode(code, {}, {});
    expect(result.output).toBe("no-timers");
  });

  it("does not export prototype pollution to the host", async () => {
    // Attempt to pollute Object.prototype inside the sandbox and verify
    // the host's Object.prototype is unaffected.
    const code = `module.exports = function() {
      try {
        Object.prototype.pwned = true;
        return { polluted: true };
      } catch (e) {
        return { polluted: false, error: e.message };
      }
    };`;

    const hostBefore = (Object.prototype as Record<string, unknown>).pwned;
    expect(hostBefore).toBeUndefined();

    try {
      await sandboxExecuteCode(code, {}, {});
    } catch {
      // May throw due to frozen prototype — that's fine.
    }

    // The critical assertion: host prototype is NOT polluted.
    const hostAfter = (Object.prototype as Record<string, unknown>).pwned;
    expect(hostAfter).toBeUndefined();

    // Clean up just in case (belt and suspenders).
    delete (Object.prototype as Record<string, unknown>).pwned;
  });

  it("passes inputs and credentials through to the handler", async () => {
    const code = `module.exports = function(inputs, creds) {
      return { got: inputs.x, key: Object.keys(creds)[0] };
    };`;
    const result = await sandboxExecuteCode(
      code,
      { x: 42 },
      { myKey: { token: "abc" } },
    );
    expect(result.output).toEqual({ got: 42, key: "myKey" });
  });

  it("handles async handlers (resolved promise)", async () => {
    const code = `module.exports = async function(inputs) {
      return { async: true, val: inputs.v };
    };`;
    const result = await sandboxExecuteCode(code, { v: "ok" }, {});
    expect(result.output).toEqual({ async: true, val: "ok" });
  });
});
