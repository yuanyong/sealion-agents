/**
 * Web Backend Server
 *
 * Replaces the Electron main process with a Bun HTTP server using Hono.
 * Provides REST API endpoints and WebSocket for real-time events.
 *
 * Architecture:
 *   [Browser Client] --HTTP/WS--> [This Server] --> [@craft-agent/shared]
 *
 * The server reuses the exact same business logic packages as the Electron app,
 * just exposed over HTTP instead of IPC.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { resolve, join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { readFile, readdir, stat, mkdir, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { execSync } from 'child_process'

// Import sandbox manager for cloud VM isolation (E2B)
import { SandboxManager, type SandboxManagerConfig, type SandboxProviderType } from '@craft-agent/shared/sandbox'

// Import agent backend factory and types
import {
  createBackendFromConnection,
  resolveSessionConnection,
  resolveBackendContext,
  testBackendConnection,
  providerTypeToAgentProvider,
  type AgentBackend,
} from '@craft-agent/shared/agent/backend'

// Import credential manager for secure API key storage
import { getCredentialManager } from '@craft-agent/shared/credentials'

// Import model registry
import { getModelsForProviderType, type LlmProviderType } from '@craft-agent/shared/config/llm-connections'
import { ANTHROPIC_MODELS, DEFAULT_MODEL, getModelShortName } from '@craft-agent/shared/config/models'

import type { BackendHostRuntimeContext } from '@craft-agent/shared/agent/backend'

// Import shared packages (same business logic as Electron main process)
import {
  loadStoredConfig,
  saveConfig,
  getWorkspaceByNameOrId,
  addWorkspace,
  setActiveWorkspace,
  getLlmConnections,
  getLlmConnection,
  addLlmConnection,
  updateLlmConnection,
  deleteLlmConnection,
  getDefaultLlmConnection,
  setDefaultLlmConnection,
  type Workspace,
  type LlmConnection,
  type LlmConnectionWithStatus,
} from '@craft-agent/shared/config'

import { getPreferencesPath } from '@craft-agent/shared/config'

// ─── WebSocket Event Broadcasting ──────────────────────────────────────

type WSClient = { send: (data: string) => void; readyState: number }
const wsClients = new Set<WSClient>()

function broadcast(type: string, data: unknown = null) {
  const message = JSON.stringify({ type, data })
  for (const client of wsClients) {
    try {
      if (client.readyState === 1) { // OPEN
        client.send(message)
      }
    } catch {
      wsClients.delete(client)
    }
  }
}

// ─── In-memory session store ───────────────────────────────────────────
// In a production deployment, this would use a database or the same
// file-based storage as the Electron app. For now, we use in-memory
// storage to demonstrate the architecture.

interface WebSession {
  id: string
  workspaceId: string
  name: string
  messages: Array<{ id: string; role: string; content: string; timestamp: number }>
  status: string
  createdAt: number
  updatedAt: number
  parentSessionId?: string
  metadata?: Record<string, unknown>
  // LLM connection & model (locked after first message)
  llmConnection?: string   // Connection slug
  model?: string           // Model ID
  connectionLocked?: boolean
}

const sessions = new Map<string, WebSession>()

// Per-session agent instances (lazy-created on first message)
const agents = new Map<string, AgentBackend>()

function createSessionId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

// ─── Sandbox Manager ────────────────────────────────────────────────
// Provides per-session cloud sandbox VMs for isolated agent tool execution.
// Configured via environment variables:
//   SANDBOX_PROVIDER=e2b (default)
//   E2B_API_KEY=... (required for E2B)
//   SANDBOX_TIMEOUT=300000 (idle timeout in ms, default 5 min)
//   SANDBOX_TEMPLATE=base (E2B template, default 'base')

const sandboxConfig: SandboxManagerConfig = {
  provider: (Bun.env.SANDBOX_PROVIDER ?? 'e2b') as SandboxProviderType,
  defaults: {
    apiKey: Bun.env.E2B_API_KEY,
    template: Bun.env.SANDBOX_TEMPLATE,
    timeoutMs: parseInt(Bun.env.SANDBOX_TIMEOUT || '300000'),
  },
  idleTimeoutMs: parseInt(Bun.env.SANDBOX_IDLE_TIMEOUT || '600000'), // 10 min idle
}

const sandboxManager = Bun.env.E2B_API_KEY
  ? new SandboxManager(sandboxConfig)
  : null

if (sandboxManager) {
  console.log(`[Sandbox] E2B sandbox manager initialized (provider=${sandboxConfig.provider})`)
} else {
  console.log('[Sandbox] No E2B_API_KEY set — sandbox disabled, agent tools run locally')
}

// Host runtime context for backend operations
const hostRuntime: BackendHostRuntimeContext = {
  appRootPath: resolve(__dirname, '../../..'),
  isPackaged: Bun.env.NODE_ENV === 'production',
}

// ─── Hono App ──────────────────────────────────────────────────────────

const app = new Hono()

// CORS for development
app.use('*', cors({
  origin: ['http://localhost:3000', 'http://localhost:5173'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
}))

// ─── Session endpoints ─────────────────────────────────────────────────

app.get('/api/sessions', (c) => {
  const allSessions = Array.from(sessions.values()).map(s => ({
    id: s.id,
    workspaceId: s.workspaceId,
    name: s.name,
    status: s.status,
    messages: s.messages,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    parentSessionId: s.parentSessionId,
    metadata: s.metadata,
  }))
  return c.json(allSessions)
})

app.get('/api/sessions/:id/messages', (c) => {
  const session = sessions.get(c.req.param('id'))
  if (!session) return c.json(null)
  return c.json(session)
})

app.post('/api/sessions', async (c) => {
  const { workspaceId, options } = await c.req.json()
  const id = createSessionId()
  const session: WebSession = {
    id,
    workspaceId,
    name: options?.name || 'New Chat',
    messages: [],
    status: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: options?.metadata,
  }
  sessions.set(id, session)
  broadcast('session:event', { type: 'session_created', sessionId: id, session })
  return c.json(session)
})

app.post('/api/sessions/sub', async (c) => {
  const { workspaceId, parentSessionId, options } = await c.req.json()
  const id = createSessionId()
  const session: WebSession = {
    id,
    workspaceId,
    parentSessionId,
    name: options?.name || 'Sub-session',
    messages: [],
    status: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  sessions.set(id, session)
  broadcast('session:event', { type: 'session_created', sessionId: id, session })
  return c.json(session)
})

app.post('/api/sessions/:id/delete', async (c) => {
  const id = c.req.param('id')
  sessions.delete(id)
  // Destroy associated agent (if any)
  const agent = agents.get(id)
  if (agent) {
    try { await agent.destroy() } catch { /* ignore */ }
    agents.delete(id)
  }
  // Destroy associated sandbox (if any)
  if (sandboxManager) {
    await sandboxManager.destroy(id).catch(() => {})
  }
  broadcast('session:event', { type: 'session_deleted', sessionId: id })
  return c.json({ success: true })
})

