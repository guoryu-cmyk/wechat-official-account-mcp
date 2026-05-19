# 微信公众号 MCP 服务

一个为 AI 应用提供微信公众号 API 集成的 MCP (Model Context Protocol) 服务项目。

**作者**: xwang152-jack <xwang152@163.com>
**更新日期**: 2025年02月16日

## 🚀 项目概述

本项目基于 MCP 协议，为 AI 应用（如 Claude Desktop、Cursor、Trae AI 等）提供**完整**的微信公众号 API 集成。通过标准化的工具接口，AI 应用可以轻松管理微信公众号的用户、标签、菜单、素材、草稿、发布、消息、数据统计等**所有核心功能**。

**当前版本**: `v2.0.0` （查看 [CHANGELOG](./CHANGELOG.md) | [v1.1.0 Release Notes](./RELEASE_NOTES_v1.1.0.md)）

**重大更新**: 从 6 个工具扩展到 17 个工具，覆盖微信公众号 95% 的核心 API 功能！（详见 [功能总览](./FEATURES_OVERVIEW.md)）

## 📖 文档导航

- **[功能总览 (FEATURES_OVERVIEW.md)](./FEATURES_OVERVIEW.md)** - v2.0.0 完整功能介绍、对比表格和使用场景
- **[更新日志 (CHANGELOG.md)](./CHANGELOG.md)** - 版本历史和详细更新内容
- **[开发者指南 (CLAUDE.md)](./CLAUDE.md)** - 架构说明、开发规范、常见模式

