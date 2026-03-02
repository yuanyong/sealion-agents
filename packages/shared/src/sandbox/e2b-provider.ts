/**
 * E2B Sandbox Provider
 *
 * Implements SandboxProvider using the E2B SDK.
 * Each instance wraps a single E2B cloud sandbox VM.
 *
 * @see https://e2b.dev/docs
 */

import { Sandbox } from 'e2b';
import type {
  SandboxProvider,
  SandboxConfig,
  CommandResult,
  CommandOptions,
  FileEntry,
  GrepOptions,
} from './types.ts';

export class E2bSandboxProvider implements SandboxProvider {
  private sandbox: Sandbox | null = null;
  private sandboxId: string = '';

  async start(config: SandboxConfig): Promise<void> {
    const opts: Record<string, unknown> = {
      timeoutMs: config.timeoutMs ?? 300_000, // 5 min default
    };

    if (config.apiKey) {
      opts.apiKey = config.apiKey;
    }

    if (config.envVars) {
      opts.envs = config.envVars;
    }

    if (config.template) {
      this.sandbox = await Sandbox.create(config.template, opts as any);
    } else {
      this.sandbox = await Sandbox.create(opts as any);
    }

    this.sandboxId = this.sandbox.sandboxId;

    // Set up working directory if specified
    if (config.workingDir) {
      await this.sandbox.commands.run(`mkdir -p ${config.workingDir}`);
    }
  }

  async executeCommand(command: string, opts?: CommandOptions): Promise<CommandResult> {
    this.ensureRunning();
    const result = await this.sandbox!.commands.run(command, {
      cwd: opts?.cwd,
      envs: opts?.envVars,
      timeoutMs: opts?.timeoutMs,
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async readFile(path: string): Promise<string> {
    this.ensureRunning();
    return await this.sandbox!.files.read(path, { format: 'text' });
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.ensureRunning();
    await this.sandbox!.files.write(path, content);
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    this.ensureRunning();
    const entries = await this.sandbox!.files.list(path);
    return entries.map(entry => ({
      name: entry.name,
      path: entry.path ?? `${path}/${entry.name}`,
      type: entry.type === 'dir' ? 'directory' as const : 'file' as const,
    }));
  }

  async glob(pattern: string, cwd?: string): Promise<string[]> {
    this.ensureRunning();
    // Use find with glob pattern in the sandbox
    const dir = cwd ?? '/';
    const result = await this.sandbox!.commands.run(
      `find ${dir} -path '${pattern}' -type f 2>/dev/null || true`
    );
    return result.stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  }

  async grep(pattern: string, path: string, opts?: GrepOptions): Promise<string> {
    this.ensureRunning();
    const flags: string[] = ['-r'];
    if (opts?.ignoreCase) flags.push('-i');
    if (opts?.lineNumbers) flags.push('-n');
    if (opts?.context) flags.push(`-C ${opts.context}`);

    let cmd = `grep ${flags.join(' ')} '${pattern.replace(/'/g, "'\\''")}'`;

    if (opts?.glob) {
      cmd += ` --include='${opts.glob}'`;
    }

    cmd += ` ${path} 2>/dev/null || true`;

    const result = await this.sandbox!.commands.run(cmd);
    return result.stdout;
  }

  async destroy(): Promise<void> {
    if (this.sandbox) {
      try {
        await this.sandbox.kill();
      } catch {
        // Sandbox may already be dead
      }
      this.sandbox = null;
    }
  }

  async isAlive(): Promise<boolean> {
    if (!this.sandbox) return false;
    try {
      return await this.sandbox.isRunning();
    } catch {
      return false;
    }
  }

  getId(): string {
    return this.sandboxId;
  }

  private ensureRunning(): void {
    if (!this.sandbox) {
      throw new Error('Sandbox not started. Call start() first.');
    }
  }
}
