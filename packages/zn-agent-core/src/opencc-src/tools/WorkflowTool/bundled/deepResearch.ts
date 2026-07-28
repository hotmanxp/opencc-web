// src/tools/WorkflowTool/bundled/deepResearch.ts
import type { Workflow } from '../types.js'

/**
 * Phase metadata for the PermissionDialog + WorkflowDetailDialog.
 *
 * Each entry maps a logical phase to a short user-facing title and a
 * longer detail string the dialog can render inline (or use as a
 * tooltip) so the user understands what the workflow is about to do
 * before granting permission to run.
 *
 * The phases are the upstream 5-phase adversarial deep-research
 * pipeline: Scope -> Search -> Fetch -> Verify -> Synthesize.
 */
export const DEEP_RESEARCH_PHASES = [
  {
    title: 'Scope',
    detail: 'Decompose the question into sub-questions and pick the angle each lens will attack — narrow or wide, depending on what the user is actually asking.',
  },
  {
    title: 'Search',
    detail: 'Fan out parallel web searches from multiple angles — background, current state, critiques — using the WebSearch tool.',
  },
  {
    title: 'Fetch',
    detail: 'Fetch the most promising sources identified during Search, full-text via WebFetch, and pull the structured data the synthesis will need.',
  },
  {
    title: 'Verify',
    detail: 'Cross-check factual claims across sources — a separate verifier subagent spot-checks dubious or hallucinated findings and surfaces conflicts.',
  },
  {
    title: 'Synthesize',
    detail: 'Write the final cited report — combining background, current state, critiques, and verification into one coherent answer with links to every source.',
  },
] as const

/**
 * The deep-research bundled workflow.
 *
 * 5-phase adversarial pipeline (Scope -> Search -> Fetch -> Verify ->
 * Synthesize). Fans out multiple parallel subagents per phase, then
 * synthesizes a single cited report at the end.
 *
 * Invocation: /deep-research <question>
 *
 * The script source is emitted as a template literal so it can be
 * passed verbatim to the Worker runtime, where it gets compiled
 * together with the worker-script prelude (spawnSubagent, agent,
 * parallel, phase, log, __setMeta, budget). The Worker's agent()
 * wrapper accepts Plan1's {schema, isolation} options end-to-end,
 * so structured-output and worktree-isolation just work.
 */
