import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../services/ConfigManager';

// 简单的测试框架
let passed = 0;
let failed = 0;
const errors: string[] = [];

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`  ✗ ${name}\n    ${message}`);
    console.log(`  ✗ ${name}`);
  }
}

async function runTests() {
  console.log('\nConfigManager Unit Tests\n');

  let testDir: string;
  let manager: ConfigManager;

  // Setup helper
  const setup = async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-manage-test-'));
    manager = new ConfigManager(testDir);
    await manager.init();
  };

  // Teardown helper
  const teardown = () => {
    fs.rmSync(testDir, { recursive: true, force: true });
  };

  // Test: Initialize with empty configs
  await setup();
  await test('should initialize with empty configs', () => {
    const configs = manager.getSafeConfigs();
    assert.strictEqual(configs.length, 0);
  });
  teardown();

  // Test: Add a new config
  await setup();
  await test('should add a new config', async () => {
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
    assert.strictEqual(configs[0].claude?.baseUrl, 'https://api.test.com');
  });
  teardown();

  // Test: Reject duplicate names
  await setup();
  await test('should reject duplicate names', async () => {
    await manager.addConfig({
      name: 'Duplicate',
      claude: {
        settingsJson: JSON.stringify({
          env: { ANTHROPIC_AUTH_TOKEN: 'sk-1', ANTHROPIC_BASE_URL: 'https://api1.com' }
        })
      }
    });

    let threw = false;
    try {
      await manager.addConfig({
        name: 'Duplicate',
        claude: {
          settingsJson: JSON.stringify({
            env: { ANTHROPIC_AUTH_TOKEN: 'sk-2', ANTHROPIC_BASE_URL: 'https://api2.com' }
          })
        }
      });
    } catch (error) {
      threw = true;
      assert.ok(error instanceof Error && error.message.includes('已存在'));
    }
    assert.ok(threw, 'Should throw for duplicate name');
  });
  teardown();

  // Test: Require at least one endpoint
  await setup();
  await test('should require at least one endpoint', async () => {
    let threw = false;
    try {
      await manager.addConfig({ name: 'No Endpoint' });
    } catch (error) {
      threw = true;
      assert.ok(error instanceof Error && error.message.includes('至少需要配置一个接口'));
    }
    assert.ok(threw);
  });
  teardown();

  // Test: Validate JSON format
  await setup();
  await test('should validate Claude settings JSON format', async () => {
    let threw = false;
    try {
      await manager.addConfig({
        name: 'Invalid JSON',
        claude: { settingsJson: 'not a json' }
      });
    } catch (error) {
      threw = true;
      assert.ok(error instanceof Error && error.message.includes('格式错误'));
    }
    assert.ok(threw);
  });
  teardown();

  // Test: Update config
  await setup();
  await test('should update config', async () => {
    await manager.addConfig({
      name: 'Original',
      claude: {
        settingsJson: JSON.stringify({
          env: { ANTHROPIC_AUTH_TOKEN: 'sk-old', ANTHROPIC_BASE_URL: 'https://old.com' }
        })
      }
    });

    const configs = manager.getSafeConfigs();
    await manager.updateConfig({
      id: configs[0].id,
      name: 'Updated',
      claude: {
        settingsJson: JSON.stringify({
          env: { ANTHROPIC_AUTH_TOKEN: 'sk-new', ANTHROPIC_BASE_URL: 'https://new.com' }
        })
      }
    });

    const updated = manager.getSafeConfigs();
    assert.strictEqual(updated[0].name, 'Updated');
    assert.strictEqual(updated[0].claude?.baseUrl, 'https://new.com');
  });
  teardown();

  // Test: Delete config
  await setup();
  await test('should delete config', async () => {
    await manager.addConfig({
      name: 'ToDelete',
      claude: {
        settingsJson: JSON.stringify({
          env: { ANTHROPIC_AUTH_TOKEN: 'sk-del', ANTHROPIC_BASE_URL: 'https://del.com' }
        })
      }
    });

    const configs = manager.getSafeConfigs();
    await manager.deleteConfig(configs[0].id);
    assert.strictEqual(manager.getSafeConfigs().length, 0);
  });
  teardown();

  // Test: Get config detail
  await setup();
  await test('should get config detail with sensitive data', async () => {
    await manager.addConfig({
      name: 'Detail',
      status: { url: 'https://status.com', authorization: 'Bearer secret' },
      claude: {
        settingsJson: JSON.stringify({
          env: { ANTHROPIC_AUTH_TOKEN: 'sk-secret', ANTHROPIC_BASE_URL: 'https://api.com' }
        })
      }
    });

    const configs = manager.getSafeConfigs();
    const detail = manager.getConfigDetail(configs[0].id);
    assert.ok(detail);
    assert.ok(detail.claude?.settingsJson.includes('sk-secret'));
    assert.strictEqual(detail.status?.authorization, 'Bearer secret');
  });
  teardown();

  // Test: Set active Claude config
  await setup();
  await test('should write Claude settings on setActive', async () => {
    await manager.addConfig({
      name: 'Active',
      claude: {
        settingsJson: JSON.stringify({
          env: { ANTHROPIC_AUTH_TOKEN: 'sk-active', ANTHROPIC_BASE_URL: 'https://active.com' }
        })
      }
    });

    const configs = manager.getSafeConfigs();
    await manager.setActiveConfig(configs[0].id, 'claude');

    const settingsPath = path.join(testDir, '.claude', 'settings.json');
    assert.ok(fs.existsSync(settingsPath));
    const content = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(content.env.ANTHROPIC_AUTH_TOKEN, 'sk-active');
  });
  teardown();

  // Test: Set active Codex config
  await setup();
  await test('should write Codex files on setActive', async () => {
    await manager.addConfig({
      name: 'Codex',
      codex: {
        authJson: JSON.stringify({ OPENAI_API_KEY: 'sk-codex' }),
        configToml: 'base_url = "https://codex.com/v1"\nmodel = "gpt-5"'
      }
    });

    const configs = manager.getSafeConfigs();
    await manager.setActiveConfig(configs[0].id, 'codex');

    const authPath = path.join(testDir, '.codex', 'auth.json');
    const configPath = path.join(testDir, '.codex', 'config.toml');
    assert.ok(fs.existsSync(authPath));
    assert.ok(fs.existsSync(configPath));
  });
  teardown();

  // Test: Templates
  await setup();
  await test('should return templates', () => {
    const templates = manager.getTemplates();
    assert.ok(Array.isArray(templates));
    assert.ok(templates.length > 0);
    assert.ok(templates[0].name);
  });
  teardown();

  // Test: Persistence
  await setup();
  await test('should persist configs to disk', async () => {
    await manager.addConfig({
      name: 'Persist',
      claude: {
        settingsJson: JSON.stringify({
          env: { ANTHROPIC_AUTH_TOKEN: 'sk-persist', ANTHROPIC_BASE_URL: 'https://p.com' }
        })
      }
    });

    const newManager = new ConfigManager(testDir);
    await newManager.init();
    assert.strictEqual(newManager.getSafeConfigs().length, 1);
  });
  teardown();

  // Test: Detect active on init
  await setup();
  await test('should detect active config on init', async () => {
    await manager.addConfig({
      name: 'Detect',
      claude: {
        settingsJson: JSON.stringify({
          env: { ANTHROPIC_AUTH_TOKEN: 'sk-detect', ANTHROPIC_BASE_URL: 'https://d.com' }
        })
      }
    });

    const configs = manager.getSafeConfigs();
    await manager.setActiveConfig(configs[0].id, 'claude');

    const newManager = new ConfigManager(testDir);
    await newManager.init();
    assert.strictEqual(newManager.getSafeConfigs()[0].claude?.isActive, true);
  });
  teardown();

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (errors.length > 0) {
    console.log('\nFailed tests:');
    errors.forEach(err => console.log(err));
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
