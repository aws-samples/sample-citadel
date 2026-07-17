/**
 * WorkflowToolbar Component
 *
 * Provides action buttons for workflow operations including:
 * - Save: Save workflow to the blueprint catalog (create + publish)
 * - Load: Load a published blueprint from the catalog
 * - Validate: Check workflow for errors and warnings
 * - Clear: Remove all nodes and edges from canvas
 * - Import: Load workflow from a local JSON file
 * - Export: Download workflow as formatted JSON
 *
 */

import React, { useRef, useState, memo, useCallback } from 'react';
import {
  SaveIcon,
  FolderOpenIcon,
  CheckCircleIcon,
  TrashIcon,
  DownloadIcon,
  UploadIcon,
  AlertCircleIcon,
  AlertTriangleIcon,
} from 'lucide-react';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Badge } from './ui/badge';
import { toast } from 'sonner';
import type {
  WorkflowNode,
  WorkflowEdge,
  ValidationResult,
  WorkflowDefinition,
} from '../types/workflow';
import {
  serializeWorkflow,
  validateWorkflow,
  WorkflowError,
  deserializeWorkflow,
} from '../services/workflowService';
import { workflowApiService } from '../services/workflowApiService';
import { isPlaceholderAgentId } from '../utils/blueprintPlaceholders';

export interface WorkflowToolbarProps {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  onLoad: (nodes: WorkflowNode[], edges: WorkflowEdge[]) => void;
  onClear: () => void;
  orgId: string;
  workflowName?: string;
  hasUnsavedChanges?: boolean;
  validationResult?: ValidationResult | null;
}

/** Blueprint row shape returned by workflowApiService.listBlueprints(). */
interface CatalogBlueprint {
  workflowId: string;
  name: string;
  description?: string | null;
  definition: string;
  metadata?: string | null;
}

/**
 * Parse a blueprint definition defensively: the backend may return the
 * definition as a JSON string, or as a double-encoded JSON string.
 * Mirrors parseDefinitionNodes in ImportBlueprintDialog.tsx.
 */
function parseBlueprintDefinition(definition: string): WorkflowDefinition {
  let parsed: unknown = JSON.parse(definition);
  if (typeof parsed === 'string') {
    parsed = JSON.parse(parsed);
  }
  return parsed as WorkflowDefinition;
}

/** Defensively extract a category string from a blueprint's metadata JSON. */
function parseBlueprintCategory(metadata: string | null | undefined): string | null {
  if (typeof metadata !== 'string' || !metadata.trim()) {
    return null;
  }
  try {
    let parsed: unknown = JSON.parse(metadata);
    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed);
    }
    const category = (parsed as { category?: unknown } | null)?.category;
    return typeof category === 'string' && category.trim() ? category : null;
  } catch {
    return null;
  }
}

/**
 * True when the blueprint's definition references any `placeholder-*` agent
 * slots (seeded templates). Such blueprints cannot be loaded directly onto
 * the canvas — their slots must be re-mapped via the app import flow first.
 * Parsed defensively: an unparseable definition is treated as
 * non-placeholder so the existing load error path handles it.
 */
function blueprintReferencesPlaceholders(definition: string): boolean {
  try {
    const parsed = parseBlueprintDefinition(definition);
    const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
    return nodes.some(
      (node) => typeof node?.agentId === 'string' && isPlaceholderAgentId(node.agentId)
    );
  } catch {
    return false;
  }
}