### 外部资源
- [微信公众平台官方文档](https://developers.weixin.qq.com/doc/)
- [MCP 协议规范](https://modelcontextprotocol.io/)

## ✨ 核心功能

- **🔐 认证管理**: 安全管理微信公众号 AppID、AppSecret 和 Access Token
- **📁 素材管理**: 上传、获取、管理临时和永久素材
- **📝 草稿管理**: 创建、编辑、管理图文草稿
- **📢 发布管理**: 发布草稿到微信公众号
- **💾 本地存储**: 使用 SQLite 本地存储配置和数据
- **🔧 MCP 集成**: 完全兼容 MCP 协议标准
 - **🛡️ 安全增强（v1.1.0）**: 支持敏感字段加密存储与日志脱敏，跨域来源白名单配置

## 🛠️ 技术栈

- **运行时**: Node.js 18+
- **语言**: TypeScript
- **协议**: MCP (Model Context Protocol)
- **数据库**: SQLite
- **HTTP 客户端**: Axios
- **参数验证**: Zod
- **构建工具**: Vite

## 📦 快速开始

### 方式一：使用 npx（推荐）

直接使用 npx 运行，无需安装：

```bash
# 启动 MCP 服务器
npx wechat-official-account-mcp mcp -a <your_app_id> -s <your_app_secret>

# 示例
npx wechat-official-account-mcp mcp -a wx1234567890abcdef -s your_app_secret_here
```

> 提示：如使用 SSE 模式，请设置 `CORS_ORIGIN` 为允许访问的域名白名单。

### SSE 模式图片上传流程

> 兼容说明：SSE 模式现在同时暴露现代 MCP Streamable HTTP 入口 `POST /mcp`。如果客户端已经配置了旧地址 `https://<domain>/sse`，服务端也会兼容 `POST /sse` 的 Streamable HTTP 调用；旧版 `GET /sse` + `POST /messages` 仍可继续使用。公网部署建议优先给 ChatGPT/Codex 等现代客户端配置 `https://<domain>/mcp?token=<MCP_AUTH_TOKEN>`，如果客户端仍缓存旧 `/sse` 地址，删除后重新添加连接。

远程 SSE 模式下，`wechat_upload_img` 的 `filePath` 必须是 MCP 服务器上的路径，不能直接读取用户电脑本地文件。为了避免把图片转成超长 base64 后在 AI/MCP JSON 参数链路中被截断，且兼容 ChatGPT 执行环境无法对外 curl 的情况，推荐优先调用 MCP 工具 `wechat_stage_image_upload` 分片上传图片。

`wechat_stage_image_upload` 不需要外部 HTTP 网络，完整流程如下：

```text
1. 调用 wechat_stage_image_upload({ "action": "start", "fileName": "article.jpg", "totalSize": 5572 })
2. 把本地图片转成 base64，并按 65536 个字符左右切块，分片长度必须是 4 的倍数
3. 按顺序多次调用 wechat_stage_image_upload({ "action": "append", "uploadId": "...", "chunkIndex": 0, "chunkData": "..." })
4. 调用 wechat_stage_image_upload({ "action": "finish", "uploadId": "..." })，读取返回的 filePath
5. 调用 wechat_upload_img({ "filePath": "<返回的 filePath>" })
```

如果客户端明确可以直接执行外部 HTTP POST，也可以调用 `wechat_prepare_image_upload` 获取一次性 `uploadUrl`：

`wechat_prepare_image_upload` 会返回：

```json
{
  "ok": true,
  "uploadUrl": "https://example.com/upload-image?upload_token=xxxx",
  "method": "POST",
  "contentType": "multipart/form-data",
  "formField": "file",
  "maxBytes": 1048576,
  "allowedFormats": ["jpg", "jpeg", "png"],
  "expiresInSeconds": 300,
  "oneTime": true,
  "networkHint": {
    "curlResolve": "guoairong.site:443:110.42.214.78",
    "curlOption": "--resolve guoairong.site:443:110.42.214.78"
  },
  "curlExample": "curl --resolve 'guoairong.site:443:110.42.214.78' -X POST -F 'file=@/path/to/image.png' 'https://guoairong.site/upload-image?upload_token=xxxx'",
  "nextStep": {
    "tool": "wechat_upload_img",
    "arguments": {
      "filePath": "<filePath from upload response>"
    }
  }
}
```

> 生成绝对 `uploadUrl` 需要服务端配置 `MCP_PUBLIC_BASE_URL`，例如 `MCP_PUBLIC_BASE_URL=https://example.com`。
> 如果执行环境无法解析域名，可配置 `MCP_UPLOAD_CURL_RESOLVE=guoairong.site:443:110.42.214.78`。客户端使用返回的 `networkHint.curlOption`，不要把 HTTPS URL 改成 `https://IP`。

上传地址对应的 HTTP 接口：

```text
POST /upload-image
Content-Type: multipart/form-data
字段名: file
```

鉴权方式支持两种：

- 推荐：使用 `wechat_prepare_image_upload` 返回的 `uploadUrl`，其中已经包含一次性 `upload_token`
- 兼容：`POST /upload-image?token=<MCP_AUTH_TOKEN>` 或 `Authorization: Bearer <MCP_AUTH_TOKEN>`

上传要求：

- 图片格式：完整的 JPG/JPEG/PNG
- 大小限制：不超过 1MB（符合微信公众号图文正文图片 `uploadimg` 接口要求）
- 保存目录：`~/wechat-official-account-mcp/temp`

返回示例：

```json
{
  "ok": true,
  "filePath": "/home/ubuntu/wechat-official-account-mcp/temp/xxx.png",
  "fileName": "xxx.png",
  "size": 5589,
  "detectedFormat": "png",
  "contentType": "image/png",
  "nextTool": {
    "name": "wechat_upload_img",
    "arguments": {
      "filePath": "/home/ubuntu/wechat-official-account-mcp/temp/xxx.png"
    }
  }
}
```

HTTP uploadUrl 调用流程：

```text
1. 调用 MCP 工具 wechat_prepare_image_upload，获取 uploadUrl
2. 客户端用 multipart/form-data 的 file 字段上传本地图片到 uploadUrl
3. 读取响应里的 filePath
4. 调用 MCP 工具 wechat_upload_img({ "filePath": "<返回的 filePath>" })
5. 使用 wechat_upload_img 返回的微信图片 URL 写入图文正文
```

curl 示例：

```bash
curl -X POST \
  -F "file=@./article-image.png;type=image/png" \
  "https://example.com/upload-image?upload_token=<wechat_prepare_image_upload返回的一次性token>"
```

> 注意：如果 ChatGPT 执行 curl 出现 DNS 失败、Failed to connect、HTTP_STATUS:000 等网络错误，请不要继续尝试 HTTP 上传，改用 `wechat_stage_image_upload` 分片上传。

### 方式二：全局安装

```bash
# 全局安装
npm install -g wechat-official-account-mcp

# 启动服务
wechat-mcp mcp -a <your_app_id> -s <your_app_secret>
```

### 方式三：本地开发

```bash
# 1. 克隆项目
git clone https://github.com/xwang152-jack/wechat-official-account-mcp.git
cd wechat-official-account-mcp

# 2. 安装依赖
npm install

# 3. 构建项目
npm run build

# 4. 启动服务
node dist/src/cli.js mcp -a <your_app_id> -s <your_app_secret>
```

### CLI 参数说明

- `-a, --app-id <appId>`: 微信公众号 AppID（必需）
- `-s, --app-secret <appSecret>`: 微信公众号 AppSecret（必需）
- `-m, --mode <mode>`: 传输模式，支持 `stdio`（默认）和 `sse`
- `-p, --port <port>`: SSE 模式下的端口号（默认 3000）
- `-c, --config <path>`: 统一 MCP 配置文件路径
- `--account <name>`: 配置文件中的公众号 profile 名称
- `--mcp-token <token>`: 当前 MCP 实例访问 token
- `--public-base-url <url>`: 当前 MCP 实例公网基础地址
- `--db-path <path>`: 当前公众号独立 SQLite 数据库路径
- `--image-upload-dir <path>`: 当前公众号独立图片临时目录
- `-h, --help`: 显示帮助信息

环境变量（常用）：
- `WECHAT_MCP_CONFIG`: 统一配置文件路径
- `WECHAT_MCP_ACCOUNT`: 默认启动的公众号 profile 名称
- `CORS_ORIGIN`: 逗号分隔的跨域来源白名单（示例：`https://a.example.com,https://b.example.com`）
- `WECHAT_MCP_SECRET_KEY`: 开启敏感字段加密存储（AES），设置即启用

### 多公众号统一配置文件

一个配置文件可以放多个公众号 profile。实际运行时仍建议“一个 profile 一个 MCP 进程”，每个进程使用独立端口、数据库、临时目录和 MCP token，避免多个公众号之间串数据。

```json
{
  "defaultAccount": "justin",
  "accounts": {
    "justin": {
      "wechat": {
        "appId": "wx_your_justin_appid",
        "appSecret": "your_justin_appsecret"
      },
      "mcp": {
        "mode": "sse",
        "port": 3000,
        "authToken": "justin-mcp-token",
        "publicBaseUrl": "https://justin.guoairong.site",
        "uploadCurlResolve": "justin.guoairong.site:443:110.42.214.78"
      },
      "storage": {
        "dbPath": "./data/justin/wechat-mcp.db",
        "imageUploadDir": "./temp/justin"
      }
    },
    "zhandaren": {
      "wechat": {
        "appId": "wx_your_zhandaren_appid",
        "appSecret": "your_zhandaren_appsecret"
      },
      "mcp": {
        "mode": "sse",
        "port": 3001,
        "authToken": "zhandaren-mcp-token",
        "publicBaseUrl": "https://zhandaren.guoairong.site",
        "uploadCurlResolve": "zhandaren.guoairong.site:443:110.42.214.78"
      },
      "storage": {
        "dbPath": "./data/zhandaren/wechat-mcp.db",
        "imageUploadDir": "./temp/zhandaren"
      }
    }
  }
}
```

启动示例：

```bash
wechat-mcp mcp --config ~/wechat-official-account-mcp/accounts.json --account justin
wechat-mcp mcp --config ~/wechat-official-account-mcp/accounts.json --account zhandaren
```

字段说明：
- `wechat.appId` / `wechat.appSecret`: 当前公众号的 AppID 和 AppSecret
- `mcp.authToken`: ChatGPT/Codex 连接 MCP 时使用的访问 token，对应旧的 `MCP_AUTH_TOKEN`
- `mcp.publicBaseUrl`: 当前 profile 对外访问的域名，对应旧的 `MCP_PUBLIC_BASE_URL`
- `mcp.uploadCurlResolve`: 可选 DNS 绕过提示，对应旧的 `MCP_UPLOAD_CURL_RESOLVE`
- `storage.dbPath`: 当前公众号独立 SQLite 数据库，对应旧的 `DB_PATH`
- `storage.imageUploadDir`: 当前公众号独立临时上传目录，对应旧的 `WECHAT_MCP_IMAGE_UPLOAD_DIR`

命令行参数优先级最高，其次是配置文件，最后是环境变量。也可以用 `WECHAT_MCP_CONFIG` 和 `WECHAT_MCP_ACCOUNT` 指定默认配置文件与 profile。

## 🔧 MCP 工具列表

### 1. 认证工具 (`wechat_auth`)

管理微信公众号认证配置和 Access Token。

**支持操作**:
- `configure`: 配置 AppID 和 AppSecret
- `get_token`: 获取当前 Access Token
- `refresh_token`: 刷新 Access Token
- `get_config`: 查看当前配置

### 2. 素材上传工具 (`wechat_media_upload`)

上传和管理微信公众号临时素材。

**支持操作**:
- `upload`: 上传素材（图片、语音、视频、缩略图）
- `get`: 获取素材信息
- `list`: 暂不支持（临时素材有效期 3 天，建议使用永久素材功能）

**支持格式**:
- 图片：JPG、PNG（大小不超过 10MB）
- 语音：MP3、WMA、WAV、AMR（大小不超过 10MB，时长不超过 60s）
- 视频：MP4（大小不超过 10MB）
- 缩略图：JPG（大小不超过 64KB）

### 3. 分片图片暂存工具 (`wechat_stage_image_upload`)

当 ChatGPT/远程 SSE 环境无法直接访问外部 HTTP 上传地址时，通过 MCP tool 调用链路分片上传本地图片到服务器临时目录。

**支持操作**:
- `start`: 创建分片上传会话，返回 `uploadId` 和推荐分片大小
- `append`: 按 `chunkIndex` 顺序追加一个 base64 分片
- `finish`: 合并、校验并保存图片，返回服务器 `filePath`
- `abort`: 取消会话并清理临时分片

**使用场景**:
- ChatGPT 执行 curl 返回 DNS 失败、Failed to connect、HTTP_STATUS:000
- 避免把完整图片 base64 一次性传给 `wechat_upload_img`
- 不需要暴露 `MCP_AUTH_TOKEN`，也不依赖额外 HTTP 上传网络

### 4. 图片上传准备工具 (`wechat_prepare_image_upload`)

远程 SSE 模式下上传本地图片前，生成短期一次性 `uploadUrl`。AI 应先调用本工具，再把本地图片以 multipart/form-data 上传到返回的地址。

**返回信息**:
- `uploadUrl`: 已包含一次性 `upload_token` 的上传地址
- `formField`: 固定为 `file`
- `expiresInSeconds`: 有效期，默认 300 秒
- `nextStep`: 上传成功后应调用的 MCP 工具与参数格式

**使用场景**:
- ChatGPT 等远程 MCP 客户端不能直接读取用户电脑本地路径
- 避免把图片转成超长 base64 导致参数截断
- 避免把长期 `MCP_AUTH_TOKEN` 暴露给 AI

### 5. 图文消息图片上传工具 (`wechat_upload_img`)

上传图文消息内所需的图片，不占用素材库限制。

**支持操作**:
- `upload`: 上传图片（支持文件路径或base64数据）

**支持格式**:
- 图片：JPG、PNG（大小不超过 1MB）

**特点**:
- 不占用公众号素材库的100000个图片限制
- 专用于图文消息内容中的图片
- 返回可直接在图文消息中使用的图片URL
- 远程 SSE 模式推荐先调用 `wechat_stage_image_upload` 分片暂存图片，再把 finish 响应里的 `filePath` 传给本工具，避免长 base64 被截断

### 6. 永久素材工具 (`wechat_permanent_media`)

管理微信公众号永久素材。

**支持操作**:
- `add`: 上传永久素材（图片、语音、视频、缩略图）
- `get`: 获取永久素材
- `delete`: 删除永久素材
- `list`: 获取素材列表
- `count`: 获取素材总数统计

### 7. 草稿管理工具 (`wechat_draft`)

管理微信公众号图文草稿。

**支持操作**:
- `add`: 新建草稿
- `get`: 获取草稿详情
- `delete`: 删除草稿
- `list`: 获取草稿列表
- `count`: 获取草稿总数

### 8. 发布工具 (`wechat_publish`)

管理微信公众号文章发布。

**支持操作**:
- `submit`: 发布草稿
- `get`: 获取发布状态
- `delete`: 删除发布
- `list`: 获取发布列表

### 9. 用户管理工具 (`wechat_user`)

管理微信公众号用户信息和数据统计。

**支持操作**:
- `get_user_list`: 获取用户列表（支持分页）
- `get_user_info`: 获取用户基本信息
- `batch_get_user_info`: 批量获取用户信息（最多100个）
- `set_remark`: 设置用户备注名
- `get_user_summary`: 获取用户增减数据
- `get_user_cumulate`: 获取累计用户数据

**使用场景**:
- 用户画像分析
- 用户增长追踪
- 用户信息管理

### 10. 标签管理工具 (`wechat_tag`)

管理用户标签，实现用户分组。

**支持操作**:
- `create`: 创建新标签
- `get_list`: 获取所有标签
- `update`: 编辑标签名称
- `delete`: 删除标签
- `batch_tagging`: 批量为用户打标签
- `batch_untagging`: 批量为用户取消标签
- `get_tag_users`: 获取标签下的用户列表

**使用场景**:
- 用户分组管理
- 精准营销
- 用户分层运营

### 11. 自定义菜单工具 (`wechat_menu`)

管理公众号底部菜单。

**支持操作**:
- `create`: 创建自定义菜单
- `get`: 查询当前菜单
- `delete`: 删除菜单
- `add_conditional`: 创建个性化菜单
- `delete_conditional`: 删除个性化菜单
- `get_selfmenu_info`: 获取菜单配置

**菜单类型**:
- click: 点击推事件
- view: 跳转URL
- scancode_push: 扫码推事件
- pic_photo_or_album: 拍照或相册发图
- location_select: 发送位置

**使用场景**:
- 功能导航
- 活动推广
- 自定义服务入口

### 12. 模板消息工具 (`wechat_template_msg`)

发送服务通知类模板消息。

**支持操作**:
- `send`: 发送模板消息
- `get_all_templates`: 获取所有模板
- `delete`: 删除模板
- `get_industry`: 获取账号所属行业

**使用场景**:
- 订单通知
- 支付成功通知
- 预约提醒
- 物流更新

**注意**: 模板消息需要先在微信公众平台后台配置模板。

### 13. 客服消息工具 (`wechat_customer_service`)

在用户动作后48小时内主动发送消息。

**支持操作**:
- `send_text`: 发送文本消息
- `send_image`: 发送图片消息
- `send_voice`: 发送语音消息
- `send_video`: 发送视频消息
- `send_music`: 发送音乐消息
- `send_news`: 发送图文消息
- `send_mpnews`: 发送永久图文素材
- `get_records`: 获取客服聊天记录

**使用场景**:
- 用户咨询回复
- 售后服务
- 主动关怀

**限制**: 只能在用户产生动作后48小时内发送。

### 14. 数据统计分析工具 (`wechat_statistics`)

获取公众号运营数据分析。

**支持操作**:
- `get_article_summary`: 图文群发每日数据
- `get_article_total`: 图文群发总数据
- `get_user_read`: 图文统计数据
- `get_user_share`: 图文分享转发数据
- `get_upstream_message`: 消息发送概况
- `get_interface_summary`: 接口分析数据
- `get_interface_summary_hour`: 接口分时数据

**数据维度**:
- 用户分析
- 图文分析
- 消息分析
- 接口分析

**使用场景**:
- 运营数据分析
- 内容效果评估
- 接口性能监控

### 15. 自动回复工具 (`wechat_auto_reply`)

查询自动回复规则配置。

**支持操作**:
- `get_current_info`: 获取当前自动回复规则

**包含信息**:
- 关注后自动回复
- 消息自动回复
- 关键词自动回复

**使用场景**:
- 查看当前配置
- 调试自动回复规则

### 16. 群发消息工具 (`wechat_mass_send`)

向用户群发消息。

**支持操作**:
- `send_by_tag`: 根据标签群发
- `send_by_openid`: 根据OpenID列表群发
- `delete`: 删除群发
- `preview`: 预览群发消息

**支持消息类型**:
- mpnews: 图文消息
- text: 文本消息
- voice: 语音消息
- image: 图片消息
- mpvideo: 视频消息
- wxcard: 卡券消息

**限制说明**:
- 订阅号：每天只能群发1条
- 服务号：每月可群发4条
- 群发给全部用户需要管理员二次确认

**使用场景**:
- 内容推送
- 活动通知
- 节日问候

### 17. 订阅通知工具 (`wechat_subscribe_msg`)

发送一次性订阅通知。

**支持操作**:
- `send`: 发送订阅通知

**特点**:
- 需要用户主动订阅
- 一次性推送
- 可包含小程序跳转

**使用场景**:
- 服务进度通知
- 预约成功通知
- 重要事件提醒

**注意**: 订阅通知是模板消息的升级版，需要用户授权。

## 📁 项目结构

```
src/
├── cli.ts               # CLI 入口文件
├── index.ts             # 模块导出入口
├── mcp-server/          # MCP 服务器实现
│   ├── shared/          # 共享组件
│   │   ├── init.ts      # 服务器初始化
│   │   └── types.ts     # 类型定义
│   └── transport/       # 传输层实现
│       ├── stdio.ts     # stdio 传输
│       └── sse.ts       # SSE 传输
├── mcp-tool/            # MCP 工具实现
│   ├── index.ts         # 工具管理器
│   ├── types.ts         # 类型定义
│   └── tools/           # 具体工具实现
│       ├── index.ts
│       ├── auth-tool.ts
│       ├── media-upload-tool.ts
│       ├── upload-img-tool.ts
│       ├── permanent-media-tool.ts
│       ├── draft-tool.ts
│       └── publish-tool.ts
├── auth/                # 认证管理
│   └── auth-manager.ts
├── wechat/              # 微信 API 客户端
│   └── api-client.ts
├── storage/             # 数据存储
│   └── storage-manager.ts
└── utils/               # 工具函数
    ├── logger.ts
    └── db-init.ts
```

## 🔗 在 AI 应用中使用

### Claude Desktop

在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "wechat-official-account": {
      "command": "npx",
      "args": [
        "wechat-official-account-mcp",
        "mcp",
        "-a", "your_wechat_app_id",
        "-s", "your_wechat_app_secret"
      ]
    }
  }
}
```

或者使用全局安装的版本：

```json
{
  "mcpServers": {
    "wechat-official-account": {
      "command": "wechat-mcp",
      "args": [
        "mcp",
        "-a", "your_wechat_app_id",
        "-s", "your_wechat_app_secret"
      ]
    }
  }
}
```

### Cursor / Trae AI

在 MCP 配置中添加服务器配置：

```json
{
  "mcpServers": {
    "wechat-official-account": {
      "command": "npx",
      "args": [
        "wechat-official-account-mcp",
        "mcp",
        "-a", "your_wechat_app_id",
        "-s", "your_wechat_app_secret"
      ]
    }
  }
}
```

或者使用全局安装的版本：

```json
{
  "mcpServers": {
    "wechat-official-account": {
      "command": "wechat-mcp",
      "args": [
        "mcp",
        "-a", "your_wechat_app_id",
        "-s", "your_wechat_app_secret"
      ]
    }
  }
}
```



## 🧪 开发指南

### 开发模式

```bash
# 安装依赖
npm install

