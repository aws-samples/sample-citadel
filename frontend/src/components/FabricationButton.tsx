import React from 'react';
import { Cog } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';

interface FabricationButtonProps {
  queueCount: number;
  onClick: () => void;
}

export const FabricationButton: React.FC<FabricationButtonProps> = ({
  queueCount,
  onClick,
}) => {
  return (
    <Button
      variant="outline"
      className="gap-2 h-9 px-3 font-medium rounded-md inline-flex items-center transition-colors duration-200 bg-card text-muted-foreground border-none cursor-pointer text-sm hover:bg-accent"
      onClick={onClick}
    >
      <Cog className="size-4" />
      <span>Fabrication</span>
      <Badge
        variant="secondary"
        className="ml-1 text-xs px-1.5 py-0.5 font-semibold rounded"
        style={{
          backgroundColor: '#0a0a0a',
          color: '#6b7280',
          fontSize: '11px',
          minWidth: '20px',
          textAlign: 'center',
        }}
      >
        {queueCount}
      </Badge>
    </Button>
  );
};
