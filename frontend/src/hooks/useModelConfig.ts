/**
 * useModelConfig — loads the model catalog and the resolved model config once
 * on mount and exposes a manual `refresh`.
 *
 * Mirrors the structure of useGovernanceMode (mountedRef + useCallback
 * fetchData + refresh) but without a polling interval — model configuration
 * changes are operator-driven, so callers refresh explicitly after a mutation.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  modelConfigService,
  ModelCatalogEntry,
  ModelConfig,
} from '../services/modelConfigService';

export interface UseModelConfigResult {
  catalog: ModelCatalogEntry[];
  config: ModelConfig | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useModelConfig(): UseModelConfigResult {
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      const [catalogResult, configResult] = await Promise.all([
        modelConfigService.listModelCatalog(),
        modelConfigService.getModelConfig('platform'),
      ]);
      if (!mountedRef.current) return;
      setCatalog(catalogResult);
      setConfig(configResult);
      setError(null);
    } catch (err: any) {
      if (mountedRef.current) {
        setError(err?.message || 'Failed to load model configuration');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    fetchData(false);
  }, [fetchData]);

  useEffect(() => {
    mountedRef.current = true;
    fetchData(true);
    return () => {
      mountedRef.current = false;
    };
  }, [fetchData]);

  return { catalog, config, loading, error, refresh };
}

export default useModelConfig;
