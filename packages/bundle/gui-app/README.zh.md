# `@deepseek-ai/dsh-gui-app`

[English](README.md) | 中文

共享 GUI profile 层。[`cordis.patch.yml`](cordis.patch.yml) 位于 [`dsh-base`](../base/README.md) 之后，添加与传输无关的 Host 服务、API 网关、客户端模块清单、连接配置项以及完整的客户端／UI roster，并把面向每个 agent 的模型可见配置项移入 Agent Presets。其后必须再应用一个表层：[`dsh-web-app`](../web-app/README.md) 提供 HTTP／WebSocket 启动和浏览器运行时粘合逻辑，[`dsh-electron-app`](../electron-app/README.md) 提供桌面原生交互，并把 renderer 传输交给 Electron 应用。把 roster 放在这里，可以让两个表层共享相同的包 id、注入图、设置页面和会话投影，同时避免桌面安装依赖 Web 启动或对外服务包。

本包没有运行时 API。Profile 组合器通过 `dsh.bundle.patch` 解析其 patch；profile 必须按 `base`、`gui-app`、一个且仅一个表层组合包的顺序应用各层。Patch 会替换配置项的完整 `config`，因此专门调整共享配置项的表层必须重述所有要保留的字段。

## 模型体验

### GUI persona 和逐会话组合

#### 模型看到什么

本层设置共享 GUI persona，并挂载 Agent Presets，使每个会话获得所选 preset 自身拥有的提示词和工具。

##### 共享 persona

```markdown
You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
```

#### Token 影响

一条固定 persona 语句，加上由所选 preset 独立拥有的上下文。本组合包自身不贡献工具 schema 或结果文本。

#### KV Cache 影响

Persona 在进程生命周期内是稳定的系统提示词前缀。后续会话若选择不同 preset，该会话独立组装的提示词与工具目录会随之变化。

## 已知限制和延后工作

- **必须提供表层组合包**：本层刻意不挂载 renderer 资源载体或目录选择器交互；若未组合 `web-app` 或 `electron-app`，这些 GUI 操作将不可用。
- **会话导出仍沿用浏览器下载操作**：共享 roster 包含 `dsh-session-log-export`；Electron 导出完成之前，桌面保存对话框载体必须适配该操作。