app.post('/api/sessions/:id/message', async (c) => {
  const id = c.req.param('id')
  const { message, attachments, storedAttachments, options } = await c.req.json()
  const session = sessions.get(id)
  if (!session) return c.json({ error: 'Session not found' }, 404)

  // Add user message
  const userMsg = {
    id: randomUUID(),
    role: 'user',
    content: message,
    timestamp: Date.now(),
  }
  session.messages.push(userMsg)
  session.status = 'processing'
  session.updatedAt = Date.now()

  broadcast('session:event', {
    type: 'message_added',
    sessionId: id,
    message: userMsg,
  })

  // Run agent chat in background (non-blocking — events stream via WebSocket)
  runAgentChat(id, session, message).catch(err => {
    console.error(`[Agent] Error in session ${id}:`, err)
    const errorMsg = {
      id: randomUUID(),
      role: 'assistant',
      content: `Error: ${String(err)}`,
      timestamp: Date.now(),
    }
    session.messages.push(errorMsg)
    session.status = 'idle'
    broadcast('session:event', { type: 'message_added', sessionId: id, message: errorMsg })
    broadcast('session:event', { type: 'complete', sessionId: id })
  })

  return c.json({ success: true })
})

// ─── Agent lifecycle ─────────────────────────────────────────────────

/**
 * Get or create an agent for a session.
 * Uses the session's llmConnection (or global default) to determine provider.
 */
