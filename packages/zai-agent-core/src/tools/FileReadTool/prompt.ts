export function renderPrompt(): string {
  return `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter can be absolute or relative to the current working directory
- By default, it reads up to 2000 lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- When you already know which part of the file you need, only read that part. This can be important for larger files
- Results are returned using cat -n format, with line numbers prefixed as "<line>: <content>" (0-based)
- For very long files, prefer offset+limit to read sections
- This tool can only read files, not directories. To read a directory, use the Bash tool.`
}
