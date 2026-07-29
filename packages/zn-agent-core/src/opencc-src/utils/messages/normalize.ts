import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type {
  ContentBlock,
  NormalizedAssistantMessage,
  NormalizedMessage,
  NormalizedUserMessage,
  Message,
  AssistantMessage,
  UserMessage,
  UUID,
} from '../../types/message.ts'

// Local message shapes with the `message` envelope narrowed to what normalize
// needs. The parent `Message` interface leaves `message` optional (it is absent
// for system/progress/attachment/etc), so iterating `Message[]` and reading
// `m.message.content` would not narrow correctly. These local shapes are the
// post-normalization pre-conditions: only assistant/user variants reach the
// branches that dereference `m.message`, and we assert that here.
type AssistantMessageWithBody = AssistantMessage & {
  message: NonNullable<AssistantMessage['message']>
  uuid: UUID
  timestamp: string
}
type UserMessageWithBody = UserMessage & {
  message: NonNullable<UserMessage['message']>
  uuid: UUID
  timestamp: string
}
type MessageWithBody = Message & {
  message: NonNullable<Message['message']>
  uuid: UUID
  timestamp: string
}

function createNormalizedUserBlockMessage({
  source,
  content,
  imagePasteIds,
  uuid,
}: {
  source: UserMessageWithBody
  content: ContentBlockParam[]
  imagePasteIds?: (number | string)[]
  uuid: UUID
}): UserMessage {
  return {
    type: 'user',
    content: '',
    message: {
      role: 'user',
      content: content as unknown as string | ContentBlock[],
    },
    isMeta: source.isMeta,
    isVisibleInTranscriptOnly: source.isVisibleInTranscriptOnly,
    isVirtual: source.isVirtual,
    isCollapseSummary: source.isCollapseSummary,
    uuid,
    timestamp: source.timestamp,
    toolUseResult: source.toolUseResult,
    mcpMeta: source.mcpMeta,
    imagePasteIds,
    origin: source.origin,
  }
}

// Deterministic UUID derivation. Produces a stable UUID-shaped string from a
// parent UUID + content block index so that the same input always produces the
// same key across calls. Used by normalizeMessages and synthetic message creation.
export function deriveUUID(parentUUID: UUID, index: number): UUID {
  const hex = index.toString(16).padStart(12, '0')
  return `${parentUUID.slice(0, 24)}${hex}` as UUID
}

// Split messages, so each content block gets its own message. Restores the
// upstream per-subtype overload set (AssistantMessage[] -> NormalizedAssistantMessage[],
// etc.) so callers that pass concrete subtypes get a precisely-typed return.
// The impl signature stays a single (Message[] -> NormalizedMessage[]) — TS
// cannot verify overload-impl contravariance here because OpenCC's
// UserMessage.uuid? / AssistantMessage.uuid? (optional) are not assignable
// to Message.uuid: string (required) at the array level. The body returns
// the union of normalized types matching the widest overload, which is sound.
// @ts-expect-error - overload-impl variance: per-subtype overload inputs are
// not contravariant with the impl's Message[] input because the optional-uuid
// subtypes don't satisfy Message.uuid: string at the array level. Body is sound.
export function normalizeMessages(
  messages: AssistantMessage[],
): NormalizedAssistantMessage[]
export function normalizeMessages(
  messages: UserMessage[],
): NormalizedUserMessage[]
export function normalizeMessages(
  messages: (AssistantMessage | UserMessage)[],
): (NormalizedAssistantMessage | NormalizedUserMessage)[]
export function normalizeMessages(messages: Message[]): NormalizedMessage[]
export function normalizeMessages(messages: Message[]): NormalizedMessage[] {
  // isNewChain tracks whether we need to generate new UUIDs for messages when normalizing.
  // When a message has multiple content blocks, we split it into multiple messages,
  // each with a single content block. When this happens, we need to generate new UUIDs
  // for all subsequent messages to maintain proper ordering and prevent duplicate UUIDs.
  // This flag is set to true once we encounter a message with multiple content blocks,
  // and remains true for all subsequent messages in the normalization process.
  let isNewChain = false
  return messages.flatMap((message): NormalizedMessage[] => {
    switch (message.type) {
      default:
        return [message as unknown as NormalizedMessage]
      case 'assistant': {
        const m = message as AssistantMessageWithBody
        const content = m.message.content
        // assistant content is always an array per the SDK contract; if a
        // string slips in, fall back to an empty array rather than erroring.
        const blocks = Array.isArray(content) ? content : []
        isNewChain = isNewChain || blocks.length > 1
        return blocks.map((_, index) => {
          const uuid = isNewChain
            ? deriveUUID(m.uuid, index)
            : m.uuid
          return {
            type: 'assistant' as const,
            timestamp: m.timestamp,
            message: {
              ...m.message,
              content: [_] as ContentBlockParam[],
              context_management: m.message.context_management ?? null,
            },
            isMeta: m.isMeta,
            isVirtual: m.isVirtual,
            requestId: m.requestId,
            uuid,
            error: m.error,
            isApiErrorMessage: m.isApiErrorMessage,
            advisorModel: m.advisorModel,
          } as unknown as NormalizedAssistantMessage
        })
      }
      case 'attachment':
        return [message as unknown as NormalizedMessage]
      case 'progress':
        return [message as unknown as NormalizedMessage]
      case 'system':
        return [message as unknown as NormalizedMessage]
      case 'user': {
        const m = message as UserMessageWithBody
        if (typeof m.message.content === 'string') {
          const uuid = isNewChain ? deriveUUID(m.uuid, 0) : m.uuid
          return [
            {
              ...m,
              uuid,
              message: {
                ...m.message,
                content: [{ type: 'text', text: m.message.content }],
              },
            } as unknown as NormalizedMessage,
          ]
        }
        isNewChain = isNewChain || m.message.content.length > 1
        let imageIndex = 0
        return m.message.content.map((_, index) => {
          const isImage = _.type === 'image'
          // For image content blocks, extract just the ID for this image
          const imageId =
            isImage && m.imagePasteIds
              ? m.imagePasteIds[imageIndex]
              : undefined
          if (isImage) imageIndex++
          return createNormalizedUserBlockMessage({
            source: m,
            content: [_] as unknown as ContentBlockParam[],
            imagePasteIds:
              imageId !== undefined ? [imageId] as (string | number)[] : undefined,
            uuid: isNewChain ? deriveUUID(m.uuid, index) : m.uuid,
          }) as unknown as NormalizedMessage
        })
      }
    }
  })
}