async function getOrCreateAgent(session: WebSession): Promise<AgentBackend> {
  const existing = agents.get(session.id)
  if (existing) return existing

  // Resolve workspace
  const defaultWorkspace: Workspace = { id: 'default', name: 'Default', rootPath: homedir(), createdAt: Date.now() }
  let workspace: Workspace
  try {
    const config = loadStoredConfig()
    workspace = config?.workspaces?.find((w: Workspace) => w.id === session.workspaceId)
      ?? config?.workspaces?.[0]
      ?? defaultWorkspace
  } catch {
    workspace = defaultWorkspace
  }

  // Resolve connection: session → global default
  const connectionSlug = session.llmConnection || getDefaultLlmConnection() || undefined
  const model = session.model || undefined

  // Create agent via factory (uses BackendConfig internally)
  const agent = createBackendFromConnection(
    connectionSlug ?? '',
    {
      workspace,
      model,
      session: {
        id: session.id,
        workspaceRootPath: workspace.rootPath,
      } as any,
      isHeadless: false,
      envOverrides: {},
      sandboxManager: sandboxManager ?? undefined,
    },
  )

  // Wire callbacks — stream agent events to WebSocket clients
  agent.onPermissionRequest = (request) => {
    broadcast('session:event', {
      type: 'permission_request',
      sessionId: session.id,
      request,
    })
  }

  agent.onDebug = (msg) => {
    console.log(`[Agent:${session.id}] ${msg}`)
  }

  // Initialize auth (injects API key / OAuth token into process.env)
  const initResult = await agent.postInit()
  if (!initResult.authInjected && initResult.authWarning) {
    console.warn(`[Agent:${session.id}] Auth warning: ${initResult.authWarning}`)
  }

  // Lock connection after first agent creation
  if (connectionSlug && !session.connectionLocked) {
    session.llmConnection = connectionSlug
    session.connectionLocked = true
  }

  agents.set(session.id, agent)
  return agent
}

/**
 * Run agent chat and stream events via WebSocket.
 */
async function runAgentChat(sessionId: string, session: WebSession, message: string) {
  const agent = await getOrCreateAgent(session)

  let fullText = ''

  for await (const event of agent.chat(message)) {
    // Forward all events to WebSocket clients
    broadcast('session:event', {
      type: 'agent_event',
      sessionId,
      event,
    })

    switch (event.type) {
      case 'text_delta':
        fullText += event.text
        break

      case 'text_complete':
        fullText = event.text
        break

      case 'tool_start':
        broadcast('session:event', {
          type: 'tool_start',
          sessionId,
          toolName: event.toolName,
          toolUseId: event.toolUseId,
          input: event.input,
        })
        break

      case 'tool_result':
        broadcast('session:event', {
          type: 'tool_result',
          sessionId,
          toolUseId: event.toolUseId,
          result: event.result,
          isError: event.isError,
        })
        break

      case 'error':
      case 'typed_error':
        const errorText = event.type === 'error' ? event.message : `Error: ${JSON.stringify(event.error)}`
        broadcast('session:event', {
          type: 'error',
          sessionId,
          message: errorText,
        })
        break
    }
  }

  // Store assistant message
  if (fullText) {
    const assistantMsg = {
      id: randomUUID(),
      role: 'assistant',
      content: fullText,
      timestamp: Date.now(),
    }
    session.messages.push(assistantMsg)
    broadcast('session:event', {
      type: 'message_added',
      sessionId,
      message: assistantMsg,
    })
  }

  session.status = 'idle'
  session.updatedAt = Date.now()
  broadcast('session:event', { type: 'complete', sessionId })

  // Auto-generate title after first message
  if (session.messages.filter(m => m.role === 'user').length === 1) {
    try {
      const title = await agent.generateTitle(message)
      if (title) {
        session.name = title
        broadcast('session:event', { type: 'session_updated', sessionId, updates: { name: title } })
      }
    } catch { /* title generation is best-effort */ }
  }
}

app.post('/api/sessions/:id/cancel', async (c) => {
  const id = c.req.param('id')
  const session = sessions.get(id)
  if (session) {
    session.status = 'idle'
    // Abort running agent
    const agent = agents.get(id)
    if (agent) {
      try { await agent.abort('User cancelled') } catch { /* ignore */ }
    }
    broadcast('session:event', { type: 'interrupted', sessionId: id })
  }
  return c.json({ success: true })
})

app.post('/api/sessions/:id/kill-shell', (c) => {
  return c.json({ success: true })
})

app.get('/api/tasks/:id/output', (c) => {
  return c.json(null)
})

app.post('/api/sessions/:id/permission', async (c) => {
  return c.json(true)
})

app.post('/api/sessions/:id/credential', async (c) => {
  return c.json(true)
})

app.post('/api/sessions/:id/command', async (c) => {
  const id = c.req.param('id')
  const command = await c.req.json()
  const session = sessions.get(id)

  if (!session) return c.json({ error: 'Session not found' }, 404)

  switch (command.type) {
    case 'rename':
      session.name = command.name || session.name
      session.updatedAt = Date.now()
      broadcast('session:event', { type: 'session_updated', sessionId: id, updates: { name: session.name } })
      break
    case 'flag':
    case 'unflag':
    case 'archive':
    case 'unarchive':
    case 'markRead':
    case 'markUnread':
      session.updatedAt = Date.now()
      break
    case 'setSessionStatus':
      session.status = command.state || 'idle'
      break
    default:
      break
  }

  return c.json({ success: true })
})

app.get('/api/sessions/:id/pending-plan', (c) => {
  return c.json(null)
})

