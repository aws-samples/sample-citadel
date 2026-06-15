import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

interface CreateProjectProps {
  onBack: () => void;
  onCreate: (name: string, description: string) => Promise<void>;
}

export function CreateProject({ onBack, onCreate }: CreateProjectProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (name.length >= 3 && name.length <= 100) {
      setLoading(true);
      try {
        await onCreate(name, description);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3 mb-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={onBack}
                disabled={loading}
                className="size-8"
              >
                <ArrowLeft className="size-4" />
              </Button>
              <CardTitle>Create New Assessment</CardTitle>
            </div>
            <CardDescription className="ml-11">
              Start a new agentic AI assessment by providing project details
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">Project Name *</Label>
                <Input
                  id="name"
                  placeholder="Enter project name (3-100 characters)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  minLength={3}
                  maxLength={100}
                  required
                />
                <p className="text-sm text-muted-foreground">
                  {name.length}/100 characters
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  placeholder="Provide a brief description of the agentic AI project you want to assess"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                />
                <p className="text-sm text-muted-foreground">
                  Optional: Add context about your project goals and requirements
                </p>
              </div>

              <div className="flex gap-3">
                <Button type="button" variant="outline" onClick={onBack} disabled={loading}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={name.length < 3 || name.length > 100 || loading}
                >
                  {loading ? 'Creating...' : 'Create Project'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
    </div>
  );
}
