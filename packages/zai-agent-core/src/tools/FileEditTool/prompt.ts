export function renderPrompt(): string {
  return `Performs a string replacement in a file. The file_path can be absolute or relative to the current working directory.

Usage:
- file_path: required path to existing file
- old_string: the exact text to replace (must be unique in the file unless replace_all=true)
- new_string: replacement text
- replace_all: set true to replace every occurrence (default false — requires uniqueness)

Before editing, you MUST have read the file (Read or offset/limit section). Include enough surrounding context in old_string to make it unique. The edit fails if:
- file does not exist
- old_string is not found
- old_string is not unique and replace_all is not set

The file is written atomically only after the string is found and replaced.`
}
