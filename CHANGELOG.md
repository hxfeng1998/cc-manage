# 更新日志

本文件记录了 "CC Manage" 扩展的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2025-11-22

### 新增
- 无侵入写入配置文件，只修改/合并配置内容，其余内容完整保留
- 卡片折叠状态持久化
- 去掉自动刷新，面板展示时刷新一次
- 增加认证过期提示

## [1.0.0] - 2025-11-16

### 新增
- 初始版本发布
- 支持 Claude 和 Codex 配置管理
- 侧边栏 UI，支持添加、编辑、删除配置
- 自动余额查询功能（每 5 分钟刷新）
- 配置文件同步到 `~/.claude/settings.json` 和 `~/.codex/config.toml`
- 内置默认配置模板（foxcode, DuckCoding, 88Code, IKunCode, PackyCode, Privnode）
- 配置持久化到 `~/.cc-manage/configs.json`

### 功能特性
- ✅ 多配置管理
- ✅ 一键切换激活配置
- ✅ 余额监控和查询
- ✅ Claude/Codex 双端点支持

[1.0.0]: https://github.com/hxfeng1998/cc-manage/releases/tag/v1.0.0
