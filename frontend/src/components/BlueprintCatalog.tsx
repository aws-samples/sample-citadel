/**
 * BlueprintCatalog Component
 * Browsable catalog of reusable blueprints with search, category filtering,
 * loading skeleton, empty state, and error state with retry.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 23.3
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { workflowApiService } from '../services/workflowApiService';
import { BlueprintCard, type BlueprintData } from './BlueprintCard';
import { BlueprintPreviewDialog } from './BlueprintPreviewDialog';
import { ImportBlueprintDialog } from './ImportBlueprintDialog';
import { Button } from './ui/button';
import { Input } from './ui/input';

type LoadState = 'loading' | 'loaded' | 'error';

function parseMetadata(metadata?: string): { category?: string; tags?: string[]; isSystem?: boolean } {
  if (!metadata) return {};
  try {
    return JSON.parse(metadata);
  } catch {
    return {};
  }
}

export function BlueprintCatalog() {
  const [blueprints, setBlueprints] = useState<BlueprintData[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [previewBlueprint, setPreviewBlueprint] = useState<BlueprintData | null>(null);
  const [importBlueprint, setImportBlueprint] = useState<BlueprintData | null>(null);

  const fetchBlueprints = useCallback(async () => {
    setLoadState('loading');
    try {
      const result = await workflowApiService.listBlueprints();
      setBlueprints(result.items || []);
      setLoadState('loaded');
    } catch {
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    fetchBlueprints();
  }, [fetchBlueprints]);

  // Derive unique categories from blueprint metadata
  const categories = useMemo(() => {
    const cats = new Set<string>();
    blueprints.forEach((bp) => {
      const meta = parseMetadata(bp.metadata);
      if (meta.category) cats.add(meta.category);
    });
    return Array.from(cats).sort();
  }, [blueprints]);

  // Filter blueprints by search and category
  const filtered = useMemo(() => {
    let result = blueprints;

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (bp) =>
          bp.name.toLowerCase().includes(q) ||
          (bp.description && bp.description.toLowerCase().includes(q))
      );
    }

    if (selectedCategory) {
      result = result.filter((bp) => {
        const meta = parseMetadata(bp.metadata);
        return meta.category === selectedCategory;
      });
    }

    return result;
  }, [blueprints, search, selectedCategory]);

  if (loadState === 'loading') {
    return (
      <div className="p-6" data-testid="blueprint-loading-skeleton">
        <div className="mb-6 h-10 bg-accent rounded animate-pulse" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-40 bg-accent rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-muted-foreground">Failed to load blueprints</p>
        <Button onClick={fetchBlueprints} size="sm">
          Retry
        </Button>
      </div>
    );
  }

  if (blueprints.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">No blueprints available</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Search input */}
      <div className="mb-4">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search blueprints..."
        />
      </div>

      {/* Category filter tabs */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <Button
          variant={selectedCategory === null ? 'default' : 'secondary'}
          size="sm"
          className="text-xs h-7 px-3"
          onClick={() => setSelectedCategory(null)}
        >
          All
        </Button>
        {categories.map((cat) => (
          <Button
            key={cat}
            variant={selectedCategory === cat ? 'default' : 'secondary'}
            size="sm"
            className="text-xs h-7 px-3"
            onClick={() => setSelectedCategory(cat)}
          >
            {cat}
          </Button>
        ))}
      </div>

      {/* Blueprint grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((bp) => (
          <BlueprintCard
            key={bp.workflowId}
            blueprint={bp}
            onUseInApp={setImportBlueprint}
            onPreview={setPreviewBlueprint}
          />
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="flex items-center justify-center h-32">
          <p className="text-muted-foreground text-sm">No blueprints match your filters</p>
        </div>
      )}

      {/* Preview dialog */}
      <BlueprintPreviewDialog
        blueprint={previewBlueprint!}
        open={previewBlueprint !== null}
        onClose={() => setPreviewBlueprint(null)}
      />

      {/* Import dialog */}
      <ImportBlueprintDialog
        blueprint={importBlueprint}
        open={importBlueprint !== null}
        onClose={() => setImportBlueprint(null)}
      />
    </div>
  );
}
