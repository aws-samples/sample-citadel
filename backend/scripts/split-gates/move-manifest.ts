/**
 * The move manifest — the single source of truth for "what has moved out of
 * the backend stack, to where, and why".
 *
 * Phase 1 (decision 30e6d067, this stage): the projects / conversations /
 * documents / assessment / design-progress / planning / chatter domain
 * moved from BackendStack to CitadelProjectsStack. Every entry below was
 * derived directly from a diff between the committed pre-split baseline
 * (`split-baseline/citadel-backend-dev.json`, captured at commit ce6497b)
 * and a fresh synth of both citadel-backend-dev and citadel-projects-dev
 * after the move — not hand-typed. Re-derive with the same diff if the
 * moved Lambdas' construct IDs ever change.
 */
import { AllowlistEntry } from "./rails/rail1-removals-only";
import { MovedLambdaMapping } from "./rails/rail6-iam-equivalence";
import { MovedResolverMapping } from "./rails/rail7-resolver-equivalence";

/** Logical IDs the removals-only diff (rail 1) is allowed to see disappear from backend, with justification. */
export const REMOVAL_ALLOWLIST: AllowlistEntry[] = [
  // --- Lambda functions (14) ---
  {
    logicalId: "ProjectResolverFunction1AB69E16",
    justification:
      "Moved to CitadelProjectsStack (phase 1, decision 30e6d067).",
  },
  {
    logicalId: "ProjectResolverFunctionLogsC65D0DC1",
    justification: "LogGroup of ProjectResolverFunction; moved with it.",
  },
  {
    logicalId: "ProjectResolverFunctionServiceRoleD35F2FBB",
    justification: "Execution role of ProjectResolverFunction; moved with it.",
  },
  {
    logicalId: "ProjectResolverFunctionServiceRoleDefaultPolicy75B6E5A1",
    justification:
      "DefaultPolicy of ProjectResolverFunction's role; moved with it.",
  },
  {
    logicalId: "ConversationResolverFunctionA84FB482",
    justification:
      "Moved to CitadelProjectsStack (phase 1, decision 30e6d067).",
  },
  {
    logicalId: "ConversationResolverFunctionLogs1A830C4B",
    justification: "LogGroup of ConversationResolverFunction; moved with it.",
  },
  {
    logicalId: "ConversationResolverFunctionServiceRoleF6A23AA5",
    justification:
      "Execution role of ConversationResolverFunction; moved with it.",
  },
  {
    logicalId: "ConversationResolverFunctionServiceRoleDefaultPolicy017815CF",
    justification:
      "DefaultPolicy of ConversationResolverFunction's role; moved with it.",
  },
  {
    logicalId: "AgentResolverFunctionEF491ADF",
    justification:
      "Moved to CitadelProjectsStack (phase 1, decision 30e6d067).",
  },
  {
    logicalId: "AgentResolverFunctionLogs14A0600B",
    justification: "LogGroup of AgentResolverFunction; moved with it.",
  },
  {
    logicalId: "AgentResolverFunctionServiceRole5824F55A",
    justification: "Execution role of AgentResolverFunction; moved with it.",
  },
  {
    logicalId: "AgentResolverFunctionServiceRoleDefaultPolicy23EF618E",
    justification:
      "DefaultPolicy of AgentResolverFunction's role; moved with it.",
  },
  {
    logicalId: "DocumentUploadResolverFunction905C268F",
    justification:
      "Moved to CitadelProjectsStack (phase 1, decision 30e6d067).",
  },
  {
    logicalId: "DocumentUploadResolverFunctionLogsC5B9C38B",
    justification: "LogGroup of DocumentUploadResolverFunction; moved with it.",
  },
  {
    logicalId: "DocumentUploadResolverFunctionServiceRole31545179",
    justification:
      "Execution role of DocumentUploadResolverFunction; moved with it.",
  },
  {
    logicalId: "DocumentUploadResolverFunctionServiceRoleDefaultPolicy4277A959",
    justification:
      "DefaultPolicy of DocumentUploadResolverFunction's role; moved with it.",
  },
  {
    logicalId: "DocumentResolverFunctionADF84905",
    justification:
      "Moved to CitadelProjectsStack (phase 1, decision 30e6d067).",
  },
  {
    logicalId: "DocumentResolverFunctionLogs55EED230",
    justification: "LogGroup of DocumentResolverFunction; moved with it.",
  },
  {
    logicalId: "DocumentResolverFunctionServiceRole185574A3",
    justification: "Execution role of DocumentResolverFunction; moved with it.",
  },
  {
    logicalId: "DocumentResolverFunctionServiceRoleDefaultPolicy4635269E",
    justification:
      "DefaultPolicy of DocumentResolverFunction's role; moved with it.",
  },
  {
    logicalId: "ChatterPublisherFunction40B50CEA",
    justification:
      "Moved to CitadelProjectsStack (phase 1, decision 30e6d067).",
  },
  {
    logicalId: "ChatterPublisherFunctionLogs703E6915",
    justification: "LogGroup of ChatterPublisherFunction; moved with it.",
  },
  {
    logicalId: "ChatterPublisherFunctionServiceRoleBD9E5EE0",
    justification: "Execution role of ChatterPublisherFunction; moved with it.",
  },
  {
    logicalId: "ChatterPublisherFunctionServiceRoleDefaultPolicy3ACB2AD8",
    justification:
      "DefaultPolicy of ChatterPublisherFunction's role; moved with it.",
  },
  {
    logicalId: "ChatterResolverFunction3B170D4D",
    justification:
      "Moved to CitadelProjectsStack (phase 1, decision 30e6d067).",
  },
  {
    logicalId: "ChatterResolverFunctionLogsAC2AD360",
    justification: "LogGroup of ChatterResolverFunction; moved with it.",
  },
  {
    logicalId: "ChatterResolverFunctionServiceRole5E890AE9",
    justification:
      "Execution role of ChatterResolverFunction (no DefaultPolicy — no addToRolePolicy calls); moved with it.",
  },
  {
    logicalId: "ProjectProgressUpdater66E18062",
    justification:
      "Moved to CitadelProjectsStack (phase 1, decision 30e6d067).",
  },
  {
    logicalId: "ProjectProgressUpdaterLogs9A56750A",
    justification: "LogGroup of ProjectProgressUpdater; moved with it.",
  },
  {
    logicalId: "ProjectProgressUpdaterServiceRoleC9BF95C7",
    justification: "Execution role of ProjectProgressUpdater; moved with it.",
  },
  {
    logicalId: "ProjectProgressUpdaterServiceRoleDefaultPolicyA81D2263",
    justification:
      "DefaultPolicy of ProjectProgressUpdater's role; moved with it.",
  },
  {
    logicalId: "AssessmentCompletionNotifierF2243F8D",
    justification:
      "Moved to CitadelProjectsStack (phase 1, decision 30e6d067).",
  },
  {
    logicalId: "AssessmentCompletionNotifierLogsE93BC728",
    justification: "LogGroup of AssessmentCompletionNotifier; moved with it.",
  },
  {
    logicalId: "AssessmentCompletionNotifierServiceRole17069A96",
    justification:
      "Execution role of AssessmentCompletionNotifier; moved with it.",
  },
  {
    logicalId: "AssessmentCompletionNotifierServiceRoleDefaultPolicy0D48BA2B",
    justification:
      "DefaultPolicy of AssessmentCompletionNotifier's role; moved with it.",
  },
  {
    logicalId: "AssessmentCompletionResolverFunction01CCC17D",
    justification:
      "Moved to CitadelProjectsStack (phase 1, decision 30e6d067).",
  },
  {
    logicalId: "AssessmentCompletionResolverFunctionLogsADA7B248",
    justification:
      "LogGroup of AssessmentCompletionResolverFunction; moved with it.",
  },
  {
    logicalId: "AssessmentCompletionResolverFunctionServiceRole09A608DC",
    justification:
      "Execution role of AssessmentCompletionResolverFunction (no DefaultPolicy); moved with it.",
  },
  {
    logicalId: "AssessmentProgressResolverFunctionC05492C6",
    justification:
      "Moved to CitadelProjectsStack (phase 1, decision 30e6d067).",
  },
  {
    logicalId: "AssessmentProgressResolverFunctionLogsC1A7E017",
    justification:
      "LogGroup of AssessmentProgressResolverFunction; moved with it.",
  },
  {
    logicalId: "AssessmentProgressResolverFunctionServiceRole799D9B79",
    justification:
      "Execution role of AssessmentProgressResolverFunction; moved with it.",
  },
  {
    logicalId:
      "AssessmentProgressResolverFunctionServiceRoleDefaultPolicy0F187242",
    justification:
      "DefaultPolicy of AssessmentProgressResolverFunction's role; moved with it.",
  },
  {
    logicalId: "DesignProgressNotifier61A5E671",
    justification:
      "Moved to CitadelProjectsStack (phase 1, decision 30e6d067).",
  },
  {
    logicalId: "DesignProgressNotifierLogsD652E6CB",
    justification: "LogGroup of DesignProgressNotifier; moved with it.",
  },
  {
    logicalId: "DesignProgressNotifierServiceRole1321C778",
    justification: "Execution role of DesignProgressNotifier; moved with it.",
  },
  {
    logicalId: "DesignProgressNotifierServiceRoleDefaultPolicyC0A04D28",
    justification:
      "DefaultPolicy of DesignProgressNotifier's role; moved with it.",
  },
  {
    logicalId: "DesignProgressResolverFunctionCDC01114",
    justification:
      "Moved to CitadelProjectsStack (phase 1, decision 30e6d067).",
  },
  {
    logicalId: "DesignProgressResolverFunctionLogs12C92D91",
    justification: "LogGroup of DesignProgressResolverFunction; moved with it.",
  },
  {
    logicalId: "DesignProgressResolverFunctionServiceRoleD95F9C64",
    justification:
      "Execution role of DesignProgressResolverFunction (no DefaultPolicy); moved with it.",
  },
  {
    logicalId: "GenerateReportUrlFunction63D5CCD0",
    justification:
      "Moved to CitadelProjectsStack (phase 1, decision 30e6d067).",
  },
  {
    logicalId: "GenerateReportUrlFunctionLogs3A7D33F3",
    justification: "LogGroup of GenerateReportUrlFunction; moved with it.",
  },
  {
    logicalId: "GenerateReportUrlFunctionServiceRole5330DB34",
    justification:
      "Execution role of GenerateReportUrlFunction; moved with it.",
  },
  {
    logicalId: "GenerateReportUrlFunctionServiceRoleDefaultPolicyA9D4C228",
    justification:
      "DefaultPolicy of GenerateReportUrlFunction's role; moved with it.",
  },
  // --- EventBridge rules + their auto-generated Lambda invoke permissions (4 rules) ---
  {
    logicalId: "ChatterRule264A0546",
    justification: "Targets ChatterPublisherFunction only; moved with it.",
  },
  {
    logicalId:
      "ChatterRuleAllowEventRulecitadelbackenddevChatterPublisherFunction37FCEB3EBE70000E",
    justification:
      "Auto-generated Lambda::Permission for ChatterRule's target; moved with it.",
  },
  {
    logicalId: "ProgressUpdateRule1132E7FE",
    justification: "Targets ProjectProgressUpdater only; moved with it.",
  },
  {
    logicalId:
      "ProgressUpdateRuleAllowEventRulecitadelbackenddevProjectProgressUpdaterE26B1FC232D7AEB6",
    justification:
      "Auto-generated Lambda::Permission for ProgressUpdateRule's target; moved with it.",
  },
  {
    logicalId: "AssessmentCompletionRule184CD45C",
    justification: "Targets AssessmentCompletionNotifier only; moved with it.",
  },
  {
    logicalId:
      "AssessmentCompletionRuleAllowEventRulecitadelbackenddevAssessmentCompletionNotifier86C7D303E464C82A",
    justification:
      "Auto-generated Lambda::Permission for AssessmentCompletionRule's target; moved with it.",
  },
  {
    logicalId: "DesignProgressRule4722B2BE",
    justification: "Targets DesignProgressNotifier only; moved with it.",
  },
  {
    logicalId:
      "DesignProgressRuleAllowEventRulecitadelbackenddevDesignProgressNotifierC92BAAEF4E3FBB11",
    justification:
      "Auto-generated Lambda::Permission for DesignProgressRule's target; moved with it.",
  },
  // --- AppSync DataSources + their service roles (10 Lambda DS + 3 dead DynamoDB DS) ---
  {
    logicalId: "AgenticAIApiProjectLambdaDataSource3B8E595B",
    justification:
      "DataSource for moved project resolvers; recreated as ProjectLambdaDataSource in CitadelProjectsStack.",
  },
  {
    logicalId: "AgenticAIApiProjectLambdaDataSourceServiceRoleFDD9E507",
    justification: "Service role of ProjectLambdaDataSource; moved with it.",
  },
  {
    logicalId:
      "AgenticAIApiProjectLambdaDataSourceServiceRoleDefaultPolicyF015540F",
    justification:
      "DefaultPolicy of ProjectLambdaDataSource's role; moved with it.",
  },
  {
    logicalId: "AgenticAIApiConversationLambdaDataSource0F5CEA1A",
    justification:
      "DataSource for moved conversation resolvers; recreated in CitadelProjectsStack.",
  },
  {
    logicalId: "AgenticAIApiConversationLambdaDataSourceServiceRole083029CC",
    justification:
      "Service role of ConversationLambdaDataSource; moved with it.",
  },
  {
    logicalId:
      "AgenticAIApiConversationLambdaDataSourceServiceRoleDefaultPolicy22411EBC",
    justification:
      "DefaultPolicy of ConversationLambdaDataSource's role; moved with it.",
  },
  {
    logicalId: "AgenticAIApiAgentLambdaDataSourceDA63EBDA",
    justification:
      "DataSource for moved getAgentStatus resolver; recreated in CitadelProjectsStack.",
  },
  {
    logicalId: "AgenticAIApiAgentLambdaDataSourceServiceRoleBF5FEDBE",
    justification: "Service role of AgentLambdaDataSource; moved with it.",
  },
  {
    logicalId:
      "AgenticAIApiAgentLambdaDataSourceServiceRoleDefaultPolicyF10F15C6",
    justification:
      "DefaultPolicy of AgentLambdaDataSource's role; moved with it.",
  },
  {
    logicalId: "AgenticAIApiDocumentUploadLambdaDataSource4BC80711",
    justification:
      "DataSource for moved document-upload resolvers; recreated in CitadelProjectsStack.",
  },
  {
    logicalId: "AgenticAIApiDocumentUploadLambdaDataSourceServiceRole5B0EFE97",
    justification:
      "Service role of DocumentUploadLambdaDataSource; moved with it.",
  },
  {
    logicalId:
      "AgenticAIApiDocumentUploadLambdaDataSourceServiceRoleDefaultPolicy1A76D465",
    justification:
      "DefaultPolicy of DocumentUploadLambdaDataSource's role; moved with it.",
  },
  {
    logicalId: "AgenticAIApiDocumentLambdaDataSource49614661",
    justification:
      "DataSource for moved document resolvers; recreated in CitadelProjectsStack.",
  },
  {
    logicalId: "AgenticAIApiDocumentLambdaDataSourceServiceRole6C3C0E9B",
    justification: "Service role of DocumentLambdaDataSource; moved with it.",
  },
  {
    logicalId:
      "AgenticAIApiDocumentLambdaDataSourceServiceRoleDefaultPolicy24047825",
    justification:
      "DefaultPolicy of DocumentLambdaDataSource's role; moved with it.",
  },
  {
    logicalId: "AgenticAIApiChatterLambdaDataSource7A18574D",
    justification:
      "DataSource for moved publishChatter resolver; recreated in CitadelProjectsStack.",
  },
  {
    logicalId: "AgenticAIApiChatterLambdaDataSourceServiceRole8B68A612",
    justification: "Service role of ChatterLambdaDataSource; moved with it.",
  },
  {
    logicalId:
      "AgenticAIApiChatterLambdaDataSourceServiceRoleDefaultPolicy4BCA5365",
    justification:
      "DefaultPolicy of ChatterLambdaDataSource's role; moved with it.",
  },
  {
    logicalId: "AgenticAIApiAssessmentCompletionLambdaDataSourceD6ED942E",
    justification:
      "DataSource for moved publishAssessmentCompletion resolver; recreated in CitadelProjectsStack.",
  },
  {
    logicalId:
      "AgenticAIApiAssessmentCompletionLambdaDataSourceServiceRole1C2C5431",
    justification:
      "Service role of AssessmentCompletionLambdaDataSource; moved with it.",
  },
  {
    logicalId:
      "AgenticAIApiAssessmentCompletionLambdaDataSourceServiceRoleDefaultPolicy41FDCE83",
    justification:
      "DefaultPolicy of AssessmentCompletionLambdaDataSource's role; moved with it.",
  },
  {
    logicalId: "AgenticAIApiAssessmentProgressLambdaDataSourceD3E4191F",
    justification:
      "DataSource for moved getAssessmentProgress resolver; recreated in CitadelProjectsStack.",
  },
  {
    logicalId:
      "AgenticAIApiAssessmentProgressLambdaDataSourceServiceRole34F91CE6",
    justification:
      "Service role of AssessmentProgressLambdaDataSource; moved with it.",
  },
  {
    logicalId:
      "AgenticAIApiAssessmentProgressLambdaDataSourceServiceRoleDefaultPolicy9D219235",
    justification:
      "DefaultPolicy of AssessmentProgressLambdaDataSource's role; moved with it.",
  },
  {
    logicalId: "AgenticAIApiDesignProgressLambdaDataSource0B9C4AAA",
    justification:
      "DataSource for moved publishDesignProgress resolver; recreated in CitadelProjectsStack.",
  },
  {
    logicalId: "AgenticAIApiDesignProgressLambdaDataSourceServiceRole7F0D9227",
    justification:
      "Service role of DesignProgressLambdaDataSource; moved with it.",
  },
  {
    logicalId:
      "AgenticAIApiDesignProgressLambdaDataSourceServiceRoleDefaultPolicy9255715C",
    justification:
      "DefaultPolicy of DesignProgressLambdaDataSource's role; moved with it.",
  },
  {
    logicalId: "AgenticAIApiGenerateReportUrlDataSource2BEEB1F4",
    justification:
      "DataSource for moved generateReportDownloadUrl resolver; recreated in CitadelProjectsStack.",
  },
  {
    logicalId: "AgenticAIApiGenerateReportUrlDataSourceServiceRoleC36FF3A0",
    justification:
      "Service role of GenerateReportUrlDataSource; moved with it.",
  },
  {
    logicalId:
      "AgenticAIApiGenerateReportUrlDataSourceServiceRoleDefaultPolicyF85F1259",
    justification:
      "DefaultPolicy of GenerateReportUrlDataSource's role; moved with it.",
  },
  {
    logicalId: "AgenticAIApiProjectsDataSourceA5D879B8",
    justification:
      "Unused DynamoDB DataSource (never had a resolver attached in the pre-split baseline either); dropped rather than recreated, since it served no field.",
  },
  {
    logicalId: "AgenticAIApiProjectsDataSourceServiceRoleB722A09A",
    justification:
      "Service role of the unused ProjectsDataSource; dropped with it.",
  },
  {
    logicalId: "AgenticAIApiProjectsDataSourceServiceRoleDefaultPolicy97526FA2",
    justification:
      "DefaultPolicy of the unused ProjectsDataSource's role; dropped with it.",
  },
  {
    logicalId: "AgenticAIApiConversationsDataSource50154233",
    justification:
      "Unused DynamoDB DataSource (never had a resolver attached in the pre-split baseline either); dropped rather than recreated, since it served no field.",
  },
  {
    logicalId: "AgenticAIApiConversationsDataSourceServiceRoleDA8EEF07",
    justification:
      "Service role of the unused ConversationsDataSource; dropped with it.",
  },
  {
    logicalId:
      "AgenticAIApiConversationsDataSourceServiceRoleDefaultPolicy29CD7256",
    justification:
      "DefaultPolicy of the unused ConversationsDataSource's role; dropped with it.",
  },
  {
    logicalId: "AgenticAIApiAgentStatusDataSourceC16782E0",
    justification:
      "Unused DynamoDB DataSource (never had a resolver attached in the pre-split baseline either); dropped rather than recreated, since it served no field.",
  },
  {
    logicalId: "AgenticAIApiAgentStatusDataSourceServiceRole955C06E5",
    justification:
      "Service role of the unused AgentStatusDataSource; dropped with it.",
  },
  {
    logicalId:
      "AgenticAIApiAgentStatusDataSourceServiceRoleDefaultPolicy2E87E1F4",
    justification:
      "DefaultPolicy of the unused AgentStatusDataSource's role; dropped with it.",
  },
  // --- AppSync Resolvers (23) ---
  {
    logicalId: "AgenticAIApiGetProjectResolverEA8B2F67",
    justification: "Moved to CitadelProjectsStack as GetProjectResolver.",
  },
  {
    logicalId: "AgenticAIApiListProjectsResolver3F1F1150",
    justification: "Moved to CitadelProjectsStack as ListProjectsResolver.",
  },
  {
    logicalId: "AgenticAIApiCreateProjectResolver15C9890E",
    justification: "Moved to CitadelProjectsStack as CreateProjectResolver.",
  },
  {
    logicalId: "AgenticAIApiUpdateProjectResolver8D527D4B",
    justification: "Moved to CitadelProjectsStack as UpdateProjectResolver.",
  },
  {
    logicalId: "AgenticAIApiUploadDocumentResolverA75B2DE0",
    justification: "Moved to CitadelProjectsStack as UploadDocumentResolver.",
  },
  {
    logicalId: "AgenticAIApiGetAgentStatusResolverE4790BA2",
    justification: "Moved to CitadelProjectsStack as GetAgentStatusResolver.",
  },
  {
    logicalId: "AgenticAIApiGetConversationHistoryResolverA891E8EE",
    justification:
      "Moved to CitadelProjectsStack as GetConversationHistoryResolver.",
  },
  {
    logicalId: "AgenticAIApiSendMessageResolver7BECC9D3",
    justification: "Moved to CitadelProjectsStack as SendMessageResolver.",
  },
  {
    logicalId: "AgenticAIApiPublishConversationMessageResolverB0BE2EEB",
    justification:
      "Moved to CitadelProjectsStack as PublishConversationMessageResolver.",
  },
  {
    logicalId: "AgenticAIApiSendMessageToAgentResolver2E8BB9BA",
    justification:
      "Moved to CitadelProjectsStack as SendMessageToAgentResolver.",
  },
  {
    logicalId: "AgenticAIApiGenerateDocumentUploadUrlResolver1710E567",
    justification:
      "Moved to CitadelProjectsStack as GenerateDocumentUploadUrlResolver.",
  },
  {
    logicalId: "AgenticAIApiGetDocumentIngestionStatusResolver1273B9A6",
    justification:
      "Moved to CitadelProjectsStack as GetDocumentIngestionStatusResolver.",
  },
  {
    logicalId: "AgenticAIApiListProjectDocumentsResolver8233808C",
    justification:
      "Moved to CitadelProjectsStack as ListProjectDocumentsResolver.",
  },
  {
    logicalId: "AgenticAIApiDeleteDocumentResolver2EFF3AED",
    justification: "Moved to CitadelProjectsStack as DeleteDocumentResolver.",
  },
  {
    logicalId: "AgenticAIApiGetProjectDocumentResolver980F0E28",
    justification:
      "Moved to CitadelProjectsStack as GetProjectDocumentResolver.",
  },
  {
    logicalId: "AgenticAIApiListDocumentVersionsResolver3F603C9D",
    justification:
      "Moved to CitadelProjectsStack as ListDocumentVersionsResolver.",
  },
  {
    logicalId: "AgenticAIApiGetDocumentVersionResolver9FF311AD",
    justification:
      "Moved to CitadelProjectsStack as GetDocumentVersionResolver.",
  },
  {
    logicalId: "AgenticAIApiGenerateDocumentPdfResolver31C667B1",
    justification:
      "Moved to CitadelProjectsStack as GenerateDocumentPdfResolver.",
  },
  {
    logicalId: "AgenticAIApiPublishChatterResolverD144FAF4",
    justification: "Moved to CitadelProjectsStack as PublishChatterResolver.",
  },
  {
    logicalId: "AgenticAIApiPublishAssessmentCompletionResolver7D8B1F67",
    justification:
      "Moved to CitadelProjectsStack as PublishAssessmentCompletionResolver.",
  },
  {
    logicalId: "AgenticAIApiGetAssessmentProgressResolver9ECD99A8",
    justification:
      "Moved to CitadelProjectsStack as GetAssessmentProgressResolver.",
  },
  {
    logicalId: "AgenticAIApiPublishDesignProgressResolver4D37FB3B",
    justification:
      "Moved to CitadelProjectsStack as PublishDesignProgressResolver.",
  },
  {
    logicalId: "AgenticAIApiGenerateReportDownloadUrlResolver498E58D8",
    justification:
      "Moved to CitadelProjectsStack as GenerateReportDownloadUrlResolver.",
  },
  // --- CloudWatch Alarms (2, followed ProjectResolverFunction) ---
  {
    logicalId: "ProjectResolverErrorAlarm6D4A121B",
    justification:
      "Alarm on ProjectResolverFunction; recreated in CitadelProjectsStack as ProjectResolverErrorAlarm.",
  },
  {
    logicalId: "ProjectResolverThrottleAlarmD3F0F4B5",
    justification:
      "Alarm on ProjectResolverFunction; recreated in CitadelProjectsStack as ProjectResolverThrottleAlarm.",
  },
];

