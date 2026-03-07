/**
 * Web API Adapter
 *
 * Implements the same ElectronAPI interface but uses HTTP REST + WebSocket
 * instead of Electron IPC. This allows the renderer code to be shared
 * between the Electron desktop app and the web app.
 *
 * Pattern:
 *  - invoke() methods → HTTP POST/GET to /api/*
 *  - on*() listener methods → WebSocket subscriptions
 */

import type { ElectronAPI } from '../../electron/src/shared/types'

const API_BASE = '/api'

// ─── HTTP helpers ──────────────────────────────────────────────────────

async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`API ${path}: ${res.status} ${text}`)
  }
  // Handle empty responses (204 No Content or empty body)
  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

// ─── WebSocket event bus ───────────────────────────────────────────────

type EventCallback = (data: unknown) => void

class WebSocketEventBus {
  private ws: WebSocket | null = null
  private listeners = new Map<string, Set<EventCallback>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws`

    this.ws = new WebSocket(wsUrl)

    this.ws.onopen = () => {
      this.reconnectDelay = 1000
      console.log('[WebSocket] Connected')
    }

    this.ws.onmessage = (event) => {
      try {
        const { type, data } = JSON.parse(event.data)
        const callbacks = this.listeners.get(type)
        if (callbacks) {
          for (const cb of callbacks) {
            try { cb(data) } catch (e) { console.error('[WebSocket] Handler error:', e) }
          }
        }
      } catch (e) {
        console.error('[WebSocket] Parse error:', e)
      }
    }

    this.ws.onclose = () => {
      console.log('[WebSocket] Disconnected, reconnecting...')
      this.scheduleReconnect()
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000)
      this.connect()
    }, this.reconnectDelay)
  }

  subscribe(eventType: string, callback: EventCallback): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set())
    }
    this.listeners.get(eventType)!.add(callback)

    // Ensure connected
    this.connect()

    return () => {
      const set = this.listeners.get(eventType)
      if (set) {
        set.delete(callback)
        if (set.size === 0) this.listeners.delete(eventType)
      }
    }
  }
}

const eventBus = new WebSocketEventBus()

// ─── Noop helpers for desktop-only features ────────────────────────────

const noop = () => {}
const noopAsync = async () => {}
const noopCleanup = (_cb: unknown) => noop

// ─── Settings stored in localStorage ───────────────────────────────────

function getLocalSetting<T>(key: string, defaultValue: T): T {
  try {
    const v = localStorage.getItem(`craft-agent:${key}`)
    return v !== null ? JSON.parse(v) : defaultValue
  } catch { return defaultValue }
}

function setLocalSetting(key: string, value: unknown) {
  localStorage.setItem(`craft-agent:${key}`, JSON.stringify(value))
}

// ─── WebAPI implementation ─────────────────────────────────────────────

export const webAPI: ElectronAPI = {
  // ── Session management ──────────────────────────────────────────────
  getSessions: () => api('/sessions'),
  getSessionMessages: (sessionId) => api(`/sessions/${sessionId}/messages`),
  createSession: (workspaceId, options) => api('/sessions', { workspaceId, options }),
  createSubSession: (workspaceId, parentSessionId, options) =>
    api('/sessions/sub', { workspaceId, parentSessionId, options }),
  deleteSession: (sessionId) => api(`/sessions/${sessionId}/delete`, {}),
  sendMessage: (sessionId, message, attachments, storedAttachments, options) =>
    api(`/sessions/${sessionId}/message`, { message, attachments, storedAttachments, options }),
  cancelProcessing: (sessionId, silent) =>
    api(`/sessions/${sessionId}/cancel`, { silent }),
  killShell: (sessionId, shellId) =>
    api(`/sessions/${sessionId}/kill-shell`, { shellId }),
  getTaskOutput: (taskId) => api(`/tasks/${taskId}/output`),
  respondToPermission: (sessionId, requestId, allowed, alwaysAllow) =>
    api(`/sessions/${sessionId}/permission`, { requestId, allowed, alwaysAllow }),
  respondToCredential: (sessionId, requestId, response) =>
    api(`/sessions/${sessionId}/credential`, { requestId, response }),

  // ── Session command ─────────────────────────────────────────────────
  sessionCommand: (sessionId, command) =>
    api(`/sessions/${sessionId}/command`, command),

  // ── Pending plan execution ──────────────────────────────────────────
  getPendingPlanExecution: (sessionId) =>
    api(`/sessions/${sessionId}/pending-plan`),

  // ── Workspace management ────────────────────────────────────────────
  getWorkspaces: () => api('/workspaces'),
  createWorkspace: (folderPath, name) => api('/workspaces', { folderPath, name }),
  checkWorkspaceSlug: (slug) => api(`/workspaces/check-slug?slug=${encodeURIComponent(slug)}`),

  // ── Window management (web adaptations) ─────────────────────────────
  getWindowWorkspace: async () => {
    // In web, we use URL-based routing or localStorage to track active workspace
    return localStorage.getItem('craft-agent:activeWorkspace') || null
  },
  getWindowMode: async () => 'main',
  openWorkspace: async (workspaceId) => {
    localStorage.setItem('craft-agent:activeWorkspace', workspaceId)
    // In web, opening a workspace navigates rather than opening a new window
    window.location.hash = `#/workspace/${workspaceId}`
  },
  openSessionInNewWindow: async (workspaceId, sessionId) => {
    // Open in new browser tab
    window.open(`${window.location.origin}/#/workspace/${workspaceId}/session/${sessionId}`, '_blank')
  },
  switchWorkspace: async (workspaceId) => {
    localStorage.setItem('craft-agent:activeWorkspace', workspaceId)
    // Trigger workspace change event via WebSocket
    await api('/workspaces/switch', { workspaceId })
  },
  closeWindow: async () => { /* no-op in web */ },
  confirmCloseWindow: async () => { /* no-op in web */ },
  onCloseRequested: () => {
    // Use beforeunload event in web
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  },
  setTrafficLightsVisible: async () => { /* macOS-only, no-op in web */ },

  // ── Event listeners (WebSocket) ─────────────────────────────────────
  onSessionEvent: (callback) =>
    eventBus.subscribe('session:event', (data) => callback(data as Parameters<typeof callback>[0])),

  // ── File operations ─────────────────────────────────────────────────
  readFile: (path) => api(`/files/read?path=${encodeURIComponent(path)}`),
  readFileDataUrl: (path) => api(`/files/read-data-url?path=${encodeURIComponent(path)}`),
  readFileBinary: async (path) => {
    const res = await fetch(`${API_BASE}/files/read-binary?path=${encodeURIComponent(path)}`)
    if (!res.ok) throw new Error(`File read failed: ${res.status}`)
    const buffer = await res.arrayBuffer()
    return new Uint8Array(buffer)
  },
  openFileDialog: async () => {
    // Use the web File API
    return new Promise<string[]>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.onchange = () => {
        const files = Array.from(input.files || [])
        // For web, we return file names. The server handles actual paths.
        resolve(files.map(f => f.name))
      }
      input.click()
    })
  },
  readFileAttachment: (path) => api(`/files/read-attachment?path=${encodeURIComponent(path)}`),
  storeAttachment: (sessionId, attachment) =>
    api(`/sessions/${sessionId}/attachment`, attachment),
  generateThumbnail: (base64, mimeType) =>
    api('/files/generate-thumbnail', { base64, mimeType }),

  // ── Filesystem search ───────────────────────────────────────────────
  searchFiles: (basePath, query) =>
    api(`/files/search?basePath=${encodeURIComponent(basePath)}&query=${encodeURIComponent(query)}`),
  debugLog: (...args) => {
    console.log('[debug]', ...args)
  },

  // ── Theme ───────────────────────────────────────────────────────────
  getSystemTheme: async () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  onSystemThemeChange: (callback) => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => callback(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  },

  // ── System ──────────────────────────────────────────────────────────
  getVersions: () => ({
    node: 'web',
    chrome: navigator.userAgent,
    electron: 'web',
  }),
  getHomeDir: () => api('/system/home-dir'),
  isDebugMode: async () => import.meta.env.DEV,

  // ── Auto-update (not needed for web) ────────────────────────────────
  checkForUpdates: async () => ({
    available: false,
    currentVersion: '0.5.1',
    latestVersion: null,
    downloadState: 'idle' as const,
    downloadProgress: 0,
  }),
  getUpdateInfo: async () => ({
    available: false,
    currentVersion: '0.5.1',
    latestVersion: null,
    downloadState: 'idle' as const,
    downloadProgress: 0,
  }),
  installUpdate: noopAsync,
  dismissUpdate: noopAsync,
  getDismissedUpdateVersion: async () => null,
  onUpdateAvailable: noopCleanup as ElectronAPI['onUpdateAvailable'],
  onUpdateDownloadProgress: noopCleanup as ElectronAPI['onUpdateDownloadProgress'],

  // ── Release notes ───────────────────────────────────────────────────
  getReleaseNotes: () => api('/system/release-notes'),
  getLatestReleaseVersion: () => api('/system/latest-version'),

  // ── Shell operations (web adaptations) ──────────────────────────────
  openUrl: async (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
  openFile: async (path) => {
    // In web, we download the file or open in a new tab
    window.open(`${API_BASE}/files/open?path=${encodeURIComponent(path)}`, '_blank')
  },
  showInFolder: async (path) => {
    // No direct equivalent in web, just show the file
    window.open(`${API_BASE}/files/open?path=${encodeURIComponent(path)}`, '_blank')
  },

  // ── Menu event listeners (web keyboard shortcuts) ───────────────────
  onMenuNewChat: (callback) => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); callback() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  },
  onMenuOpenSettings: (callback) => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); callback() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  },
  onMenuKeyboardShortcuts: (callback) => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); callback() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  },
  onMenuToggleFocusMode: noopCleanup as ElectronAPI['onMenuToggleFocusMode'],
  onMenuToggleSidebar: (callback) => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') { e.preventDefault(); callback() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  },

  // ── Deep link ───────────────────────────────────────────────────────
  onDeepLinkNavigate: noopCleanup as ElectronAPI['onDeepLinkNavigate'],

  // ── Auth ─────────────────────────────────────────────────────────────
  showLogoutConfirmation: async () => window.confirm('Are you sure you want to log out?'),
  showDeleteSessionConfirmation: async (name) => window.confirm(`Delete session "${name}"?`),
  logout: () => api('/auth/logout', {}),

  // ── Credential health ───────────────────────────────────────────────
  getCredentialHealth: () => api('/auth/credential-health'),

  // ── Onboarding ──────────────────────────────────────────────────────
  getAuthState: () => api('/auth/state'),
  getSetupNeeds: () => api('/auth/setup-needs'),
  startWorkspaceMcpOAuth: (mcpUrl) => api('/auth/mcp-oauth', { mcpUrl }),
  startClaudeOAuth: () => api('/auth/claude-oauth/start', {}),
  exchangeClaudeCode: (code, connectionSlug) =>
    api('/auth/claude-oauth/exchange', { code, connectionSlug }),
  hasClaudeOAuthState: () => api('/auth/claude-oauth/has-state'),
  clearClaudeOAuthState: () => api('/auth/claude-oauth/clear', {}),

  // ── ChatGPT OAuth ───────────────────────────────────────────────────
  startChatGptOAuth: (connectionSlug) => api('/auth/chatgpt-oauth/start', { connectionSlug }),
  cancelChatGptOAuth: () => api('/auth/chatgpt-oauth/cancel', {}),
  getChatGptAuthStatus: (connectionSlug) =>
    api(`/auth/chatgpt-oauth/status?slug=${encodeURIComponent(connectionSlug)}`),
  chatGptLogout: (connectionSlug) => api('/auth/chatgpt-oauth/logout', { connectionSlug }),

  // ── Copilot OAuth ───────────────────────────────────────────────────
  startCopilotOAuth: (connectionSlug) => api('/auth/copilot-oauth/start', { connectionSlug }),
  cancelCopilotOAuth: () => api('/auth/copilot-oauth/cancel', {}),
  getCopilotAuthStatus: (connectionSlug) =>
    api(`/auth/copilot-oauth/status?slug=${encodeURIComponent(connectionSlug)}`),
  copilotLogout: (connectionSlug) => api('/auth/copilot-oauth/logout', { connectionSlug }),
  onCopilotDeviceCode: (callback) =>
    eventBus.subscribe('copilot:deviceCode', (data) => callback(data as Parameters<typeof callback>[0])),

  // ── LLM Connection Setup ────────────────────────────────────────────
  setupLlmConnection: (setup) => api('/llm/setup', setup),
  testLlmConnectionSetup: (params) => api('/llm/test-setup', params),

  // ── Pi providers ────────────────────────────────────────────────────
  getPiApiKeyProviders: () => api('/llm/pi/providers'),
  getPiProviderBaseUrl: (provider) => api(`/llm/pi/base-url?provider=${encodeURIComponent(provider)}`),
  getPiProviderModels: (provider) => api(`/llm/pi/models?provider=${encodeURIComponent(provider)}`),

  // ── Session model ───────────────────────────────────────────────────
  getSessionModel: (sessionId, workspaceId) =>
    api(`/sessions/${sessionId}/model?workspaceId=${encodeURIComponent(workspaceId)}`),
  setSessionModel: (sessionId, workspaceId, model, connection) =>
    api(`/sessions/${sessionId}/model`, { workspaceId, model, connection }),

  // ── Workspace Settings ──────────────────────────────────────────────
  getWorkspaceSettings: (workspaceId) => api(`/workspaces/${workspaceId}/settings`),
  updateWorkspaceSetting: (workspaceId, key, value) =>
    api(`/workspaces/${workspaceId}/settings`, { key, value }),

  // ── Folder dialog ───────────────────────────────────────────────────
  openFolderDialog: async () => {
    // Use web Directory Picker API if available
    if ('showDirectoryPicker' in window) {
      try {
        const handle = await (window as unknown as { showDirectoryPicker: () => Promise<{ name: string }> }).showDirectoryPicker()
        return handle.name
      } catch { return null }
    }
    return prompt('Enter folder path:')
  },

  // ── User Preferences ───────────────────────────────────────────────
  readPreferences: () => api('/preferences'),
  writePreferences: (content) => api('/preferences', { content }),

  // ── Session Drafts ──────────────────────────────────────────────────
  getDraft: async (sessionId) => getLocalSetting(`draft:${sessionId}`, null),
  setDraft: async (sessionId, text) => { setLocalSetting(`draft:${sessionId}`, text) },
  deleteDraft: async (sessionId) => { localStorage.removeItem(`craft-agent:draft:${sessionId}`) },
  getAllDrafts: async () => {
    const drafts: Record<string, string> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('craft-agent:draft:')) {
        const sessionId = key.replace('craft-agent:draft:', '')
        const value = localStorage.getItem(key)
        if (value) drafts[sessionId] = JSON.parse(value)
      }
    }
    return drafts
  },

  // ── Session Info Panel ──────────────────────────────────────────────
  getSessionFiles: (sessionId) => api(`/sessions/${sessionId}/files`),
  getSessionNotes: (sessionId) => api(`/sessions/${sessionId}/notes`),
  setSessionNotes: (sessionId, content) =>
    api(`/sessions/${sessionId}/notes`, { content }),
  watchSessionFiles: (sessionId) => api(`/sessions/${sessionId}/watch-files`, {}),
  unwatchSessionFiles: () => api('/sessions/unwatch-files', {}),
  onSessionFilesChanged: (callback) =>
    eventBus.subscribe('session:filesChanged', (data) => callback(data as string)),

  // ── Sources ─────────────────────────────────────────────────────────
  getSources: (workspaceId) => api(`/workspaces/${workspaceId}/sources`),
  createSource: (workspaceId, config) =>
    api(`/workspaces/${workspaceId}/sources`, config),
  deleteSource: (workspaceId, sourceSlug) =>
    api(`/workspaces/${workspaceId}/sources/${sourceSlug}/delete`, {}),
  startSourceOAuth: (workspaceId, sourceSlug) =>
    api(`/workspaces/${workspaceId}/sources/${sourceSlug}/oauth`, {}),
  saveSourceCredentials: (workspaceId, sourceSlug, credential) =>
    api(`/workspaces/${workspaceId}/sources/${sourceSlug}/credentials`, { credential }),
  getSourcePermissionsConfig: (workspaceId, sourceSlug) =>
    api(`/workspaces/${workspaceId}/sources/${sourceSlug}/permissions`),
  getWorkspacePermissionsConfig: (workspaceId) =>
    api(`/workspaces/${workspaceId}/permissions`),
  getDefaultPermissionsConfig: () => api('/permissions/default'),
  getMcpTools: (workspaceId, sourceSlug) =>
    api(`/workspaces/${workspaceId}/sources/${sourceSlug}/mcp-tools`),

  // ── Session content search ──────────────────────────────────────────
  searchSessionContent: (workspaceId, query, searchId) =>
    api(`/workspaces/${workspaceId}/search?query=${encodeURIComponent(query)}${searchId ? `&searchId=${encodeURIComponent(searchId)}` : ''}`),

  // ── Sources change listener ─────────────────────────────────────────
  onSourcesChanged: (callback) =>
    eventBus.subscribe('sources:changed', (data) => callback(data as Parameters<typeof callback>[0])),

  // ── Default permissions change listener ─────────────────────────────
  onDefaultPermissionsChanged: (callback) =>
    eventBus.subscribe('permissions:defaultChanged', () => callback()),

  // ── Skills ──────────────────────────────────────────────────────────
  getSkills: (workspaceId, workingDirectory) =>
    api(`/workspaces/${workspaceId}/skills${workingDirectory ? `?workingDirectory=${encodeURIComponent(workingDirectory)}` : ''}`),
  getSkillFiles: (workspaceId, skillSlug) =>
    api(`/workspaces/${workspaceId}/skills/${skillSlug}/files`),
  deleteSkill: (workspaceId, skillSlug) =>
    api(`/workspaces/${workspaceId}/skills/${skillSlug}/delete`, {}),
  openSkillInEditor: async () => { /* Not available in web */ },
  openSkillInFinder: async () => { /* Not available in web */ },

  // ── Skills change listener ──────────────────────────────────────────
  onSkillsChanged: (callback) =>
    eventBus.subscribe('skills:changed', (data) => callback(data as Parameters<typeof callback>[0])),

  // ── Statuses ────────────────────────────────────────────────────────
  listStatuses: (workspaceId) => api(`/workspaces/${workspaceId}/statuses`),
  reorderStatuses: (workspaceId, orderedIds) =>
    api(`/workspaces/${workspaceId}/statuses/reorder`, { orderedIds }),
  onStatusesChanged: (callback) =>
    eventBus.subscribe('statuses:changed', (data) => callback(data as string)),

  // ── Labels ──────────────────────────────────────────────────────────
  listLabels: (workspaceId) => api(`/workspaces/${workspaceId}/labels`),
  createLabel: (workspaceId, input) =>
    api(`/workspaces/${workspaceId}/labels`, input),
  deleteLabel: (workspaceId, labelId) =>
    api(`/workspaces/${workspaceId}/labels/${labelId}/delete`, {}),
  onLabelsChanged: (callback) =>
    eventBus.subscribe('labels:changed', (data) => callback(data as string)),

  // ── LLM connections change listener ─────────────────────────────────
  onLlmConnectionsChanged: (callback) =>
    eventBus.subscribe('llm:connectionsChanged', () => callback()),

  // ── Views ───────────────────────────────────────────────────────────
  listViews: (workspaceId) => api(`/workspaces/${workspaceId}/views`),
  saveViews: (workspaceId, views) =>
    api(`/workspaces/${workspaceId}/views`, { views }),

  // ── Workspace images ────────────────────────────────────────────────
  readWorkspaceImage: (workspaceId, relativePath) =>
    api(`/workspaces/${workspaceId}/image?path=${encodeURIComponent(relativePath)}`),
  writeWorkspaceImage: (workspaceId, relativePath, base64, mimeType) =>
    api(`/workspaces/${workspaceId}/image`, { relativePath, base64, mimeType }),

  // ── Tool icon mappings ──────────────────────────────────────────────
  getToolIconMappings: () => api('/system/tool-icon-mappings'),

  // ── Theme ───────────────────────────────────────────────────────────
  getAppTheme: () => api('/theme/app'),
  loadPresetThemes: () => api('/theme/presets'),
  loadPresetTheme: (themeId) => api(`/theme/presets/${themeId}`),
  getColorTheme: async () => getLocalSetting('colorTheme', 'default'),
  setColorTheme: async (themeId) => { setLocalSetting('colorTheme', themeId) },
  getWorkspaceColorTheme: async (workspaceId) =>
    getLocalSetting(`workspaceTheme:${workspaceId}`, null),
  setWorkspaceColorTheme: async (workspaceId, themeId) => {
    setLocalSetting(`workspaceTheme:${workspaceId}`, themeId)
  },
  getAllWorkspaceThemes: async () => {
    const themes: Record<string, string | undefined> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('craft-agent:workspaceTheme:')) {
        const id = key.replace('craft-agent:workspaceTheme:', '')
        const v = localStorage.getItem(key)
        themes[id] = v ? JSON.parse(v) : undefined
      }
    }
    return themes
  },

  // ── Theme change listeners ──────────────────────────────────────────
  onAppThemeChange: (callback) =>
    eventBus.subscribe('theme:appChanged', (data) => callback(data as Parameters<typeof callback>[0])),

  // ── Logo URL ────────────────────────────────────────────────────────
  getLogoUrl: (serviceUrl, provider) =>
    api(`/system/logo-url?serviceUrl=${encodeURIComponent(serviceUrl)}${provider ? `&provider=${encodeURIComponent(provider)}` : ''}`),

  // ── Notifications (Web Notifications API) ───────────────────────────
  showNotification: async (title, body, _workspaceId, _sessionId) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body })
    } else if ('Notification' in window && Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission()
      if (permission === 'granted') new Notification(title, { body })
    }
  },
  getNotificationsEnabled: async () => getLocalSetting('notificationsEnabled', true),
  setNotificationsEnabled: async (enabled) => { setLocalSetting('notificationsEnabled', enabled) },

  // ── Input settings (stored locally) ─────────────────────────────────
  getAutoCapitalisation: async () => getLocalSetting('autoCapitalisation', true),
  setAutoCapitalisation: async (enabled) => { setLocalSetting('autoCapitalisation', enabled) },
  getSendMessageKey: async () => getLocalSetting('sendMessageKey', 'enter'),
  setSendMessageKey: async (key) => { setLocalSetting('sendMessageKey', key) },
  getSpellCheck: async () => getLocalSetting('spellCheck', true),
  setSpellCheck: async (enabled) => { setLocalSetting('spellCheck', enabled) },

  // ── Power settings (no-op in web) ───────────────────────────────────
  getKeepAwakeWhileRunning: async () => false,
  setKeepAwakeWhileRunning: noopAsync,

  // ── Appearance settings ─────────────────────────────────────────────
  getRichToolDescriptions: async () => getLocalSetting('richToolDescriptions', true),
  setRichToolDescriptions: async (enabled) => { setLocalSetting('richToolDescriptions', enabled) },

  // ── Badge/Focus (web adaptations) ───────────────────────────────────
  updateBadgeCount: async (count) => {
    // Use document.title to show badge count in browser tab
    const baseTitle = 'Craft Agents'
    document.title = count > 0 ? `(${count}) ${baseTitle}` : baseTitle
  },
  clearBadgeCount: async () => { document.title = 'Craft Agents' },
  setDockIconWithBadge: noopAsync,
  onBadgeDraw: noopCleanup as ElectronAPI['onBadgeDraw'],
  getWindowFocusState: async () => document.hasFocus(),
  onWindowFocusChange: (callback) => {
    const onFocus = () => callback(true)
    const onBlur = () => callback(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  },
  onNotificationNavigate: noopCleanup as ElectronAPI['onNotificationNavigate'],

  // ── Theme preferences sync ──────────────────────────────────────────
  broadcastThemePreferences: async (prefs) => {
    setLocalSetting('themePreferences', prefs)
  },
  onThemePreferencesChange: (callback) =>
    eventBus.subscribe('theme:preferencesChanged', (data) => callback(data as Parameters<typeof callback>[0])),

  // ── Workspace theme sync ────────────────────────────────────────────
  broadcastWorkspaceThemeChange: async (workspaceId, themeId) => {
    setLocalSetting(`workspaceTheme:${workspaceId}`, themeId)
  },
  onWorkspaceThemeChange: (callback) =>
    eventBus.subscribe('theme:workspaceChanged', (data) => callback(data as Parameters<typeof callback>[0])),

  // ── Git operations ──────────────────────────────────────────────────
  getGitBranch: (dirPath) => api(`/git/branch?path=${encodeURIComponent(dirPath)}`),

  // ── Git Bash (Windows-only, no-op in web) ───────────────────────────
  checkGitBash: async () => ({ available: false, path: null } as { available: boolean; path: string | null }),
  browseForGitBash: async () => null,
  setGitBashPath: async () => ({ success: false, error: 'Not available in web' }),

  // ── Menu actions (web equivalents) ──────────────────────────────────
  menuQuit: async () => { window.close() },
  menuNewWindow: async () => { window.open(window.location.href, '_blank') },
  menuMinimize: noopAsync,
  menuMaximize: noopAsync,
  menuZoomIn: async () => {
    document.body.style.zoom = `${(parseFloat(document.body.style.zoom || '1') * 1.1)}`
  },
  menuZoomOut: async () => {
    document.body.style.zoom = `${(parseFloat(document.body.style.zoom || '1') / 1.1)}`
  },
  menuZoomReset: async () => { document.body.style.zoom = '1' },
  menuToggleDevTools: noopAsync,
  menuUndo: async () => { document.execCommand('undo') },
  menuRedo: async () => { document.execCommand('redo') },
  menuCut: async () => { document.execCommand('cut') },
  menuCopy: async () => { document.execCommand('copy') },
  menuPaste: async () => { document.execCommand('paste') },
  menuSelectAll: async () => { document.execCommand('selectAll') },

  // ── LLM Connections ─────────────────────────────────────────────────
  listLlmConnections: () => api('/llm/connections'),
  listLlmConnectionsWithStatus: () => api('/llm/connections-with-status'),
  getLlmConnection: (slug) => api(`/llm/connections/${slug}`),
  getLlmConnectionApiKey: (slug) => api(`/llm/connections/${slug}/api-key`),
  saveLlmConnection: (connection) => api('/llm/connections/save', connection),
  deleteLlmConnection: (slug) => api(`/llm/connections/${slug}/delete`, {}),
  testLlmConnection: (slug) => api(`/llm/connections/${slug}/test`, {}),
  setDefaultLlmConnection: (slug) => api('/llm/connections/set-default', { slug }),
  setWorkspaceDefaultLlmConnection: (workspaceId, slug) =>
    api(`/workspaces/${workspaceId}/default-llm-connection`, { slug }),

  // ── Automation ──────────────────────────────────────────────────────
  testAutomation: (payload) => api('/automations/test', payload),
  setAutomationEnabled: (workspaceId, eventName, matcherIndex, enabled) =>
    api('/automations/set-enabled', { workspaceId, eventName, matcherIndex, enabled }),
  duplicateAutomation: (workspaceId, eventName, matcherIndex) =>
    api('/automations/duplicate', { workspaceId, eventName, matcherIndex }),
  deleteAutomation: (workspaceId, eventName, matcherIndex) =>
    api('/automations/delete', { workspaceId, eventName, matcherIndex }),
  getAutomationHistory: (workspaceId, automationId, limit) =>
    api(`/automations/history?workspaceId=${encodeURIComponent(workspaceId)}&automationId=${encodeURIComponent(automationId)}${limit ? `&limit=${limit}` : ''}`),
  getAutomationLastExecuted: (workspaceId) =>
    api(`/automations/last-executed?workspaceId=${encodeURIComponent(workspaceId)}`),
  onAutomationsChanged: (callback) =>
    eventBus.subscribe('automations:changed', (data) => callback(data as string)),
}

/**
 * Install the web API as window.electronAPI for compatibility with
 * the shared renderer code.
 */
export function installWebAPI(): void {
  ;(window as unknown as { electronAPI: ElectronAPI }).electronAPI = webAPI
}
