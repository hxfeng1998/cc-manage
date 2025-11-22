# CC Manage VS Code Extension

<p align="center">
  <img src="media/sidebar/icon.png" alt="CC Manage Logo" width="128" height="128">
</p>

<p align="center">
  <strong>一个用于在 VS Code 内统一管理 Claude/Codex 等 API 配置的侧边栏扩展</strong>
</p>

<p align="center">
  <a href="#功能概览">功能</a> •
  <a href="#安装">安装</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#使用说明">使用</a> •
  <a href="#开发">开发</a>
</p>

---

## 功能概览

✨ **核心功能**

- 🔧 **配置管理**：在侧边栏新增、保存任意数量的 Claude/Codex 配置
- 🔄 **一键切换**：快速切换不同的 API 配置，自动同步到 `~/.claude` 或 `~/.codex`
- 💰 **余额监控**：显示余额/用量，支持手动刷新
- 💾 **数据持久化**：所有配置保存在 `~/.cc-manage/configs.json`，卸载扩展也不会丢失
- ✏️ **配置编辑**：任何配置都可通过卡片上的"编辑"按钮重新修改
- 🏷️ **供应商聚合**：一个卡片同时管理同一提供商的 Claude 与 Codex 接口
- 📦 **内置模板**：首次初始化会自动写入 6 套默认配置（foxcode, DuckCoding, 88Code, IKunCode, PackyCode, Privnode）

## 安装

### 方式 1: 从 VSIX 安装（推荐）

1. 从 [Releases](https://github.com/hxfeng1998/cc-manage/releases) 下载最新的 `.vsix` 文件
2. 在 VS Code 中打开命令面板 (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. 输入 `Extensions: Install from VSIX...`
4. 选择下载的 `.vsix` 文件

### 方式 2: 从源码构建

```bash
git clone https://github.com/hxfeng1998/cc-manage.git
cd cc-manage
npm install
npm run compile
# 在 VS Code 中按 F5 启动调试
```

## 快速开始

1. 安装扩展后，在活动栏找到 **CC Manage** 图标
2. 点击打开侧边栏"控制面板"
3. 点击「新增配置」按钮，填写配置信息：
   - 配置名称
   - 官网链接（可选）
   - 查询接口配置（可选，用于余额查询）
   - Claude/Codex 配置（至少填写一个）
4. 保存后，点击「启用」按钮启用配置

## 使用说明

### 添加配置

1. 点击右上角「新增配置」按钮
2. 填写表单：
   - **名称**：自定义名称，不可重复
   - **官网链接**：供应商官网/控制台地址（可选）
   - **查询配置**：余额查询接口 URL 和 参数（可选）
   - **Claude 配置**：可以直接编辑 `settings.json` 或填写 Base URL + API Key
   - **Codex 配置**：可以直接编辑 `auth.json` 和 `config.toml`，或填写 Base URL + API Key
3. 点击"保存配置"

**配置预览**：表单下方会实时显示将要写入的配置文件内容

### 编辑配置

- 点击卡片上的"编辑"按钮
- 修改后保存，若该配置正处于启用状态，会立即同步

### 删除配置

- 点击卡片上的"删除"按钮并确认即可移除

### 切换配置

每个卡片提供「设为当前」按钮（Claude/Codex 各一），点击后会写入：

- **Claude**: `~/.claude/settings.json`
- **Codex**: `~/.codex/config.toml` + `~/.codex/auth.json`

### 余额查询

- 点击顶部"刷新"可手动刷新（间隔至少 5 秒）
- 显示已使用、总额信息
- 自定义配置仅支持`new api`类型

## 配置文件结构

### 内部存储

```
~/.cc-manage/configs.json
```

包含所有配置

### 外部配置

**Claude**:

```json
// ~/.claude/settings.json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-xxx",
    "ANTHROPIC_BASE_URL": "https://api.example.com"
  }
}
```

**Codex**:

```toml
# ~/.codex/config.toml
model_provider = "custom"
model = "gpt-5.1-codex"
model_reasoning_effort = "high"

[model_providers.custom]
name = "custom"
base_url = "https://api.example.com/v1"
wire_api = "responses"
requires_openai_auth = true
```

```json
// ~/.codex/auth.json
{
  "OPENAI_API_KEY": "sk-xxx"
}
```

## 开发

### 构建命令

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run compile

# 持续编译（watch 模式）
npm run watch

# 运行测试
npm test

# 运行单元测试
npm run test:unit

# 代码检查
npm run lint

# 完整检查（编译 + lint）
npm run check

# 预发布打包
npm run vscode:prepublish
```

### 目录结构

```
cc-manage/
├── src/
│   ├── extension.ts          # 入口文件
│   ├── services/
│   │   └── ConfigManager.ts  # 配置管理服务
│   ├── sidebar/
│   │   └── SidebarProvider.ts # 侧边栏视图
│   ├── config/
│   │   └── defaultConfigs.json # 默认配置模板
│   └── test/                 # 测试文件
├── media/
│   └── sidebar/
│       ├── main.js          # 前端逻辑
│       ├── styles.css       # 样式
│       └── icon.svg         # 图标
└── package.json
```

## 技术栈

- **TypeScript** - 类型安全的 JavaScript
- **VS Code Extension API** - 扩展开发框架
- **Mocha** - 单元测试框架

## 许可证

[MIT](LICENSE) © feng98

## 相关链接

- [问题反馈](https://github.com/hxfeng1998/cc-manage/issues)
- [更新日志](CHANGELOG.md)
