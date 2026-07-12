import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import type { PlantInsightsResponse } from '../_types';

interface UsePlantInsightsReturn {
  data: PlantInsightsResponse | null;
  loading: boolean;
  error: string | null;
}

export function usePlantInsights(projectId: string, plantId: string): UsePlantInsightsReturn {
  const [data, setData] = useState<PlantInsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchInsights() {
      setLoading(true);
      setError(null);
      try {
        const insights = await api.get<PlantInsightsResponse>(
          `/projects/${projectId}/plants/${plantId}/insights`
        );
        setData(insights);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to load insights';
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    }

    fetchInsights();
  }, [projectId, plantId]);

  return { data, loading, error };
}
