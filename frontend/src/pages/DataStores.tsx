import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/components/ui/utils";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Database,
  Search,
  Plus,
  CheckCircle,
  AlertCircle,
  Loader2,
  XCircle,
  BookOpen,
  Layers,
  FileText,
  Cloud,
  Brain,
  BarChart3,
  Share2,
  Clock,
  Zap,
  Key,
  Shield,
  Globe,
  LucideIcon,
} from "lucide-react";
import {
  datastoreService,
  DataStore,
  DataStoreStatus,
  DataStoreCategory,
  DataStoreStats,
  DataStoreUsage,
} from "@/services/datastoreService";
import { DataStoreCard } from "@/components/DataStoreCard";
import { CreateDataStoreWizard } from "@/components/CreateDataStoreWizard";
import { useOrganization } from "@/contexts/OrganizationContext";
import { filterDataStoresByUsage, UsageFilterTab } from "@/pages/datastoreFilterUtils";
import { PageContainer } from "@/components/PageContainer";

// Icon mapping helper
const iconMap: Record<string, LucideIcon> = {
  BookOpen,
  Database,
  Layers,
  FileText,
  Cloud,
  Brain,
  BarChart3,
  Search,
  Share2,
  Clock,
  Zap,
  Key,
  Shield,
  Globe,
};

const getIconComponent = (iconName: string): LucideIcon => {
  return iconMap[iconName] || Database;
};

// Category filters derived from the enum
const categoryFilters: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "all", label: "All Stores", icon: Database },
  { id: DataStoreCategory.KNOWLEDGE_BASE, label: "Knowledge Base", icon: BookOpen },
  { id: DataStoreCategory.RELATIONAL_DATABASE, label: "Relational", icon: Database },
  { id: DataStoreCategory.NOSQL_DATABASE, label: "NoSQL", icon: Database },
  { id: DataStoreCategory.S3_STORAGE, label: "S3 Storage", icon: Cloud },
  { id: DataStoreCategory.DATA_WAREHOUSE, label: "Data Warehouse", icon: BarChart3 },
  { id: DataStoreCategory.DATA_LAKE, label: "Data Lake", icon: Layers },
  { id: DataStoreCategory.SEARCH_ENGINE, label: "Search", icon: Search },
  { id: DataStoreCategory.GRAPH_DATABASE, label: "Graph", icon: Share2 },
  { id: DataStoreCategory.TIME_SERIES, label: "Time Series", icon: Clock },
  { id: DataStoreCategory.DOCUMENT_DATABASE, label: "Document", icon: FileText },
  { id: DataStoreCategory.CACHE, label: "Cache", icon: Zap },
  { id: DataStoreCategory.EXTERNAL, label: "External", icon: Globe },
];

const statusIcons: Record<string, LucideIcon> = {
  [DataStoreStatus.CREATED]: XCircle,
  [DataStoreStatus.CONNECTING]: Loader2,
  [DataStoreStatus.CONNECTED]: CheckCircle,
  [DataStoreStatus.PROVISIONING]: Loader2,
  [DataStoreStatus.PROVISIONED]: CheckCircle,
  [DataStoreStatus.DISCONNECTED]: XCircle,
  [DataStoreStatus.ERROR]: AlertCircle,
  [DataStoreStatus.DELETING]: Loader2,
};

