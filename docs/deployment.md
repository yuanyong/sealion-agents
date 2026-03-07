# 部署指南

## 平台选型

本项目的 Web 版本需要：

- **Bun 运行时**（非 Node.js）
- **持久 WebSocket 连接**（实时事件推送）
- **长时间运行进程**（Agent 执行可达数分钟）
- **持久内存**（会话状态 + SandboxManager）

因此 **Vercel / Netlify / Cloudflare Pages 不适用**（均为 serverless/edge，无法满足以上需求）。

### 推荐平台

| 平台 | 特点 | 适合场景 |
|------|------|---------|
| **Docker** | 完全控制，任意 VPS 部署 | 自有服务器、私有化部署 |
| **Railway** | 一键部署，原生支持 Docker + WebSocket | 快速验证、小团队 |
| **Fly.io** | 全球边缘部署，支持持久 VM | 需要低延迟的生产环境 |
| **Render** | 类 Railway，支持 Docker + WebSocket | 简单部署 |
| **自有 VPS** | 装 Bun 直接跑 | 完全控制 |

---

## 方式 1: 本地开发验证

最快的验证方式，无需任何部署。

```bash
# 1. 安装依赖
bun install

# 2. 配置环境变量
cp apps/web/.env.example apps/web/.env
# 编辑 apps/web/.env，填入 ANTHROPIC_API_KEY 和 E2B_API_KEY

# 3. 启动开发服务器（前后端 + 热重载）
bun run web:dev

# 4. 打开浏览器
# 前端: http://localhost:3000
# API:  http://localhost:3001
```

---

## 方式 2: Docker 部署

适合任何支持 Docker 的环境（VPS、ECS、GKE 等）。

### 快速启动

```bash
# 1. 配置环境变量
cp apps/web/.env.example apps/web/.env
# 编辑 .env 填入密钥

# 2. 构建并启动
docker compose up --build

# 后台运行
docker compose up -d

# 查看日志
docker compose logs -f web

# 停止
docker compose down
```

### 手动 Docker 构建

```bash
# 构建镜像
docker build -f apps/web/Dockerfile -t craft-agents-web .

# 运行
docker run -d \
  --name craft-agents-web \
  -p 3001:3001 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e E2B_API_KEY=e2b_... \
  craft-agents-web
```

访问 `http://localhost:3001`。

---

## 方式 3: Railway

[Railway](https://railway.app) 原生支持 Docker + WebSocket，适合快速部署验证。

```bash
# 1. 安装 Railway CLI
npm install -g @railway/cli

# 2. 登录
railway login

# 3. 初始化项目
railway init

# 4. 设置环境变量
railway variables set ANTHROPIC_API_KEY=sk-ant-...
railway variables set E2B_API_KEY=e2b_...
railway variables set PORT=3001

# 5. 部署（使用 Dockerfile）
railway up
```

Railway 配置说明：
- **Root Directory**: `/`（使用项目根目录，因为 Dockerfile 需要 monorepo 上下文）
- **Dockerfile Path**: `apps/web/Dockerfile`
- **Port**: `3001`

---

## 方式 4: Fly.io

[Fly.io](https://fly.io) 支持持久 VM + 全球部署。

```bash
# 1. 安装 Fly CLI
curl -L https://fly.io/install.sh | sh

# 2. 登录
fly auth login

# 3. 创建应用
fly launch --no-deploy \
  --name craft-agents-web \
  --dockerfile apps/web/Dockerfile

# 4. 设置密钥
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
fly secrets set E2B_API_KEY=e2b_...

# 5. 部署
fly deploy
```

在自动生成的 `fly.toml` 中确认：

```toml
[http_service]
  internal_port = 3001
  force_https = true
  auto_stop_machines = "suspend"   # 空闲时暂停（节省费用）
  auto_start_machines = true
  min_machines_running = 1

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
```

---

## 方式 5: 裸 VPS（Ubuntu / Debian）

直接在服务器上安装 Bun 运行。

```bash
# 1. 安装 Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# 2. 克隆代码
git clone https://github.com/yuanyong/sealion-agents.git
cd sealion-agents

# 3. 安装依赖
bun install

# 4. 配置环境变量
cp apps/web/.env.example apps/web/.env
nano apps/web/.env  # 填入密钥

# 5. 构建
cd apps/web && bun run build && cd ../..

# 6. 启动（生产模式）
bun run web:start
```

### 用 systemd 持久运行

```bash
sudo tee /etc/systemd/system/craft-agents-web.service << 'EOF'
[Unit]
Description=Craft Agents Web Server
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/home/deploy/sealion-agents
EnvironmentFile=/home/deploy/sealion-agents/apps/web/.env
ExecStart=/home/deploy/.bun/bin/bun apps/web/src/server/index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable craft-agents-web
sudo systemctl start craft-agents-web
sudo systemctl status craft-agents-web
```

### 用 Nginx 反向代理 + HTTPS

```nginx
server {
    listen 443 ssl http2;
    server_name agents.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/agents.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/agents.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;  # Agent 执行可能较长
    }
}
```

---

## 环境变量参考

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `ANTHROPIC_API_KEY` | 是 | — | Claude API 密钥 |
| `E2B_API_KEY` | 推荐 | — | E2B 沙箱密钥（未设置则工具在本地执行） |
| `PORT` | 否 | `3001` | 服务端口 |
| `SANDBOX_PROVIDER` | 否 | `e2b` | 沙箱提供商 |
| `SANDBOX_TEMPLATE` | 否 | `base` | E2B 模板 |
| `SANDBOX_TIMEOUT` | 否 | `300000` | 沙箱超时（5 分钟） |
| `SANDBOX_IDLE_TIMEOUT` | 否 | `600000` | 空闲超时（10 分钟） |

---

## 验证部署

部署完成后，验证以下端点：

```bash
# 服务器健康检查
curl http://localhost:3001/api/sandbox/info
# → {"enabled":true,"provider":"e2b","activeSandboxes":0}

# WebSocket 连接测试
wscat -c ws://localhost:3001/ws

# 创建会话
curl -X POST http://localhost:3001/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"test","options":{"name":"Test"}}'
```

---

## 参考

- [Web 架构](./web-architecture.md)
- [沙箱设计](./sandbox.md)
- [E2B 文档](https://e2b.dev/docs)
