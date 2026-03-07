/**
 * Sandbox Module
 *
 * Cloud sandbox infrastructure for executing agent tools in isolated VMs.
 * Supports E2B (default) with extensibility for other providers (Daytona).
 */

export type {
  SandboxProvider,
  SandboxConfig,
  CommandResult,
  CommandOptions,
  FileEntry,
  GrepOptions,
  SandboxProviderType,
} from './types.ts';

export { E2bSandboxProvider } from './e2b-provider.ts';
export { SandboxManager, type SandboxManagerConfig } from './sandbox-manager.ts';
export {
  createSandboxMcpServer,
  SANDBOXED_TOOLS,
  TOOL_REDIRECT_MAP,
} from './sandbox-mcp-server.ts';
