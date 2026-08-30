# 部署文档：Docker 部署 HowToCook API 并开机自动启动

本目录提供了完整的容器化文件，部署只需三条命令。镜像在构建期从官方 HowToCook 仓库下载菜谱内容（完整 git 历史，用于作者 / 编写时间元数据），运行无需外部数据库或内容挂载。

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 镜像构建（node:22-alpine + git + 应用 + 官方内容仓库） |
| `docker-compose.yml` | 编排：端口、健康检查、日志轮转、**自动重启策略** |
| `.dockerignore` | 缩小构建上下文（排除 node_modules / content 等） |

## 1. 前提条件

- Docker Engine 24+（Linux 服务器）或 Docker Desktop 4+（Windows / macOS），含 Compose V2（`docker compose` 子命令）
- 构建机能访问 GitHub 拉取基础镜像与菜谱内容（内网环境见第 6 节「离线 / 内网部署」）

## 2. 构建镜像

```bash
# 在本仓库（HowToCook-API）根目录执行
docker build -t howtocook-api:latest .

# 需要固定内容版本时，用构建参数指定内容仓库与分支 / 标签：
docker build \
  --build-arg CONTENT_REPO=https://github.com/Anduin2017/HowToCook.git \
  --build-arg CONTENT_REF=master \
  -t howtocook-api:latest .
```

> 内容获取说明：Dockerfile 在构建期 `git clone` 官方内容仓库到镜像内 `/app/content`（完整历史，非浅克隆），并通过 `CONTENT_DIR=/app/content` 告知 API。**不走浅克隆是为了保留每道菜的首位提交作者与编写时间。**

## 3. 启动

### 方式一：docker compose（推荐）

```bash
docker compose up -d          # 首次会自动构建镜像
docker compose ps             # STATUS 应为 Up (healthy)
curl http://127.0.0.1:3000/api/health
```

需要自定义反代地址等环境变量时，直接编辑 `docker-compose.yml` 中的 `environment` 段（已留注释位），然后 `docker compose up -d` 重建。

### 方式二：docker run

```bash
docker run -d \
  --name howtocook-api \
  --restart unless-stopped \
  -p 3000:3000 \
  howtocook-api:latest
```

验证：

```bash
curl http://127.0.0.1:3000/api/health
# {"data":{"status":"ok","recipes":368,"tips":18,...}}
```

## 4. 开机自动启动（重点）

容器自动启动由两层机制共同保证，缺一不可：

### 4.1 容器层：restart 策略

`docker-compose.yml` 已内置：

```yaml
restart: unless-stopped
```

该策略的含义：

| 场景 | 行为 |
| --- | --- |
| 容器进程崩溃 | Docker 自动拉起 |
| 服务器重启 / Docker 守护进程启动 | 自动拉起（这就是开机自启） |
| 你手动 `docker stop` | 不再拉起（重新 `docker start` 或 `up -d` 恢复） |

如果希望「手动 stop 后、重启机器时仍然拉起」，把策略改为 `restart: always`（裸 `docker run` 用 `--restart always`）。

### 4.2 宿主机层：Docker 服务自身开机自启

restart 策略只在 Docker 守护进程运行时生效，所以要保证 Docker 随系统启动。

**Linux（systemd，绝大多数服务器）：**

```bash
sudo systemctl enable --now docker
systemctl is-enabled docker   # 应输出 enabled
```

**Windows / macOS（Docker Desktop）：**

设置 → General → 勾选 **Start Docker Desktop when you sign in**（Windows 还可在任务栏 → 设置启动项中确认）。

### 4.3 验证自动启动

```bash
# 模拟服务器重启后 Docker 拉起容器（不必真重启机器）
sudo systemctl restart docker
sleep 5
docker ps --filter name=howtocook-api    # STATUS 为 Up，重启场景下会显示 (health: starting)
curl http://127.0.0.1:3000/api/health
```

有条件的话直接 `sudo reboot` 一次做端到端验证。

### 4.4 备选：systemd unit 管理 compose 项目（可选）