app.get('/api/sessions/:id/files', (c) => {
  return c.json([])
})

app.get('/api/sessions/:id/notes', (c) => {
  return c.json('')
})

app.post('/api/sessions/:id/notes', async (c) => {
  return c.json({ success: true })
})

app.post('/api/sessions/:id/watch-files', (c) => {
  return c.json({ success: true })
})

app.post('/api/sessions/unwatch-files', (c) => {
  return c.json({ success: true })
})

app.post('/api/sessions/:id/attachment', async (c) => {
  const body = await c.req.json()
  return c.json({ id: randomUUID(), ...body })
})

app.get('/api/sessions/:id/model', (c) => {
  const session = sessions.get(c.req.param('id'))
  if (!session) return c.json(null)
  return c.json({
    model: session.model || null,
    connectionSlug: session.llmConnection || null,
    locked: session.connectionLocked || false,
  })
})

app.post('/api/sessions/:id/model', async (c) => {
  const id = c.req.param('id')
  const session = sessions.get(id)
  if (!session) return c.json({ success: false, error: 'Session not found' }, 404)

  // Cannot change model/connection after first message
  if (session.connectionLocked) {
    return c.json({ success: false, error: 'Connection locked after first message' })
  }

  const { model, connectionSlug } = await c.req.json()
  if (model !== undefined) session.model = model
  if (connectionSlug !== undefined) session.llmConnection = connectionSlug
  session.updatedAt = Date.now()

  // Destroy any existing agent so it gets recreated with new settings
  const existingAgent = agents.get(id)
  if (existingAgent) {
    try { await existingAgent.destroy() } catch { /* ignore */ }
    agents.delete(id)
  }

  return c.json({ success: true })
})

// ─── Workspace endpoints ───────────────────────────────────────────────

// Initialize config on startup
try { loadStoredConfig() } catch { /* first launch */ }

app.get('/api/workspaces', (c) => {
  try {
    const config = loadStoredConfig()
    return c.json(config?.workspaces || [])
  } catch {
    return c.json([])
  }
})

