import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import { fileEditTool } from '../index.js'

/**
 * Wrap zai's `fileEditTool` as an opencc `Edit` tool.
 *
 * opencc calls it `Edit`; zai calls it `FileEdit`.
 * Marked `isDestructive: true` since editing modifies files.
 */
export function wrapEditToolAsOpencc() {
  const wrapped = wrapAsOpenccTool(fileEditTool as any) as any
  wrapped.name = 'Edit' // opencc calls it 'Edit', zai calls it 'FileEdit'
  wrapped.isDestructive = () => true
  // isReadOnly stays false (default from wrapAsOpenccTool)
  return wrapped
}
