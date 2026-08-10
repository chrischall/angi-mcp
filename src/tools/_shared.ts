import { errorResult, messageOf, wrapToolError, McpToolError } from '@chrischall/mcp-utils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Run a tool body, converting any throw into an MCP error result.
 *
 * `wrapToolError` returns an McpToolError (it does not build a tool result), so
 * the message is rendered here — with the actionable `hint` appended, which is
 * the part that tells the agent how to recover (resolve the slug, refresh the
 * signed-in tab). `errorResult` redacts secret-shaped values on the way out.
 */
export async function guard(
  toolName: string,
  fn: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const wrapped = wrapToolError(toolName, err);
    const hint = wrapped instanceof McpToolError ? wrapped.hint : undefined;
    return errorResult(hint ? `${messageOf(wrapped)}\n\nHint: ${hint}` : messageOf(wrapped));
  }
}
