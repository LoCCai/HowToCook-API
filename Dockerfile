# HowToCook API 镜像（构建上下文 = 本仓库根目录）
#   docker build -t howtocook-api .
# 菜谱内容在构建期完整克隆（保留 .git 以提取作者 / 编写时间元数据），可用构建参数覆盖：
#   docker build --build-arg CONTENT_REPO=https://github.com/Anduin2017/HowToCook.git \
#                --build-arg CONTENT_REF=master -t howtocook-api .
FROM node:22-alpine

# scanner 启动时通过 git log 提取作者 / 编写时间元数据（缺失时回退文件时间戳）
RUN apk add --no-cache git

ARG CONTENT_REPO=https://github.com/Anduin2017/HowToCook.git
ARG CONTENT_REF=master

# 容器内必须监听 0.0.0.0，否则端口映射不通；CONTENT_DIR 指向构建期克隆的内容目录
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WATCH=0 \
    CONTENT_DIR=/app/content

WORKDIR /app/api

# 先只拷贝依赖清单，利用 Docker 层缓存：代码变更不触发重装依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 应用代码
COPY src ./src

# 菜谱内容（不使用 --depth，完整历史才能正确提取每道菜的首位提交作者与时间）
RUN git clone --no-tags --branch "${CONTENT_REF}" "${CONTENT_REPO}" /app/content

WORKDIR /app/api
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
