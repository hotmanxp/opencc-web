/**
 * @deprecated Use vmRunner.ts (Task1-4 of Plan5) instead. Kept for
 * the /create-workflow preview path which compiles a script locally
 * without running it. Will be removed in 2026-Q3 once preview
 * moves to a syntax-highlight-only renderer.
 */
/**
 * Build the wrapper script that's loaded into node:worker_threads.
 *
 * The wrapper:
 * - Defines a restricted global scope (no require, no process, no globalThis)
 * - Exposes `args`, `spawnSubagent`, `__setMeta`, `phase`, `agent`, `parallel`
 * - Wraps the user script in an async IIFE
 * - Posts results back to main via parentPort.postMessage
 *
 * Static audit: rejects scripts containing forbidden tokens BEFORE returning.
 */
const FORBIDDEN_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /\brequire\s*\(/, name: 'require' },
  { pattern: /\bimport\s+/, name: 'import' },
  { pattern: /\bfrom\s+['"]/, name: 'import' },
  { pattern: /\bprocess\./, name: 'process' },
  { pattern: /\bprocess\[/, name: 'process' },
  { pattern: /\bglobalThis\./, name: 'globalThis' },
  { pattern: /\bglobalThis\[/, name: 'globalThis' },
  { pattern: /\bnew\s+Function\s*\(/, name: 'Function' },
  { pattern: /\beval\s*\(/, name: 'eval' },
  { pattern: /\bBuffer\./, name: 'Buffer' },
]

export function buildWorkerScript(userScript: string): string {
  for (const { pattern, name } of FORBIDDEN_PATTERNS) {
    if (pattern.test(userScript)) {
      throw new Error(
        `[workflow] Script contains forbidden token: ${name}`,
      )
    }
  }

  const cleaned = userScript
    .replace(/export\s+default\s+async\s+function/g, 'async function')
    .replace(/export\s+default\s+function/g, 'function')
    .replace(/export\s+default\s+/g, '')
    .replace(/export\s+const\s+/g, 'const ')
    .replace(/export\s+(let|var)\s+/g, '$1 ')
    // The user script uses the `export const meta = {...}` ES-module
    // pattern (per the project's documented style). After stripping
    // `export`, the `meta` binding ends up as a function-local
    // variable inside the wrapped `userScript()` — invisible to
    // the parent process. To keep the `__setMeta(meta)` channel
    // working, we hoist a capture call to the top of the function
    // body so the parent's WorkflowDetailDialog can render the
    // declared phases. (The `meta` reference is TDZ-safe because
    // we inject the capture call AFTER the variable's declaration
    // line — see `reorderMetaCapture` below.)
    .replace(
      /^(const\s+meta\s*=\s*[\s\S]*?;\s*)$/m,
      '$1\n  if (typeof __setMeta === "function") __setMeta(meta);',
    )

  // parentPort must be captured before the require shadow takes effect.
  // The module-level wrapper is trusted code (not user-supplied), so we
  // omit 'use strict' here — it would forbid 'const eval' which we need
  // to shadow. User code inside userScript() is still wrapped in strict.
  return `
const { parentPort } = require('node:worker_threads');

let cancelled = false;
parentPort.on('message', (msg) => {
  if (msg && msg.kind === 'cancel') {
    cancelled = true;
  }
});

function spawnSubagent(prompt, opts) {
  return new Promise((resolve, reject) => {
    const callId = Math.random().toString(36).slice(2);
    const onMessage = (msg) => {
      if (msg && msg.kind === 'spawnSubagentResult' && msg.callId === callId) {
        parentPort.off('message', onMessage);
        if (msg.error) reject(new Error(msg.error));
        else resolve({ agentId: msg.agentId, report: msg.report, structuredOutput: msg.structuredOutput });
      }
    };
    parentPort.on('message', onMessage);
    parentPort.postMessage({ kind: 'spawnSubagent', callId, prompt, opts });
  });
}

// __setMeta(meta) — declares the workflow's UI-visible metadata. Sent to
// main exactly once, after the user calls it. Drives the phase list in
// WorkflowDetailDialog. Calling it multiple times is harmless (last write
// wins on the main side), but only the first call typically has visible
// effect because main captures the meta at init time.
function __setMeta(meta) {
  if (!meta || typeof meta !== 'object') return;
  parentPort.postMessage({ kind: 'meta', meta });
}

// phase(title) — posts a { kind: 'phase', title } message so the dialog
// can show the current phase in the spinner. Safe to call multiple times.
function phase(title) {
  parentPort.postMessage({ kind: 'phase', title: String(title ?? '') });
}

// agent(prompt, opts) — wraps spawnSubagent and returns a structured
// result so scripts can do early-exit on failure.
// Never rejects: errors from spawnSubagent are normalized to
// { ok: false, error } so the call site can pattern-match on ok cleanly.
// The legacy spawnSubagent(prompt, opts) stays unchanged for backward
// compatibility with scripts that destructure { agentId, report }.
// label and phase are UI/grouping metadata that should pass through
// into SpawnOpts so the WorkflowDetailDialog can group agents.
// agentType is forwarded into SpawnOpts so the main-process handler
// can route through the agent registry when set (otherwise the LLM
// is called directly with the schema prompt).
// schema is forwarded so realSpawner can inject StructuredOutputTool
// (validated by the LLM and returned as structuredOutput on success).
// isolation is forwarded so downstream tasks can opt into a per-call
// worktree (e.g. for repos that must not be mutated by sibling agents).
function agent(prompt, opts) {
  const { label, phase, agentType, schema, isolation, ...spawnOpts } = opts || {};
  const finalOpts = {
    ...(label !== undefined ? { label } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(schema !== undefined ? { schema } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...spawnOpts,
    ...(agentType ? { agentType } : {}),
  };
  return spawnSubagent(prompt, finalOpts).then(
    function (r) {
      return {
        ok: true,
        agentId: r.agentId,
        report: r.report,
        structuredOutput: r.structuredOutput,
        label: label,
        phase: phase,
      };
    },
    function (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        label: label,
        phase: phase,
      };
    },
  );
}

// parallel(fns) — Promise.all over an array of thunks. Lets scripts do
// \`const [a, b, c] = await parallel([fn1, fn2, fn3])\`. Does NOT change
// spawnSubagent semantics; results come back in input order regardless
// of completion order. The thunks (not the promises) are passed in so
// the user controls when each call starts — a no-op for simple cases
// but lets scripts add setup/teardown around each fn if needed.
function parallel(fns) {
  if (!Array.isArray(fns)) {
    return Promise.reject(new Error('parallel() requires an array of functions'));
  }
  return Promise.all(fns.map(function (fn) { return fn(); }));
}

// log(msg) — posts a structured log message to main. Surfaces phase
// progress in the WorkflowDetailDialog without leaking console output
// to the worker's stdout. The WorkerOutbound.log message kind already
// existed (used for runtime error routing in schedulerBridge) — this
// just exposes a global in the wrapper that posts the same kind.
// Level defaults to 'info'; the second-arg level override is reserved
// for a future expansion (currently all messages are 'info').
function log(msg) {
  parentPort.postMessage({ kind: 'log', level: 'info', message: String(msg ?? '') });
}

// budget — token budget snapshot injected at init. budget.total is 0
// when no budget is configured; scripts should guard with
// |if (budget.total)| before reading. budget.remaining() and
// budget.used are computed on each call (not cached) so the LLM can
// poll them mid-script to track spend. The underlying __budgetTotal
// and __budgetUsed are module-level lets so the init handler can
// mutate them; the getters expose them through a frozen-shape object.
let __budgetTotal = 0;
let __budgetUsed = 0;
const budget = {
  get total() { return __budgetTotal; },
  get used() { return __budgetUsed; },
  remaining() { return Math.max(0, __budgetTotal - __budgetUsed); }
};

// workflow(nameOrRef, args) — runs a named child workflow and returns
// its result. One level of nesting is allowed: a workflow can call
// workflow() to invoke a child, but a child workflow cannot call
// workflow() again (the bridge on main enforces this by refusing to
// start a child of a child).
//
// The worker wrapper string is loaded via node:worker_threads and has
// no access to the main thread's modules or closures. So workflow()
// does NOT import workflowNested.ts — instead it posts a request to
// the parent (main) and waits for the response. The bridge in
// schedulerBridge.ts handles the resolveWorkflow + runChildScript
// step on the main side, then posts the result back.
//
// The constant __MAX_NESTING_DEPTH is documented in the comment but
// enforced by the bridge; the wrapper itself only renders the error
// if the depth arg in __runNestedWorkflow is already >=1 (which
// should never happen in a properly-configured bridge — defensive
// only). Conceptually the runner is constructed with { nestingDepth: 0 }
// — see createNestedWorkflowRunner in workflowNested.ts. The depth
// here is a third arg of __runNestedWorkflow for the same reason:
// functions over the worker boundary must be reduced to message
// passing, so we cannot capture a closure constant.
const __MAX_NESTING_DEPTH = 1;
let __workflowCallId = 0;
const __pendingWorkflowCalls = new Map();
async function __runNestedWorkflow(nameOrRef, args, depth) {
  if (depth >= __MAX_NESTING_DEPTH) {
    throw new Error(
      'workflow() cannot be called from within a child workflow — ' +
      'nesting is limited to one level. Inline the inner script or call its agents directly.'
    );
  }
  const callId = ++__workflowCallId;
  // Normalize nameOrRef to a wire-friendly shape. Strings pass through;
  // {scriptPath} objects are sent as-is so the bridge can decide
  // whether to resolve the path itself (sandboxed) or trust the worker.
  const wireRef = typeof nameOrRef === 'string'
    ? { kind: 'name', value: nameOrRef }
    : (nameOrRef && typeof nameOrRef === 'object' && 'scriptPath' in nameOrRef)
      ? { kind: 'scriptPath', value: nameOrRef.scriptPath }
      : null;
  if (!wireRef) {
    throw new TypeError('workflow() expects a workflow name (string) or {scriptPath: string}');
  }
  const promise = new Promise((resolve, reject) => {
    __pendingWorkflowCalls.set(callId, { resolve, reject });
  });
  parentPort.postMessage({ kind: 'workflow', callId, ref: wireRef, args });
  return promise;
}
function workflow(nameOrRef, args) {
  return Promise.resolve(__runNestedWorkflow(nameOrRef, args, 0));
}

async function userScript(args) {
  'use strict';
${cleaned
  .split('\n')
  .map(line => '  ' + line)
  .join('\n')}
}

parentPort.on('message', async (msg) => {
  if (!msg) return;
  if (msg.kind === 'workflowResult') {
    const pending = __pendingWorkflowCalls.get(msg.callId);
    if (pending) {
      __pendingWorkflowCalls.delete(msg.callId);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.result);
    }
    return;
  }
  if (msg.kind === 'init') {
    __budgetTotal = Number(msg.budgetTotal ?? 0);
    __budgetUsed = Number(msg.budgetUsed ?? 0);
  }
  if (msg.kind !== 'init') return;
  try {
    if (typeof userScript !== 'function') {
      throw new Error('Workflow script must define an async function (default export or named "userScript")');
    }
    const result = await userScript(msg.args);
    if (cancelled) {
      parentPort.postMessage({ kind: 'error', message: 'Cancelled' });
      return;
    }
    parentPort.postMessage({
      kind: 'report',
      // Serialize objects as JSON so structured reports (e.g. the
      // opencc-bug-hunt final report: { bugs, top3, notes }) survive
      // the Worker boundary intact. Strings pass through as-is (no
      // extra quotes) so script authors can return either a string
      // or a JSON-serializable object.
      value:
        typeof result === 'string'
          ? result
          : result === undefined || result === null
            ? ''
            : JSON.stringify(result, null, 2),
    });
  } catch (err) {
    parentPort.postMessage({
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
});
`
}
