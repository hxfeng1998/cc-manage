import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import defaultConfigsFile from '../config/defaultConfigs.json';

export type ProviderType = 'claude' | 'codex';

export interface ProviderStatus {
  fetchedAt: number;
  ok: boolean;
  balance?: string;
  usage?: string;
  total?: string;
  quotaPerUnit?: number;
  message?: string;
  rawText?: string;
}

export interface ProviderStatusConfig {
  url?: string;
  authorization?: string;
  userId?: string;
  cookie?: string;
}

// 完整的 Claude 配置（存储 settings.json 的完整内容）
export interface ClaudeConfig {
  settingsJson: string;
}

// 完整的 Codex 配置
export interface CodexConfig {
  authJson: string;
  configToml: string; // 包含完整的 config.toml 内容（包括 base_url）
}

// 配置详情（供编辑使用）
export interface ConfigDetail {
  id: string;
  name: string;
  website?: string;
  status?: ProviderStatusConfig;
  claude?: ClaudeConfig;
  codex?: CodexConfig;
}

// 持久化的配置结构
interface ProviderConfig {
  id: string;
  name: string;
  website?: string;
  status?: ProviderStatusConfig;
  claude?: ClaudeConfig;
  codex?: CodexConfig;
}

// 安全的配置摘要（不包含敏感信息）
export interface SafeProviderConfig {
  id: string;
  name: string;
  website?: string;
  claude?: SafeEndpointSummary;
  codex?: SafeEndpointSummary;
  hasStatusConfig: boolean;
  lastStatus?: ProviderStatus;
}

interface SafeEndpointSummary {
  baseUrl: string;
  hasCredentials: boolean;
  isActive: boolean;
}

interface StoredData {
  version: number;
  configs: ProviderConfig[];
}

// 前端传入的配置输入（兼容旧格式）
interface ProviderConfigInput {
  name: string;
  website?: string;
  status?: ProviderStatusConfig;
  claude?: ClaudeConfig;
  codex?: CodexConfig;
}

interface DefaultConfigFile {
  providers?: ProviderConfigInput[];
}

const DEFAULT_CONFIGS = (defaultConfigsFile as DefaultConfigFile).providers ?? [];
const FILE_VERSION = 1;

export class ConfigManager {
  private readonly baseDir: string;
  private readonly configFile: string;
  private readonly homeDir: string;
  private data: StoredData = { version: FILE_VERSION, configs: [] };

  // 运行时缓存
  private statusCache = new Map<string, ProviderStatus>();
  private activeClaudeId?: string;
  private activeCodexId?: string;

