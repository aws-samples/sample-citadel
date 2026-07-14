import { useEffect, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  modelConfigService,
  ModelCatalogEntry,
} from '../services/modelConfigService';

/**
 * Sentinel value for the "use platform default" option. Radix `SelectItem`
 * cannot use an empty string as its value, so the empty stored value (meaning
 * "no override — use the platform default") is mapped to this sentinel in the
 * UI and translated back to '' on change.
 */
const DEFAULT_VALUE = '__default__';

export interface ModelOverrideSelectProps {
  value?: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
}

/**
 * Catalog-backed dropdown for the per-agent model override. Stores a catalog
 * `modelKey`, or '' to mean "use the platform default". The stored value is
 * dormant at runtime today; this control only changes how the override is
 * edited and the shape of the value that gets persisted.
 *
 * Fully data-driven: every model option is derived from the enabled model
 * catalog, so there are no hardcoded model-id literals. A non-empty incoming
 * value that is not an enabled catalog key (e.g. a legacy free-text entry) is
 * preserved as a trailing "Current: <value>" option so editing a binding never
 * silently drops it.
 */
export function ModelOverrideSelect({
  value,
  onChange,
  disabled,
  id,
  'aria-label': ariaLabel,
}: ModelOverrideSelectProps) {
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    modelConfigService
      .listModelCatalog()
      .then((entries) => {
        if (!mounted) return;
        setCatalog(entries.filter((entry) => entry.status === 'enabled'));
        setError(null);
      })
      .catch((err: any) => {
        if (mounted) setError(err?.message || 'Failed to load model catalog');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const hasValue = typeof value === 'string' && value.length > 0;
  const selectValue = hasValue ? value : DEFAULT_VALUE;
  const isLegacyValue =
    hasValue && !catalog.some((entry) => entry.modelKey === value);

  return (
    <div className="flex flex-col gap-1">
      <Select
        value={selectValue}
        onValueChange={(v) => onChange(v === DEFAULT_VALUE ? '' : v)}
        disabled={disabled || loading}
      >
        <SelectTrigger
          id={id}
          aria-label={ariaLabel}
          className="cursor-pointer bg-transparent border border-input text-foreground text-xs"
        >
          <SelectValue
            placeholder={loading ? 'Loading models…' : 'Use platform default'}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_VALUE}>Use platform default</SelectItem>
          {catalog.map((entry) => (
            <SelectItem key={entry.modelKey} value={entry.modelKey}>
              {`${entry.provider} · ${entry.baseModelId}${
                entry.supportsTools ? ' · tools' : ''
              }`}
            </SelectItem>
          ))}
          {isLegacyValue ? (
            <SelectItem value={value as string}>{`Current: ${value}`}</SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      {error ? (
        <p className="text-xs text-muted-foreground">
          Could not load the model catalog; showing the current value only.
        </p>
      ) : null}
    </div>
  );
}

export default ModelOverrideSelect;