app.post('/api/workspaces', async (c) => {
  const { folderPath, name } = await c.req.json()
  try {
    const workspace = addWorkspace({ name: name || folderPath, rootPath: folderPath })
    return c.json(workspace)
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

app.get('/api/workspaces/check-slug', (c) => {
  const slug = c.req.query('slug') || ''
  const workspace = getWorkspaceByNameOrId(slug)
  return c.json({ exists: !!workspace, path: workspace?.rootPath || '' })
})

app.post('/api/workspaces/switch', async (c) => {
  const { workspaceId } = await c.req.json()
  setActiveWorkspace(workspaceId)
  return c.json({ success: true })
})

app.get('/api/workspaces/:id/settings', (c) => {
  return c.json(null)
})

app.post('/api/workspaces/:id/settings', async (c) => {
  return c.json({ success: true })
})

app.get('/api/workspaces/:id/sources', (c) => {
  return c.json([])
})

app.post('/api/workspaces/:id/sources', async (c) => {
  const body = await c.req.json()
  return c.json(body)
})

app.post('/api/workspaces/:id/sources/:slug/delete', (c) => {
  return c.json({ success: true })
})

app.post('/api/workspaces/:id/sources/:slug/oauth', (c) => {
  return c.json({ success: false, error: 'OAuth not implemented for web yet' })
})

app.post('/api/workspaces/:id/sources/:slug/credentials', async (c) => {
  return c.json({ success: true })
})

app.get('/api/workspaces/:id/sources/:slug/permissions', (c) => {
  return c.json(null)
})

app.get('/api/workspaces/:id/permissions', (c) => {
  return c.json(null)
})

app.get('/api/workspaces/:id/sources/:slug/mcp-tools', (c) => {
  return c.json({ success: true, tools: [] })
})

app.get('/api/workspaces/:id/search', (c) => {
  return c.json([])
})

app.get('/api/workspaces/:id/skills', (c) => {
  return c.json([])
})

app.get('/api/workspaces/:id/skills/:slug/files', (c) => {
  return c.json([])
})

app.post('/api/workspaces/:id/skills/:slug/delete', (c) => {
  return c.json({ success: true })
})

app.get('/api/workspaces/:id/statuses', (c) => {
  return c.json([])
})

app.post('/api/workspaces/:id/statuses/reorder', async (c) => {
  return c.json({ success: true })
})

app.get('/api/workspaces/:id/labels', (c) => {
  return c.json([])
})

app.post('/api/workspaces/:id/labels', async (c) => {
  const body = await c.req.json()
  return c.json({ id: randomUUID(), ...body })
})

app.post('/api/workspaces/:id/labels/:labelId/delete', (c) => {
  return c.json({ stripped: 0 })
})

app.get('/api/workspaces/:id/views', (c) => {
  return c.json([])
})

app.post('/api/workspaces/:id/views', async (c) => {
  return c.json({ success: true })
})

app.get('/api/workspaces/:id/image', (c) => {
  return c.json('')
})

app.post('/api/workspaces/:id/image', async (c) => {
  return c.json({ success: true })
})

app.post('/api/workspaces/:id/default-llm-connection', async (c) => {
  return c.json({ success: true })
})

// ─── File endpoints ────────────────────────────────────────────────────

app.get('/api/files/read', async (c) => {
  const path = c.req.query('path')
  if (!path) return c.json({ error: 'Path required' }, 400)
  try {
    const content = await readFile(path, 'utf-8')
    return c.json(content)
  } catch (e) {
    return c.json({ error: String(e) }, 404)
  }
})

app.get('/api/files/read-data-url', async (c) => {
  const path = c.req.query('path')
  if (!path) return c.json({ error: 'Path required' }, 400)
  try {
    const buffer = await readFile(path)
    const ext = path.split('.').pop()?.toLowerCase() || ''
    const mimeTypes: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
      pdf: 'application/pdf',
    }
    const mime = mimeTypes[ext] || 'application/octet-stream'
    const base64 = Buffer.from(buffer).toString('base64')
    return c.json(`data:${mime};base64,${base64}`)
  } catch (e) {
    return c.json({ error: String(e) }, 404)
  }
})

app.get('/api/files/read-binary', async (c) => {
  const path = c.req.query('path')
  if (!path) return c.json({ error: 'Path required' }, 400)
  try {
    const buffer = await readFile(path)
    return new Response(buffer, {
      headers: { 'Content-Type': 'application/octet-stream' },
    })
  } catch (e) {
    return c.json({ error: String(e) }, 404)
  }
})

app.get('/api/files/read-attachment', (c) => {
  return c.json(null)
})

app.post('/api/files/generate-thumbnail', async (c) => {
  return c.json(null)
})

app.get('/api/files/search', async (c) => {
  const basePath = c.req.query('basePath')
  const query = c.req.query('query')
  if (!basePath || !query) return c.json([])

  try {
    const entries = await readdir(basePath, { withFileTypes: true })
    const lowerQuery = query.toLowerCase()
    const results = entries
      .filter(e => e.name.toLowerCase().includes(lowerQuery))
      .slice(0, 20)
      .map(e => ({
        name: e.name,
        path: join(basePath, e.name),
        type: e.isDirectory() ? 'directory' : 'file',
        relativePath: e.name,
      }))
    return c.json(results)
  } catch {
    return c.json([])
  }
})

app.get('/api/files/open', async (c) => {
  const path = c.req.query('path')
  if (!path) return c.json({ error: 'Path required' }, 400)
  try {
    const buffer = await readFile(path)
    const ext = path.split('.').pop()?.toLowerCase() || ''
    const mimeTypes: Record<string, string> = {
      txt: 'text/plain', md: 'text/markdown', json: 'application/json',
      js: 'text/javascript', ts: 'text/typescript', html: 'text/html',
      css: 'text/css', png: 'image/png', jpg: 'image/jpeg',
      pdf: 'application/pdf', svg: 'image/svg+xml',
    }
    return new Response(buffer, {
      headers: {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${path.split('/').pop()}"`,
      },
    })
  } catch {
    return c.json({ error: 'File not found' }, 404)
  }
})

// ─── Auth endpoints ────────────────────────────────────────────────────

app.get('/api/auth/state', async (c) => {
  try {
    const connections = getLlmConnections()
    const credManager = getCredentialManager()

    // Check if any connection has stored credentials
    for (const conn of connections) {
      const apiKey = await credManager.getLlmApiKey(conn.slug)
      if (apiKey) {
        return c.json({ authenticated: true, type: 'api_key', connectionSlug: conn.slug })
      }
    }
    return c.json({ authenticated: false, type: 'none' })
  } catch {
    return c.json({ authenticated: false, type: 'none' })
  }
})

app.get('/api/auth/setup-needs', async (c) => {
  try {
    const config = loadStoredConfig()
    const connections = getLlmConnections()
    const credManager = getCredentialManager()

    const hasWorkspace = !!(config?.workspaces && config.workspaces.length > 0)

    // Check if at least one connection is authenticated
    let hasAuthenticatedConnection = false
    for (const conn of connections) {
      const apiKey = await credManager.getLlmApiKey(conn.slug)
      if (apiKey) {
        hasAuthenticatedConnection = true
        break
      }
    }

    return c.json({
      needsLlmConnection: connections.length === 0 || !hasAuthenticatedConnection,
      needsWorkspace: !hasWorkspace,
      availableConnections: connections.map(c => ({ slug: c.slug, name: c.name, providerType: c.providerType })),
    })
  } catch {
    return c.json({
      needsLlmConnection: true,
      needsWorkspace: true,
      availableConnections: [],
    })
  }
})

app.get('/api/auth/credential-health', (c) => {
  return c.json({ status: 'unknown', issues: [] })
})

app.post('/api/auth/logout', (c) => {
  return c.json({ success: true })
})

app.post('/api/auth/mcp-oauth', async (c) => {
  return c.json({ success: false, error: 'MCP OAuth not yet implemented for web' })
})

app.post('/api/auth/claude-oauth/start', (c) => {
  return c.json({ success: false, error: 'Claude OAuth not yet implemented for web' })
})

app.post('/api/auth/claude-oauth/exchange', async (c) => {
  return c.json({ success: false, error: 'Claude OAuth not yet implemented for web' })
})

app.get('/api/auth/claude-oauth/has-state', (c) => {
  return c.json(false)
})

app.post('/api/auth/claude-oauth/clear', (c) => {
  return c.json({ success: true })
})

app.post('/api/auth/chatgpt-oauth/start', (c) => {
  return c.json({ success: false, error: 'ChatGPT OAuth not yet implemented for web' })
})

app.post('/api/auth/chatgpt-oauth/cancel', (c) => {
  return c.json({ success: true })
})

app.get('/api/auth/chatgpt-oauth/status', (c) => {
  return c.json({ authenticated: false })
})

app.post('/api/auth/chatgpt-oauth/logout', (c) => {
  return c.json({ success: true })
})

app.post('/api/auth/copilot-oauth/start', (c) => {
  return c.json({ success: false, error: 'Copilot OAuth not yet implemented for web' })
})

app.post('/api/auth/copilot-oauth/cancel', (c) => {
  return c.json({ success: true })
})

app.get('/api/auth/copilot-oauth/status', (c) => {
  return c.json({ authenticated: false })
})

app.post('/api/auth/copilot-oauth/logout', (c) => {
  return c.json({ success: true })
})

// ─── LLM connection endpoints ──────────────────────────────────────────

app.get('/api/llm/connections', (c) => {
  try {
    const connections = getLlmConnections()
    return c.json(connections)
  } catch {
    return c.json([])
  }
})

app.get('/api/llm/connections-with-status', async (c) => {
  try {
    const connections = getLlmConnections()
    const credManager = getCredentialManager()

    const withStatus = await Promise.all(connections.map(async (conn) => {
      let authenticated = false
      try {
        const hasKey = await credManager.getLlmApiKey(conn.slug)
        authenticated = !!hasKey
      } catch { /* ignore */ }

      const models = getModelsForProviderType(conn.providerType, conn.piAuthProvider)

      return {
        ...conn,
        status: authenticated ? 'ready' : 'needs_auth',
        authenticated,
        models,
      }
    }))
    return c.json(withStatus)
  } catch {
    return c.json([])
  }
})

app.get('/api/llm/connections/:slug', (c) => {
  try {
    const conn = getLlmConnection(c.req.param('slug'))
    return c.json(conn || null)
  } catch {
    return c.json(null)
  }
})

app.get('/api/llm/connections/:slug/api-key', async (c) => {
  try {
    const credManager = getCredentialManager()
    const apiKey = await credManager.getLlmApiKey(c.req.param('slug'))
    return c.json(apiKey)
  } catch {
    return c.json(null)
  }
})

app.post('/api/llm/connections/:slug/api-key', async (c) => {
  const slug = c.req.param('slug')
  const { apiKey } = await c.req.json()
  try {
    const credManager = getCredentialManager()
    if (apiKey) {
      await credManager.setLlmApiKey(slug, apiKey)
    } else {
      await credManager.deleteLlmApiKey(slug)
    }
    broadcast('llm:connectionsChanged', null)
    return c.json({ success: true })
  } catch (e) {
    return c.json({ success: false, error: String(e) })
  }
})

app.post('/api/llm/connections/save', async (c) => {
  const connection = await c.req.json()
  try {
    addLlmConnection(connection)
    broadcast('llm:connectionsChanged', null)
    return c.json({ success: true })
  } catch (e) {
    return c.json({ success: false, error: String(e) })
  }
})

app.post('/api/llm/connections/:slug/delete', (c) => {
  try {
    deleteLlmConnection(c.req.param('slug'))
    broadcast('llm:connectionsChanged', null)
    return c.json({ success: true })
  } catch (e) {
    return c.json({ success: false, error: String(e) })
  }
})

app.post('/api/llm/connections/:slug/test', async (c) => {
  const slug = c.req.param('slug')
  try {
    const conn = getLlmConnection(slug)
    if (!conn) return c.json({ success: false, error: 'Connection not found' })

    const credManager = getCredentialManager()
    const apiKey = await credManager.getLlmApiKey(slug) || ''
    const provider = providerTypeToAgentProvider(conn.providerType)
    const model = conn.defaultModel || 'claude-sonnet-4-5-20250929'

    const result = await testBackendConnection({
      provider,
      apiKey,
      model,
      baseUrl: conn.baseUrl,
      hostRuntime,
      timeoutMs: 15000,
      connection: conn,
    })
    return c.json(result)
  } catch (e) {
    return c.json({ success: false, error: String(e) })
  }
})

app.post('/api/llm/connections/set-default', async (c) => {
  const { slug } = await c.req.json()
  try {
    setDefaultLlmConnection(slug)
    return c.json({ success: true })
  } catch (e) {
    return c.json({ success: false, error: String(e) })
  }
})

app.post('/api/llm/setup', async (c) => {
  const setup = await c.req.json()
  try {
    // Store the LLM connection config
    const providerType: LlmProviderType = setup.providerType || (setup.slug?.includes('anthropic') ? 'anthropic' : 'anthropic_compat')
    const connection: LlmConnection = {
      slug: setup.slug,
      name: setup.name || setup.slug,
      providerType,
      authType: setup.authType || 'api_key',
      baseUrl: setup.baseUrl || undefined,
      defaultModel: setup.defaultModel || undefined,
      createdAt: Date.now(),
    }
    addLlmConnection(connection)

    // Store API key if provided
    if (setup.apiKey) {
      const credManager = getCredentialManager()
      await credManager.setLlmApiKey(setup.slug, setup.apiKey)
    }

    broadcast('llm:connectionsChanged', null)
    return c.json({ success: true })
  } catch (e) {
    return c.json({ success: false, error: String(e) })
  }
})

app.post('/api/llm/test-setup', async (c) => {
  const { slug, apiKey, model, baseUrl, providerType } = await c.req.json()
  try {
    const provider = providerTypeToAgentProvider(providerType || 'anthropic')
    const result = await testBackendConnection({
      provider,
      apiKey: apiKey || '',
      model: model || 'claude-sonnet-4-5-20250929',
      baseUrl,
      hostRuntime,
      timeoutMs: 15000,
    })
    return c.json(result)
  } catch (e) {
    return c.json({ success: false, error: String(e) })
  }
})

app.get('/api/llm/pi/providers', (c) => {
  return c.json([])
})

app.get('/api/llm/pi/base-url', (c) => {
  return c.json(undefined)
})

app.get('/api/llm/pi/models', (c) => {
  return c.json({ models: [], totalCount: 0 })
})

// ─── Theme endpoints ───────────────────────────────────────────────────

app.get('/api/theme/app', (c) => {
  return c.json(null)
})

app.get('/api/theme/presets', (c) => {
  // Load preset themes from resources
  try {
    const themesDir = resolve(__dirname, '../../../electron/resources/themes')
    if (existsSync(themesDir)) {
      const files = Bun.env.NODE_ENV === 'production' ? [] : []
      // In development, try to load themes
      return c.json([])
    }
  } catch { /* ignore */ }
  return c.json([])
})

app.get('/api/theme/presets/:id', (c) => {
  return c.json(null)
})

// ─── Permissions endpoint ──────────────────────────────────────────────

app.get('/api/permissions/default', (c) => {
  return c.json({ config: null, path: '' })
})

// ─── System endpoints ──────────────────────────────────────────────────

app.get('/api/system/home-dir', (c) => {
  return c.json(homedir())
})

app.get('/api/system/release-notes', (c) => {
  return c.json('')
})

app.get('/api/system/latest-version', (c) => {
  return c.json(undefined)
})

app.get('/api/system/tool-icon-mappings', (c) => {
  return c.json([])
})

app.get('/api/system/logo-url', (c) => {
  return c.json(null)
})

// ─── Preferences endpoints ────────────────────────────────────────────

app.get('/api/preferences', (c) => {
  try {
    const path = getPreferencesPath()
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8')
      return c.json({ content, exists: true, path })
    }
    return c.json({ content: '', exists: false, path })
  } catch {
    return c.json({ content: '', exists: false, path: '' })
  }
})

app.post('/api/preferences', async (c) => {
  try {
    const { content } = await c.req.json()
    const path = getPreferencesPath()
    writeFile(path, content, 'utf-8')
    return c.json({ success: true })
  } catch (e) {
    return c.json({ success: false, error: String(e) })
  }
})

// ─── Git endpoints ─────────────────────────────────────────────────────

app.get('/api/git/branch', (c) => {
  const path = c.req.query('path')
  if (!path) return c.json(null)
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: path,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
    return c.json(branch)
  } catch {
    return c.json(null)
  }
})