/** Resolver fields moved to a satellite stack, for rail 3 parity + rail 7 equivalence. */
export const MOVED_RESOLVERS: MovedResolverMapping[] = [
  { fieldKey: "Query.getProject", satelliteStackName: "citadel-projects-dev" },
  {
    fieldKey: "Query.listProjects",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Mutation.createProject",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Mutation.updateProject",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Mutation.uploadDocument",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Query.getAgentStatus",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Query.getConversationHistory",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Mutation.sendMessage",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Mutation.publishConversationMessage",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Mutation.sendMessageToAgent",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Mutation.generateDocumentUploadUrl",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Query.getDocumentIngestionStatus",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Query.listProjectDocuments",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Mutation.deleteDocument",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Query.getProjectDocument",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Query.listDocumentVersions",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Query.getDocumentVersion",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Mutation.generateDocumentPdf",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Mutation.publishChatter",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Mutation.publishAssessmentCompletion",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Query.getAssessmentProgress",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Mutation.publishDesignProgress",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    fieldKey: "Query.generateReportDownloadUrl",
    satelliteStackName: "citadel-projects-dev",
  },
];

/** Lambda logical-ID name-mapping (backend baseline -> satellite) for rail 6 IAM equivalence. */
export const MOVED_LAMBDA_ROLES: MovedLambdaMapping[] = [
  {
    baselineLogicalId: "ProjectResolverFunction1AB69E16",
    satelliteLogicalId: "ProjectResolverFunction1AB69E16",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    baselineLogicalId: "ConversationResolverFunctionA84FB482",
    satelliteLogicalId: "ConversationResolverFunctionA84FB482",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    baselineLogicalId: "AgentResolverFunctionEF491ADF",
    satelliteLogicalId: "AgentResolverFunctionEF491ADF",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    baselineLogicalId: "DocumentUploadResolverFunction905C268F",
    satelliteLogicalId: "DocumentUploadResolverFunction905C268F",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    baselineLogicalId: "DocumentResolverFunctionADF84905",
    satelliteLogicalId: "DocumentResolverFunctionADF84905",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    baselineLogicalId: "ChatterPublisherFunction40B50CEA",
    satelliteLogicalId: "ChatterPublisherFunction40B50CEA",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    baselineLogicalId: "ChatterResolverFunction3B170D4D",
    satelliteLogicalId: "ChatterResolverFunction3B170D4D",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    baselineLogicalId: "ProjectProgressUpdater66E18062",
    satelliteLogicalId: "ProjectProgressUpdater66E18062",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    baselineLogicalId: "AssessmentCompletionNotifierF2243F8D",
    satelliteLogicalId: "AssessmentCompletionNotifierF2243F8D",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    baselineLogicalId: "AssessmentCompletionResolverFunction01CCC17D",
    satelliteLogicalId: "AssessmentCompletionResolverFunction01CCC17D",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    baselineLogicalId: "AssessmentProgressResolverFunctionC05492C6",
    satelliteLogicalId: "AssessmentProgressResolverFunctionC05492C6",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    baselineLogicalId: "DesignProgressNotifier61A5E671",
    satelliteLogicalId: "DesignProgressNotifier61A5E671",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    baselineLogicalId: "DesignProgressResolverFunctionCDC01114",
    satelliteLogicalId: "DesignProgressResolverFunctionCDC01114",
    satelliteStackName: "citadel-projects-dev",
  },
  {
    baselineLogicalId: "GenerateReportUrlFunction63D5CCD0",
    satelliteLogicalId: "GenerateReportUrlFunction63D5CCD0",
    satelliteStackName: "citadel-projects-dev",
  },
];

/** Satellite stack names participating in the split, for rail 3's merged-set computation. */
export const SATELLITE_STACK_NAMES: string[] = ["citadel-projects-dev"];
