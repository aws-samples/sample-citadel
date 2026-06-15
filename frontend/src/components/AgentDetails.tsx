import React, { useState, useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { agentConfigService, AgentConfig } from '../services/agentConfigService';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { AgentConfigTab } from './AgentConfig';
import { AgentCodeTab } from './AgentCode';
import './AgentDetails.css';

type TabType = 'details' | 'code';

interface AgentDetailsProps {
  agentId?: string;
  isCreating?: boolean;
  onBack: () => void;
  onSave?: () => void;
}

export const AgentDetails: React.FC<AgentDetailsProps> = ({
  agentId,
  isCreating = false,
  onBack,
  onSave,
}) => {
  const [agent, setAgent] = useState<AgentConfig | null>(null);
  const [loading, setLoading] = useState(!isCreating);
  const [error, setError] = useState<string | null>(null);
  const [isEditingDetails, setIsEditingDetails] = useState(isCreating);
  const [isEditingCode, setIsEditingCode] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('details');
  const [agentCode, setAgentCode] = useState<string>('// Agent code goes here\n');
  const [originalAgentCode, setOriginalAgentCode] = useState<string>('// Agent code goes here\n');
  const [formData, setFormData] = useState({
    agentId: '',
    config: {} as any,
  });

  useEffect(() => {
    if (agentId && !isCreating) {
      loadAgent();
      loadAgentCode();
    } else if (isCreating) {
      // Initialize form for creating new agent
      const initialConfig = {
        name: '',
        description: '',
        schema: {
          type: 'object',
          properties: {},
          required: [],
        },
        version: '0',
        action: {
          type: 'sqs',
          target: '',
        },
      };
      console.log('Initializing create form with config:', initialConfig);
      setFormData({
        agentId: '',
        config: initialConfig,
      });
      // Set default code for new agent
      const defaultCode = `# Agent: New Agent
# Add your agent code here

def handler(event, context):
    """
    Main handler for the agent.
    
    Args:
        event: The event data passed to the agent
        context: Runtime information
    
    Returns:
        dict: Response from the agent
    """
    pass
`;
      setAgentCode(defaultCode);
      setOriginalAgentCode(defaultCode);
    }
  }, [agentId, isCreating]);

  const loadAgent = async () => {
    if (!agentId) return;

    try {
      setLoading(true);
      setError(null);
      const data = await agentConfigService.getAgentConfig(agentId);
      if (data) {
        console.debug('Loaded agent data:', data);
        console.debug('Config type:', typeof data.config);
        console.debug('Config value:', data.config);
        
        // Ensure config is an object, not a string
        let config = data.config;
        if (typeof config === 'string') {
          console.debug('Parsing config from string');
          config = JSON.parse(config);
        }
        console.debug('Final config:', config);
        console.debug('Final config type:', typeof config);
        
        // Store agent with parsed config
        const agentWithParsedConfig = {
          ...data,
          config: config || {},
        };
        
        setAgent(agentWithParsedConfig);
        setFormData({
          agentId: agentWithParsedConfig.agentId,
          config: agentWithParsedConfig.config,
        });
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load agent');
    } finally {
      setLoading(false);
    }
  };

  const loadAgentCode = async () => {
    if (!agentId) return;

    try {
      const codeData = await agentConfigService.getAgentCode(agentId);
      if (codeData) {
        console.debug('Loaded code length:', codeData.code.length);
        console.debug('Loaded code:', codeData.code);
        const code = codeData.code;
        setAgentCode(code);
        setOriginalAgentCode(code);
      }
    } catch (err: any) {
      console.error('Error loading agent code:', err);
      // Don't set error state, just use default code
    }
  };

  /**
   * Increment version by 1 whole number (for code changes)
   * Examples: "0" -> "1", "1.5" -> "2", "2.3" -> "3"
   */
  const incrementMajorVersion = (currentVersion: string): string => {
    const version = parseFloat(currentVersion) || 0;
    return Math.floor(version + 1).toString();
  };

  /**
   * Increment version by 0.1 (for config changes)
   * Examples: "0" -> "0.1", "1" -> "1.1", "1.5" -> "1.6"
   */
  const incrementMinorVersion = (currentVersion: string): string => {
    const version = parseFloat(currentVersion) || 0;
    const newVersion = version + 0.1;
    // Round to 1 decimal place to avoid floating point issues
    return newVersion.toFixed(1);
  };

  const handleSaveDetails = async () => {
    try {
      setError(null);

      if (isCreating) {
        await agentConfigService.createAgentConfig({
          agentId: formData.agentId,
          config: formData.config,
          state: 'active',
        });
      } else if (agent) {
        // Increment version by 0.1 for config changes
        const currentVersion = formData.config.version || '0';
        const newVersion = incrementMinorVersion(currentVersion);
        
        const updatedConfig = {
          ...formData.config,
          version: newVersion,
        };

        await agentConfigService.updateAgentConfig({
          agentId: agent.agentId,
          config: updatedConfig,
        });

        console.log(`Config updated: version ${currentVersion} -> ${newVersion}`);
      }

      setIsEditingDetails(false);
      if (onSave) {
        onSave();
      }
      if (!isCreating) {
        await loadAgent();
      }
    } catch (err: any) {
      setError(err.message || 'Failed to save agent config');
    }
  };

  const handleSaveCode = async () => {
    try {
      setError(null);
      
      const agentIdToUse = isCreating ? formData.agentId : agent?.agentId;
      if (!agentIdToUse) {
        setError('Agent ID is required to save code');
        return;
      }

      // Save the code first
      await agentConfigService.updateAgentCode(agentIdToUse, agentCode);
      setOriginalAgentCode(agentCode);
      setIsEditingCode(false);

      // Increment version by 1 whole number for code changes
      if (agent) {
        const currentVersion = agent.config.version || '0';
        const newVersion = incrementMajorVersion(currentVersion);
        
        const updatedConfig = {
          ...agent.config,
          version: newVersion,
        };

        await agentConfigService.updateAgentConfig({
          agentId: agent.agentId,
          config: updatedConfig,
        });

        console.log(`Code updated: version ${currentVersion} -> ${newVersion}`);
        
        // Reload agent to get updated version
        await loadAgent();
      }
      
      if (onSave) {
        onSave();
      }
    } catch (err: any) {
      setError(err.message || 'Failed to save agent code');
    }
  };

  const handleCancelDetailsEdit = () => {
    setIsEditingDetails(false);
    if (isCreating) {
      onBack();
    } else if (agent) {
      setFormData({
        agentId: agent.agentId,
        config: agent.config,
      });
    }
  };

  const handleCancelCodeEdit = () => {
    setIsEditingCode(false);
    setAgentCode(originalAgentCode);
  };

  const handleDelete = async () => {
    if (!agent) return;
    if (!window.confirm(`Are you sure you want to delete agent "${agent.agentId}"?`)) {
      return;
    }

    try {
      setError(null);
      await agentConfigService.deleteAgentConfig(agent.agentId);
      if (onSave) {
        onSave();
      }
      onBack();
    } catch (err: any) {
      setError(err.message || 'Failed to delete agent');
    }
  };

  const handleToggleState = async () => {
    if (!agent) return;

    try {
      setError(null);
      const newState = agent.state === 'active' ? 'inactive' : 'active';
      await agentConfigService.updateAgentConfig({
        agentId: agent.agentId,
        state: newState,
      });
      await loadAgent();
      if (onSave) {
        onSave();
      }
    } catch (err: any) {
      setError(err.message || 'Failed to update agent state');
    }
  };

  if (loading) {
    return (
      <div className="agent-details-container">
        <div className="agent-details-loading">Loading agent details...</div>
      </div>
    );
  }

  return (
    <div className="agent-details-container">
      {/* Header */}
      <div className="agent-details-page-header">
        <Button
          variant="ghost"
          onClick={onBack}
          className="text-foreground hover:bg-accent"
        >
          <ArrowLeft className="size-4 mr-2" />
          Back
        </Button>
      </div>

      {/* Error Message */}
      {error && (
        <div className="agent-details-error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Content */}
      <div className="agent-details-content">
        <div className="agent-details-header">
          <div>
            <h2 className="agent-details-title">
              {isCreating ? 'Create New Agent' : agent?.agentId}
            </h2>
            {agent && !isCreating && (
              <div className="agent-details-meta">
                <Badge
                  variant={agent.state === 'active' ? 'default' : 'secondary'}
                  className={
                    agent.state === 'active'
                      ? 'bg-chart-2/20 text-chart-2 border-chart-2'
                      : 'bg-muted/20 text-muted-foreground'
                  }
                >
                  {agent.state}
                </Badge>
              </div>
            )}
          </div>

          <div className="agent-details-actions">
            {!isCreating && (
              <>
                <Button
                  variant="outline"
                  onClick={handleToggleState}
                  className="border-border text-foreground hover:bg-accent"
                >
                  {agent?.state === 'active' ? 'Deactivate' : 'Activate'}
                </Button>
                {!agent?.categories?.includes('built-in') && (
                  <Button
                    variant="outline"
                    onClick={handleDelete}
                    className="border-destructive text-destructive hover:bg-destructive/10"
                  >
                    Delete
                  </Button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="agent-details-tabs">
          <Button
            type="button"
            variant="ghost"
            className={`agent-tab h-auto rounded-none ${activeTab === 'details' ? 'active' : ''}`}
            onClick={() => setActiveTab('details')}
          >
            Details
          </Button>
          {/* Hide code tab for fabricator agent */}
          {agent?.agentId !== 'fabricator' && !isCreating && (
            <Button
              type="button"
              variant="ghost"
              className={`agent-tab h-auto rounded-none ${activeTab === 'code' ? 'active' : ''}`}
              onClick={() => setActiveTab('code')}
            >
              Code
            </Button>
          )}
        </div>

        {/* Tab Content */}
        {activeTab === 'details' && (
          <AgentConfigTab
            agent={agent}
            isCreating={isCreating}
            isEditing={isEditingDetails}
            formData={formData}
            onFormDataChange={setFormData}
            onStartEdit={() => setIsEditingDetails(true)}
            onSave={handleSaveDetails}
            onCancel={handleCancelDetailsEdit}
            isFabricator={agent?.agentId === 'fabricator'}
          />
        )}

        {/* Hide code tab for fabricator agent */}
        {activeTab === 'code' && agent?.agentId !== 'fabricator' && (
          <AgentCodeTab
            isCreating={isCreating}
            isEditing={isEditingCode}
            agentCode={agentCode}
            onCodeChange={setAgentCode}
            onStartEdit={() => setIsEditingCode(true)}
            onSave={handleSaveCode}
            onCancel={handleCancelCodeEdit}
          />
        )}
      </div>
    </div>
  );
};
