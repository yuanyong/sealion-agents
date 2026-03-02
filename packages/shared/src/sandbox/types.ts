/**
 * Sandbox Provider Interface & Types
 *
 * Defines the abstraction layer for cloud sandbox providers (E2B, Daytona, etc.).
 * Each provider implements this interface to enable agent tool execution in isolated VMs.
 */

export interface SandboxConfig {
  /** Sandbox template name or ID (provider-specific). */
  template?: string;
  /** Sandbox timeout in milliseconds. After this, the sandbox is auto-destroyed. */
  timeoutMs?: number;
  /** Environment variables to set inside the sandbox. */
  envVars?: Record<string, string>;
  /** Working directory for command execution inside the sandbox. */
  workingDir?: string;
  /** Provider-specific API key. */
  apiKey?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  /** Working directory for this command. */
  cwd?: string;
  /** Environment variables for this command. */
  envVars?: Record<string, string>;
  /** Timeout in milliseconds for this command. */
  timeoutMs?: number;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export interface GrepOptions {
  /** Case-insensitive search. */
  ignoreCase?: boolean;
  /** Include line numbers in output. */
  lineNumbers?: boolean;
  /** Number of context lines around matches. */
  context?: number;
  /** Glob pattern to filter files. */
  glob?: string;
}

/**
 * Abstraction for a cloud sandbox that can execute commands and manage files.
 * Each provider (E2B, Daytona, etc.) implements this interface.
 */
export interface SandboxProvider {
  /** Provision and start the sandbox. */
  start(config: SandboxConfig): Promise<void>;

  /** Execute a shell command in the sandbox. */
  executeCommand(command: string, opts?: CommandOptions): Promise<CommandResult>;

  /** Read a file's text content from the sandbox. */
  readFile(path: string): Promise<string>;

  /** Write text content to a file in the sandbox. */
  writeFile(path: string, content: string): Promise<void>;

  /** List entries in a directory inside the sandbox. */
  listFiles(path: string): Promise<FileEntry[]>;

  /** Find files matching a glob pattern. */
  glob(pattern: string, cwd?: string): Promise<string[]>;

  /** Search file contents for a regex pattern. */
  grep(pattern: string, path: string, opts?: GrepOptions): Promise<string>;

  /** Destroy the sandbox and free resources. */
  destroy(): Promise<void>;

  /** Check if the sandbox is still running. */
  isAlive(): Promise<boolean>;

  /** Get the unique sandbox ID (for reconnection). */
  getId(): string;
}

/** Supported sandbox provider types. */
export type SandboxProviderType = 'e2b' | 'daytona';
