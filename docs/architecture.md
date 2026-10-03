# 架构说明 · PE-Workbench

## 一句话概括

一个**配置驱动的工作流内核**（源自 LeebertyGXP 的合规引擎），加一组药物经济学领域模块，加一个零依赖的中英双语界面。

## 为什么是"配置驱动"

药物经济学各类工作的受控流程形态高度同构：

```
受控记录 = 一串有顺序、有角色门槛、部分需签名的步骤
```

| 记录 | 步骤特征 |
|---|---|
| PROTO 方案 | 起草(PICO) → 方法学评审 → 批准✍ → 修订 → 归档 |
| SLR 综述 | 检索批准 → 筛选 → 提取 → 质量评估 → 综合 → QA审阅 → 关闭 |
| MODEL 模型 | 结构 → 结构评审 → 参数 → 编码 → 内部验证 → 外审 → 发布 → 归档 |
| DISS 数据问题 | 识别 → 偏倚评估 → 纠正 → QA 独立关闭 |
| CEA 报告 | 汇总 → 增量 → 解读 → CHEERS核查 → 批准✍ → 提交✍ → 归档 |

差别只在步骤数量、名称、角色、签名含义、表单字段。因此：

> **新增一条药物经济学流程 = 往 `seed/workflows/` 放一个 JSON 文件。不写代码。**

`src/domain/workflow.js` 是全系统唯一的状态机，它校验定义合法性（步骤码不重复、目标状态存在）并物化步骤清单。

## 分层

```
┌──────────────────────────────────────────────────────────┐
│ PEWorkbench.exe  原生 WinForms 桌面窗口（自有标题栏/任务栏/托盘）│
│   内嵌 WebView2 控件渲染工作台（不依赖用户浏览器）            │
│   自动拉起隐藏 Node 服务；退出时经令牌端点优雅关停（审计冲洗）  │
└──────────────────────────┬───────────────────────────────┘
                           │ REST (JSON, cookie session)
┌──────────────────────────▼───────────────────────────────┐
│ src/api/   routes.js   每条路由声明所需权限                │
│            server.js   静态文件 + JSON API，node:http     │
├──────────────────────────────────────────────────────────┤
│ src/domain/  领域模块                                     │
│   workflow ★  explorer  inbox  dashboard  inspections    │
│   analysis ★  documents  accounts  visibility            │
│   constraints                                           │
├──────────────────────────────────────────────────────────┤
│ src/core/   合规内核（所有领域共用）★                      │
│   db       SQLite schema（含防篡改触发器）                 │
│   audit    只可追加哈希链 ★★                              │
│   auth     认证 / 会话 / 双要素电子签名 ★★                 │
│   rbac     13 角色权限矩阵                                │
│   crypto   scrypt / TOTP / 规范化 JSON 哈希               │
└──────────────────────────┬───────────────────────────────┘
                           │ node:sqlite（内置，零依赖）
                    data/pe.db  +  data/audit-chain.key
```

### 桌面窗口（PEWorkbench.exe）

Web 界面部分（`web/`，原生 JS 中英双语 SPA，零依赖无构建）由桌面窗口内的 WebView2 控件渲染，也可在任何浏览器访问同一地址——同一套界面，两个载体。

- 源码 `desktop/PEWorkbench.cs`（C# 5，兼容 Windows 自带的 .NET Framework 编译器）；构建脚本 `scripts/build-desktop.js`（仅构建期联网获取 WebView2 SDK 程序集，产物为项目根的 `PEWorkbench.exe` + 3 个 DLL，运行期零下载）
- `x86` 目标平台：与 Evergreen WebView2 运行时的常见注册布局（WOW6432Node 视图）匹配，避免 x64 host 下的 RPC_E_CHANGED_MODE / 发现失败
- 启动器定位 WebView2 运行时（注册表双视图 + 标准目录扫描）并显式绑定 `BrowserExecutableFolder`
- 服务生命周期：隐藏子进程（stdout/stderr 重定向至 `logs/server.log`）→ 轮询 `/api/health` 就绪 → 托盘管理（打开/日志/重启/退出）；退出时读 `data/.shutdown-token` 调 `POST /api/shutdown`（仅 127.0.0.1 + 令牌比对），服务器走与 Ctrl+C 相同的优雅关闭路径
- 窗口关闭收进托盘；`--shot <png>` 自检模式（截图 + 页面标题取证 + 重启 + 优雅关停 + 退出）

## 内核的三个关键机制

### 1. 哈希链审计追踪（`src/core/audit.js`）

