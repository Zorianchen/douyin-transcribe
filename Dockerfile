# 抖音文字稿提取 - 云端部署镜像
FROM node:20-bookworm-slim

# 安装 ffmpeg（提取音频用）+ ca-certificates
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先拷依赖清单，利用缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 再拷业务代码
COPY server ./server
COPY public ./public

# 运行时目录（临时音频 / 历史记录）
RUN mkdir -p temp data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Render 等平台会通过 PORT 环境变量映射端口；容器内固定 3000
CMD ["node", "server/index.js"]
