# Cloud Sandbox Integration

Agent 在执行任务时会调用 Bash、文件读写、Glob、Grep 等工具，在桌面端直接操作本地文件系统是可接受的，但在 Web 部署中需要隔离执行环境，防止任意代码在服务器上运行。

本文档描述了基于 [E2B](https://e2b.dev) 的云端沙箱集成方案。

## 架构

```
Browser ──HTTP/WS──> Hono Server (apps/web)
                           │
                    Agent SDK (packages/shared)
                           │
                    Sandbox MCP Server
                           │
                     E2B Cloud VM (per session)
                     ┌─────────────────┐
                     │  bash / files   │
                     │  glob / grep    │
                     └─────────────────┘
```

**核心思路**：通过一个自定义 MCP Server 将内置工具（Bash、Read、Write 等）重定向到 E2B 云端 VM 执行，而不是在宿主机上执行。每个会话拥有独立的沙箱实例。

## 模块结构

```
packages/shared/src/sandbox/
  types.ts              SandboxProvider 接口 & 类型定义
  e2b-provider.ts       E2B SDK 封装实现
  sandbox-manager.ts    按会话管理沙箱生命周期
  sandbox-mcp-server.ts MCP Server（工具重定向）
  index.ts              Barrel 导出
```

## 核心接口

### SandboxProvider

```typescript
interface SandboxProvider {
  start(config: SandboxConfig): Promise<void>
  executeCommand(command: string, opts?: CommandOptions): Promise<CommandResult>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  listFiles(path: string): Promise<FileEntry[]>
  glob(pattern: string, cwd?: string): Promise<string[]>
  grep(pattern: string, path: string, opts?: GrepOptions): Promise<string>
  destroy(): Promise<void>
  isAlive(): Promise<boolean>
  getId(): string
}
```

### SandboxManager

```typescript
class SandboxManager {
  getOrCreate(sessionId: string): Promise<SandboxProvider>  // 懒创建
  get(sessionId: string): SandboxProvider | null
  destroy(sessionId: string): Promise<void>
  destroyAll(): Promise<void>   // 服务器关闭时调用
  touchActivity(sessionId: string): void  // 重置空闲计时器
  size: number
}
```

## MCP 工具映射

沙箱 MCP Server 的 key 为 `sandbox`，SDK 自动添加 `mcp__sandbox__` 前缀：

| 内置工具 | 沙箱替代工具 |
|---------|-------------|
| `Bash` | `mcp__sandbox__sandbox_bash` |
| `Read` | `mcp__sandbox__sandbox_read` |
| `Write` | `mcp__sandbox__sandbox_write` |
| `Edit` | `mcp__sandbox__sandbox_edit` |
| `Glob` | `mcp__sandbox__sandbox_glob` |
| `Grep` | `mcp__sandbox__sandbox_grep` |

## 集成方式

### ClaudeAgent 中的集成

`packages/shared/src/agent/claude-agent.ts` 在 `chat()` 方法中：

1. 通过 `SandboxManager.getOrCreate(sessionId)` 获取或创建沙箱
2. 调用 `createSandboxMcpServer(sandbox)` 生成 MCP Server
3. 将其注入 `mcpServers.sandbox`，Agent SDK 自动暴露沙箱工具给模型
4. `PreToolUse` 钩子拦截内置工具调用，返回重定向提示，引导模型改用沙箱工具

```typescript
// ClaudeAgentConfig 中新增字段
interface ClaudeAgentConfig {
  sandboxManager?: SandboxManager  // Web 模式下传入
}
```

### Web Server 中的集成

`apps/web/src/server/index.ts`：

```typescript
// 服务器启动时初始化（需要 E2B_API_KEY 环境变量）
const sandboxManager = Bun.env.E2B_API_KEY
  ? new SandboxManager({ provider: 'e2b', defaults: { ... } })
  : null

// 会话删除时清理沙箱
await sandboxManager?.destroy(sessionId)

// 服务器关闭时销毁所有沙箱
process.on('SIGTERM', async () => {
  await sandboxManager?.destroyAll()
  process.exit(0)
})
```

## 配置

通过环境变量控制沙箱行为：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `E2B_API_KEY` | — | **必填**，E2B API 密钥，缺失时沙箱禁用，工具在本地执行 |
| `SANDBOX_PROVIDER` | `e2b` | 沙箱提供商（当前仅支持 `e2b`） |
| `SANDBOX_TEMPLATE` | `base` | E2B 沙箱模板名称或 ID |
| `SANDBOX_TIMEOUT` | `300000` | 单次沙箱超时（毫秒），到期自动销毁 |
| `SANDBOX_IDLE_TIMEOUT` | `600000` | 空闲超时（毫秒），无活动后自动销毁 |

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /api/sandbox/info` | 沙箱全局状态（是否启用、当前活跃数） |
| `GET /api/sandbox/:sessionId/status` | 指定会话的沙箱状态（running/dead/not_created） |

## 沙箱生命周期

```
Session Created
      │
      ▼
Agent First Tool Call
      │
      ▼  (SandboxManager.getOrCreate)
E2B VM Provisioned  ◄──── ~2-5 秒冷启动
      │
      ▼
Tool Calls Execute in VM
      │
   ┌──┴──────────────────┐
   │                     │
Session Deleted      Idle Timeout (10 min)
   │                     │
   ▼                     ▼
sandbox.kill()      sandbox.kill()
```

## 扩展其他 Provider

实现 `SandboxProvider` 接口并在 `SandboxManager.createProvider()` 中注册即可：

```typescript
// sandbox-manager.ts
private createProvider(): SandboxProvider {
  switch (this.config.provider) {
    case 'e2b': return new E2bSandboxProvider()
    case 'daytona': return new DaytonaSandboxProvider()  // 待实现
  }
}
```

## 注意事项

- **首次工具调用有延迟**：E2B 冷启动需 2-5 秒，后续调用复用同一 VM 无额外延迟
- **文件持久性**：沙箱内文件仅在会话期间保留，会话结束后随 VM 销毁
- **不支持 GUI**：沙箱为纯 CLI 环境，无法运行需要图形界面的程序
- **网络访问**：E2B 沙箱默认有网络访问权限（可在 E2B 控制台配置限制）
- **费用**：E2B 按沙箱运行时长计费，空闲超时机制有助于控制成本

## 参考

- [E2B 文档](https://e2b.dev/docs)
- [E2B JavaScript SDK](https://e2b.dev/docs/sdk-reference/js-sdk/v1.2.0/sandbox)
- [Web 架构](./web-architecture.md)
