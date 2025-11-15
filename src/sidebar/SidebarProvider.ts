import * as vscode from "vscode"
import { ConfigManager } from "../services/ConfigManager"

type EndpointPayload = {
  apiKey: string
  baseUrl: string
}

type ConfigFormPayload = {
  name: string
  website?: string
  status?: {
    url?: string
    authorization?: string
    userId?: string
    cookie?: string
  }
  claude?: EndpointPayload
  codex?: EndpointPayload
  claudeSettings?: string // 用户自定义的完整 settings.json
  codexAuth?: string // 用户自定义的完整 auth.json
  codexConfig?: string // 用户自定义的完整 config.toml
}

type IncomingMessage =
  | { type: "ready" }
  | { type: "getTemplates" }
  | {
      type: "addConfig"
      payload: ConfigFormPayload
    }
  | {
      type: "setActive"
      payload: { id: string; providerType: "claude" | "codex" }
    }
  | { type: "refreshStatus"; payload: { id: string } }
  | { type: "refreshAll" }
  | { type: "requestConfig"; payload: { id: string } }
  | { type: "updateConfig"; payload: ConfigFormPayload & { id: string } }
  | { type: "deleteConfig"; payload: { id: string } }
  | { type: "openWebsite"; payload: { id: string } }

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "ccManage.sidebar"

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configManager: ConfigManager
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media", "sidebar")
      ]
    }

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview)

    webviewView.webview.onDidReceiveMessage((message: IncomingMessage) => {
      void this.handleMessage(webviewView, message)
    })

    // 监听面板可见性变化
    webviewView.onDidChangeVisibility(() => {
      webviewView.webview.postMessage({
        type: "visibilityChange",
        payload: { visible: webviewView.visible }
      })
    })
  }

  private async handleMessage(
    webviewView: vscode.WebviewView,
    message: IncomingMessage
  ) {
    try {
      switch (message.type) {
        case "ready":
          await this.postState(webviewView)
          break
        case "getTemplates":
          await this.postTemplates(webviewView)
          break
        case "addConfig": {
          const newConfig = this.transformPayload(message.payload)
          await this.configManager.addConfig(newConfig)
          vscode.window.showInformationMessage("已保存新配置")
          // 如果配置了查询接口，自动查询一次状态
          if (newConfig.status?.url) {
            // 获取新增的配置 ID（最后一个）
            const configs = this.configManager.getSafeConfigs()
            const addedConfig = configs.find((c) => c.name === newConfig.name)
            if (addedConfig) {
              await this.configManager.refreshStatus(addedConfig.id)
            }
          }
          await this.postState(webviewView)
          break
        }
        case "setActive": {
          await this.configManager.setActiveConfig(
            message.payload.id,
            message.payload.providerType
          )
          // 立即更新 UI，让用户看到"已启用"状态
          await this.postState(webviewView)

          const action = await vscode.window.showInformationMessage(
            "已切换当前配置",
            "重新加载窗口"
          )
          if (action === "重新加载窗口") {
            await vscode.commands.executeCommand(
              "workbench.action.reloadWindow"
            )
          }
          break
        }
        case "refreshStatus":
          await this.configManager.refreshStatus(message.payload.id)
          await this.postState(webviewView)
          break
        case "refreshAll":
          await this.configManager.refreshAll()
          await this.postState(webviewView)
          break
        case "requestConfig":
          await this.postConfigDetail(webviewView, message.payload.id)
          break
        case "updateConfig": {
          const updatedPayload = this.transformPayload(message.payload)
          // 获取旧配置，检查状态配置是否变化
          const oldConfig = this.configManager.getConfigDetail(message.payload.id)
          const statusConfigChanged =
            oldConfig &&
            (oldConfig.status?.url !== updatedPayload.status?.url ||
              oldConfig.status?.authorization !==
                updatedPayload.status?.authorization ||
              oldConfig.status?.userId !== updatedPayload.status?.userId ||
              oldConfig.status?.cookie !== updatedPayload.status?.cookie)

          const needsReload = await this.configManager.updateConfig({
            ...updatedPayload,
            id: message.payload.id
          })

          // 如果状态配置变化了，自动刷新状态
          if (statusConfigChanged && updatedPayload.status?.url) {
            await this.configManager.refreshStatus(message.payload.id)
          }

          if (needsReload) {
            const action = await vscode.window.showInformationMessage(
              "配置已更新，建议重新加载窗口以使更改生效",
              "重新加载窗口",
              "稍后"
            )
            if (action === "重新加载窗口") {
              await vscode.commands.executeCommand(
                "workbench.action.reloadWindow"
              )
            }
          } else {
            vscode.window.showInformationMessage("配置已更新")
          }
          await this.postState(webviewView)
          break
        }
        case "deleteConfig":
          await this.handleDeleteConfig(webviewView, message.payload.id)
          break
        case "openWebsite":
          await this.handleOpenWebsite(message.payload.id)
          break
        default:
          break
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      vscode.window.showErrorMessage(`CC Manage: ${messageText}`)
    }
  }

  private async postState(webviewView: vscode.WebviewView) {
    const configs = this.configManager.getSafeConfigs()
    webviewView.webview.postMessage({
      type: "state",
      payload: configs
    })
  }

  private async postTemplates(webviewView: vscode.WebviewView) {
    const templates = this.configManager.getTemplates()
    webviewView.webview.postMessage({
      type: "templates",
      payload: templates
    })
  }

  private transformPayload(payload: ConfigFormPayload): {
    name: string
    website?: string
    status?: {
      url?: string
      authorization?: string
      userId?: string
      cookie?: string
    }
    claude?: { settingsJson: string }
    codex?: { authJson: string; configToml: string }
  } {
    const result: {
      name: string
      website?: string
      status?: {
        url?: string
        authorization?: string
        userId?: string
        cookie?: string
      }
      claude?: { settingsJson: string }
      codex?: { authJson: string; configToml: string }
    } = {
      name: payload.name,
      website: payload.website,
      status: payload.status
    }

    // 如果有自定义的完整配置，使用自定义配置
    if (payload.claudeSettings) {
      result.claude = { settingsJson: payload.claudeSettings }
    } else if (payload.claude) {
      // 否则从 apiKey/baseUrl 生成默认配置
      const settingsJson = JSON.stringify(
        {
          env: {
            ANTHROPIC_AUTH_TOKEN: payload.claude.apiKey,
            ANTHROPIC_BASE_URL: payload.claude.baseUrl
          }
        },
        null,
        2
      )
      result.claude = { settingsJson }
    }

    // 处理 Codex 配置
    if (payload.codexAuth && payload.codexConfig) {
      // 用户提供了完整的自定义配置
      result.codex = {
        authJson: payload.codexAuth,
        configToml: payload.codexConfig
      }
    } else if (payload.codexAuth && payload.codex) {
      // 用户提供了 auth 和 baseUrl，但 codexConfig 为空
      // 生成基本配置（base_url 在主配置段，向后兼容）
      const configToml = `base_url = "${payload.codex.baseUrl}"`
      result.codex = {
        authJson: payload.codexAuth,
        configToml
      }
    } else if (payload.codex) {
      // 只有 codex endpoint，生成默认配置
      const authJson = JSON.stringify(
        {
          OPENAI_API_KEY: payload.codex.apiKey
        },
        null,
        2
      )
      const configToml = `base_url = "${payload.codex.baseUrl}"`
      result.codex = {
        authJson,
        configToml
      }
    }

    return result
  }

  private async postConfigDetail(webviewView: vscode.WebviewView, id: string) {
    const config = this.configManager.getConfigDetail(id)
    if (!config) {
      throw new Error("配置不存在")
    }

    // 将后端的 ClaudeConfig/CodexConfig 格式转换为前端期望的格式
    const frontendPayload: {
      id: string
      name: string
      website?: string
      status?: { token?: string; url?: string }
      claude?: { baseUrl: string; apiKey: string }
      codex?: { baseUrl: string; apiKey: string }
      claudeSettings?: string
      codexAuth?: string
      codexConfig?: string
    } = {
      id: config.id,
      name: config.name,
      website: config.website,
      status: config.status
    }

    // 解析 Claude 配置
    if (config.claude) {
      frontendPayload.claudeSettings = config.claude.settingsJson
      try {
        const parsed = JSON.parse(config.claude.settingsJson)
        const baseUrl = parsed.env?.ANTHROPIC_BASE_URL
        const apiKey = parsed.env?.ANTHROPIC_AUTH_TOKEN
        if (baseUrl && apiKey) {
          frontendPayload.claude = { baseUrl, apiKey }
        }
      } catch {
        // ignore parse error
      }
    }

    // 解析 Codex 配置
    if (config.codex) {
      frontendPayload.codexAuth = config.codex.authJson

      // 从 config.toml 中提取 base_url（优先从 [model_providers.xxx] 部分提取）
      const baseUrl = this.extractCodexBaseUrl(config.codex.configToml)
      const customToml = this.extractCustomToml(config.codex.configToml)

      frontendPayload.codexConfig = customToml

      try {
        const authParsed = JSON.parse(config.codex.authJson)
        const apiKey = authParsed.OPENAI_API_KEY
        if (apiKey && baseUrl) {
          frontendPayload.codex = { baseUrl, apiKey }
        }
      } catch {
        // ignore parse error
      }
    }

    webviewView.webview.postMessage({
      type: "configDetail",
      payload: frontendPayload
    })
  }

  private async handleDeleteConfig(
    webviewView: vscode.WebviewView,
    id: string
  ) {
    const config = this.configManager.getConfigDetail(id)
    if (!config) {
      throw new Error("配置不存在")
    }

    const selection = await vscode.window.showWarningMessage(
      `确定要删除配置 "${config.name}" 吗？此操作仅移除扩展内部存储。`,
      { modal: true },
      "删除"
    )

    if (selection !== "删除") {
      return
    }

    await this.configManager.deleteConfig(id)
    vscode.window.showInformationMessage("配置已删除")
    await this.postState(webviewView)
  }

  private async handleOpenWebsite(id: string) {
    const config = this.configManager.getConfigDetail(id)
    if (!config?.website) {
      vscode.window.showWarningMessage("当前配置未设置官网链接")
      return
    }

    try {
      await vscode.env.openExternal(vscode.Uri.parse(config.website))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      vscode.window.showErrorMessage(`无法打开官网：${message}`)
    }
  }

  /**
   * 从 config.toml 中提取 base_url（优先从 [model_providers.xxx] 部分提取）
   */
  private extractCodexBaseUrl(configToml: string): string | undefined {
    // 优先从 [model_providers.xxx] 部分提取 base_url
    const providerMatch = configToml.match(/^\s*model_provider\s*=\s*"([^"]+)"/m)
    if (providerMatch) {
      const providerName = providerMatch[1]
      const sectionRegex = new RegExp(
        `\\[model_providers\\.${providerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][\\s\\S]*?base_url\\s*=\\s*"([^"]+)"`,
        "i"
      )
      const sectionMatch = configToml.match(sectionRegex)
      if (sectionMatch) {
        return sectionMatch[1]
      }
    }

    // 如果没找到，尝试从主配置段提取 base_url（向后兼容）
    const mainBaseUrlMatch = configToml.match(/^base_url\s*=\s*"([^"]+)"/m)
    return mainBaseUrlMatch?.[1]
  }

  /**
   * 提取自定义 TOML 配置（移除 [model_providers.xxx] 中的 base_url）
   */
  private extractCustomToml(configToml: string): string {
    const providerMatch = configToml.match(/^\s*model_provider\s*=\s*"([^"]+)"/m)
    if (!providerMatch) {
      return configToml
    }

    const providerName = providerMatch[1]
    const sectionRegex = new RegExp(
      `\\[model_providers\\.${providerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`,
      "i"
    )

    const lines = configToml.split("\n")
    const result: string[] = []
    let inProviderSection = false

    for (const line of lines) {
      // 检测进入 [model_providers.xxx] 部分
      if (sectionRegex.test(line)) {
        inProviderSection = true
        result.push(line)
        continue
      }

      // 检测离开当前部分
      if (inProviderSection && /^\s*\[/.test(line)) {
        inProviderSection = false
      }

      // 跳过 [model_providers.xxx] 部分中的 base_url
      if (inProviderSection && /^\s*base_url\s*=/.test(line)) {
        continue
      }

      result.push(line)
    }

    return result.join("\n").trim()
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "sidebar",
        "main.js"
      )
    )
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "sidebar",
        "styles.css"
      )
    )
    const nonce = this.getNonce()

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <link rel="stylesheet" href="${stylesUri}" />
    <title>CC Manage</title>
  </head>
  <body>
    <section class="toolbar">
      <div class="toolbar-row">
        <h2>CC Manage 配置面板</h2>
        <div class="actions">
          <button id="refresh-all" class="primary" type="button">刷新</button>
          <button id="toggle-form" class="secondary" type="button">新增配置</button>
        </div>
      </div>
      <p id="toolbar-status" class="hint toolbar-hint">5 分钟自动刷新，可随时手动更新</p>
      <div id="toast" role="status" aria-live="polite"></div>
    </section>
    <section id="config-section" class="config-section">
      <h3>当前配置</h3>
      <ul id="config-list" class="config-list" aria-live="polite"></ul>
    </section>
    <section id="form-section" class="form-section hidden" aria-hidden="true">
      <h3 id="form-title">新增配置</h3>
      <form id="config-form" class="config-form">
        <input type="hidden" name="configId" />
        <label>
          选择模板（可选）
          <select id="template-selector" name="template">
            <option value="">自定义</option>
          </select>
          <span class="hint">选择预设模板快速填充配置，或选择"自定义"手动填写</span>
        </label>
        <label>
          名称
          <input name="name" type="text" required placeholder="例如：Claude 测试" />
        </label>
        <label>
          官网链接
          <input name="website" type="url" placeholder="https://provider.example.com" />
        </label>
        <div class="status-group">
          <label>
            查询接口 URL（自定义时仅支持new api类型）
            <input
              name="statusUrl"
              type="url"
              placeholder="https://api.example.com/account/usage"
            />
          </label>
          <label>
            Authorization（可选）
            <input name="statusAuthorization" type="password" placeholder="Bearer xxx..." />
          </label>
          <label>
            User ID（可选）
            <input name="statusUserId" type="text" placeholder="用户 ID，如：123" />
          </label>
          <label>
            Cookie（可选）
            <input name="statusCookie" type="password" placeholder="session=xxx; ..." />
          </label>
        </div>
        <div class="endpoint-grid">
          <fieldset class="endpoint-section">
            <legend>Claude</legend>
            <label>
              Base URL
              <input name="claudeBaseUrl" type="url" placeholder="https://claude.example.com" />
            </label>
            <label>
              API Key
              <input name="claudeApiKey" type="password" placeholder="sk-claude..." />
            </label>
            <div class="config-preview">
              <h4>.claude/settings.json</h4>
              <textarea id="claude-preview" class="preview-block" rows="4" spellcheck="false"></textarea>
            </div>
          </fieldset>
          <fieldset class="endpoint-section">
            <legend>Codex</legend>
            <label>
              Base URL
              <input name="codexBaseUrl" type="url" placeholder="https://codex.example.com/v1" />
            </label>
            <label>
              API Key
              <input name="codexApiKey" type="password" placeholder="sk-codex..." />
            </label>
            <div class="config-preview">
              <h4>.codex/auth.json</h4>
              <textarea id="codex-auth-preview" class="preview-block" rows="3" spellcheck="false"></textarea>
              <h4>.codex/config.toml</h4>
              <label class="base-url-display">
                <input id="codex-config-base" type="text" readonly />
              </label>
              <textarea id="codex-toml-preview" class="preview-block" rows="5" spellcheck="false"></textarea>
            </div>
          </fieldset>
        </div>
        <div class="form-actions">
          <button id="form-submit" class="primary" type="submit">保存配置</button>
          <button id="cancel-form" class="secondary" type="button">取消</button>
        </div>
      </form>
    </section>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`
  }

  private getNonce(): string {
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    let text = ""
    for (let i = 0; i < 16; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length))
    }
    return text
  }
}
