FROM node:20-alpine
WORKDIR /srv/web

# 构建上下文是仓库根（见 docker-compose.yml），frontend 与 scripts 都能拷进来。
# 先拷依赖清单安装，再拷代码跑同一份播种流水线，保证镜像里带 seed-snapshot.json。
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
COPY scripts/ ../scripts/
ENV SEED_FRONTEND_DIR=/srv/web SEED_STATE_DIR=/tmp/seed-state
RUN node ../scripts/seed.mjs --no-install

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
