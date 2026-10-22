# dsh-plugin-checkup

插件体检是一个 DSH 插件，用只读方式回答一个具体问题：当前宿主实际加载了哪些插件条目、模型实际能看到哪些工具和斜杠命令、这些内容与 profile 里的组合包声明是否一致。它不调用模型，不改 profile，只读取宿主运行时注册表与已安装包的文本文件。

DSH 的插件故障大多是静默的。加载失败的条目不会弹窗，被覆盖的同名工具不会提示，声明了但没有加载的行也不会出现在界面上。用户看到的现象是能力消失、行为异常或界面出现重复元素，却拿不到证据。这个插件把事实读出来，与声明做对照，按阻断、警告、提示三级输出。

## 已实现的能力

### 运行时事实采集

采集以下内容，全部来自官方运行时接缝：

1. Loader 真实条目，包含 entry id、模块名、启用状态、fiber 阶段与显示元信息
2. 模型可见的工具清单
3. 斜杠命令清单
4. profile 组合包清单，包含版本、启用状态、可用性、声明行、覆盖的内置行与安装诊断
5. 最近修改的插件包，按 package.json 文件时间排序

数据不落盘，页面关闭即丢弃，重新打开时重新采集。

### 声明对照

把运行时条目与组合包声明行对比，得到以下结论：

1. 声明了但运行时没有对应条目的行
2. 运行时存在但没有任何组合包声明的条目
3. 同一条目被多个启用组合包声明
4. 同一模块被多个启用条目加载
5. 声明为依赖但安装文件不可读的包
6. 宿主已经拒绝的版本不兼容，带未满足的 engines 与 peer 要求

官方内核行与 include 行不参与未声明判定，避免把宿主自身的常驻插件误报成野条目。可选但未安装的官方组合包也不参与缺失判定。

### 工具与命令来源归因

运行时注册表只给名字，不给来源。插件扫描已安装包的构建产物，把 defineTool、commands.register、slots.register 里的字符串名字映射回包名。扫描有文件数量上限与总字节预算，超出预算会写入采集告警，不会无界读取。

扫描不到来源的工具单独报告。这条规则用于发现运行了但没有声明来源的工具，是运行时检查里最有价值的一类线索。同名工具出现在多个包时也会报告，因为运行时只保留最后注册的那一个。

### 基线对比

记录一次运行时快照，之后每次打开页面都显示相对基线的变化，覆盖条目、工具、命令与组合包四类，分别给出新增与消失。基线保存在 DSH_HOME/plugin-checkup/baseline.json，不写入 profile。适合在安装或升级插件前后各记录一次，用事实回答这次变更到底改变了什么。

### 插件页入口

1. 插件页概览卡片显示阻断、警告、提示数量
2. 插件详情页徽章显示该插件相关发现的最严重级别
3. 插件详情页区块列出该插件的发现与规则名
4. 每个组合包的操作区有体检按钮
5. 本插件所在行的配置区有打开巡检页的按钮

### 巡检页面

页面包含汇总卡片、发现列表、运行时条目表、组合包表、工具与命令清单、来源归因表、基线对比区、最近变更的插件包，以及采集告警。支持复制 Markdown 报告，方便贴给插件作者或团队成员。

## 检测规则

| 规则 | 级别 | 判定依据 |
|---|---|---|
| `failed-entry` | 阻断 | Loader 条目的 fiber 阶段为 failed |
| `package-missing` | 阻断 | profile 声明为依赖，但包文件不可读 |
| `incompatible-version` | 阻断 | 宿主给出的 incompatible-version 诊断 |
| `duplicate-module` | 警告 | 同一模块被多个启用条目加载 |
| `declared-but-missing` | 警告 | 启用的组合包声明了该行，运行时没有启用条目 |
| `undeclared-entry` | 警告 | 运行时条目没有对应声明，官方内核行除外 |
| `duplicate-declaration` | 警告 | 同一 entry id 被多个启用组合包声明，include 行与官方包之间除外 |
| `unattributed-tool` | 警告 | 工具对模型可见，但扫描不到注册来源 |
| `tool-multi-source` | 提示 | 同名工具出现在多个包 |
| `command-multi-source` | 提示 | 同名命令出现在多个包 |
| `namespace-collision` | 提示 | 工具名与斜杠命令名相同 |
| `unmanaged-entries` | 提示 | 带 readOnlyReason 的条目数量 |
| `loader-unavailable` | 警告 | 宿主没有暴露 Loader 条目 |
| `degraded-mode` | 提示 | 没有 pluginManager 时只展示运行时事实 |