每行存储 `chain_hash = HMAC(key, prev_hash ‖ canonical(payload))`。HMAC 密钥存于数据库之外（`audit-chain.key`），因此即使拿到数据库文件也无法重算伪造整条链。

三层防护：直接 UPDATE/DELETE 被触发器拦截；绕过触发器改文件被摘要比对精确定位断点；复制数据库重算链因缺密钥而失败。

### 2. 双分量电子签名（`src/core/auth.js`）

21 CFR Part 11.200(a)(1)(i) 之精神：签名使用至少两个不同的识别要素。

```
分量 A：识别码（用户名）+ 密码（签署时重新输入，不使用已登录会话）
分量 B：TOTP 动态口令 或 服务端签发的一次性挑战码（TTL 120 秒，一次性消费）
```

已登录会话不构成签名分量；挑战码重放被拒绝（e2e 覆盖）。签名记录姓名、时间、含义（封闭枚举）、理由，并与记录、步骤永久关联。

### 3. 职责分离（`rbac.js` + `workflow.js` + `constraints.js`）

三道门，全部在服务端：
1. **路由权限**：每条路由声明 permission，缺失返回 403 并记入审计
2. **步骤角色门**：步骤声明的角色数组不含当前角色则 403
3. **独立性门**：`independentOfAuthor: true` 的步骤拒绝记录作者本人（数据问题关闭、方案批准、模型发布、报告批准……）

另：系统管理员不得作为分析记录的唯一批准人；负面检查判定必须附客观证据。

## 领域内容（数据而非代码）

- **7 个专业领域**：`src/seed.js` 的 `PE_AREAS`（RSD/EVS/OUT/CST/MDL/ANA/RPT），各带理念一句话
- **10 条工作流**：`seed/workflows/*.json`
- **4 张检查表 71 项要求**：`seed/checklists/*.json`（CHEERS-2022 / CN-GUIDELINE-2020 / ISPOR-SMDM-MODEL / ALCOA-ANALYSIS）
- 以上全部在服务启动时热加载，改 JSON 即生效

## 就绪度评分（`inspections.readinessDashboard`）

```
base = 100
- 25 × 未关闭 critical 缺陷
- 10 × 超期记录（封顶 30）
- 15 × critical 级超期记录（已升级）
- 5  × 文件审核欠账（封顶 20）
- 10 × 已发布模型缺 ISPOR-SMDM 验证记录
审计链失败 → 直接 0（一切失去意义）
```

评分的意义是**具名阻碍项**：每一条都指向具体记录，不是情绪指数。

## 前端设计

零依赖、无构建步骤，`window.Views.register()` 注册视图。合规相关的 UI 决策沿用内核精神：

- 标识符/日期/哈希用等宽字体（电话里能念清楚）
- 颜色永不作为唯一信息载体（黑白打印仍可读）
- 签名对话框不可用点击遮罩关闭；密码提交后立即从 DOM 清除
- 三态权限矩阵的"⚠ 有约束"逐项注明理由与方法学依据
- 领域理念（philosophy）写在每张领域卡与流程页顶部

## 已知取舍

| 取舍 | 原因 |
|---|---|
| 计算器只做汇总级（ICER/BIA/QALY），不做建模仿真 | 建模仍是 R/Excel/TreeAge 的职责；工作台管受控流程与留痕 |
| 检查表为自拟自查断言 | 依据公开规范编写但未逐条对照原文；使用前需人工核对（README 明示） |
| 单实例、本地优先 | 审计链为单写入者设计；局域网共享需自行前置 HTTPS |
| 演示身份共用密码 | 明确的演示取舍，界面警示 + 生产环境开关（PE_BUILTIN_ACCOUNTS=0） |

## 扩展点

| 想做什么 | 改哪里 |
|---|---|
| 新增工作流 | `seed/workflows/` 加 JSON，重启即生效 |
| 新增检查表 | `seed/checklists/` 加 JSON |
| 新增岗位 | `src/core/rbac.js` + `visibility.js` HOME_AREAS_BY_ROLE |
| 调整就绪度规则 | `src/domain/inspections.js` readinessDashboard |
| 新计算器 | `src/domain/analysis.js` + routes + 前端视图 |
| 对接企业 SSO | `src/core/auth.js` login() 替换为令牌校验 |

## 与 LeebertyGXP 的关系

本项目的合规内核（db/audit/auth/crypto/workflow/api 骨架）直接改编自 LeebertyGXP（MIT 许可），已在 LICENSE 中注明；领域层（工作流/检查表/角色/界面/演示数据）为本项目全新编写。