// Per-element cache for normalizeMessages. The only cross-message state in
// normalizeMessages is the monotonic isNewChain flag, so each message's
// normalized output is fully determined by (message identity, entry flag).
// Caching on the message object keeps output identity stable across calls,
// which preserves downstream WeakMap caches and React.memo bailouts, and
// reduces each unchanged message to an O(1) cache hit (reused blocks, no
// re-splitting or re-allocation) instead of a full renormalization. The call
// itself still scans the message list and reassembles the output array, so it
// stays O(n) per render — this is an allocation/object-identity optimization,
// not an O(1) append. Entries GC together with their messages.
type NormalizedCacheEntry = {
  entryFlag: boolean
  exitFlag: boolean
  out: NormalizedMessage[]
}
const normalizedMessageCache = new WeakMap<Message, NormalizedCacheEntry>()

// Drop-in replacement for normalizeMessages on render hot paths. Reuses each
// message's previously normalized blocks (preserving object identity) when the
// incoming isNewChain flag matches the cached run; recomputes only changed or
// new messages. Messages are treated as immutable, matching the assumptions of
// the React.memo comparators downstream.
export function normalizeMessagesCached(
  messages: Message[],
): NormalizedMessage[] {
  const out: NormalizedMessage[] = []
  let flag = false
  for (const message of messages) {
    const cached = normalizedMessageCache.get(message)
    if (cached && cached.entryFlag === flag) {
      for (const m of cached.out) {
        out.push(m)
      }
      flag = cached.exitFlag
      continue
    }
    const entryFlag = flag
    // Reuse normalizeMessages for the actual block-splitting logic so the two
    // implementations cannot drift. isNewChain only transitions false -> true,
    // so seeding the single-element run with the current flag is equivalent to
    // running the whole list: pass a synthetic multi-block predecessor when the
    // flag is already set.
    const normalized = normalizeSingleMessageWithFlag(message, entryFlag)
    normalizedMessageCache.set(message, {
      entryFlag,
      exitFlag: normalized.exitFlag,
      out: normalized.out,
    })
    for (const m of normalized.out) {
      out.push(m)
    }
    flag = normalized.exitFlag
  }
  return out
}

function normalizeSingleMessageWithFlag(
  message: Message,
  entryFlag: boolean,
): { out: NormalizedMessage[]; exitFlag: boolean } {
  const exitFlag =
    entryFlag ||
    ((message.type === 'assistant' ||
      (message.type === 'user' && typeof (message as MessageWithBody).message.content !== 'string')) &&
      (message as MessageWithBody).message.content.length > 1)

  if (!entryFlag) {
    return { out: normalizeMessages([message]), exitFlag }
  }

  // normalizeMessages keys UUID derivation off its internal isNewChain flag;
  // when the chain flag is already set for this position, every produced block
  // must get a derived UUID. Recreate that by normalizing the single message
  // and re-deriving UUIDs the same way the full pass would.
  switch (message.type) {
    case 'attachment':
    case 'progress':
    case 'system':
      return { out: [message] as unknown as NormalizedMessage[], exitFlag }
    default: {
      const normalized = normalizeMessages([message])
      return {
        out: normalized.map(
          (m, index) =>
            ({
              ...m,
              uuid: deriveUUID(message.uuid as UUID, index),
            }) as unknown as NormalizedMessage,
        ),
        exitFlag,
      }
    }
  }
}