export function DataStores() {
  const { selectedOrganization } = useOrganization();
  const orgId = selectedOrganization || "default";

  const [dataStores, setDataStores] = useState<DataStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [selectedUsageTab, setSelectedUsageTab] = useState<UsageFilterTab>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [viewMode, setViewMode] = useState<"all" | "connected">("all");
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [selectedDataStore, setSelectedDataStore] = useState<DataStore | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DataStore | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [stats, setStats] = useState<DataStoreStats>({
    total: 0,
    connected: 0,
    error: 0,
  });

  const loadDataStores = async () => {
    try {
      setLoading(true);
      const [data, statsData] = await Promise.all([
        datastoreService.listDataStores(orgId),
        datastoreService.getDataStoreStats(orgId),
      ]);
      setDataStores(data);
      setStats(statsData);
    } catch (error) {
      console.error("Failed to load data stores:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDataStores();
  }, [orgId]);

  const getCategoryCount = (categoryId: string) => {
    if (categoryId === "all") return dataStores.length;
    return dataStores.filter((ds) => ds.category === categoryId).length;
  };

  const filteredDataStores = filterDataStoresByUsage(dataStores, selectedUsageTab).filter((dataStore) => {
    const matchesCategory = selectedCategory === "all" || dataStore.category === selectedCategory;
    const matchesSearch =
      dataStore.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (dataStore.description || "").toLowerCase().includes(searchTerm.toLowerCase());
    const matchesView =
      viewMode === "connected"
        ? dataStore.status === DataStoreStatus.CONNECTED || dataStore.status === DataStoreStatus.PROVISIONED
        : true;
    return matchesCategory && matchesSearch && matchesView;
  });

  if (loading) {
    return (
      <PageContainer className="flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full size-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading Data Stores</p>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col w-full max-w-full box-border min-w-0">
      <div className="flex items-center justify-between shrink-0 mb-3">
        <div>
          <h1 className="text-2xl font-semibold mb-0">Data Stores</h1>
          <p className="text-muted-foreground text-xs">
            Manage knowledge bases, databases, and data sources
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="gap-1 text-xs py-1 px-2 h-7"
            onClick={() => setWizardOpen(true)}
          >
            <Plus className="size-3" />
            Add Data Store
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-muted-foreground text-xs mb-1">Total Stores</p>
              <p className="text-foreground text-2xl font-bold">{stats.total}</p>
            </div>
            <Database className="size-8 text-primary" />
          </div>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-muted-foreground text-xs mb-1">Connected</p>
              <p className="text-foreground text-2xl font-bold">{stats.connected}</p>
            </div>
            <CheckCircle className="size-8 text-chart-2" />
          </div>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-muted-foreground text-xs mb-1">Errors</p>
              <p className="text-foreground text-2xl font-bold">{stats.error}</p>
            </div>
            <AlertCircle className="size-8 text-destructive" />
          </div>
        </div>
      </div>

      <Tabs value={viewMode} onValueChange={(value: string) => setViewMode(value as "all" | "connected")} className="shrink-0">
        <TabsList className="shrink-0 mb-2">
          <TabsTrigger value="all" className="text-xs px-3 py-1">
            All ({dataStores.length})
          </TabsTrigger>
          <TabsTrigger value="connected" className="text-xs px-3 py-1">
            Connected ({stats.connected})
          </TabsTrigger>
        </TabsList>

        <div className="min-w-0">
          <TabsContent value={viewMode} className="flex flex-col gap-6">
            {/* Search */}
            <div className="flex items-center gap-4 mt-[15px]">
              <div className="flex items-center flex-1 max-w-md h-10 px-3 rounded-lg bg-accent border border-border">
                <Search className="size-4 text-muted-foreground mr-2 shrink-0" />
                <input
                  type="text"
                  placeholder="Search data stores..."
                  className="flex-1 bg-transparent border-none outline-none text-muted-foreground placeholder:text-muted-foreground text-sm"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
            </div>

            {/* Usage Filter Tabs */}
            <div className="flex gap-2">
              {([
                { id: "all" as UsageFilterTab, label: "All" },
                { id: "knowledge" as UsageFilterTab, label: "Knowledge Stores" },
                { id: "operational" as UsageFilterTab, label: "Writable Stores" },
              ]).map((tab) => {
                const isActive = selectedUsageTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    className={cn(
                      "px-4 py-1.5 rounded-md text-sm font-medium transition-all",
                      isActive
                        ? "bg-primary text-foreground border border-primary"
                        : "bg-transparent text-muted-foreground border border-border"
                    )}
                    onClick={() => setSelectedUsageTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Category Filters */}
            <div className="flex flex-wrap gap-2">
              {categoryFilters.map((category) => {
                const Icon = category.icon;
                const isActive = selectedCategory === category.id;
                return (
                  <button
                    key={category.id}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all whitespace-nowrap",
                      isActive
                        ? "bg-primary text-primary-foreground border border-primary"
                        : "bg-transparent text-muted-foreground border border-border"
                    )}
                    onClick={() => setSelectedCategory(category.id)}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="whitespace-nowrap">{category.label}</span>
                    <span className={cn(
                      "text-sm shrink-0",
                      isActive ? "text-primary-foreground" : "text-muted-foreground"
                    )}>
                      {getCategoryCount(category.id)}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Data Stores Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredDataStores.map((dataStore) => {
                const Icon = getIconComponent(dataStore.icon);
                const StatusIcon = statusIcons[dataStore.status] || XCircle;
                return (
                  <DataStoreCard
                    key={dataStore.dataStoreId}
                    dataStore={dataStore}
                    icon={Icon}
                    statusIcon={StatusIcon}
                    onConfigure={(ds) => {
                      setSelectedDataStore(ds);
                      setEditName(ds.name);
                      setEditDescription(ds.description || "");
                      setConfigDialogOpen(true);
                    }}
                    onConnect={async (ds) => {
                      try {
                        toast.info(`Connecting ${ds.name}...`);
                        await datastoreService.connectDataStore(ds.dataStoreId);
                        await loadDataStores();
                        toast.success(`${ds.name} connected successfully`);
                      } catch (error: any) {
                        console.error('Connect failed:', error);
                        toast.error(error.message || 'Failed to connect');
                      }
                    }}
                    onDisconnect={async (ds) => {
                      try {
                        await datastoreService.disconnectDataStore(ds.dataStoreId);
                        await loadDataStores();
                        toast.success(`${ds.name} disconnected`);
                      } catch (error: any) {
                        console.error('Disconnect failed:', error);
                        toast.error(error.message || 'Failed to disconnect');
                      }
                    }}
                    onDelete={(ds) => {
                      setDeleteTarget(ds);
                      setDeleteDialogOpen(true);
                    }}
                  />
                );
              })}
            </div>

            {filteredDataStores.length === 0 && (
              <div className="text-center py-12">
                <Database className="size-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-medium mb-2 text-muted-foreground">No data stores found</h3>
                <p className="text-muted-foreground">Try adjusting your search, usage, or category filters</p>
              </div>
            )}
          </TabsContent>
        </div>
      </Tabs>

      {/* Configuration Dialog — editable fields */}
      <Dialog open={configDialogOpen} onOpenChange={setConfigDialogOpen}>
        <DialogContent className="max-w-2xl bg-card border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedDataStore && (() => {
                const Icon = getIconComponent(selectedDataStore.icon);
                return <Icon className="size-5" />;
              })()}
              Configure {selectedDataStore?.name}
            </DialogTitle>
            <DialogDescription>
              Edit data store settings. Changes are saved to the backend.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="ds-name">Name</Label>
              <Input
                id="ds-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Data store name"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ds-description">Description</Label>
              <Textarea
                id="ds-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Describe this data store"
                rows={3}
              />
            </div>
            <div className="flex flex-col p-4 bg-muted rounded-lg gap-2">
              <p className="text-sm font-medium">Data Store Information</p>
              <div className="flex flex-col text-xs gap-1">
                <p><span className="font-medium">Provider:</span> {selectedDataStore?.provider}</p>
                <p><span className="font-medium">Type:</span> {selectedDataStore?.type}</p>
                <p><span className="font-medium">Status:</span> {selectedDataStore?.status}</p>
                <p><span className="font-medium">Version:</span> {selectedDataStore?.version}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={saving}
                onClick={async () => {
                  if (!selectedDataStore) return;
                  setSaving(true);
                  try {
                    await datastoreService.updateDataStore({
                      dataStoreId: selectedDataStore.dataStoreId,
                      name: editName || undefined,
                      description: editDescription,
                      version: selectedDataStore.version,
                    });
                    setConfigDialogOpen(false);
                    loadDataStores();
                  } catch (error) {
                    console.error("Failed to update data store:", error);
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? "Saving..." : "Save Configuration"}
              </Button>
              <Button variant="outline" onClick={() => setConfigDialogOpen(false)}>Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Data Store</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <span className="font-semibold">{deleteTarget?.name}</span> and
              its underlying infrastructure including IAM roles, secrets, and any provisioned resources.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              className="bg-destructive hover:bg-destructive text-foreground"
              onClick={async (e) => {
                e.preventDefault();
                if (!deleteTarget) return;
                setDeleting(true);
                try {
                  await datastoreService.deleteDataStore(deleteTarget.dataStoreId);
                  setDeleteDialogOpen(false);
                  setDeleteTarget(null);
                  loadDataStores();
                } catch (error) {
                  console.error("Failed to delete data store:", error);
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {deleting ? "Deleting..." : "Delete Data Store"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create Data Store Wizard */}
      <CreateDataStoreWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        orgId={orgId}
        onCreated={loadDataStores}
      />
    </PageContainer>
  );
}
