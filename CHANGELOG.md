# 更新日志

本文件记录了 "CC Manage" 扩展的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [1.0.0] - 2025-01-16

### 新增
- 初始版本发布
- 支持 Claude 和 Codex 配置管理
- 侧边栏 UI，支持添加、编辑、删除配置
- 自动余额查询功能（每 5 分钟刷新）
- 配置文件同步到 `~/.claude/settings.json` 和 `~/.codex/config.toml`
- 内置默认配置模板（foxcode, DuckCoding, 88Code, IKunCode, PackyCode, Privnode）
- 配置持久化到 `~/.cc-manage/configs.json`
- Codex config.toml 支持 `[model_providers.xxx]` 格式
- 实时配置预览功能

### 功能特性
- ✅ 多配置管理
- ✅ 一键切换激活配置
- ✅ 余额监控和查询
- ✅ 配置导入/导出
- ✅ Claude/Codex 双端点支持
- ✅ 向后兼容旧配置格式

[未发布]: https://github.com/hxfeng1998/cc-manage/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/hxfeng1998/cc-manage/releases/tag/v1.0.0
