import { Plugin } from "@opencode/plugin"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

// Idea B: Code Mode wrapper tools under the `fs` namespace.
// Built-in tools are untouched. Plugin tools get no automatic permission
// checks, so every executor asserts the same action the built-in uses.

const SKIP_DIRS = new Set([".git", "node_modules", ".hg", ".svn"])
const MAX_FILE_BYTES = 50 * 1024 * 1024

type ToolCtx = { sessionID: string; agent?: string; messageID: string; id: string; signal?: AbortSignal }

function globToRegex(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/"
        re += slash ? "(?:.*/)?" : ".*"
        i += slash ? 2 : 1
      } else re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else if (c === "{") {
      const end = glob.indexOf("}", i)
      if (end < 0) re += "\\{"
      else {
        re += "(?:" + glob.slice(i + 1, end).split(",").map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")"
        i = end
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&")
  }
  return new RegExp("^" + re + "$")
}

async function* walk(root: string, hidden: boolean, signal?: AbortSignal): AsyncGenerator<string> {
  const stack = [root]
  while (stack.length) {
    signal?.throwIfAborted()
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!hidden && e.name.startsWith(".")) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full)
      } else if (e.isFile()) yield full
    }
  }
}

const toPosix = (p: string) => p.split(sep).join("/")

export default Plugin.define({
  id: "codemode-fs",
  async setup(ctx) {
    const base = ctx.location.directory
    const abs = (p: string) => (isAbsolute(p) ? p : resolve(base, p))
    const rel = (p: string) => {
      const r = relative(base, p)
      return r.startsWith("..") || isAbsolute(r) ? toPosix(p) : toPosix(r)
    }

    const assert = (context: ToolCtx, action: string, resources: string[]) =>
      ctx.permission.assert({
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
        action,
        resources,
      })

    // Match built-in resources: location-relative path inside, absolute path outside
    // (plus an external_directory check first, as the built-ins do).
    const assertPath = async (context: ToolCtx, action: string, file: string) => {
      const r = relative(base, file)
      const inside = r !== "" && !r.startsWith("..") && !isAbsolute(r)
      if (!inside) await assert(context, "external_directory", [toPosix(dirname(file)) + "/*"])
      await assert(context, action, [inside ? toPosix(r) : toPosix(file)])
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "fs",
        description:
          "File tools for Code Mode scripts. Each returns a JSON string: wrap calls in JSON.parse(...) before using the result. Paths are relative to the session directory unless absolute.",
      })

      editor.add({
        name: "read",
        description: "Read a text file. Returns { path, content, startLine, endLine, totalLines, next } where next is the line to continue from, or null.",
        input: {
          type: "object",
          properties: {
            path: { type: "string" },
            offset: { type: "integer", minimum: 1, description: "1-based start line (default 1)" },
            limit: { type: "integer", minimum: 1, description: "Max lines (default 2000)" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        options: { namespace: "fs", codemode: true },
        execute: async (input, context) => {
          const { path, offset = 1, limit = 2000 } = input as { path: string; offset?: number; limit?: number }
          const file = abs(path)
          await assertPath(context as ToolCtx, "read", file)
          const lines = (await readFile(file, "utf8")).split(/\r?\n/)
          const start = offset - 1
          const slice = lines.slice(start, start + limit)
          const endLine = start + slice.length
          return {
            content: JSON.stringify({
              path: rel(file),
              content: slice.join("\n"),
              startLine: offset,
              endLine,
              totalLines: lines.length,
              next: endLine < lines.length ? endLine + 1 : null,
            }),
          }
        },
      })

      editor.add({
        name: "glob",
        description: "Find files by glob pattern (e.g. **/*.ts). Returns an array of relative paths. Skips .git and node_modules.",
        input: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string", description: "Directory to search (default session directory)" },
            hidden: { type: "boolean", description: "Include dot files/dirs (default false)" },
            limit: { type: "integer", minimum: 1, description: "Max results (default 200)" },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
        options: { namespace: "fs", codemode: true },
        execute: async (input, context) => {
          const { pattern, path = ".", hidden = false, limit = 200 } = input as {
            pattern: string; path?: string; hidden?: boolean; limit?: number
          }
          const c = context as ToolCtx
          await assert(c, "glob", [pattern])
          const root = abs(path)
          const re = globToRegex(pattern)
          const out: string[] = []
          for await (const f of walk(root, hidden, c.signal)) {
            if (re.test(toPosix(relative(root, f)))) out.push(rel(f))
            if (out.length >= limit) break
          }
          return { content: JSON.stringify(out) }
        },
      })

      editor.add({
        name: "grep",
        description: "Search file contents. Returns [{ path, line, text }]. pattern is a JS regex unless literal is true.",
        input: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string", description: "Directory or file (default session directory)" },
            include: { type: "string", description: "Glob filter on file paths, e.g. **/*.ts" },
            literal: { type: "boolean" },
            caseSensitive: { type: "boolean", description: "Default true" },
            limit: { type: "integer", minimum: 1, description: "Max matches (default 100)" },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
        options: { namespace: "fs", codemode: true },
        execute: async (input, context) => {
          const { pattern, path = ".", include, literal = false, caseSensitive = true, limit = 100 } = input as {
            pattern: string; path?: string; include?: string; literal?: boolean; caseSensitive?: boolean; limit?: number
          }
          const c = context as ToolCtx
          await assert(c, "grep", [pattern])
          const src = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern
          const re = new RegExp(src, caseSensitive ? "" : "i")
          const inc = include ? globToRegex(include) : undefined
          const root = abs(path)
          const hits: { path: string; line: number; text: string }[] = []
          let files: AsyncIterable<string> | string[]
          try {
            files = (await readdir(root)) && walk(root, false, c.signal)
          } catch {
            files = [root]
          }
          outer: for await (const f of files) {
            if (inc && !inc.test(toPosix(relative(root, f)))) continue
            let text: string
            try {
              const buf = await readFile(f)
              if (buf.length > MAX_FILE_BYTES || buf.includes(0)) continue
              text = buf.toString("utf8")
            } catch {
              continue
            }
            const lines = text.split(/\r?\n/)
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                hits.push({ path: rel(f), line: i + 1, text: lines[i].slice(0, 300) })
                if (hits.length >= limit) break outer
              }
            }
          }
          return { content: JSON.stringify(hits) }
        },
      })

      editor.add({
        name: "edit",
        description: "Replace exact text in a file. oldString must match once unless replaceAll. Returns { path, replacements }.",
        input: {
          type: "object",
          properties: {
            path: { type: "string" },
            oldString: { type: "string" },
            newString: { type: "string" },
            replaceAll: { type: "boolean" },
          },
          required: ["path", "oldString", "newString"],
          additionalProperties: false,
        },
        options: { namespace: "fs", codemode: true },
        execute: async (input, context) => {
          const { path, oldString, newString, replaceAll = false } = input as {
            path: string; oldString: string; newString: string; replaceAll?: boolean
          }
          if (oldString === newString) throw new Error("oldString and newString are identical")
          const file = abs(path)
          await assertPath(context as ToolCtx, "edit", file)
          const text = await readFile(file, "utf8")
          const count = text.split(oldString).length - 1
          if (count === 0) throw new Error(`oldString not found in ${rel(file)}`)
          if (count > 1 && !replaceAll) throw new Error(`oldString matches ${count} times in ${rel(file)}; set replaceAll or add context`)
          await writeFile(file, replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString))
          return { content: JSON.stringify({ path: rel(file), replacements: replaceAll ? count : 1 }) }
        },
      })
    })
  },
})
