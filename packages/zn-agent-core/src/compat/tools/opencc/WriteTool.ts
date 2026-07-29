import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import { fileWriteTool } from '../index.js'

export function wrapWriteToolAsOpencc() {
  const wrapped = wrapAsOpenccTool(fileWriteTool as any) as any
  wrapped.name = 'Write'
  wrapped.isDestructive = () => true
  return wrapped
}
