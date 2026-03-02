/**
 * Sandbox MCP Server
 *
 * Creates an SDK MCP server that redirects agent tools (Bash, Read, Write, Edit, Glob, Grep)
 * to execute inside a cloud sandbox instead of on the host.
 *
 * Follows the existing pattern in claude-agent.ts `createSourceProxyServers()`.
 * The SDK adds an `mcp__{serverKey}__` prefix to tool names automatically.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SandboxProvider } from './types.ts';

/**
 * Create an SDK MCP server with tools that execute inside the sandbox.
 *
 * When added to the agent's mcpServers with key 'sandbox', tools become available as:
 *   mcp__sandbox__sandbox_bash, mcp__sandbox__sandbox_read, etc.
 *
 * The agent's PreToolUse hook can redirect built-in tool calls to these sandbox versions.
 */
export function createSandboxMcpServer(sandbox: SandboxProvider) {
  const sandboxTools = [
    // ── Bash ──────────────────────────────────────────────────────
    tool(
      'sandbox_bash',
      'Execute a shell command in the cloud sandbox. Use this for all command execution.',
      {
        command: z.string().describe('The shell command to execute'),
        cwd: z.string().optional().describe('Working directory for the command'),
        timeout: z.number().optional().describe('Timeout in milliseconds'),
      },
      async (args) => {
        try {
          const result = await sandbox.executeCommand(args.command, {
            cwd: args.cwd,
            timeoutMs: args.timeout,
          });
          const output = [
            result.stdout,
            result.stderr ? `[stderr]\n${result.stderr}` : '',
          ].filter(Boolean).join('\n');
          return {
            content: [{
              type: 'text' as const,
              text: result.exitCode === 0
                ? output || '(no output)'
                : `Command failed with exit code ${result.exitCode}\n${output}`,
            }],
            ...(result.exitCode !== 0 ? { isError: true } : {}),
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Sandbox error: ${String(err)}` }],
            isError: true,
          };
        }
      }
    ),

    // ── Read File ────────────────────────────────────────────────
    tool(
      'sandbox_read',
      'Read a file from the cloud sandbox filesystem.',
      {
        file_path: z.string().describe('Absolute path to the file to read'),
        offset: z.number().optional().describe('Line number to start reading from (1-indexed)'),
        limit: z.number().optional().describe('Number of lines to read'),
      },
      async (args) => {
        try {
          let content = await sandbox.readFile(args.file_path);

          // Apply offset and limit if specified
          if (args.offset || args.limit) {
            const lines = content.split('\n');
            const start = (args.offset ?? 1) - 1;
            const end = args.limit ? start + args.limit : lines.length;
            content = lines.slice(start, end)
              .map((line, i) => `${String(start + i + 1).padStart(6)}→${line}`)
              .join('\n');
          } else {
            // Add line numbers like the Read tool
            content = content.split('\n')
              .map((line, i) => `${String(i + 1).padStart(6)}→${line}`)
              .join('\n');
          }

          return {
            content: [{ type: 'text' as const, text: content }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error reading file: ${String(err)}` }],
            isError: true,
          };
        }
      }
    ),

    // ── Write File ───────────────────────────────────────────────
    tool(
      'sandbox_write',
      'Write content to a file in the cloud sandbox. Creates the file if it does not exist.',
      {
        file_path: z.string().describe('Absolute path to the file to write'),
        content: z.string().describe('The content to write to the file'),
      },
      async (args) => {
        try {
          await sandbox.writeFile(args.file_path, args.content);
          return {
            content: [{ type: 'text' as const, text: `File written: ${args.file_path}` }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error writing file: ${String(err)}` }],
            isError: true,
          };
        }
      }
    ),

    // ── Edit File (string replacement) ───────────────────────────
    tool(
      'sandbox_edit',
      'Perform an exact string replacement in a file in the cloud sandbox.',
      {
        file_path: z.string().describe('Absolute path to the file to edit'),
        old_string: z.string().describe('The exact text to find and replace'),
        new_string: z.string().describe('The replacement text'),
        replace_all: z.boolean().optional().describe('Replace all occurrences (default: false)'),
      },
      async (args) => {
        try {
          const content = await sandbox.readFile(args.file_path);
          const occurrences = content.split(args.old_string).length - 1;

          if (occurrences === 0) {
            return {
              content: [{ type: 'text' as const, text: `Error: old_string not found in ${args.file_path}` }],
              isError: true,
            };
          }

          if (!args.replace_all && occurrences > 1) {
            return {
              content: [{ type: 'text' as const, text: `Error: old_string found ${occurrences} times in ${args.file_path}. Use replace_all=true or provide a more specific string.` }],
              isError: true,
            };
          }

          let newContent: string;
          if (args.replace_all) {
            newContent = content.split(args.old_string).join(args.new_string);
          } else {
            newContent = content.replace(args.old_string, args.new_string);
          }

          await sandbox.writeFile(args.file_path, newContent);
          return {
            content: [{ type: 'text' as const, text: `File edited: ${args.file_path} (${args.replace_all ? occurrences : 1} replacement${occurrences > 1 ? 's' : ''})` }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error editing file: ${String(err)}` }],
            isError: true,
          };
        }
      }
    ),

    // ── Glob ─────────────────────────────────────────────────────
    tool(
      'sandbox_glob',
      'Find files matching a glob pattern in the cloud sandbox.',
      {
        pattern: z.string().describe('Glob pattern to match files (e.g., "**/*.ts")'),
        path: z.string().optional().describe('Directory to search in (default: /)'),
      },
      async (args) => {
        try {
          const results = await sandbox.glob(args.pattern, args.path);
          if (results.length === 0) {
            return {
              content: [{ type: 'text' as const, text: 'No files found matching the pattern.' }],
            };
          }
          return {
            content: [{ type: 'text' as const, text: results.join('\n') }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${String(err)}` }],
            isError: true,
          };
        }
      }
    ),

    // ── Grep ─────────────────────────────────────────────────────
    tool(
      'sandbox_grep',
      'Search file contents for a regex pattern in the cloud sandbox.',
      {
        pattern: z.string().describe('Regular expression pattern to search for'),
        path: z.string().describe('File or directory to search in'),
        ignore_case: z.boolean().optional().describe('Case-insensitive search'),
        include: z.string().optional().describe('Glob pattern to filter files (e.g., "*.ts")'),
        context: z.number().optional().describe('Number of context lines around matches'),
      },
      async (args) => {
        try {
          const result = await sandbox.grep(args.pattern, args.path, {
            ignoreCase: args.ignore_case,
            lineNumbers: true,
            context: args.context,
            glob: args.include,
          });
          if (!result.trim()) {
            return {
              content: [{ type: 'text' as const, text: 'No matches found.' }],
            };
          }
          return {
            content: [{ type: 'text' as const, text: result }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${String(err)}` }],
            isError: true,
          };
        }
      }
    ),

    // ── List Files ───────────────────────────────────────────────
    tool(
      'sandbox_ls',
      'List entries in a directory in the cloud sandbox.',
      {
        path: z.string().describe('Directory path to list'),
      },
      async (args) => {
        try {
          const entries = await sandbox.listFiles(args.path);
          if (entries.length === 0) {
            return {
              content: [{ type: 'text' as const, text: 'Directory is empty.' }],
            };
          }
          const listing = entries.map(e =>
            `${e.type === 'directory' ? 'd' : '-'} ${e.name}`
          ).join('\n');
          return {
            content: [{ type: 'text' as const, text: listing }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${String(err)}` }],
            isError: true,
          };
        }
      }
    ),
  ];

  return createSdkMcpServer({
    name: 'sandbox-tools',
    version: '1.0.0',
    tools: sandboxTools,
  });
}

/**
 * The set of built-in tool names that should be redirected to sandbox equivalents
 * when a sandbox is active. The agent's PreToolUse hook checks this set.
 */
export const SANDBOXED_TOOLS = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
]);

/**
 * Map from built-in tool names to their sandbox MCP equivalents.
 * Used by PreToolUse to generate redirection messages.
 */
export const TOOL_REDIRECT_MAP: Record<string, string> = {
  'Bash': 'mcp__sandbox__sandbox_bash',
  'Read': 'mcp__sandbox__sandbox_read',
  'Write': 'mcp__sandbox__sandbox_write',
  'Edit': 'mcp__sandbox__sandbox_edit',
  'Glob': 'mcp__sandbox__sandbox_glob',
  'Grep': 'mcp__sandbox__sandbox_grep',
};
