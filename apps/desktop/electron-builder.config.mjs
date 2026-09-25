/** electron-builder CLI entry; the factory lives in scripts/ so tests and `--check` can import it. */
import { createElectronBuilderConfig } from './scripts/electron-builder-config.mjs'

export default createElectronBuilderConfig()
