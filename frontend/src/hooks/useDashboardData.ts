/**
 * Dashboard Data Hook
 *
 * Fetches entity lists from existing GraphQL APIs in parallel,
 * computes summary counts and deltas, and polls for updates.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { projectService } from '../services/projectService';
import { agentConfigService } from '../services/agentConfigService';
import { workflowApiService } from '../services/workflowApiService';
import { integrationServiceBackend } from '../services/integrationServiceBackend';
import { datastoreService } from '../services/datastoreService';

const ACTIVE_STATUSES = new Set([
  'IN_PROGRESS', 'ASSESSMENT_COMPLETE', 'DESIGN_COMPLETE',
  'PLANNING_COMPLETE', 'IMPLEMENTATION_READY',
]);

const POLL_INTERVAL = 60_000;

export interface DashboardCounts {
  activeRequests: number;
  deployedAgents: number;
  totalWorkflows: number;
  connectedIntegrations: number;
  connectedDataStores: number;
  totalDataStores: number;
  deltas: {
    activeRequests: number;
    deployedAgents: number;
    workflows: number;
    integrations: number;
  };
}

export interface DashboardData {
  projects: any[];
  agents: any[];
  workflows: any[];
  integrations: any[];
  dataStores: any[];
  counts: DashboardCounts;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function computeCounts(
  projects: any[],
  agents: any[],
  workflows: any[],
  integrations: any[],
  dataStores: any[],
): DashboardCounts {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const isRecent = (d: string | undefined) => d ? new Date(d) > weekAgo : false;

  return {
    activeRequests: projects.filter(p => ACTIVE_STATUSES.has(p.status)).length,
    deployedAgents: agents.filter(a => a.state === 'active').length,
    totalWorkflows: workflows.length,
    connectedIntegrations: integrations.filter(i => i.status === 'connected').length,
    connectedDataStores: dataStores.filter(d => d.status === 'CONNECTED').length,
    totalDataStores: dataStores.length,
    deltas: {
      activeRequests: projects.filter(p => ACTIVE_STATUSES.has(p.status) && isRecent(p.createdAt)).length,
      deployedAgents: agents.filter(a => a.state === 'active' && isRecent(a.createdAt)).length,
      workflows: workflows.filter(w => isRecent(w.createdAt)).length,
      integrations: integrations.filter(i => i.status === 'connected' && isRecent(i.createdAt)).length,
    },
  };
}

const EMPTY_COUNTS: DashboardCounts = {
  activeRequests: 0, deployedAgents: 0, totalWorkflows: 0,
  connectedIntegrations: 0, connectedDataStores: 0, totalDataStores: 0,
  deltas: { activeRequests: 0, deployedAgents: 0, workflows: 0, integrations: 0 },
};

export function useDashboardData(): DashboardData {
  const [projects, setProjects] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [dataStores, setDataStores] = useState<any[]>([]);
  const [counts, setCounts] = useState<DashboardCounts>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    setError(null);

    try {
      const results = await Promise.allSettled([
        projectService.listProjects(),
        agentConfigService.listAgentConfigs(),
        workflowApiService.listWorkflows('default'),
        integrationServiceBackend.listIntegrations('default'),
        datastoreService.listDataStores('default'),
      ]);

      if (!mountedRef.current) return;

      const p = results[0].status === 'fulfilled' ? (results[0].value?.items || results[0].value || []) : projects;
      const a = results[1].status === 'fulfilled' ? (results[1].value || []) : agents;
      const w = results[2].status === 'fulfilled' ? (results[2].value?.items || results[2].value || []) : workflows;
      const i = results[3].status === 'fulfilled' ? (results[3].value || []) : integrations;
      const d = results[4].status === 'fulfilled' ? (results[4].value || []) : dataStores;

      setProjects(p);
      setAgents(a);
      setWorkflows(w);
      setIntegrations(i);
      setDataStores(d);
      setCounts(computeCounts(p, a, w, i, d));

      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        setError(`${failures.length} API call(s) failed`);
      }
    } catch (err: any) {
      if (mountedRef.current) {
        setError(err.message || 'Failed to load dashboard data');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => { fetchData(false); }, [fetchData]);

  useEffect(() => {
    mountedRef.current = true;
    fetchData(true);
    const interval = setInterval(() => fetchData(false), POLL_INTERVAL);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchData]);

  return { projects, agents, workflows, integrations, dataStores, counts, loading, error, refresh };
}