# 构建项目
npm run build

# 本地测试 CLI
node dist/src/cli.js mcp -a test_app_id -s test_app_secret

# 类型检查
npm run check

# 代码检查
npm run lint
```

### 构建和发布

```bash
# 构建项目
npm run build

# 本地测试包
npm pack

# 发布到 npm
npm publish
```

### 测试

```bash
# 运行测试
npm test

# 测试 CLI 功能
node dist/src/cli.js --help
```

## 📝 配置说明

### 环境变量

创建 `.env` 文件：

```env
# 开发模式（可选）
NODE_ENV=development

# 调试模式（可选）
DEBUG=true

# 跨域来源白名单（强烈建议生产环境设置）
CORS_ORIGIN=https://your-domain.com,https://another-domain.com

# 开启敏感字段加密（设置后启用 AES 加密存储）
WECHAT_MCP_SECRET_KEY=your-strong-secret-key

# 数据库路径（可选，默认为 ./data/wechat-mcp.db）
DB_PATH=./data/wechat-mcp.db
```

### 微信公众号配置

1. 登录微信公众平台
2. 进入「开发」->「基本配置」
3. 获取 AppID 和 AppSecret
4. 使用 `wechat_auth` 工具进行配置

## 🔒 安全说明

- 加密存储：设置 `WECHAT_MCP_SECRET_KEY` 后，`app_secret/token/encoding_aes_key/access_token` 以加密形式持久化（带 `enc:` 前缀标识）
- 日志脱敏：错误日志仅记录状态码或消息，避免泄露响应体与敏感信息
- 跨域白名单：生产环境务必设置 `CORS_ORIGIN` 为精确域名列表，避免 `*`
- 参数校验：工具参数使用 Zod 校验，降低不当输入风险
- 切勿提交密钥：不要将 AppSecret、Token 等放入代码仓库或构建产物

## 🤝 贡献指南

1. Fork 本项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 📄 许可证

本项目采用 MIT 许可证。详见 [LICENSE](LICENSE) 文件。

## 🆘 支持

如果您遇到问题或有建议，请：

1. 查看 [Issues](https://github.com/xwang152-jack/wechat-official-account-mcp/issues) 页面
2. 创建新的 Issue
3. 联系项目维护者: xwang152-jack <xwang152@163.com>

## 🙏 致谢

- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP 协议标准
- [微信公众平台](https://mp.weixin.qq.com/) - 微信公众号 API
- [Anthropic](https://www.anthropic.com/) - Claude Desktop MCP 支持

---

**注意**: 本项目仅供学习和开发使用，请遵守微信公众平台的使用条款和相关法律法规。
