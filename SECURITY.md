# 安全披露 · Security policy

DSH Desktop 是个人维护的开源项目。发现安全问题请**不要**开公开 issue，通过以下任一渠道报告：

- GitHub 私有漏洞报告：仓库 Security 页 → Report a vulnerability；
- 邮件：3252024846@qq.com。

报告时请尽量附复现步骤与影响评估。项目为业余维护，无法承诺响应时限，但会在能力范围内尽快处理。

范围说明：

- 捆绑的 dsh 运行时（`@deepseek-ai/*` 系列包）的问题请报告上游 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)；
- 第三方插件本身的行为不属于本项目范围——安装第三方插件即是在本机执行其代码，这一点 README 已明示。

---

DSH Desktop is a personally maintained open-source project. Please **do not** open public issues for security problems; report via GitHub private vulnerability reporting (repo Security tab → Report a vulnerability) or email 3252024846@qq.com, including reproduction steps and impact where possible. Response is best-effort; there is no SLA.

Scope: issues in the bundled dsh runtime (`@deepseek-ai/*` packages) belong upstream at [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness); third-party plugins are out of scope — installing one runs its code on your machine by design, as the README states.