export const WorkflowToolbar = memo(function WorkflowToolbar({
  nodes,
  edges,
  onLoad,
  onClear,
  orgId,
  workflowName,
  hasUnsavedChanges = false,
  validationResult: externalValidationResult,
}: WorkflowToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [showValidationDialog, setShowValidationDialog] = useState(false);
  const [showSaveWarningDialog, setShowSaveWarningDialog] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);

  // Save-to-catalog dialog state
  const [showSaveCatalogDialog, setShowSaveCatalogDialog] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveCategory, setSaveCategory] = useState('');
  const [saving, setSaving] = useState(false);

  // Load-from-catalog dialog state
  const [showReplaceDialog, setShowReplaceDialog] = useState(false);
  const [showCatalogDialog, setShowCatalogDialog] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [blueprints, setBlueprints] = useState<CatalogBlueprint[]>([]);
  const [loadingBlueprint, setLoadingBlueprint] = useState(false);

  /**
   * Open the save-to-catalog dialog with the name prefilled from the
   * workflowName prop (falling back to 'Untitled Blueprint').
   */
  const openSaveCatalogDialog = useCallback(() => {
    setSaveName(workflowName?.trim() || 'Untitled Blueprint');
    setSaveCategory('');
    setShowSaveCatalogDialog(true);
  }, [workflowName]);

  /**
   * Handle Save button click
   * Requirement: Save workflow to the blueprint catalog
   * Requirement: Prevent saving invalid workflows with prompt
   */
  const handleSave = useCallback(() => {
    // Use external validation result if available, otherwise validate now
    const validation = externalValidationResult || validateWorkflow(nodes, edges);

    // Show warning dialog if workflow has errors
    if (!validation.isValid) {
      setValidationResult(validation);
      setShowSaveWarningDialog(true);
      return;
    }

    openSaveCatalogDialog();
  }, [nodes, edges, externalValidationResult, openSaveCatalogDialog]);

  /**
   * Handle save confirmation when workflow has errors ('Save Anyway')
   */
  const handleSaveConfirm = useCallback(() => {
    setShowSaveWarningDialog(false);
    openSaveCatalogDialog();
  }, [openSaveCatalogDialog]);

  /**
   * Perform the save-to-catalog operation:
   * createWorkflow(isBlueprint: true) then publishWorkflow.
   */
  const handleSaveToCatalog = useCallback(async () => {
    const name = saveName.trim();
    if (!name) {
      return;
    }

    setSaving(true);
    let created: { workflowId: string };
    try {
      const workflow = serializeWorkflow(nodes, edges, { name });
      const category = saveCategory.trim();
      created = await workflowApiService.createWorkflow({
        name,
        orgId,
        definition: JSON.stringify(workflow),
        isBlueprint: true,
        metadata: category ? JSON.stringify({ category }) : undefined,
      });
    } catch (error) {
      console.error('Failed to save blueprint to catalog:', error);
      toast.error('Failed to save blueprint', {
        description:
          error instanceof Error ? error.message : 'An unexpected error occurred',
      });
      setSaving(false);
      return;
    }

    try {
      await workflowApiService.publishWorkflow(created.workflowId);
      toast.success('Blueprint saved to catalog', {
        description: name,
      });
    } catch (error) {
      console.error('Failed to publish blueprint:', error);
      toast.warning('Blueprint saved but not published', {
        description:
          error instanceof Error
            ? error.message
            : 'The blueprint was created but could not be published.',
      });
    } finally {
      setSaving(false);
      setShowSaveCatalogDialog(false);
    }
  }, [saveName, saveCategory, nodes, edges, orgId]);

  /**
   * Fetch the blueprint catalog for the picker dialog.
   */
  const fetchBlueprints = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const result = await workflowApiService.listBlueprints();
      setBlueprints(Array.isArray(result?.items) ? result.items : []);
    } catch (error) {
      console.error('Failed to list blueprints:', error);
      setCatalogError(
        error instanceof Error ? error.message : 'Failed to load the blueprint catalog'
      );
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  /**
   * Open the catalog picker dialog and fetch blueprints.
   */
  const openCatalogDialog = useCallback(() => {
    setCatalogSearch('');
    setShowCatalogDialog(true);
    void fetchBlueprints();
  }, [fetchBlueprints]);

  /**
   * Handle Load button click
   * Requirement: Load a blueprint from the catalog. If the canvas has
   * content, ask for replace confirmation first.
   */
  const handleLoadClick = useCallback(() => {
    if (nodes.length > 0) {
      setShowReplaceDialog(true);
      return;
    }
    openCatalogDialog();
  }, [nodes.length, openCatalogDialog]);

  /**
   * Confirm replacing canvas contents, then open the catalog picker.
   */
  const handleReplaceConfirm = useCallback(() => {
    setShowReplaceDialog(false);
    openCatalogDialog();
  }, [openCatalogDialog]);

  /**
   * Load the selected blueprint from the catalog onto the canvas.
   */
  const handleSelectBlueprint = useCallback(
    async (blueprint: CatalogBlueprint) => {
      setLoadingBlueprint(true);
      try {
        const definition = parseBlueprintDefinition(blueprint.definition);
        const { nodes: loadedNodes, edges: loadedEdges } =
          await deserializeWorkflow(definition);

        const validation = validateWorkflow(loadedNodes, loadedEdges);

        onLoad(loadedNodes, loadedEdges);
        setShowCatalogDialog(false);

        if (validation.isValid) {
          toast.success('Workflow loaded successfully', {
            description: `Loaded ${loadedNodes.length} nodes and ${loadedEdges.length} connections`,
          });
        } else {
          toast.warning('Workflow loaded with warnings', {
            description: `${validation.errors.length} errors found. Review validation results.`,
          });
        }
      } catch (error) {
        console.error('Failed to load blueprint:', error);

        if (error instanceof WorkflowError) {
          toast.error('Failed to load blueprint', {
            description: error.message,
          });
        } else {
          toast.error('Failed to load blueprint', {
            description: 'Invalid blueprint definition or format',
          });
        }
      } finally {
        setLoadingBlueprint(false);
      }
    },
    [onLoad]
  );

  /**
   * Handle Import button click
   * Opens file picker for JSON file selection
   * Requirement: Import workflow from JSON file
   */
  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /**
   * Handle file selection from file picker
   * Requirement: Parse, validate, and load workflow
   */
  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      // Read file content
      const content = await file.text();
      
      // Deserialize and validate workflow
      const { nodes: loadedNodes, edges: loadedEdges } = await deserializeWorkflow(content);
      
      // Validate the loaded workflow
      const validation = validateWorkflow(loadedNodes, loadedEdges);
      
      // Load the workflow
      onLoad(loadedNodes, loadedEdges);
      
      // Show success message
      if (validation.isValid) {
        toast.success('Workflow loaded successfully', {
          description: `Loaded ${loadedNodes.length} nodes and ${loadedEdges.length} connections`,
        });
      } else {
        toast.warning('Workflow loaded with warnings', {
          description: `${validation.errors.length} errors found. Review validation results.`,
        });
      }
    } catch (error) {
      console.error('Failed to load workflow:', error);
      
      if (error instanceof WorkflowError) {
        toast.error('Failed to load workflow', {
          description: error.message,
        });
      } else {
        toast.error('Failed to load workflow', {
          description: 'Invalid workflow file or format',
        });
      }
    } finally {
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [onLoad]);

  /**
   * Handle Validate button click
   * Requirement: Validate workflow and display results
   */
  const handleValidate = useCallback(() => {
    try {
      const validation = validateWorkflow(nodes, edges);
      setValidationResult(validation);
      setShowValidationDialog(true);

      if (validation.isValid) {
        toast.success('Workflow is valid', {
          description: 'No errors found',
        });
      } else {
        toast.error('Workflow has validation errors', {
          description: `${validation.errors.length} errors found`,
        });
      }
    } catch (error) {
      console.error('Validation failed:', error);
      toast.error('Validation failed', {
        description: 'An unexpected error occurred during validation',
      });
    }
  }, [nodes, edges]);

  /**
   * Handle Clear button click
   * Shows confirmation dialog before clearing
   */
  const handleClearClick = useCallback(() => {
    if (nodes.length === 0 && edges.length === 0) {
      toast.info('Canvas is already empty');
      return;
    }
    setShowClearDialog(true);
  }, [nodes.length, edges.length]);

  /**
   * Confirm clear operation
   * Removes all nodes and edges from canvas
   */
  const handleClearConfirm = useCallback(() => {
    onClear();
    setShowClearDialog(false);
    toast.success('Canvas cleared', {
      description: 'All nodes and connections removed',
    });
  }, [onClear]);

  /**
   * Handle Export button click
   * Downloads the workflow as formatted JSON
   */
  const handleExport = useCallback(() => {
    try {
      // Serialize workflow to JSON
      const workflow = serializeWorkflow(nodes, edges, {
        name: `Workflow Export ${new Date().toLocaleDateString()}`,
      });

      // Create formatted JSON blob
      const blob = new Blob([JSON.stringify(workflow, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `workflow-export-${Date.now()}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast.success('Workflow exported successfully', {
        description: `Exported as ${link.download}`,
      });
    } catch (error) {
      console.error('Failed to export workflow:', error);
      toast.error('Failed to export workflow', {
        description: 'An unexpected error occurred',
      });
    }
  }, [nodes, edges]);

  // Blueprint rows filtered by the search query (name/description match)
  const searchQuery = catalogSearch.trim().toLowerCase();
  const filteredBlueprints = searchQuery
    ? blueprints.filter(
        (bp) =>
          (bp.name || '').toLowerCase().includes(searchQuery) ||
          (bp.description || '').toLowerCase().includes(searchQuery)
      )
    : blueprints;

  return (
    <>
      {/* Toolbar */}
      <div 
        className="workflow-toolbar flex items-center gap-2 px-4 py-3 bg-accent border-b border-border"
        role="toolbar"
        aria-label="Workflow actions"
      >
        <div className="flex items-center gap-2">
          {/* Save Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleSave}
            disabled={nodes.length === 0}
            title="Save blueprint to catalog"
            aria-label="Save blueprint to catalog"
            className="workflow-toolbar-button"
          >
            <SaveIcon className="size-4" aria-hidden="true" />
            Save
          </Button>

          {/* Load Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleLoadClick}
            title="Load blueprint from catalog"
            aria-label="Load blueprint from catalog"
            className="workflow-toolbar-button"
          >
            <FolderOpenIcon className="size-4" aria-hidden="true" />
            Load
          </Button>

          {/* Validate Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleValidate}
            disabled={nodes.length === 0}
            title="Validate workflow"
            aria-label="Validate workflow for errors"
            className="workflow-toolbar-button"
          >
            <CheckCircleIcon className="size-4" aria-hidden="true" />
            Validate
          </Button>

          {/* Clear Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearClick}
            disabled={nodes.length === 0 && edges.length === 0}
            title="Clear canvas"
            aria-label="Clear all nodes and connections from canvas"
            className="workflow-toolbar-button"
          >
            <TrashIcon className="size-4" aria-hidden="true" />
            Clear
          </Button>

          {/* Import Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleImportClick}
            title="Import workflow from JSON file"
            aria-label="Import workflow from JSON file"
            className="workflow-toolbar-button"
          >
            <UploadIcon className="size-4" aria-hidden="true" />
            Import
          </Button>

          {/* Hidden file input for Import */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={handleFileChange}
            className="hidden"
            aria-label="Select workflow file to import"
          />

          {/* Export Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={nodes.length === 0}
            title="Export workflow as JSON"
            aria-label="Export workflow as JSON file"
            className="workflow-toolbar-button"
          >
            <DownloadIcon className="size-4" aria-hidden="true" />
            Export
          </Button>
        </div>

        {/* Status indicators */}
        <div 
          className="ml-auto flex items-center gap-3 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {/* Validation Status */}
          {externalValidationResult && nodes.length > 0 && (
            <>
              {externalValidationResult.isValid ? (
                <span 
                  className="workflow-badge workflow-badge-success flex items-center gap-1"
                  aria-label="Workflow is valid"
                >
                  <CheckCircleIcon className="size-4" aria-hidden="true" />
                  Valid
                </span>
              ) : (
                <span 
                  className="workflow-badge workflow-badge-error flex items-center gap-1"
                  aria-label={`Workflow has ${externalValidationResult.errors.length} validation error${externalValidationResult.errors.length !== 1 ? 's' : ''}`}
                >
                  <AlertCircleIcon className="size-4" aria-hidden="true" />
                  {externalValidationResult.errors.length} error{externalValidationResult.errors.length !== 1 ? 's' : ''}
                </span>
              )}
              <span className="text-muted-foreground" aria-hidden="true">•</span>
            </>
          )}
          
          {hasUnsavedChanges && (
            <>
              <span 
                className="workflow-badge workflow-badge-warning"
                aria-label="Workflow has unsaved changes"
              >
                Unsaved changes
              </span>
              <span className="text-muted-foreground" aria-hidden="true">•</span>
            </>
          )}
          <span aria-label={`${nodes.length} node${nodes.length !== 1 ? 's' : ''} in workflow`}>
            {nodes.length} {nodes.length === 1 ? 'node' : 'nodes'}
          </span>
          <span aria-hidden="true">•</span>
          <span aria-label={`${edges.length} connection${edges.length !== 1 ? 's' : ''} in workflow`}>
            {edges.length} {edges.length === 1 ? 'connection' : 'connections'}
          </span>
        </div>
      </div>

      {/* Save to Catalog Dialog */}
      <Dialog open={showSaveCatalogDialog} onOpenChange={setShowSaveCatalogDialog}>
        <DialogContent className="bg-card border-border text-foreground">
          <DialogHeader>
            <DialogTitle>Save Blueprint to Catalog</DialogTitle>
            <DialogDescription>
              Save this workflow to the blueprint catalog so it can be reused.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="blueprint-name">Blueprint Name</Label>
              <Input
                id="blueprint-name"
                value={saveName}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  setSaveName(event.target.value)
                }
                placeholder="Untitled Blueprint"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="blueprint-category">Category</Label>
              <Input
                id="blueprint-category"
                value={saveCategory}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  setSaveCategory(event.target.value)
                }
                placeholder="e.g. automation (optional)"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowSaveCatalogDialog(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveToCatalog}
              disabled={saving || !saveName.trim()}
            >
              {saving ? 'Saving…' : 'Save to Catalog'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Replace Canvas Confirmation Dialog */}
      <Dialog open={showReplaceDialog} onOpenChange={setShowReplaceDialog}>
        <DialogContent className="bg-card border-border text-foreground">
          <DialogHeader>
            <DialogTitle>Replace canvas contents?</DialogTitle>
            <DialogDescription>
              Loading a blueprint will replace the current nodes and connections on
              the canvas.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReplaceDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReplaceConfirm}>
              Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Load from Catalog Dialog */}
      <Dialog open={showCatalogDialog} onOpenChange={setShowCatalogDialog}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto bg-card border-border text-foreground">
          <DialogHeader>
            <DialogTitle>Load blueprint from catalog</DialogTitle>
            <DialogDescription>
              Select a published blueprint to load onto the canvas.
            </DialogDescription>
          </DialogHeader>

          {/* min-w-0 down this chain lets long unbroken text wrap inside the
              dialog width instead of expanding the DialogContent grid column
              (grid/flex children default to min-width:auto). */}
          <div className="flex flex-col gap-3 min-w-0">
            <Input
              aria-label="Search blueprints"
              placeholder="Search blueprints..."
              value={catalogSearch}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                setCatalogSearch(event.target.value)
              }
            />

            {catalogLoading ? (
              <div
                className="flex flex-col gap-2"
                role="status"
                aria-label="Loading blueprints"
              >
                <div className="h-14 w-full rounded-md bg-muted animate-pulse" />
                <div className="h-14 w-full rounded-md bg-muted animate-pulse" />
                <div className="h-14 w-full rounded-md bg-muted animate-pulse" />
              </div>
            ) : catalogError ? (
              <div className="flex flex-col items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
                <p className="text-sm text-destructive">{catalogError}</p>
                <Button variant="outline" size="sm" onClick={fetchBlueprints}>
                  Retry
                </Button>
              </div>
            ) : blueprints.length === 0 ? (
              <p className="text-sm text-muted-foreground p-3">
                No blueprints in the catalog yet.
              </p>
            ) : filteredBlueprints.length === 0 ? (
              <p className="text-sm text-muted-foreground p-3">
                No blueprints match your search.
              </p>
            ) : (
              <div className="flex flex-col gap-2 min-w-0">
                {filteredBlueprints.map((blueprint) => {
                  const category = parseBlueprintCategory(blueprint.metadata);
                  const hasPlaceholders = blueprintReferencesPlaceholders(
                    blueprint.definition
                  );
                  return (
                    <Button
                      key={blueprint.workflowId}
                      type="button"
                      variant="ghost"
                      onClick={
                        hasPlaceholders
                          ? undefined
                          : () => handleSelectBlueprint(blueprint)
                      }
                      disabled={loadingBlueprint || hasPlaceholders}
                      aria-disabled={hasPlaceholders ? true : undefined}
                      aria-label={`Load blueprint ${blueprint.name}`}
                      className="h-auto w-full min-w-0 flex-col items-start justify-start gap-1 p-3 border border-border rounded-md text-left font-normal whitespace-normal cursor-pointer transition-colors duration-200"
                    >
                      <div className="flex items-center gap-2 w-full min-w-0">
                        <span className="text-sm font-medium min-w-0 break-words">
                          {blueprint.name}
                        </span>
                        {category && <Badge className="text-xs">{category}</Badge>}
                      </div>
                      {blueprint.description && (
                        <p className="text-sm text-muted-foreground whitespace-normal break-words w-full min-w-0">
                          {blueprint.description}
                        </p>
                      )}
                      {hasPlaceholders && (
                        <p className="text-xs text-muted-foreground whitespace-normal break-words w-full min-w-0">
                          Requires agent mapping — import this template into an app instead
                        </p>
                      )}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCatalogDialog(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear Confirmation Dialog */}
      <Dialog open={showClearDialog} onOpenChange={setShowClearDialog}>
        <DialogContent className="bg-card border-border text-foreground">
          <DialogHeader>
            <DialogTitle>Clear Canvas</DialogTitle>
            <DialogDescription>
              Are you sure you want to clear the canvas? This will remove all nodes and
              connections. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowClearDialog(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleClearConfirm}
            >
              Clear Canvas
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Validation Results Dialog */}
      <Dialog open={showValidationDialog} onOpenChange={setShowValidationDialog}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto bg-card border-border text-foreground">
          <DialogHeader>
            <DialogTitle>Workflow Validation Results</DialogTitle>
            <DialogDescription>
              {validationResult?.isValid
                ? 'Your workflow is valid and ready to execute'
                : 'Your workflow has validation issues that need attention'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            {/* Validation Status */}
            {validationResult?.isValid ? (
              <Alert>
                <CheckCircleIcon className="text-chart-2" />
                <AlertTitle>Validation Passed</AlertTitle>
                <AlertDescription>
                  No errors found. Your workflow is ready to be saved and executed.
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>Validation Failed</AlertTitle>
                <AlertDescription>
                  {validationResult?.errors.length || 0} error(s) found. Please fix these
                  issues before executing the workflow.
                </AlertDescription>
              </Alert>
            )}

            {/* Errors */}
            {validationResult && validationResult.errors.length > 0 && (
              <div className="flex flex-col gap-2">
                <h4 className="text-sm font-semibold text-destructive">Errors</h4>
                <div className="flex flex-col gap-2">
                  {validationResult.errors.map((error, index) => (
                    <div
                      key={index}
                      className="p-3 rounded-md bg-destructive/10 border border-destructive/20"
                    >
                      <div className="flex items-start gap-2">
                        <AlertCircleIcon className="size-4 text-destructive mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-destructive">
                            {error.type.replace(/_/g, ' ').toUpperCase()}
                          </p>
                          <p className="text-sm text-foreground mt-1">
                            {error.message}
                          </p>
                          {error.nodeId && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Node ID: {error.nodeId}
                            </p>
                          )}
                          {error.edgeId && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Edge ID: {error.edgeId}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Warnings */}
            {validationResult && validationResult.warnings.length > 0 && (
              <div className="flex flex-col gap-2">
                <h4 className="text-sm font-semibold text-chart-4">Warnings</h4>
                <div className="flex flex-col gap-2">
                  {validationResult.warnings.map((warning, index) => (
                    <div
                      key={index}
                      className="p-3 rounded-md bg-chart-4/10 border border-chart-4/20"
                    >
                      <div className="flex items-start gap-2">
                        <AlertTriangleIcon className="size-4 text-chart-4 mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-chart-4">
                            {warning.type.replace(/_/g, ' ').toUpperCase()}
                          </p>
                          <p className="text-sm text-foreground mt-1">
                            {warning.message}
                          </p>
                          {warning.nodeId && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Node ID: {warning.nodeId}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button onClick={() => setShowValidationDialog(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Save Warning Dialog */}
      <Dialog open={showSaveWarningDialog} onOpenChange={setShowSaveWarningDialog}>
        <DialogContent className="bg-card border-border text-foreground">
          <DialogHeader>
            <DialogTitle>Save Workflow with Errors?</DialogTitle>
            <DialogDescription>
              Your workflow has {validationResult?.errors.length || 0} validation error(s).
              Saving it may result in execution failures.
            </DialogDescription>
          </DialogHeader>

          {/* Show first few errors */}
          {validationResult && validationResult.errors.length > 0 && (
            <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
              {validationResult.errors.slice(0, 3).map((error, index) => (
                <div
                  key={index}
                  className="p-2 rounded-md bg-destructive/10 border border-destructive/20"
                >
                  <p className="text-sm text-destructive">{error.message}</p>
                </div>
              ))}
              {validationResult.errors.length > 3 && (
                <p className="text-xs text-muted-foreground">
                  +{validationResult.errors.length - 3} more error(s)
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowSaveWarningDialog(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleSaveConfirm}
            >
              Save Anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
