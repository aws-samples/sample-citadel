import { Search } from 'lucide-react';
import { Input } from './ui/input';
import { cn } from './ui/utils';

interface SearchInputProps {
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  className?: string;
}

export function SearchInput({ value, onChange, placeholder = 'Search...', className }: SearchInputProps) {
  return (
    <div className="relative">
      <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none z-10">
        <Search className="size-4 text-muted-foreground" />
      </div>
      <Input
        type="search"
        placeholder={placeholder}
        className={cn(
          'pl-9 bg-input-background placeholder:text-muted-foreground focus:border-ring',
          className,
        )}
        {...(value !== undefined ? { value } : {})}
        {...(onChange ? { onChange } : {})}
      />
    </div>
  );
}
