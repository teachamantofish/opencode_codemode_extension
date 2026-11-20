import { Plugin } from "@opencode/plugin"

// Idea A: flip built-in tools into Code Mode so `execute` scripts can call them.
// Built-ins keep their own permission checks when nested under `execute`.
const DEFAULT_TOOLS = ["read", "grep", "glob"]

export default Plugin.define({
  id: "codemode-builtins",
  async setup(ctx) {
    const ids = Array.isArray(ctx.options.tools) ? (ctx.options.tools as string[]) : DEFAULT_TOOLS

    await ctx.tool.transform((editor) => {
      const present = editor.list().map((t) => t.id)
      console.log(`[codemode-builtins] tools in editor: ${present.join(", ")}`)
      for (const id of ids) {
        if (!editor.get(id)) {
          console.log(`[codemode-builtins] '${id}' not in editor; skipped`)
          continue
        }
        editor.update(id, (tool) => {
          tool.options = { ...tool.options, codemode: true }
        })
      }
    })

    const after = (await ctx.tool.list()).filter((t) => ids.includes(t.id))
    const report = after.map((t) => ({ id: t.id, options: t.options }))
    console.log(`[codemode-builtins] result: ${JSON.stringify(report)}`)
    await ctx.storage.set("last-result", report)
  },
})
