import { useNavigate } from 'react-router-dom';
import { Button } from './ui/button';
import { FileQuestion } from 'lucide-react';

export function NotFound() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex items-center justify-center bg-background" data-testid="not-found-page">
      <div className="text-center">
        <FileQuestion className="size-16 text-muted-foreground mx-auto mb-4" />
        <h1 className="text-2xl font-semibold text-foreground mb-2">Page Not Found</h1>
        <p className="text-muted-foreground mb-6">The page you're looking for doesn't exist.</p>
        <Button onClick={() => navigate('/dashboard')} className="bg-primary text-foreground hover:bg-primary/90">
          Go to Dashboard
        </Button>
      </div>
    </div>
  );
}
