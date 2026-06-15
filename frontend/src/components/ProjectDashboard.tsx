import { useState } from 'react';
import { AlertTriangle, CheckCircle2, TrendingUp, ArrowLeft, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import type { Project } from '../services';
import serverService from '../services/server';

interface ProjectDashboardProps {
  project: Project;
  onBack: () => void;
}

export function ProjectDashboard({ project, onBack }: ProjectDashboardProps) {
  const [downloading, setDownloading] = useState(false);
  const technicalReadiness = 72;

  const handleDownloadReport = async () => {
    setDownloading(true);
    try {
      const query = `
        query GenerateReportDownloadUrl($projectId: ID!) {
          generateReportDownloadUrl(projectId: $projectId) {
            url
            expiresIn
          }
        }
      `;
      const response = await serverService.query<{
        generateReportDownloadUrl: { url: string; expiresIn: number };
      }>(query, { projectId: project.id });
      window.open(response.generateReportDownloadUrl.url, '_blank');
    } catch (error) {
      console.error('Error generating download URL:', error);
      toast.error('Failed to generate download link. Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  const topGaps = [
    {
      title: 'Observability Strategy',
      severity: 'high' as const,
      description: 'Limited monitoring and tracing capabilities for agent decision-making processes',
    },
    {
      title: 'Security Guardrails',
      severity: 'high' as const,
      description: 'Missing approval mechanisms for high-risk agent actions',
    },
    {
      title: 'Data Integration Patterns',
      severity: 'medium' as const,
      description: 'Unclear strategy for real-time data synchronization with knowledge bases',
    },
  ];

  const topRecommendations = [
    {
      title: 'Implement Amazon Bedrock Agents with Built-in Orchestration',
      category: 'Architecture',
      impact: 'High',
    },
    {
      title: 'Use Bedrock Knowledge Bases for RAG Pattern',
      category: 'Data Integration',
      impact: 'High',
    },
    {
      title: 'Deploy CloudWatch Logs Insights for Agent Tracing',
      category: 'Observability',
      impact: 'Medium',
    },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              className="size-8"
            >
              <ArrowLeft className="size-4" />
            </Button>
            <h2 className="text-foreground">Assessment Summary</h2>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground ml-11">
              Technical feasibility analysis and recommendations for your agentic AI project
            </p>
            <Button
              variant="outline"
              className="gap-2 px-4 py-2 rounded-md font-medium inline-flex items-center transition-colors duration-200 bg-primary text-primary-foreground border-none cursor-pointer text-sm h-[38px] hover:bg-muted"
              onClick={handleDownloadReport}
              disabled={downloading}
            >
              <Download className="size-4" />
              {downloading ? 'Generating...' : 'Download Report'}
            </Button>
          </div>
        </div>

        <div className="grid gap-6 mb-8">
          <Card className="border-primary/50">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <TrendingUp className="size-5 text-primary" />
                    Technical Readiness Score
                  </CardTitle>
                  <CardDescription>Overall assessment of technical preparedness</CardDescription>
                </div>
                <div className="text-center">
                  <div className="text-5xl text-primary mb-1">{technicalReadiness}</div>
                  <div className="text-sm text-muted-foreground">out of 100</div>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Progress value={technicalReadiness} className="h-3" />
              <p className="text-sm text-muted-foreground mt-4">
                Your project demonstrates solid technical foundations with some areas requiring additional attention.
                The assessment identified key gaps in observability and security controls that should be addressed
                before production deployment.
              </p>
            </CardContent>
          </Card>

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="size-5 text-destructive" />
                  Top Gaps Identified
                </CardTitle>
                <CardDescription>Critical areas requiring attention</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {topGaps.map((gap, index) => (
                  <Card key={index} className="rounded-lg p-4 gap-0">
                    <div className="flex items-start justify-between mb-2">
                      <h4 className="text-foreground">{gap.title}</h4>
                      <Badge
                        variant={gap.severity === 'high' ? 'destructive' : 'secondary'}
                      >
                        {gap.severity === 'high' ? 'High' : 'Medium'}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{gap.description}</p>
                  </Card>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="size-5 text-primary" />
                  Top Recommendations
                </CardTitle>
                <CardDescription>AWS best practices for your project</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {topRecommendations.map((rec, index) => (
                  <Card key={index} className="rounded-lg p-4 gap-0">
                    <div className="flex items-start justify-between mb-2">
                      <h4 className="text-foreground pr-2">{rec.title}</h4>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs">
                        {rec.category}
                      </Badge>
                      <Badge
                        variant={rec.impact === 'High' ? 'default' : 'secondary'}
                        className={rec.impact === 'High' ? 'bg-primary text-xs' : 'text-xs'}
                      >
                        {rec.impact} Impact
                      </Badge>
                    </div>
                  </Card>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card className="bg-accent">
            <CardHeader>
              <CardTitle>High Level Design Architecture</CardTitle>
              <CardDescription>
                Recommended AWS architecture for your agentic AI system
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Card className="rounded-lg p-8 text-center gap-0">
                <svg viewBox="0 0 800 400" className="w-full h-auto">
                  <defs>
                    <marker
                      id="arrowhead"
                      markerWidth="10"
                      markerHeight="10"
                      refX="9"
                      refY="3"
                      orient="auto"
                    >
                      <polygon points="0 0, 10 3, 0 6" fill="#FF9900" />
                    </marker>
                  </defs>
                  
                  {/* User */}
                  <rect x="50" y="170" width="100" height="60" fill="#FF9900" rx="4" />
                  <text x="100" y="205" textAnchor="middle" fill="white" fontSize="14">User</text>
                  
                  {/* API Gateway */}
                  <rect x="220" y="170" width="120" height="60" fill="#FF9900" rx="4" />
                  <text x="280" y="195" textAnchor="middle" fill="white" fontSize="12">API Gateway</text>
                  <text x="280" y="215" textAnchor="middle" fill="white" fontSize="10">(REST API)</text>
                  
                  {/* Bedrock Agent */}
                  <rect x="410" y="50" width="140" height="80" fill="#232F3E" rx="4" />
                  <text x="480" y="80" textAnchor="middle" fill="white" fontSize="12">Bedrock Agent</text>
                  <text x="480" y="100" textAnchor="middle" fill="white" fontSize="10">(Claude Sonnet)</text>
                  
                  {/* Knowledge Base */}
                  <rect x="410" y="160" width="140" height="80" fill="#232F3E" rx="4" />
                  <text x="480" y="190" textAnchor="middle" fill="white" fontSize="12">Knowledge Base</text>
                  <text x="480" y="210" textAnchor="middle" fill="white" fontSize="10">(RAG Pattern)</text>
                  
                  {/* DynamoDB */}
                  <rect x="410" y="270" width="140" height="80" fill="#232F3E" rx="4" />
                  <text x="480" y="300" textAnchor="middle" fill="white" fontSize="12">DynamoDB</text>
                  <text x="480" y="320" textAnchor="middle" fill="white" fontSize="10">(State Storage)</text>
                  
                  {/* S3 */}
                  <rect x="620" y="160" width="130" height="80" fill="#146EB4" rx="4" />
                  <text x="685" y="190" textAnchor="middle" fill="white" fontSize="12">S3 Bucket</text>
                  <text x="685" y="210" textAnchor="middle" fill="white" fontSize="10">(Documents)</text>
                  
                  {/* Arrows */}
                  <line x1="150" y1="200" x2="220" y2="200" stroke="#FF9900" strokeWidth="2" markerEnd="url(#arrowhead)" />
                  <line x1="340" y1="190" x2="410" y2="150" stroke="#FF9900" strokeWidth="2" markerEnd="url(#arrowhead)" />
                  <line x1="340" y1="200" x2="410" y2="200" stroke="#FF9900" strokeWidth="2" markerEnd="url(#arrowhead)" />
                  <line x1="340" y1="210" x2="410" y2="280" stroke="#FF9900" strokeWidth="2" markerEnd="url(#arrowhead)" />
                  <line x1="550" y1="200" x2="620" y2="200" stroke="#FF9900" strokeWidth="2" markerEnd="url(#arrowhead)" />
                </svg>
                <p className="text-sm text-muted-foreground mt-4">
                  Detailed architecture diagram included in the PDF report
                </p>
              </Card>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Next Steps</CardTitle>
              <CardDescription>Recommended actions to move forward</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="flex flex-col gap-3">
                <li className="flex gap-3">
                  <span className="flex items-center justify-center size-6 rounded-full bg-primary text-primary-foreground flex-shrink-0">
                    1
                  </span>
                  <p className="text-sm">
                    Review the comprehensive PDF report with stakeholders and technical teams
                  </p>
                </li>
                <li className="flex gap-3">
                  <span className="flex items-center justify-center size-6 rounded-full bg-primary text-primary-foreground flex-shrink-0">
                    2
                  </span>
                  <p className="text-sm">
                    Address high-priority gaps in observability and security controls
                  </p>
                </li>
                <li className="flex gap-3">
                  <span className="flex items-center justify-center size-6 rounded-full bg-primary text-primary-foreground flex-shrink-0">
                    3
                  </span>
                  <p className="text-sm">
                    Engage with AWS Solutions Architects to refine the architecture design
                  </p>
                </li>
                <li className="flex gap-3">
                  <span className="flex items-center justify-center size-6 rounded-full bg-primary text-primary-foreground flex-shrink-0">
                    4
                  </span>
                  <p className="text-sm">
                    Begin proof-of-concept implementation using recommended Bedrock services
                  </p>
                </li>
              </ol>
            </CardContent>
          </Card>
        </div>
    </div>
  );
}