一般不需要——上面的两层机制已覆盖。若团队规范要求所有服务有 systemd unit，可创建 `/etc/systemd/system/howtocook-api.service`：

```ini
[Unit]
Description=HowToCook API (docker compose)
Requires=docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/HowToCook-API
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now howtocook-api
```

注意：`WorkingDirectory` 改成你的实际仓库路径；此方案下 restart 策略依然保留，崩溃仍由 Docker 自愈。

## 5. 反向代理与图片模式

生产环境建议在容器前挂一层 Nginx（HTTPS / 域名 / 缓存）：

```nginx
server {
    listen 443 ssl;
    server_name api.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

如果图片走 CDN / 对象存储反代，把 `ASSET_BASE_URL` 设为该地址（如 `https://cdn.example.com/howtocook`），API 会把文档中的图片重写为反代地址（proxy 模式），客户端不再回源 API 服务器：

```yaml
environment:
  ASSET_BASE_URL: https://cdn.example.com/howtocook
  DEFAULT_IMAGE_MODE: proxy
```

## 6. 更新与运维

```bash
cd /opt/HowToCook-API        # 本仓库根

# 内容更新：重建镜像（构建期会拉取官方内容仓库最新代码）
docker build -t howtocook-api:latest .
docker compose up -d                  # 原地滚动替换

# 应用代码更新
git pull
docker compose up -d --build

# 常用命令
docker compose logs -f               # 跟踪日志（已配 10MB x 3 轮转）
docker compose restart               # 重启
docker compose down                  # 停止并移除容器（镜像保留）
```

**不想每次重建镜像更新内容？** 把宿主机上的一份 HowToCook 检出挂载进容器，更新内容只需 `git -C /opt/HowToCook pull`：

```yaml
# docker-compose.yml 追加
    environment:
      CONTENT_DIR: /mnt/content
    volumes:
      - /opt/HowToCook:/mnt/content:ro
```

**离线 / 内网部署**：在能访问外网的机器上 `docker build` 后 `docker save howtocook-api:latest | gzip > api.tar.gz`，拷贝到内网服务器 `docker load < api.tar.gz`；或构建参数 `--build-arg CONTENT_REPO=<内网 git 镜像地址>`。

想让镜像更新全自动的话，可以跑一个 [Watchtower](https://containrrr.dev/watchtower/) 周期检查；或用 CI 在 push 时构建推送到 registry，服务器只负责 `docker compose pull && up -d`。

## 7. 端口与环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 容器内监听端口（`ports` 左侧是宿主机端口，可改映射如 `"8080:3000"`） |
| `HOST` | `0.0.0.0` | Dockerfile 已固定为 0.0.0.0（容器内不能改回 127.0.0.1，否则端口映射不通） |
| `ASSET_BASE_URL` | 空 | 资源反代地址，配置后默认图片模式自动变为 proxy |
| `DEFAULT_IMAGE_MODE` | `server`（配反代则 `proxy`） | 默认图片模式，任意端点可用 `?image_mode=` 覆盖 |
| `WATCH` | `0` | 容器内保持 0（内容已打入镜像，改内容走重建镜像流程） |
| `RATE_LIMIT_MAX` | `0`（不限） | 公网部署建议 120；限流按 IP，反代后记得 `TRUST_PROXY=1` |

## 8. 常见问题

**Q：容器里作者 / 编写时间是空的？**
镜像构建期完整克隆了官方内容仓库（含 `.git`），正常都有作者元数据。仅当你改用内容挂载且挂载目录没有 `.git` 时，API 会回退为文件时间戳。

**Q：构建时 git clone 内容仓库很慢 / 失败？**
网络问题。可用 `--build-arg CONTENT_REPO=<镜像地址>` 指向内网 git 镜像，或按第 6 节离线方案 `docker save / load`。

**Q：`curl` 通了但外部访问不了？**
检查 `ports` 映射是否写了宿主机端口；云服务器还需在安全组 / 防火墙放行对应端口。

**Q：想在一个容器里同时跑官网和 API？**
不建议。官网（VitePress）与 API 分容器部署，各自独立扩缩容；Nginx 按路径分发到两个容器即可。