// ─── Automation endpoints ──────────────────────────────────────────────

app.post('/api/automations/test', async (c) => {
  return c.json({ actions: [] })
})

app.post('/api/automations/set-enabled', async (c) => {
  return c.json({ success: true })
})

app.post('/api/automations/duplicate', async (c) => {
  return c.json({ success: true })
})

app.post('/api/automations/delete', async (c) => {
  return c.json({ success: true })
})

app.get('/api/automations/history', (c) => {
  return c.json([])
})

app.get('/api/automations/last-executed', (c) => {
  return c.json({})
})

// ─── Sandbox endpoints ──────────────────────────────────────────────────

app.get('/api/sandbox/:sessionId/status', async (c) => {
  const sessionId = c.req.param('sessionId')
  if (!sandboxManager) {
    return c.json({ enabled: false, status: 'disabled' })
  }
  const provider = sandboxManager.get(sessionId)
  if (!provider) {
    return c.json({ enabled: true, status: 'not_created', sandboxId: null })
  }
  const alive = await provider.isAlive().catch(() => false)
  return c.json({
    enabled: true,
    status: alive ? 'running' : 'dead',
    sandboxId: provider.getId(),
  })
})

app.get('/api/sandbox/info', (c) => {
  return c.json({
    enabled: !!sandboxManager,
    provider: sandboxConfig.provider,
    activeSandboxes: sandboxManager?.size ?? 0,
  })
})

