export { registerInit } from "./init.js";
export { registerWhoami } from "./whoami.js";
export { registerInvestigate } from "./investigate.js";
export { registerSetup } from "./setup.js";
export { registerEvalLocal } from "./eval-local.js";
export { buildEvalLocalArgs } from "./eval-delegation.js";
export type { EvalLocalForwardableOpts } from "./eval-delegation.js";
export { registerScanLocal } from "./scan-local.js";
export { registerGenerate } from "./generate.js";
export { registerValidate } from "./validate.js";
export { registerVerify } from "./verify.js";
export { registerCompare } from "./compare.js";
export { registerList } from "./list.js";
export { registerFirewall } from "./firewall.js";
// Local machine inventory: which AI agents and MCP servers are installed here.
export { registerMcpDiscover } from "./mcp-discover.js";
export { registerWatch } from "./watch.js";
export { registerGate } from "./gate.js";
export { registerHistory } from "./history.js";
export { registerComplianceCheck } from "./compliance-check.js";
// Certification readiness/gap analysis (ISO 42001 / ISO 27001 / SOC 2 Type II /
// EU AI Act conformity) — local + offline, and the only caller of
// @evalguard/core's cert-gap analyzer.
export { registerCertGap } from "./cert-gap.js";
export { registerImportPromptfoo } from "./import-promptfoo.js";
export { registerImportTraces } from "./import-traces.js";
export { registerImportHumanloop } from "./import-humanloop.js";
export { registerImportLangsmith } from "./import-langsmith.js";
export { registerImportBraintrust } from "./import-braintrust.js";
export { registerImportDeepeval } from "./import-deepeval.js";
export { registerImportRagas } from "./import-ragas.js";
export { registerImportOpenaiEvals } from "./import-openai-evals.js";
export { registerImportGiskard } from "./import-giskard.js";
// Typed prompt-version management: .prompt push/pull + create/show/list/deploy.
export { registerPrompt } from "./prompt.js";
// Named deployment environments (Phase 2A): env list/create/remove.
export { registerEnv } from "./env.js";
// Named CONNECTION profiles — which install the CLI talks to (SaaS vs
// self-hosted, dev/stage/prod). Distinct from `env` above, which names
// DEPLOYMENT targets inside one install.
export { registerProfile } from "./profile.js";
// Versioned + deployable Tools (Phase 2B): tool push/pull/list/show/deploy.
export { registerTool } from "./tool.js";
export { registerShare } from "./share.js";
export { registerExport } from "./export.js";
export { registerVulnLookup } from "./vuln-lookup.js";
export { registerRetry } from "./retry.js";
export { registerScorecard } from "./scorecard.js";
export { registerDebug } from "./debug.js";
export { registerLogs } from "./logs.js";
export { registerDelete } from "./delete.js";
export { registerModelScan } from "./model-scan.js";
export { registerCodeScan } from "./code-scan.js";
export { registerSkillScan } from "./skill-scan.js";
export { registerAgentRules } from "./agent-rules.js";
export { registerIntent } from "./intent.js";
export { registerGenerateDataset } from "./generate-dataset.js";
export { registerView } from "./view.js";
export { registerCache } from "./cache.js";
export { registerOptimize } from "./optimize.js";
export { registerBenchmark } from "./benchmark.js";
export { registerKeys } from "./keys.js";
export { registerBudget } from "./budget.js";
export { registerPricing } from "./pricing.js";
export { registerAgentRuns } from "./agent-runs.js";
export { registerShadowAI } from "./shadow-ai.js";
export { registerSiem } from "./siem.js";
export { registerModelsPromote } from "./models-scan.js";
export { registerDatasets } from "./datasets.js";
export { registerRedTeam } from "./red-team.js";
export { registerRag } from "./rag.js";
export { registerMcp } from "./mcp.js";
export { registerGrpc } from "./grpc.js";
export { registerFineTune } from "./fine-tune.js";
export { registerClickhouse } from "./clickhouse.js";
export { registerAiBom } from "./ai-bom.js";
export { registerInfra } from "./infra.js";
export { registerRepoScan } from "./repo-scan.js";
export { registerEvaluators } from "./evaluators.js";
export { registerCostExport } from "./cost-export.js";
export { registerDecisionBom } from "./decision-bom.js";
export { registerRagAutoML } from "./rag-automl.js";
export { registerGatewayConfig } from "./gateway-config.js";
export { registerDetectorEval } from "./detector-eval.js";
export { registerAttackProof } from "./attack-proof.js";
export { registerAgentTools } from "./agent-tools.js";
export { registerAbuseReport } from "./abuse-report.js";
export { registerGuardrailShadow } from "./guardrail-shadow.js";
// Per-project gateway guardrail-config management (list/set/rm), incl. the two
// Wave-2 LOCAL agent guardrails (data-not-instructions, tool-call-circuit-breaker).
export { registerGuardrail } from "./guardrail.js";
export { registerRegressionTrigger } from "./regression-trigger.js";
export { registerAgentMemory } from "./agent-memory.js";
export { registerVoice } from "./voice.js";
export { registerModeration } from "./moderation.js";
export { registerLanguage } from "./language.js";
export { registerGovernanceRisk } from "./governance-risk.js";
export { registerFirewallFairnessReport } from "./firewall-fairness-report.js";
export { registerVulnWaiver } from "./vuln-waiver.js";
export { registerConsensus } from "./consensus.js";
export { registerSbomMonitor } from "./sbom-monitor.js";
export { registerIncidentRca } from "./incident-rca.js";
export { registerDataBoundary } from "./data-boundary.js";
export { registerIssueSync } from "./issue-sync.js";
export { registerIacScan } from "./iac-scan.js";
// G10 — committed-secret detection over repo file contents (signature-based).
export { registerSecretScan } from "./secret-scan.js";
// Server-READ commands: runs/scans/traces/prompts/scorers/webhooks — inspect
// what the EvalGuard SERVER persists (vs the local-only history/view commands).
export { registerServerRead } from "./server-read.js";
