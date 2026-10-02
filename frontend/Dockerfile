FROM node:20-alpine
# 目录布局与仓库保持一致：/srv/frontend + /srv/seed，
# 播种脚本靠自身位置推导仓库根，不写死绝对路径。
WORKDIR /srv
COPY frontend/package.json ./frontend/package.json
RUN cd frontend && npm install
COPY frontend/ ./frontend/
COPY seed/ ./seed/
WORKDIR /srv/frontend
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
