from collections.abc import Mapping

from workflow_platform.models import WorkflowDefinition


WORKFLOW_ID = "workflow-full-feature-local-delivery"
WORKFLOW_NAME = "全功能软件交付演练"
REQUIRED_ROLE_IDS = (
    "requirement-analyst",
    "tech-architect",
    "developer",
    "tester",
    "verifier",
    "deployer",
    "knowledge-keeper",
)


def build_full_feature_workflow(
    role_versions: Mapping[str, str],
) -> WorkflowDefinition:
    missing_roles = [role_id for role_id in REQUIRED_ROLE_IDS if not role_versions.get(role_id)]
    if missing_roles:
        raise ValueError(f"Missing required role versions: {', '.join(missing_roles)}")

    nodes = [
        _node("intake", "任务登记", "task", description="确认本次演练目标、范围和完成标准。"),
        _agent_node(
            "requirements",
            "需求分析",
            "requirement-analyst",
            "分析任务目标，识别用户故事、边界、风险和验收标准，并生成需求说明。",
            "requirements",
            "需求说明",
            "requirements.md",
            upstream="direct",
        ),
        _agent_node(
            "architecture",
            "技术设计",
            "tech-architect",
            "基于已确认需求给出架构、接口、数据、风险和回滚设计。",
            "architecture",
            "技术设计",
            "architecture.md",
            upstream="ancestors",
        ),
        _node(
            "design-approval",
            "方案审批",
            "approval",
            description="由人工确认需求与技术方案可以进入实施阶段。",
            requires=[{"type": "approval", "approvalRole": "product-owner", "required": True}],
        ),
        _agent_node(
            "implementation",
            "开发实现",
            "developer",
            "按照批准方案完成最小范围实现、测试更新和变更说明。",
            "implementation-record",
            "实现记录",
            "implementation.md",
            upstream="ancestors",
        ),
        _node(
            "build-evidence",
            "构建证据",
            "evidence",
            description="运行本地构建并记录命令、结果和产物位置。",
            outputs=[_output("build-log", "构建日志", "evidence", "build-evidence.md")],
        ),
        _agent_node(
            "automated-test",
            "自动测试",
            "tester",
            "执行与本次变更相关的测试，记录覆盖范围、结果和剩余风险。",
            "test-report",
            "测试报告",
            "test-report.md",
            upstream="ancestors",
        ),
        _node(
            "quality-gate",
            "质量门禁",
            "gate",
            description="独立核验构建、测试和实现证据。",
            gates=["quality-gate"],
            requires=[{"type": "gate", "gateId": "quality-gate", "required": True}],
        ),
        _node(
            "release-approval",
            "发布审批",
            "approval",
            description="人工确认允许进入本地 staging 部署。",
            requires=[{"type": "approval", "approvalRole": "release-manager", "required": True}],
        ),
        _node(
            "local-deploy",
            "本地 Staging 部署",
            "deploy",
            description="仅在本机创建 staging 部署记录，不连接远程服务器。",
            metadata={
                "environment": "local-staging",
                "risk": "high",
                "serverRequired": False,
                "deploy": {
                    "command": [
                        "node",
                        "-e",
                        "const fs=require('fs');const p='.workflow-platform/local-staging';fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'/deployed.txt','local staging deployment completed\\n');console.log('local staging deployment completed');",
                    ],
                    "cwd": ".",
                    "timeoutSeconds": 60,
                    "maxOutputBytes": 65536,
                },
            },
        ),
        _node(
            "acceptance-evidence",
            "验收证据",
            "evidence",
            description="记录本地 staging 的验收步骤、结果和截图或日志位置。",
            outputs=[_output("acceptance", "验收记录", "evidence", "acceptance.md")],
        ),
        _node(
            "release-report",
            "发布报告",
            "report",
            description="汇总需求、实现、测试、门禁、审批、部署与验收结果。",
            outputs=[_output("release-report", "发布报告", "report", "release-report.md")],
        ),
        _node("closeout", "复合收尾", "composite", description="检查审计记录并完成知识沉淀。"),
    ]

    return WorkflowDefinition.model_validate(
        {
            "id": WORKFLOW_ID,
            "name": WORKFLOW_NAME,
            "version": "1",
            "sourceAdapter": "full-feature-local-example",
            "nodes": nodes,
            "edges": [
                {
                    "id": f"edge-{source['id']}-{target['id']}",
                    "from": source["id"],
                    "to": target["id"],
                }
                for source, target in zip(nodes, nodes[1:])
            ],
            "roles": [
                {
                    "id": role_id,
                    "name": role_id,
                    "assetVersionId": role_versions[role_id],
                }
                for role_id in REQUIRED_ROLE_IDS
            ],
            "gates": [
                {
                    "id": "quality-gate",
                    "name": "质量门禁",
                    "description": "构建成功、相关测试通过、所需产物齐全且没有未处理高风险问题。",
                }
            ],
            "policies": {
                "deploymentTarget": "local-staging",
                "serverRequired": False,
                "requireHumanReleaseApproval": True,
                "requireVerifiedArtifacts": True,
            },
            "metadata": {
                "example": "full-feature-local-delivery",
                "installerSchemaVersion": 2,
                "canvas": {
                    "nodes": {
                        node["id"]: {"x": (index % 4) * 300, "y": (index // 4) * 190}
                        for index, node in enumerate(nodes)
                    }
                },
            },
        }
    )


def _node(
    node_id: str,
    name: str,
    kind: str,
    *,
    description: str,
    outputs: list[dict] | None = None,
    requires: list[dict] | None = None,
    gates: list[str] | None = None,
    metadata: dict | None = None,
) -> dict:
    return {
        "id": node_id,
        "name": name,
        "kind": kind,
        "description": description,
        "requires": requires or [],
        "gates": gates or [],
        "artifacts": {"outputs": outputs or []},
        "advance": {"mode": "manual"},
        "metadata": metadata or {},
    }


def _agent_node(
    node_id: str,
    name: str,
    role_id: str,
    prompt: str,
    artifact_id: str,
    artifact_name: str,
    artifact_filename: str,
    *,
    upstream: str,
) -> dict:
    node = _node(
        node_id,
        name,
        "agent",
        description=prompt,
        outputs=[_output(artifact_id, artifact_name, "document", artifact_filename)],
    )
    node["agent"] = {
        "roleId": role_id,
        "promptTemplate": prompt,
        "context": {
            "upstream": upstream,
            "maxArtifacts": 8,
            "summaryCharsPerArtifact": 2500,
            "maxTotalChars": 12000,
        },
    }
    return node


def _output(artifact_id: str, name: str, artifact_type: str, filename: str) -> dict:
    return {
        "id": artifact_id,
        "name": name,
        "type": artifact_type,
        "required": True,
        "path": f"docs/runs/{{{{runId}}}}/{{{{nodeId}}}}/{filename}",
        "description": f"{name}，用于后续节点和审计检查。",
    }