每条发现都带规则名、置信度、证据引用与建议动作。置信度分高、中两级，无法归因的内容标为中，不给出确定结论。

## 安装

从本地目录安装：

```bash
dsh plugin --profile desktop add "D:\path\to\dsh-plugin-checkup"
```

安装后重启 DSH。开发目录以 link 方式安装时，修改代码后重启宿主即可生效。

## 打开方式

1. 插件页找到 dsh-plugin-checkup，在行配置区点打开运行时巡检
2. 插件页概览卡片或任一插件详情页的体检按钮
3. 浏览器访问 http://127.0.0.1:端口/_dsh/plugin-checkup

桌面端只允许 Electron 渲染进程访问本地路由，普通浏览器直接访问会被拒绝。这是桌面宿主的安全边界，不是插件行为。

## 记录基线

打开巡检页，点记录当前为基线。安装或升级插件后重新打开页面，基线对比区会列出新增与消失的条目、工具、命令与组合包。点清除基线删除快照。基线接口需要页面内令牌，令牌随页面加载生成，不写入磁盘。

## HTTP 接口

```
GET  /_dsh/plugin-checkup            巡检页面
GET  /_dsh/plugin-checkup/api        JSON 报告
GET  /_dsh/plugin-checkup/api?refresh=1   绕过 3 秒缓存
GET  /_dsh/plugin-checkup/api?format=md   Markdown 报告
POST /_dsh/plugin-checkup/api/baseline    保存或清除基线
```

所有接口只接受回环地址与同源请求。只读接口只接受 GET。基线接口是唯一的写操作，且只写插件自己的数据目录。

## 数据位置与权限

1. 运行时数据不落盘
2. 基线文件位于 DSH_HOME/plugin-checkup/baseline.json
3. 不写 profile，不修改 cordis.patch.yml，不启停插件
4. 不执行被检查插件的代码，只读取安装包内的文本文件
5. 零模型调用，报告中的 modelCalls 恒为 0

## 能看到与看不到的

能看到的内容：Loader 条目、工具与命令注册、组合包声明、安装诊断、构建产物里的字符串注册名。

看不到的内容：纯副作用行为，包括写文件、修改全局变量、修改原型链、跨进程操作；被覆盖后没有留下痕迹的注册；运行期拼装出来的注册名。

这是运行时事实检查，不是安全扫描。报告不会声称检查了全部行为，采集失败或超出范围的项目会写入采集告警。

## 兼容性

1. 目标宿主为 DSH 0.2.x
2. 使用官方运行时接缝：ctx.loader.entries、pluginManager.listBundles、pluginManager.listPlugins、profileContext.dir、ctx.tools.schemas、ctx.commands.list
3. 任一接缝缺失时降级运行，并在采集告警中说明原因，页面不会崩溃
4. 无运行时依赖，无构建步骤，src 目录即发布产物

## 开发与测试

```bash
node test/rules.test.js
node test/probe.test.js
node test/web.test.js
node test/scan.test.js
node test/baseline.test.js
node scripts/demo.mjs
node scripts/verify-live.mjs http://127.0.0.1:4790
```

demo 使用内置 fixture，不访问真实安装环境。verify-live 对运行中的宿主执行完整接口检查与基线流程，输出条目数、发现数与基线保存结果。

## 目录结构

```
src/index.js     宿主入口、编排与缓存
src/probe.js     运行时事实采集
src/rules.js     检测规则
src/scan.js      来源归因扫描
src/baseline.js  基线快照与差分
src/report.js    报告组装与 Markdown 导出
src/web.js       只读路由、令牌校验与请求防护
src/page.js      巡检页面
src/client.js    插件页徽章、区块与按钮
```

## 路线图

1. 0.3 组合预检：安装前对比 engines 与 peer 要求，给出兼容结论
2. 0.4 升级预检：对比 npm 最新版本与会话格式契约，列出升级风险
3. 0.5 团队报告：导出可交付的 HTML 报告与白名单策略

## 许可

MIT
