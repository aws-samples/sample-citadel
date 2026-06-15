/**
 * Utility functions for the DataPipelineWizard component.
 *
 * Extracts the pipeline binding construction logic into pure, testable functions
 * that can be validated independently of React component rendering.
 *
 * @module pipeline-wizard-utils
 */

import { CreateToolRequest } from '../services/fabricatorService';
import { DataStoreBinding, IntegrationBinding, BindingDirection } from '../services/toolConfigService';

/** Describes a selected resource (data store or integration) for a pipeline step. */
export interface PipelineResourceSelection {
  kind: 'dataStore' | 'integration';
  id: string;
  type: string;
  operations: string[];
}

/** Parameters for building a pipeline tool payload. */
export interface BuildPipelinePayloadParams {
  toolName: string;
  toolDescription: string;
  processingLogic: string;
  inputSource: PipelineResourceSelection;
  outputDestination: PipelineResourceSelection;
}

/**
 * Builds the directional bindings for a pipeline tool from the input source
 * and output destination selections.
 *
 * - The input source gets `direction: 'input'`
 * - The output destination gets `direction: 'output'`
 * - Data store selections produce DataStoreBinding entries
 * - Integration selections produce IntegrationBinding entries
 *
 * @returns An object with `dataStoreBindings` and `integrationBindings` arrays
 */
export function buildPipelineBindings(
  inputSource: PipelineResourceSelection,
  outputDestination: PipelineResourceSelection,
): {
  dataStoreBindings: DataStoreBinding[];
  integrationBindings: IntegrationBinding[];
} {
  const dataStoreBindings: DataStoreBinding[] = [];
  const integrationBindings: IntegrationBinding[] = [];

  // Build input binding
  if (inputSource.kind === 'dataStore') {
    dataStoreBindings.push({
      dataStoreId: inputSource.id,
      dataStoreType: inputSource.type,
      operations: inputSource.operations,
      direction: 'INPUT' as BindingDirection,
    });
  } else {
    integrationBindings.push({
      integrationId: inputSource.id,
      integrationType: inputSource.type,
      operations: inputSource.operations,
      direction: 'INPUT' as BindingDirection,
    });
  }

  // Build output binding
  if (outputDestination.kind === 'dataStore') {
    dataStoreBindings.push({
      dataStoreId: outputDestination.id,
      dataStoreType: outputDestination.type,
      operations: outputDestination.operations,
      direction: 'OUTPUT' as BindingDirection,
    });
  } else {
    integrationBindings.push({
      integrationId: outputDestination.id,
      integrationType: outputDestination.type,
      operations: outputDestination.operations,
      direction: 'OUTPUT' as BindingDirection,
    });
  }

  return { dataStoreBindings, integrationBindings };
}

/**
 * Builds the full pipeline tool creation payload including directional bindings
 * and an enhanced description with pipeline context.
 */
export function buildPipelineToolPayload(params: BuildPipelinePayloadParams): CreateToolRequest {
  const { dataStoreBindings, integrationBindings } = buildPipelineBindings(
    params.inputSource,
    params.outputDestination,
  );

  const enhancedDescription = [
    params.toolDescription.trim(),
    `\nInput Source: ${params.inputSource.type} (${params.inputSource.kind})`,
    `Input Operations: ${params.inputSource.operations.join(', ')}`,
    `\nProcessing Logic: ${params.processingLogic.trim()}`,
    `\nOutput Destination: ${params.outputDestination.type} (${params.outputDestination.kind})`,
    `Output Operations: ${params.outputDestination.operations.join(', ')}`,
  ].join('\n');

  return {
    toolName: params.toolName,
    toolDescription: enhancedDescription,
    dataStoreBindings: dataStoreBindings.length > 0 ? dataStoreBindings : undefined,
    integrationBindings: integrationBindings.length > 0 ? integrationBindings : undefined,
  };
}
