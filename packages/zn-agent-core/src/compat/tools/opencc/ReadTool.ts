import { falseFn } from '../../runtime/openccToolDefaults.js'
import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import { fileReadTool } from '../index.js'

/**
 * Wrap zai's `fileReadTool` as an opencc `Read` tool.
 *
 * opencc calls it `Read`; zai calls it `FileRead`.
 * Marked `isReadOnly: true` since reading never modifies files.
 */
export function wrapReadToolAsOpencc() {
  const wrapped = wrapAsOpenccTool(fileReadTool as any) as any
  wrapped.name = 'Read' // opencc calls it 'Read', zai calls it 'FileRead'
  wrapped.isReadOnly = () => true
  wrapped.isDestructive = falseFn
  return wrapped
}
