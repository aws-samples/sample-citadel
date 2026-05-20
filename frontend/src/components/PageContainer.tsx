import { cn } from './ui/utils';

interface PageContainerProps {
  children: React.ReactNode;
  className?: string;
}

export function PageContainer({ children, className }: PageContainerProps) {
  return (
    <div className={cn('p-4 overflow-y-auto h-full', className)}>
      {children}
    </div>
  );
}
