/**
 * Sandbox Manager
 *
 * Manages per-session sandbox lifecycle: lazy creation, idle timeout, cleanup.
 * Each session gets its own isolated sandbox. The manager provides a central
 * point for the web server to create, retrieve, and destroy sandboxes.
 */

import type { SandboxProvider, SandboxConfig, SandboxProviderType } from './types.ts';
import { E2bSandboxProvider } from './e2b-provider.ts';

export interface SandboxManagerConfig {
  /** Which sandbox provider to use. */
  provider: SandboxProviderType;
  /** Default sandbox configuration applied to all new sandboxes. */
  defaults: SandboxConfig;
  /** Idle timeout in ms — auto-destroy sandbox after inactivity. 0 = no auto-destroy. */
  idleTimeoutMs?: number;
}

interface ManagedSandbox {
  provider: SandboxProvider;
  lastActivity: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export class SandboxManager {
  private sandboxes = new Map<string, ManagedSandbox>();
  private config: SandboxManagerConfig;

  constructor(config: SandboxManagerConfig) {
    this.config = config;
  }

  /**
   * Get an existing sandbox or create a new one for the given session.
   * Creation is lazy — the first call provisions the sandbox.
   */
  async getOrCreate(sessionId: string, overrides?: Partial<SandboxConfig>): Promise<SandboxProvider> {
    const existing = this.sandboxes.get(sessionId);
    if (existing) {
      // Check if still alive
      const alive = await existing.provider.isAlive();
      if (alive) {
        this.touchActivity(sessionId);
        return existing.provider;
      }
      // Dead sandbox — clean up and recreate
      this.sandboxes.delete(sessionId);
    }

    // Create new sandbox
    const provider = this.createProvider();
    const sandboxConfig: SandboxConfig = {
      ...this.config.defaults,
      ...overrides,
    };

    await provider.start(sandboxConfig);

    const managed: ManagedSandbox = {
      provider,
      lastActivity: Date.now(),
    };

    this.sandboxes.set(sessionId, managed);

    // Set up idle timeout if configured
    if (this.config.idleTimeoutMs && this.config.idleTimeoutMs > 0) {
      this.resetIdleTimer(sessionId);
    }

    return provider;
  }

  /**
   * Get sandbox for a session without creating one. Returns null if none exists.
   */
  get(sessionId: string): SandboxProvider | null {
    return this.sandboxes.get(sessionId)?.provider ?? null;
  }

  /**
   * Check if a sandbox exists for the given session.
   */
  has(sessionId: string): boolean {
    return this.sandboxes.has(sessionId);
  }

  /**
   * Destroy the sandbox for a specific session.
   */
  async destroy(sessionId: string): Promise<void> {
    const managed = this.sandboxes.get(sessionId);
    if (!managed) return;

    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
    }

    try {
      await managed.provider.destroy();
    } catch {
      // Best effort cleanup
    }

    this.sandboxes.delete(sessionId);
  }

  /**
   * Destroy all sandboxes. Called during server shutdown.
   */
  async destroyAll(): Promise<void> {
    const destroyPromises = Array.from(this.sandboxes.keys()).map(
      sessionId => this.destroy(sessionId)
    );
    await Promise.allSettled(destroyPromises);
  }

  /**
   * Get the number of active sandboxes.
   */
  get size(): number {
    return this.sandboxes.size;
  }

  /**
   * Update last activity timestamp for a session (prevents idle timeout).
   */
  touchActivity(sessionId: string): void {
    const managed = this.sandboxes.get(sessionId);
    if (managed) {
      managed.lastActivity = Date.now();
      if (this.config.idleTimeoutMs && this.config.idleTimeoutMs > 0) {
        this.resetIdleTimer(sessionId);
      }
    }
  }

  private createProvider(): SandboxProvider {
    switch (this.config.provider) {
      case 'e2b':
        return new E2bSandboxProvider();
      case 'daytona':
        throw new Error('Daytona provider not yet implemented');
      default:
        throw new Error(`Unknown sandbox provider: ${this.config.provider}`);
    }
  }

  private resetIdleTimer(sessionId: string): void {
    const managed = this.sandboxes.get(sessionId);
    if (!managed) return;

    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
    }

    managed.idleTimer = setTimeout(async () => {
      console.log(`[SandboxManager] Idle timeout reached for session ${sessionId}, destroying sandbox`);
      await this.destroy(sessionId);
    }, this.config.idleTimeoutMs!);
  }
}
