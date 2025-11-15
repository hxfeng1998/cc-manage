import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../../services/ConfigManager';

suite('ConfigManager Test Suite', () => {
  let manager: ConfigManager;
  let testDir: string;
  let originalHomedir: () => string;

  setup(async () => {
    // 创建临时测试目录
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-manage-test-'));

    // Mock os.homedir() 返回测试目录
    originalHomedir = os.homedir;
    (os as { homedir: () => string }).homedir = () => testDir;

    manager = new ConfigManager();
    await manager.init();
  });

  teardown(async () => {
    // 恢复 os.homedir
    (os as { homedir: () => string }).homedir = originalHomedir;

    // 清理测试目录
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should initialize with empty configs', () => {
    const configs = manager.getSafeConfigs();
    assert.strictEqual(configs.length, 0);
  });

  test('should add a new config', async () => {
    await manager.addConfig({
      name: 'Test Provider',
      website: 'https://test.com',
      claude: {
        settingsJson: JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-test-123',
            ANTHROPIC_BASE_URL: 'https://api.test.com'
          }
        }, null, 2)
      }
    });

    const configs = manager.getSafeConfigs();
    assert.strictEqual(configs.length, 1);
    assert.strictEqual(configs[0].name, 'Test Provider');
    assert.strictEqual(configs[0].website, 'https://test.com');
    assert.strictEqual(configs[0].claude?.baseUrl, 'https://api.test.com');
    assert.strictEqual(configs[0].claude?.hasCredentials, true);
  });

  test('should reject duplicate names', async () => {
    await manager.addConfig({
      name: 'Duplicate',
      claude: {
        settingsJson: JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-1',
            ANTHROPIC_BASE_URL: 'https://api1.com'
          }
        })
      }
    });

    await assert.rejects(
      async () => {
        await manager.addConfig({
          name: 'Duplicate',
          claude: {
            settingsJson: JSON.stringify({
              env: {
                ANTHROPIC_AUTH_TOKEN: 'sk-2',
                ANTHROPIC_BASE_URL: 'https://api2.com'
              }
            })
          }
        });
      },
      /已存在/
    );
  });

  test('should require at least one endpoint', async () => {
    await assert.rejects(
      async () => {
        await manager.addConfig({
          name: 'No Endpoint'
        });
      },
      /至少需要配置一个接口/
    );
  });

  test('should validate Claude settings JSON format', async () => {
    await assert.rejects(
      async () => {
        await manager.addConfig({
          name: 'Invalid JSON',
          claude: {
            settingsJson: 'not a json'
          }
        });
      },
      /格式错误/
    );
  });

  test('should validate Claude settings contains required fields', async () => {
    await assert.rejects(
      async () => {
        await manager.addConfig({
          name: 'Missing Fields',
          claude: {
            settingsJson: JSON.stringify({ env: {} })
          }
        });
      },
      /ANTHROPIC_AUTH_TOKEN/
    );
  });

  test('should update config', async () => {
    await manager.addConfig({
      name: 'Original',
      claude: {
        settingsJson: JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-old',
            ANTHROPIC_BASE_URL: 'https://old.com'
          }
        })
      }
    });

    const configs = manager.getSafeConfigs();
    const configId = configs[0].id;

    await manager.updateConfig({
      id: configId,
      name: 'Updated',
      claude: {
        settingsJson: JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-new',
            ANTHROPIC_BASE_URL: 'https://new.com'
          }
        })
      }
    });

    const updatedConfigs = manager.getSafeConfigs();
    assert.strictEqual(updatedConfigs[0].name, 'Updated');
    assert.strictEqual(updatedConfigs[0].claude?.baseUrl, 'https://new.com');
  });

  test('should delete config', async () => {
    await manager.addConfig({
      name: 'ToDelete',
      claude: {
        settingsJson: JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-delete',
            ANTHROPIC_BASE_URL: 'https://delete.com'
          }
        })
      }
    });

    const configs = manager.getSafeConfigs();
    assert.strictEqual(configs.length, 1);

    await manager.deleteConfig(configs[0].id);

    const afterDelete = manager.getSafeConfigs();
    assert.strictEqual(afterDelete.length, 0);
  });

  test('should get config detail', async () => {
    await manager.addConfig({
      name: 'Detail Test',
      website: 'https://detail.com',
      status: {
        url: 'https://api.detail.com/status',
        authorization: 'Bearer token123'
      },
      claude: {
        settingsJson: JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-detail',
            ANTHROPIC_BASE_URL: 'https://api.detail.com'
          }
        })
      }
    });

    const configs = manager.getSafeConfigs();
    const detail = manager.getConfigDetail(configs[0].id);

    assert.ok(detail);
    assert.strictEqual(detail.name, 'Detail Test');
    assert.strictEqual(detail.status?.url, 'https://api.detail.com/status');
    assert.strictEqual(detail.status?.authorization, 'Bearer token123');
    assert.ok(detail.claude?.settingsJson.includes('sk-detail'));
  });

  test('should set active Claude config', async () => {
    await manager.addConfig({
      name: 'Active Test',
      claude: {
        settingsJson: JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-active',
            ANTHROPIC_BASE_URL: 'https://active.com'
          }
        })
      }
    });

    const configs = manager.getSafeConfigs();
    await manager.setActiveConfig(configs[0].id, 'claude');

    // 验证文件已写入
    const claudeDir = path.join(testDir, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');
    assert.ok(fs.existsSync(settingsPath));

    const content = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(content);
    assert.strictEqual(parsed.env.ANTHROPIC_AUTH_TOKEN, 'sk-active');
  });

  test('should set active Codex config', async () => {
    await manager.addConfig({
      name: 'Codex Test',
      codex: {
        authJson: JSON.stringify({ OPENAI_API_KEY: 'sk-codex-key' }),
        configToml: 'base_url = "https://codex.com/v1"\n\nmodel = "gpt-5"'
      }
    });

    const configs = manager.getSafeConfigs();
    await manager.setActiveConfig(configs[0].id, 'codex');

    // 验证文件已写入
    const codexDir = path.join(testDir, '.codex');
    const authPath = path.join(codexDir, 'auth.json');
    const configPath = path.join(codexDir, 'config.toml');

    assert.ok(fs.existsSync(authPath));
    assert.ok(fs.existsSync(configPath));

    const authContent = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    assert.strictEqual(authContent.OPENAI_API_KEY, 'sk-codex-key');

    const tomlContent = fs.readFileSync(configPath, 'utf8');
    assert.ok(tomlContent.includes('base_url = "https://codex.com/v1"'));
  });

  test('should return templates', () => {
    const templates = manager.getTemplates();
    assert.ok(Array.isArray(templates));
    assert.ok(templates.length > 0);

    // 验证模板结构
    const firstTemplate = templates[0];
    assert.ok(firstTemplate.name);
    assert.ok(firstTemplate.claude || firstTemplate.codex);
  });

  test('should persist configs to disk', async () => {
    await manager.addConfig({
      name: 'Persist Test',
      claude: {
        settingsJson: JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-persist',
            ANTHROPIC_BASE_URL: 'https://persist.com'
          }
        })
      }
    });

    // 创建新实例，验证数据持久化
    const newManager = new ConfigManager();
    await newManager.init();

    const configs = newManager.getSafeConfigs();
    assert.strictEqual(configs.length, 1);
    assert.strictEqual(configs[0].name, 'Persist Test');
  });

  test('should detect active config on init', async () => {
    // 先添加配置
    await manager.addConfig({
      name: 'Detect Test',
      claude: {
        settingsJson: JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-detect',
            ANTHROPIC_BASE_URL: 'https://detect.com'
          }
        })
      }
    });

    const configs = manager.getSafeConfigs();
    await manager.setActiveConfig(configs[0].id, 'claude');

    // 创建新实例，验证自动检测
    const newManager = new ConfigManager();
    await newManager.init();

    const newConfigs = newManager.getSafeConfigs();
    assert.strictEqual(newConfigs[0].claude?.isActive, true);
  });
});