// ─── Static file serving (production) ──────────────────────────────────

if (Bun.env.NODE_ENV === 'production') {
  const clientDist = resolve(__dirname, '../dist/client')
  app.use('/*', serveStatic({ root: clientDist }))
  // SPA fallback
  app.get('*', (c) => {
    const indexPath = join(clientDist, 'index.html')
    if (existsSync(indexPath)) {
      return c.html(readFileSync(indexPath, 'utf-8'))
    }
    return c.text('Not Found', 404)
  })
}

// ─── Start server ──────────────────────────────────────────────────────

const PORT = parseInt(Bun.env.PORT || '3001')

const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
  websocket: {
    message(ws, message) {
      // Handle incoming WebSocket messages if needed
      try {
        const data = JSON.parse(String(message))
        console.log('[WS] Received:', data.type)
      } catch { /* ignore non-JSON messages */ }
    },
    open(ws) {
      const client = {
        send: (data: string) => ws.send(data),
        readyState: 1,
      }
      wsClients.add(client)
      console.log(`[WS] Client connected (total: ${wsClients.size})`)
    },
    close(ws) {
      // Remove client by matching the send function reference
      for (const client of wsClients) {
        try {
          client.readyState = 3 // CLOSED
          wsClients.delete(client)
        } catch { /* ignore */ }
      }
      console.log(`[WS] Client disconnected (total: ${wsClients.size})`)
    },
  },
})

