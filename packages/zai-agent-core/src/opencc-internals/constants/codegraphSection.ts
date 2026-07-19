// @ts-nocheck
import { pwd } from '../utils/cwd.js'
import { hasCodegraphIndex } from '../utils/codegraph.js'
import { systemPromptSection } from './systemPromptSections.js'

// Keep in sync with the CodeGraph section in AGENTS.md.
//
// CodeGraph MCP exposes only 4 tools by default since v1.0.0 (June 2026):
// the other 4 (callees/impact/files/status) are gated behind CODEGRAPH_MCP_TOOLS.
// See https://github.com/colbymchenry/codegraph CHANGELOG 1.0.0.
const CODEGRAPH_SECTION_TEXT = `# CodeGraph

This project is indexed by CodeGraph (a tree-sitter-parsed knowledge graph
of every symbol, edge, and file). Prefer CodeGraph over native grep/Read
for structural questions.

Available tools (use these instead of grep/Read/Grep when possible):

| Question | Tool |
| ------------------------------------- | -------------------------- |
| "Where is X defined?" / "Find symbol named X" | codegraph_search |
| "What calls function Y?" | codegraph_callers |
| "Show me Y's source / signature / docstring" | codegraph_node |
| "Several related symbols at once" / "How does X reach Y?" / "What would break if I changed Z?" | codegraph_explore |

Trust CodeGraph results — they're from a full AST parse. Do NOT re-verify
with grep. Don't grep first when looking up a symbol by name.

For questions the 4-tool surface doesn't directly cover — "what does Y call?",
"list files under path/", "is the index healthy?" — fall back to:
- Glob/Grep/Read for plain file listing and text search
- codegraph_explore's blast-radius section (it reports callers AND callees inline)
- codegraph_node's dependents note for change impact
- codegraph_node with a file path returns the file body with line numbers, so a
  "list this directory" request is one codegraph_search away

If a CodeGraph response shows a ⚠️ staleness banner listing pending files,
Read those specific files for accurate content — files NOT in the banner
are fresh.`

export const codegraphSection = systemPromptSection(
  'codegraph',
  () => (hasCodegraphIndex(pwd()) ? CODEGRAPH_SECTION_TEXT : null),
)
