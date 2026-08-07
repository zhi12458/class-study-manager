# 班级共修管理系统

独立的新版本班级共修管理系统。前端使用 React，服务端使用 Express，数据保存在 SQLite。它与现有旧系统没有数据迁移或运行依赖，最终在同一台 AMD miniPC 上以独立容器、端口和目录并行运行。

- 旧系统保持：`http://jingxin.myds.me:3002/`
- 新系统目标：`http://jingxin.myds.me:3003/`
- 新系统数据：`/opt/class-study-manager/data`
- 新系统备份：`/opt/class-study-manager/backups`

面向管理员、辅导员和班长的操作说明见：[简明使用说明](docs/简明使用说明.md)。

## 本机开发与验收

当前 Mac 需要 Node.js 24 和 npm。本机不需要安装 Docker Desktop，也不以 GitHub 检查作为验收条件。

```bash
cd /Users/jingzhi/puti/class-study-manager
npm ci
npm test
npm run typecheck
npm run build
```

本地开发服务器：

```bash
npm run dev
```

开发环境未提供管理员密码时会使用仅供本机调试的 `admin / admin12345`。不得把这个密码用于部署。项目不配置 GitHub Actions；以上检查全部在 Mac 本机完成后再提交和推送代码。

## 配置与持久化

生产部署前复制环境变量示例：

```bash
cp .env.example .env
chmod 600 .env
id -u
id -g
```

把命令输出填入 `APP_UID`、`APP_GID`，并将 `ADMIN_PASSWORD` 改为独立的高强度随机密码。`.env`、SQLite 数据库和备份均被 Git 忽略，不应上传到 GitHub。

重要说明：

- `ADMIN_PASSWORD` 仅在首次创建数据库中的管理员账号时使用；数据库已存在后，修改 `.env` 不会重置管理员密码。
- 当前入口是 HTTP，因此 `COOKIE_SECURE=false`。以后通过 HTTPS 反向代理访问时，应改为 `true`。
- 应用容器固定使用容器端口 3000，默认映射为宿主机端口 3003。
- `data` 和 `backups` 都是项目目录下的独立绑定目录，不与旧系统的数据卷共用。

## AMD64 miniPC 部署

所有 Docker 操作都在最终的 AMD miniPC 上执行。通过 UU 远程连接后，先只读检查环境；不要停止、重启或修改旧系统容器。

```bash
uname -m
cat /etc/os-release
docker --version
docker compose version
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
docker volume ls
df -h
timedatectl
sudo ss -lntp | grep -E ':3002|:3003' || true
```

应确认：

- `uname -m` 返回 `x86_64`（Docker 镜像架构对应 `amd64`）；
- 旧系统仍占用 3002，且其容器、目录和数据卷名称已记录；
- 3003 没有被其他进程占用；
- 磁盘空间、Asia/Shanghai 时区、防火墙规则均合适；
- 路由器或公网端口映射能把 TCP 3003 转发到 miniPC，同时不改变 3002 的映射。

首次安装：

```bash
sudo mkdir -p /opt/class-study-manager
sudo chown "$(id -u):$(id -g)" /opt/class-study-manager
git clone https://github.com/zhi12458/class-study-manager.git /opt/class-study-manager
cd /opt/class-study-manager
cp .env.example .env
chmod 600 .env
mkdir -p data backups
```

编辑 `.env`，至少设置真实的 `APP_UID`、`APP_GID` 和强管理员密码。随后在 miniPC 原机构建并启动：

```bash
docker compose config
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 app backup
```

Compose 未指定跨平台模拟，因此在 `x86_64` miniPC 上构建的是原生 AMD64 镜像。可进一步核对正在运行的应用镜像：

```bash
docker image inspect "$(docker inspect -f '{{.Image}}' class-study-manager)" --format '{{.Architecture}}'
```

结果应为 `amd64`。容器和资源保持独立：

| 用途 | 名称或路径 |
| --- | --- |
| 应用容器 | `class-study-manager` |
| 备份容器 | `class-study-manager-backup` |
| 宿主机端口 | `3003` |
| 容器应用端口 | `3000` |
| 数据目录 | `/opt/class-study-manager/data` |
| 备份目录 | `/opt/class-study-manager/backups` |

## 上线检查

先在 miniPC 本机检查健康接口和网页：

```bash
curl -fsS http://127.0.0.1:3003/api/health
curl -I http://127.0.0.1:3003/
docker inspect class-study-manager --format '{{.State.Health.Status}} {{.HostConfig.RestartPolicy.Name}}'
```

然后使用不在该局域网内的设备检查公网地址，以免路由器不支持 NAT 回环而造成误判：

- 新版：`http://jingxin.myds.me:3003/`
- 旧版：`http://jingxin.myds.me:3002/`

在生产环境完成管理员、辅导员和班长三种账号的冒烟测试：登录与首次改密、班级切换、敏感字段隔离、考勤保存、统计与导出。最后再次确认旧版 3002 可访问，且旧容器未被重启、旧数据库时间戳未因本次部署改变。

## 备份

`class-study-manager-backup` 在首次启动时立即创建一份备份，之后按 Asia/Shanghai 时区每月 1 日 03:00 执行。脚本使用 SQLite 在线备份并运行 `PRAGMA quick_check`，同时生成 SHA-256 校验文件；默认删除超过 400 天且名称匹配 `class-study-*.sqlite` 的备份。

手工触发和检查：

```bash
docker compose exec backup /usr/local/bin/monthly-backup.sh
ls -lh backups
cd backups && sha256sum -c class-study-YYYYMMDD-HHMMSS.sqlite.sha256
```

恢复前必须停止应用和备份容器，并先保留当前数据库副本。不要在应用仍运行时直接覆盖 `data/class-study.sqlite`。

## 更新与排障

```bash
cd /opt/class-study-manager
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=200 app backup
```

健康接口应返回类似 `{"ok":true,"service":"class-study-manager"}`。如果应用启动失败，优先检查 `.env` 是否存在、`ADMIN_PASSWORD` 是否已替换、3003 是否冲突，以及 `data` 目录是否可由 `APP_UID:APP_GID` 写入。

## 公网安全说明

当前按需求直接提供 HTTP 公网访问。HTTP 不加密传输，登录密码、手机号、备注及会话 Cookie 都可能被链路上的第三方读取或篡改，不适合长期承载真实敏感数据。上线后应尽快在反向代理中配置 HTTPS、限制管理入口来源并保留定期离线备份；启用 HTTPS 后将 `COOKIE_SECURE` 改为 `true`。

仓库不包含开源许可证，也不包含旧项目历史、旧数据库、备份、PDF、截图、真实密码或 GitHub Actions 工作流。