// Upgrade HTTP connections to WebSocket for /ws path
const originalFetch = server.fetch
server.fetch = function (req: Request, server: { upgrade: (req: Request) => boolean }) {
  const url = new URL(req.url)
  if (url.pathname === '/ws') {
    if (server.upgrade(req)) return // WebSocket upgrade succeeded
    return new Response('WebSocket upgrade failed', { status: 400 })
  }
  return app.fetch(req)
} as typeof server.fetch

// ─── Graceful shutdown ──────────────────────────────────────────────────
// Destroy all sandboxes when the server shuts down to free E2B resources.

async function shutdown(signal: string) {
  console.log(`\n[Server] ${signal} received, shutting down...`)
  // Destroy all active agents
  if (agents.size > 0) {
    console.log(`[Agent] Destroying ${agents.size} active agents...`)
    await Promise.allSettled(Array.from(agents.values()).map(a => a.destroy()))
    agents.clear()
    console.log('[Agent] All agents destroyed')
  }
  if (sandboxManager) {
    console.log(`[Sandbox] Destroying ${sandboxManager.size} active sandboxes...`)
    await sandboxManager.destroyAll()
    console.log('[Sandbox] All sandboxes destroyed')
  }
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

console.log(`
╔══════════════════════════════════════════════╗
║        Craft Agents Web Server               ║
║                                              ║
║   HTTP:  http://localhost:${PORT}              ║
║   WS:    ws://localhost:${PORT}/ws             ║
║   Sandbox: ${sandboxManager ? 'ENABLED (E2B)' : 'DISABLED'}                     ║
║                                              ║
║   Client dev: http://localhost:3000           ║
╚══════════════════════════════════════════════╝
`)
