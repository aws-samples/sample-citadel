import React from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from './ui/sheet';
import { FabricationQueueItem } from '../services/fabricatorQueueService';
import { QueueItemCard } from './QueueItemCard';
import { PackageOpen } from 'lucide-react';
import {
  groupFabricationItems,
  summarizeFabricationQueue,
  formatFabricationQueueSummary,
} from './fabricationGrouping';

interface FabricationTrayProps {
  isOpen: boolean;
  onClose: () => void;
  queueItems: FabricationQueueItem[];
  onRefresh: () => void;
  onNavigate?: (view: string) => void;
}

const EmptyState: React.FC = () => {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="size-16 rounded-full bg-accent border-2 border-border flex items-center justify-center mb-4 shadow-lg">
        <PackageOpen className="size-8 text-muted-foreground" />
      </div>
      <p className="text-sm text-muted-foreground">No pending fabrication requests</p>
    </div>
  );
};

export const FabricationTray: React.FC<FabricationTrayProps> = ({
  isOpen,
  onClose,
  queueItems,
  onRefresh: _onRefresh,
  onNavigate,
}) => {
  const groups = groupFabricationItems(queueItems);
  const summary = summarizeFabricationQueue(queueItems);

  return (
    <Sheet open={isOpen} onOpenChange={onClose}>
      <SheetContent side="right" className="w-[400px] bg-background border-l border-border">
        <SheetHeader>
          <SheetTitle className="text-foreground">Fabrication Queue</SheetTitle>
          <SheetDescription className="text-muted-foreground">
            {formatFabricationQueueSummary(summary)}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col mt-6 gap-4">
          {queueItems.length === 0 ? (
            <EmptyState />
          ) : (
            groups.map((group) => (
              <div key={group.appId || '__unassigned__'}>
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                  {group.appName}
                </h3>
                <div className="flex flex-col gap-2">
                  {group.items.map((item) => (
                    <QueueItemCard key={item.requestId} item={item} onNavigate={onNavigate} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};