const deepResearchScript = `
__setMeta({
  name: 'deep-research',
  description: 'Multi-phase adversarial deep-research pipeline: Scope the question, fan out parallel Search agents, Fetch the best sources, Verify claims, then Synthesize a cited report.',
  phases: [
    { title: 'Scope' },
    { title: 'Search' },
    { title: 'Fetch' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
});

async function userScript(args) {
  'use strict';
  // OpenCC fork (2026-06-22): the runtime now passes args as the parsed
  // object (CLI-style strings -> keys), so args.question is the new
  // happy path for '/deep-research --question="What is X?"'. We still
  // accept the legacy positional shape (array of strings or a bare
  // quoted question string like '/deep-research "What is X?"') for
  // backward compat — the parser ignores strings with no '--' flags
  // and passes them through, so we map non-objects back to a string.
  const raw = args && typeof args === 'object' && !Array.isArray(args)
    ? (args.question ?? args._ ?? args.q ?? '')
    : (Array.isArray(args) ? args.join(' ') : String(args ?? ''));
  const question = String(raw).trim();
  if (!question) {
    return 'Usage: /deep-research <question>';
  }

  // --- Phase 1: Scope ---------------------------------------------------
  // Decompose the question into 3 lens angles + a verification spec.
  phase('Scope');
  const scope = await agent(
    \`Decompose this research question into 3 distinct lens angles plus a verification spec.\n\nQuestion: \${question}\n\nReturn JSON with:\n- angles: array of { label, prompt } — each prompt should be a self-contained WebSearch/WebFetch directive for one angle (background / current state / critiques)\n- verification_focus: a short list of the 2-3 claim types that need cross-checking (e.g. dates, statistics, named-attribution quotes)\`,
    {
      label: 'scoper',
      phase: 'Scope',
      schema: {
        type: 'object',
        properties: {
          angles: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                prompt: { type: 'string' },
              },
              required: ['label', 'prompt'],
              additionalProperties: false,
            },
          },
          verification_focus: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['angles', 'verification_focus'],
        additionalProperties: false,
      },
    },
  );

  if (!scope.ok || !scope.structuredOutput || !scope.structuredOutput.angles) {
    return 'Scope phase failed: ' + (scope.error || 'no structured output');
  }
  const angles = scope.structuredOutput.angles;
  const verificationFocus = scope.structuredOutput.verification_focus || [];

  // --- Phase 2: Search --------------------------------------------------
  // Fan out one search subagent per lens angle, in parallel.
  phase('Search');
  const searchResults = await parallel(
    angles.map(function (angle) {
      return function () {
        return agent(angle.prompt, {
          label: 'search:' + angle.label,
          phase: 'Search',
          tools: ['WebSearch', 'WebFetch'],
        });
      };
    }),
  );

  // --- Phase 3: Fetch ---------------------------------------------------
  // Dedup URLs from all search results and dispatch one fetcher per URL
  // in parallel. Each fetcher runs in its own worktree (isolation) so it
  // cannot be biased by sibling fetches' context.
  phase('Fetch');
  const allUrls = searchResults.flatMap(function (r) {
    if (!r.ok) return [];
    // searchResults are unstructured (no schema); extract URLs from the
    // report text via a simple line scan. This keeps Search cheap.
    var urls = [];
    var re = /https?:\\/\\/[^\\s)]+/g;
    var match;
    while ((match = re.exec(r.report)) !== null) {
      urls.push(match[0]);
    }
    return urls;
  });
  var uniqueUrls = Array.from(new Set(allUrls)).slice(0, 15);
  var fetches = await parallel(uniqueUrls.map(function (url, i) {
    return function () {
      return agent(
        \`Fetch this URL and extract any falsifiable factual claims (assertions about specific numbers, dates, people, or events that could be verified or refuted). Skip opinions. Return a JSON array of {claim, quote} objects (the quote should be the exact text supporting the claim).

URL: \${url}\`,
        {
          label: 'fetch:' + i,
          phase: 'Fetch',
          isolation: 'worktree',
          tools: ['WebFetch'],
          schema: {
            type: 'object',
            properties: {
              claims: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    claim: { type: 'string' },
                    quote: { type: 'string' },
                    url: { type: 'string' },
                  },
                  required: ['claim', 'quote'],
                },
              },
            },
            required: ['claims'],
            additionalProperties: false,
          },
        }
      );
    };
  }));
  var allClaims = [];
  fetches.forEach(function (f) {
    if (f.ok && f.structuredOutput && f.structuredOutput.claims) {
      f.structuredOutput.claims.forEach(function (cl) {
        allClaims.push({ claim: cl.claim, quote: cl.quote, url: cl.url || '' });
      });
    }
  });
  log('fetch: ' + allClaims.length + ' claims extracted from ' + uniqueUrls.length + ' URLs');

  // --- Phase 4: Verify --------------------------------------------------
  // 3-vote adversarial per claim: three independent fact-checker agents
  // each vote SUPPORTED/REFUTED/UNCERTAIN. 2+ REFUTED kills the claim.
  // No isolation here — verifier bias comes from sibling context, not the
  // worker tree, and the verify agents should share the corpus.
  phase('Verify');
  var verifiedClaims = await parallel(allClaims.slice(0, 30).map(function (c, i) {
    return function () {
      return (async function () {
        var votes = await parallel([0, 1, 2].map(function (v) {
          return function () {
            return agent(
              \`You are a skeptical fact-checker. Vote on whether this claim is SUPPORTED, REFUTED, or UNCERTAIN based on the quote and your knowledge.

Claim: "\${c.claim}"
Quote: "\${c.quote}"

Use WebSearch if needed. Return JSON: {vote: "SUPPORTED"|"REFUTED"|"UNCERTAIN", reason: "<1 sentence>"}\`,
              {
                label: 'verify:' + i + '.v' + v,
                phase: 'Verify',
                tools: ['WebSearch'],
                schema: {
                  type: 'object',
                  properties: {
                    vote: { type: 'string', enum: ['SUPPORTED', 'REFUTED', 'UNCERTAIN'] },
                    reason: { type: 'string' },
                  },
                  required: ['vote', 'reason'],
                  additionalProperties: false,
                },
              }
            );
          };
        }));
        var counts = { SUPPORTED: 0, REFUTED: 0, UNCERTAIN: 0 };
        votes.forEach(function (vote) {
          if (vote.ok && vote.structuredOutput && vote.structuredOutput.vote && counts.hasOwnProperty(vote.structuredOutput.vote)) {
            counts[vote.structuredOutput.vote]++;
          }
        });
        // 2/3 refutes kills the claim
        var killed = counts.REFUTED >= 2;
        return { claim: c.claim, quote: c.quote, url: c.url, votes: counts, killed: killed };
      })();
    };
  }));
  var surviving = verifiedClaims.filter(function (v) { return !v.killed; });
  log('verify: ' + surviving.length + '/' + verifiedClaims.length + ' claims survived');

  // --- Phase 5: Synthesize ---------------------------------------------
  // Sort surviving claims by net support (SUPPORTED - REFUTED) and emit
  // a cited report. Vote counts are included inline so the reader can
  // see the adversarial verdict per claim.
  phase('Synthesize');
  var sorted = surviving.slice().sort(function (a, b) {
    var aNet = a.votes.SUPPORTED - a.votes.REFUTED;
    var bNet = b.votes.SUPPORTED - b.votes.REFUTED;
    return bNet - aNet;
  });
  var lines = [
    '# Deep research: ' + question,
    '',
    '## Summary',
    'Verified ' + sorted.length + ' claims across ' + uniqueUrls.length + ' sources (out of ' + allClaims.length + ' extracted, ' + (verifiedClaims.length - sorted.length) + ' killed by adversarial verification).',
    '',
    '## Verified claims',
  ];
  sorted.forEach(function (v, i) {
    lines.push('### ' + (i + 1) + '. ' + v.claim);
    lines.push('> ' + v.quote);
    lines.push('— ' + v.url + ' (votes: ' + v.votes.SUPPORTED + 'S/' + v.votes.REFUTED + 'R/' + v.votes.UNCERTAIN + 'U)');
    lines.push('');
  });
  return lines.join('\\n');
}
`

export const deepResearch: Workflow = {
  name: 'deep-research',
  description: '5-phase adversarial deep-research pipeline: Scope → Search → Fetch → Verify → Synthesize. Produces a cited report from multiple parallel lens agents with independent cross-verification.',
  whenToUse: 'When the user wants a deep, multi-source, fact-checked research report on any topic. BEFORE invoking, check if the question is specific enough to research directly — if underspecified (e.g. "what car to buy" without budget/use-case/region), ask 2-3 clarifying questions to narrow scope. Then pass the refined question as args, weaving the answers in.',
  source: 'bundled',
  path: '<bundled:deepResearch>',
  run: async () => '',  // not used — script source is read separately
}

// Also export the script source for the Worker
export const deepResearchSource = deepResearchScript