  constructor(homeDir?: string) {
    this.homeDir = homeDir ?? os.homedir();
    this.baseDir = path.join(this.homeDir, '.cc-manage');
    this.configFile = path.join(this.baseDir, 'configs.json');
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.baseDir, { recursive: true });
    await this.load();
    // 检测当前激活的配置
    await this.detectActiveConfigs();
    // Auto-query status after loading configs
    await this.refreshAll();
  }

  getTemplates(): ProviderConfigInput[] {
    return DEFAULT_CONFIGS;
  }

  getSafeConfigs(): SafeProviderConfig[] {
    return this.data.configs.map((config) => {
      const claudeEndpoint = config.claude ? this.parseClaudeConfig(config.claude) : undefined;
      const codexEndpoint = config.codex ? this.parseCodexConfig(config.codex) : undefined;

      return {
        id: config.id,
        name: config.name,
        website: config.website,
        claude: claudeEndpoint
          ? {
              baseUrl: claudeEndpoint.baseUrl,
              hasCredentials: Boolean(claudeEndpoint.apiKey),
              isActive: config.id === this.activeClaudeId,
            }
          : undefined,
        codex: codexEndpoint
          ? {
              baseUrl: codexEndpoint.baseUrl,
              hasCredentials: Boolean(codexEndpoint.apiKey),
              isActive: config.id === this.activeCodexId,
            }
          : undefined,
        hasStatusConfig: Boolean(config.status?.url),
        lastStatus: this.statusCache.get(config.id),
      };
    });
  }

  getConfigDetail(id: string): ConfigDetail | undefined {
    const config = this.data.configs.find((item) => item.id === id);
    if (!config) {
      return undefined;
    }

    return {
      id: config.id,
      name: config.name,
      website: config.website,
      status: config.status,
      claude: config.claude,
      codex: config.codex,
    };
  }

  async addConfig(input: ProviderConfigInput): Promise<void> {
    const payload = this.normalizeInput(input);
    this.ensureUniqueName(payload.name);
    const newId = randomUUID();

    this.data.configs.push({
      id: newId,
      ...payload,
    });

    await this.persist();

    // 添加后检测是否与当前激活配置匹配
    await this.detectActiveConfigForId(newId);
  }

  async updateConfig(input: ProviderConfigInput & { id: string }): Promise<boolean> {
    const target = this.data.configs.find((item) => item.id === input.id);
    if (!target) {
      throw new Error('配置不存在');
    }

    const payload = this.normalizeInput(input);
    this.ensureUniqueName(payload.name, target.id);

    // 检查是否修改了当前启用配置的关键内容
    let needsReload = false;

    // 检查 Claude 配置变化
    if (this.activeClaudeId === target.id && target.claude && payload.claude) {
      if (target.claude.settingsJson !== payload.claude.settingsJson) {
        needsReload = true;
      }
    }

    // 检查 Codex 配置变化
    if (this.activeCodexId === target.id && target.codex && payload.codex) {
      if (
        target.codex.authJson !== payload.codex.authJson ||
        target.codex.configToml !== payload.codex.configToml
      ) {
        needsReload = true;
      }
    }

    Object.assign(target, payload);
    await this.persist();

    if (this.activeClaudeId === target.id && !target.claude) {
      this.activeClaudeId = undefined;
    }

    if (this.activeCodexId === target.id && !target.codex) {
      this.activeCodexId = undefined;
    }

    // 如果修改的是当前启用的配置，立即同步到配置文件
    if (needsReload) {
      if (this.activeClaudeId === target.id && target.claude) {
        await this.writeClaudeConfig(target.claude);
      }
      if (this.activeCodexId === target.id && target.codex) {
        await this.writeCodexConfig(target.codex);
      }
    }

    // 更新后重新检测是否与当前激活配置匹配
    await this.detectActiveConfigForId(target.id);

    return needsReload;
  }

  async deleteConfig(id: string): Promise<void> {
    const exists = this.data.configs.some((item) => item.id === id);
    if (!exists) {
      throw new Error('配置不存在');
    }

    this.data.configs = this.data.configs.filter((item) => item.id !== id);
    this.statusCache.delete(id);

    if (this.activeClaudeId === id) {
      this.activeClaudeId = undefined;
    }

    if (this.activeCodexId === id) {
      this.activeCodexId = undefined;
    }

    await this.persist();
  }

  async setActiveConfig(providerId: string, type: ProviderType): Promise<void> {
    const config = this.data.configs.find((item) => item.id === providerId);
    if (!config) {
      throw new Error('配置不存在');
    }

    if (type === 'claude') {
      if (!config.claude) {
        throw new Error('该提供商未配置 Claude 接口');
      }
      if (this.activeClaudeId === providerId) {
        return;
      }
      this.activeClaudeId = providerId;
      await this.writeClaudeConfig(config.claude);
    } else {
      if (!config.codex) {
        throw new Error('该提供商未配置 Codex 接口');
      }
      if (this.activeCodexId === providerId) {
        return;
      }
      this.activeCodexId = providerId;
      await this.writeCodexConfig(config.codex);
    }
  }

  async refreshStatus(providerId: string): Promise<ProviderStatus> {
    const config = this.data.configs.find((item) => item.id === providerId);
    if (!config) {
      throw new Error('配置不存在');
    }

    const status = await this.fetchStatus(config);
    this.statusCache.set(providerId, status);
    return status;
  }

  async refreshAll(): Promise<void> {
    for (const config of this.data.configs) {
      await this.refreshStatus(config.id);
    }
  }

  // ========== 私有方法 ==========

  private async load(): Promise<void> {
    try {
      const buffer = await fs.promises.readFile(this.configFile, 'utf8');
      const parsed = JSON.parse(buffer) as StoredData;
      if (Array.isArray(parsed.configs)) {
        this.data = {
          version: FILE_VERSION,
          configs: parsed.configs,
        };
      }
    } catch (error) {
      // ignore missing file
    }
  }

  private async persist(): Promise<void> {
    await fs.promises.writeFile(this.configFile, JSON.stringify(this.data, null, 2), 'utf8');
  }

  private normalizeInput(input: ProviderConfigInput): Omit<ProviderConfig, 'id'> {
    const name = input.name?.trim();
    if (!name) {
      throw new Error('配置名称不能为空');
    }

    const website = input.website?.trim();

    // 验证 Claude 配置
    let claude: ClaudeConfig | undefined;
    if (input.claude) {
      if (!input.claude.settingsJson?.trim()) {
        throw new Error('Claude settings.json 内容不能为空');
      }
      // 验证 JSON 格式并提取必要字段
      try {
        const parsed = JSON.parse(input.claude.settingsJson);
        const token = parsed.env?.ANTHROPIC_AUTH_TOKEN;
        const baseUrl = parsed.env?.ANTHROPIC_BASE_URL;
        if (!token || !baseUrl) {
          throw new Error('Claude settings.json 必须包含 ANTHROPIC_AUTH_TOKEN 和 ANTHROPIC_BASE_URL');
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error('Claude settings.json 格式错误');
        }
        throw error;
      }
      claude = { settingsJson: input.claude.settingsJson.trim() };
    }

    // 验证 Codex 配置
    let codex: CodexConfig | undefined;
    if (input.codex) {
      if (!input.codex.authJson?.trim() || !input.codex.configToml?.trim()) {
        throw new Error('Codex auth.json 和 config.toml 内容都不能为空');
      }
      // 验证 auth.json
      try {
        const parsed = JSON.parse(input.codex.authJson);
        if (!parsed.OPENAI_API_KEY) {
          throw new Error('Codex auth.json 必须包含 OPENAI_API_KEY');
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error('Codex auth.json 格式错误');
        }
        throw error;
      }
      // 验证 config.toml 包含 base_url（可以在主配置段或 [model_providers.xxx] 部分）
      const tomlContent = input.codex.configToml.trim();
      const baseUrl = this.extractCodexBaseUrl(tomlContent);
      if (!baseUrl) {
        throw new Error('Codex config.toml 必须包含 base_url（可以在主配置段或 [model_providers.xxx] 部分）');
      }
      codex = {
        authJson: input.codex.authJson.trim(),
        configToml: tomlContent,
      };
    }

    if (!claude && !codex) {
      throw new Error('至少需要配置一个接口（Claude 或 Codex）');
    }

    const status = this.normalizeStatusBlock(input.status);

    return {
      name,
      website,
      status,
      claude,
      codex,
    };
  }

  private normalizeStatusBlock(status?: ProviderStatusConfig): ProviderStatusConfig | undefined {
    const url = status?.url?.trim();
    const authorization = status?.authorization?.trim();
    const userId = status?.userId?.trim();
    const cookie = status?.cookie?.trim();

    if (!url && !authorization && !userId && !cookie) {
      return undefined;
    }

    return {
      url: url || undefined,
      authorization: authorization || undefined,
      userId: userId || undefined,
      cookie: cookie || undefined,
    };
  }

  private ensureUniqueName(name: string, ignoreId?: string): void {
    const exists = this.data.configs.some((item) => item.name === name && item.id !== ignoreId);
    if (exists) {
      throw new Error(`名称 "${name}" 已存在，请使用其他名称`);
    }
  }

  // 检测当前激活的配置（从文件系统读取）
  private async detectActiveConfigs(): Promise<void> {
    // 检测 Claude 激活配置
    try {
      const claudeSettingsPath = path.join(this.homeDir, '.claude', 'settings.json');
      const claudeContent = await fs.promises.readFile(claudeSettingsPath, 'utf8');
      const claudeParsed = JSON.parse(claudeContent);
      const claudeBaseUrl = claudeParsed.env?.ANTHROPIC_BASE_URL;
      const claudeApiKey = claudeParsed.env?.ANTHROPIC_AUTH_TOKEN;

      if (claudeBaseUrl && claudeApiKey) {
        // 查找匹配的配置
        for (const config of this.data.configs) {
          if (config.claude) {
            const parsed = this.parseClaudeConfig(config.claude);
            if (parsed && parsed.baseUrl === claudeBaseUrl && parsed.apiKey === claudeApiKey) {
              this.activeClaudeId = config.id;
              break;
            }
          }
        }
      }
    } catch {
      // 文件不存在或解析失败，忽略
    }

    // 检测 Codex 激活配置
    try {
      const codexConfigPath = path.join(this.homeDir, '.codex', 'config.toml');
      const codexAuthPath = path.join(this.homeDir, '.codex', 'auth.json');

      const codexConfigContent = await fs.promises.readFile(codexConfigPath, 'utf8');
      const codexAuthContent = await fs.promises.readFile(codexAuthPath, 'utf8');

      // 使用统一的提取方法从 [model_providers.xxx] 提取 base_url
      const codexBaseUrl = this.extractCodexBaseUrl(codexConfigContent);

      const authParsed = JSON.parse(codexAuthContent);
      const codexApiKey = authParsed.OPENAI_API_KEY;

      if (codexBaseUrl && codexApiKey) {
        // 查找匹配的配置
        for (const config of this.data.configs) {
          if (config.codex) {
            const parsed = this.parseCodexConfig(config.codex);
            if (parsed && parsed.baseUrl === codexBaseUrl && parsed.apiKey === codexApiKey) {
              this.activeCodexId = config.id;
              break;
            }
          }
        }
      }
    } catch {
      // 文件不存在或解析失败，忽略
    }
  }

  // 检测单个配置是否与当前激活配置匹配
  private async detectActiveConfigForId(configId: string): Promise<void> {
    const config = this.data.configs.find((item) => item.id === configId);
    if (!config) {
      return;
    }

    // 检测 Claude 配置是否匹配
    if (config.claude) {
      try {
        const claudeSettingsPath = path.join(this.homeDir, '.claude', 'settings.json');
        const claudeContent = await fs.promises.readFile(claudeSettingsPath, 'utf8');
        const claudeParsed = JSON.parse(claudeContent);
        const claudeBaseUrl = claudeParsed.env?.ANTHROPIC_BASE_URL;
        const claudeApiKey = claudeParsed.env?.ANTHROPIC_AUTH_TOKEN;

        const parsed = this.parseClaudeConfig(config.claude);
        if (parsed && parsed.baseUrl === claudeBaseUrl && parsed.apiKey === claudeApiKey) {
          // 匹配，设置为激活
          this.activeClaudeId = configId;
        } else if (this.activeClaudeId === configId) {
          // 之前匹配但现在不匹配了，清除激活状态
          this.activeClaudeId = undefined;
        }
      } catch {
        // 文件不存在，如果当前配置是激活的，清除激活状态
        if (this.activeClaudeId === configId) {
          this.activeClaudeId = undefined;
        }
      }
    }

    // 检测 Codex 配置是否匹配
    if (config.codex) {
      try {
        const codexConfigPath = path.join(this.homeDir, '.codex', 'config.toml');
        const codexAuthPath = path.join(this.homeDir, '.codex', 'auth.json');

        const codexConfigContent = await fs.promises.readFile(codexConfigPath, 'utf8');
        const codexAuthContent = await fs.promises.readFile(codexAuthPath, 'utf8');

        // 使用统一的提取方法从 [model_providers.xxx] 提取 base_url
        const codexBaseUrl = this.extractCodexBaseUrl(codexConfigContent);

        const authParsed = JSON.parse(codexAuthContent);
        const codexApiKey = authParsed.OPENAI_API_KEY;

        const parsed = this.parseCodexConfig(config.codex);
        if (parsed && parsed.baseUrl === codexBaseUrl && parsed.apiKey === codexApiKey) {
          // 匹配，设置为激活
          this.activeCodexId = configId;
        } else if (this.activeCodexId === configId) {
          // 之前匹配但现在不匹配了，清除激活状态
          this.activeCodexId = undefined;
        }
      } catch {
        // 文件不存在，如果当前配置是激活的，清除激活状态
        if (this.activeCodexId === configId) {
          this.activeCodexId = undefined;
        }
      }
    }
  }

  // 解析 Claude 配置，提取 baseUrl 和 apiKey
  private parseClaudeConfig(config: ClaudeConfig): { baseUrl: string; apiKey: string } | null {
    try {
      const parsed = JSON.parse(config.settingsJson);
      const baseUrl = parsed.env?.ANTHROPIC_BASE_URL;
      const apiKey = parsed.env?.ANTHROPIC_AUTH_TOKEN;
      if (baseUrl && apiKey) {
        return { baseUrl, apiKey };
      }
    } catch {
      // ignore
    }
    return null;
  }

  // 解析 Codex 配置，提取 baseUrl 和 apiKey
  private parseCodexConfig(config: CodexConfig): { baseUrl: string; apiKey: string } | null {
    try {
      // 从 authJson 提取 apiKey
      const authParsed = JSON.parse(config.authJson);
      const apiKey = authParsed.OPENAI_API_KEY;

      // 从 configToml 提取 base_url（优先从 [model_providers.xxx] 部分提取）
      const baseUrl = this.extractCodexBaseUrl(config.configToml);

      if (apiKey && baseUrl) {
        return { baseUrl, apiKey };
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * 从 config.toml 中提取 base_url（优先从 [model_providers.xxx] 部分提取）
   */
  private extractCodexBaseUrl(configToml: string): string | undefined {
    // 优先从 [model_providers.xxx] 部分提取 base_url
    const providerMatch = configToml.match(/^\s*model_provider\s*=\s*"([^"]+)"/m);
    if (providerMatch) {
      const providerName = providerMatch[1];
      const sectionRegex = new RegExp(
        `\\[model_providers\\.${providerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][\\s\\S]*?base_url\\s*=\\s*"([^"]+)"`,
        'i'
      );
      const sectionMatch = configToml.match(sectionRegex);
      if (sectionMatch) {
        return sectionMatch[1];
      }
    }

    // 如果没找到，尝试从主配置段提取 base_url（向后兼容）
    const mainBaseUrlMatch = configToml.match(/^base_url\s*=\s*"([^"]+)"/m);
    return mainBaseUrlMatch?.[1];
  }

  private async writeClaudeConfig(config: ClaudeConfig): Promise<void> {
    const targetDir = path.join(this.homeDir, '.claude');
    const settingsFile = path.join(targetDir, 'settings.json');
    await fs.promises.mkdir(targetDir, { recursive: true });
    await fs.promises.writeFile(settingsFile, config.settingsJson, 'utf8');
  }

  private async writeCodexConfig(config: CodexConfig): Promise<void> {
    const codexDir = path.join(this.homeDir, '.codex');
    await fs.promises.mkdir(codexDir, { recursive: true });

    // 写入 auth.json
    const authFile = path.join(codexDir, 'auth.json');
    await fs.promises.writeFile(authFile, config.authJson, 'utf8');

    // 写入 config.toml
    const configFile = path.join(codexDir, 'config.toml');
    await fs.promises.writeFile(configFile, config.configToml, 'utf8');
  }

  private async fetchStatus(config: ProviderConfig): Promise<ProviderStatus> {
    const statusConfig = config.status;
    if (!statusConfig?.url) {
      return {
        ok: false,
        fetchedAt: Date.now(),
        message: '未配置查询接口',
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      // 构建请求头
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // 可选：添加 Authorization
      if (statusConfig.authorization) {
        headers['Authorization'] = statusConfig.authorization;
      }

      // 可选：添加 User ID（用于 DuckCoding 等）
      if (statusConfig.userId) {
        headers['new-api-user'] = statusConfig.userId;
      }

      // 可选：添加 Cookie
      if (statusConfig.cookie) {
        headers['Cookie'] = statusConfig.cookie;
      }

      const response = await fetch(statusConfig.url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      const text = await response.text();
      const parsed = this.tryParseJson(text);
      const normalized = this.normalizeStatus(parsed);

      // 尝试获取 quota_per_unit（用于 newApi 类型）
      let quotaPerUnit: number | undefined;
      if (statusConfig.url.includes('/api/user/self')) {
        const statusUrl = statusConfig.url.replace('/api/user/self', '/api/status');
        try {
          const statusResponse = await fetch(statusUrl, {
            method: 'GET',
            headers,
            signal: controller.signal,
          });
          if (statusResponse.ok) {
            const statusText = await statusResponse.text();
            const statusData = this.tryParseJson(statusText);
            if (statusData && typeof statusData === 'object') {
              const dataRecord = statusData as Record<string, unknown>;
              if ('data' in dataRecord && typeof dataRecord.data === 'object' && dataRecord.data !== null) {
                const data = dataRecord.data as Record<string, unknown>;
                if (typeof data.quota_per_unit === 'number') {
                  quotaPerUnit = data.quota_per_unit;
                }
              }
            }
          }
        } catch {
          // 忽略获取 quota_per_unit 失败的情况
        }
      }

      // 特殊处理：88Code 需要额外调用 subscription API 获取余额
      if (statusConfig.url.includes('88code.org/admin-api/cc-admin/user/dashboard')) {
        try {
          const subscriptionUrl = statusConfig.url.replace('/user/dashboard', '/system/subscription/my');
          const subscriptionResponse = await fetch(subscriptionUrl, {
            method: 'GET',
            headers,
            signal: controller.signal,
          });
          if (subscriptionResponse.ok) {
            const subscriptionText = await subscriptionResponse.text();
            const subscriptionData = this.tryParseJson(subscriptionText);
            // 合并 dashboard 和 subscription 数据
            const merged = this.merge88CodeData(parsed, subscriptionData);
            const mergedNormalized = this.normalizeStatus(merged);
            // 88Code 直接返回美元金额，quotaPerUnit = 1（不需要转换）
            return {
              ok: response.ok,
              fetchedAt: Date.now(),
              balance: mergedNormalized.balance,
              usage: mergedNormalized.usage,
              total: mergedNormalized.total,
              quotaPerUnit: 1,
              message: response.ok ? undefined : mergedNormalized.message ?? response.statusText,
              rawText: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
            };
          }
        } catch {
          // 如果获取 subscription 失败，继续使用原始数据
        }
      }

      return {
        ok: response.ok,
        fetchedAt: Date.now(),
        balance: normalized.balance,
        usage: normalized.usage,
        total: normalized.total,
        quotaPerUnit,
        message: response.ok ? undefined : normalized.message ?? response.statusText,
        rawText: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      return {
        ok: false,
        fetchedAt: Date.now(),
        message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private tryParseJson(payload: string): unknown {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }

  private normalizeStatus(input: unknown): { balance?: string; usage?: string; total?: string; message?: string } {
    if (!input) {
      return {};
    }

    const candidates = Array.isArray(input) ? input : [input];

    for (const candidate of candidates) {
      if (candidate && typeof candidate === 'object') {
        const candidateRecord = candidate as Record<string, unknown>;

        // 特殊处理：FoxCode 嵌套结构 { success: true, data: { quota: { ... } } }
        if ('data' in candidateRecord && typeof candidateRecord.data === 'object' && candidateRecord.data !== null) {
          const dataRecord = candidateRecord.data as Record<string, unknown>;

          // FoxCode 格式：data.quota.{currentUsage, quotaRemaining, quotaLimit}
          if ('quota' in dataRecord && typeof dataRecord.quota === 'object' && dataRecord.quota !== null) {
            const quotaRecord = dataRecord.quota as Record<string, unknown>;
            return {
              balance: quotaRecord.quotaRemaining ? String(quotaRecord.quotaRemaining) : undefined,
              usage: quotaRecord.currentUsage ? String(quotaRecord.currentUsage) : undefined,
              total: quotaRecord.quotaLimit ? String(quotaRecord.quotaLimit) : undefined,
              message: undefined,
            };
          }

          // 88Code 格式：data.{usage, balance, total}（直接字段名）
          if ('usage' in dataRecord && 'balance' in dataRecord && 'total' in dataRecord) {
            return {
              balance: String(dataRecord.balance),
              usage: String(dataRecord.usage),
              total: String(dataRecord.total),
              message: undefined,
            };
          }

          // DuckCoding/newApi 格式：data.{used_quota, quota}
          // 注意：quota 是剩余额度，不是总额度
          if ('used_quota' in dataRecord || 'quota' in dataRecord) {
            const usedQuota = typeof dataRecord.used_quota === 'number' || typeof dataRecord.used_quota === 'string'
              ? Number(dataRecord.used_quota)
              : 0;
            const remainingQuota = typeof dataRecord.quota === 'number' || typeof dataRecord.quota === 'string'
              ? Number(dataRecord.quota)
              : 0;
            // 总额度 = 已使用 + 剩余
            const totalQuota = usedQuota + remainingQuota;

            return {
              balance: String(remainingQuota),
              usage: String(usedQuota),
              total: String(totalQuota),
              message: undefined,
            };
          }
        }

        // 通用字段提取
        const balance = this.extractKnownField(candidateRecord, ['balance', 'availableBalance', 'credit', 'quotaRemaining']);
        const usage = this.extractKnownField(candidateRecord, ['usage', 'used', 'consumption', 'currentUsage', 'used_quota']);
        const total = this.extractKnownField(candidateRecord, ['total', 'totalQuota', 'quotaLimit', 'limit', 'quota']);
        const message = this.extractKnownField(candidateRecord, ['message', 'error', 'detail']);

        if (balance || usage || total || message) {
          return {
            balance,
            usage,
            total,
            message,
          };
        }
      }
    }

    return {};
  }

  private merge88CodeData(dashboardData: unknown, subscriptionData: unknown): unknown {
    // 88Code 特殊格式：合并 dashboard 的 cost 和 subscription 的 currentCredits
    if (!dashboardData || typeof dashboardData !== 'object') {
      return dashboardData;
    }

    const dashboardRecord = dashboardData as Record<string, unknown>;
    if (!('data' in dashboardRecord) || typeof dashboardRecord.data !== 'object' || dashboardRecord.data === null) {
      return dashboardData;
    }

    const data = dashboardRecord.data as Record<string, unknown>;
    if (!('overview' in data) || typeof data.overview !== 'object' || data.overview === null) {
      return dashboardData;
    }

    const overview = data.overview as Record<string, unknown>;
    const cost = typeof overview.cost === 'number' ? overview.cost : 0;

    // 从 subscription 中提取余额（找 id 最大的记录）
    let balance = 0;
    if (subscriptionData && typeof subscriptionData === 'object') {
      const subscriptionRecord = subscriptionData as Record<string, unknown>;
      if ('data' in subscriptionRecord && Array.isArray(subscriptionRecord.data)) {
        const subscriptions = subscriptionRecord.data as Array<Record<string, unknown>>;
        let maxIdSubscription: Record<string, unknown> | null = null;
        let maxId = -1;

        for (const sub of subscriptions) {
          const id = typeof sub.id === 'number' ? sub.id : 0;
          if (id > maxId) {
            maxId = id;
            maxIdSubscription = sub;
          }
        }

        if (maxIdSubscription && typeof maxIdSubscription.currentCredits === 'number') {
          balance = maxIdSubscription.currentCredits;
        }
      }
    }

    // 返回合并后的数据结构（模拟标准格式）
    return {
      data: {
        usage: cost,           // 已使用（美元）
        balance: balance,      // 剩余（美元）
        total: cost + balance  // 总额（美元）
      }
    };
  }

  private extractKnownField(source: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (value === undefined || value === null) {
        continue;
      }

      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }

      if (typeof value === 'object') {
        return JSON.stringify(value);
      }
    }

    return undefined;
  }
}
