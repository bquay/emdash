import React, { useState, useCallback, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Checkbox } from './ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Separator } from './ui/separator';
import { Spinner } from './ui/spinner';
import { CheckCircle2, XCircle, AlertCircle, ChevronRight, ChevronLeft } from 'lucide-react';
import JiraIssueMultiSelector from './JiraIssueMultiSelector';
import { type JiraIssueSummary } from '../types/jira';
import { type Project } from '../types/app';
import { type ProviderId } from '@shared/providers/registry';
import { PROVIDERS } from '@shared/providers/registry';

interface BulkImportSettings {
  agent: ProviderId | null;
  branchPrefix: string;
  autoApprove: boolean;
  autoStart: boolean;
  useWorktree: boolean;
}

interface TaskCreationResult {
  issueKey: string;
  issueSummary: string;
  status: 'pending' | 'creating' | 'success' | 'error';
  taskId?: string;
  taskName?: string;
  error?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onImport: (
    selectedIssues: JiraIssueSummary[],
    settings: BulkImportSettings,
    onProgress?: (results: TaskCreationResult[]) => void
  ) => Promise<TaskCreationResult[]>;
  project: Project;
}

const JiraBulkImportModal: React.FC<Props> = ({ isOpen, onClose, onImport, project }) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedIssues, setSelectedIssues] = useState<JiraIssueSummary[]>([]);
  const [settings, setSettings] = useState<BulkImportSettings>({
    agent: 'claude',
    branchPrefix: '',
    autoApprove: false,
    autoStart: false,
    useWorktree: true,
  });
  const [results, setResults] = useState<TaskCreationResult[]>([]);
  const [isImporting, setIsImporting] = useState(false);

  // Filter to only terminal providers
  const terminalProviders = useMemo(
    () => PROVIDERS.filter((p) => p.terminalOnly),
    []
  );

  const handleClose = useCallback(() => {
    if (!isImporting) {
      setStep(1);
      setSelectedIssues([]);
      setResults([]);
      onClose();
    }
  }, [isImporting, onClose]);

  const handleNext = useCallback(() => {
    if (step === 1 && selectedIssues.length > 0) {
      setStep(2);
    } else if (step === 2 && settings.agent) {
      setStep(3);
      // Start import
      setIsImporting(true);
      onImport(selectedIssues, settings, setResults)
        .then((finalResults) => {
          setResults(finalResults);
        })
        .catch((error) => {
          console.error('Import failed:', error);
        })
        .finally(() => {
          setIsImporting(false);
        });
    }
  }, [step, selectedIssues, settings, onImport]);

  const handleBack = useCallback(() => {
    if (step === 2) {
      setStep(1);
    }
  }, [step]);

  const handleRetryFailed = useCallback(() => {
    const failedIssues = results
      .filter((r) => r.status === 'error')
      .map((r) => selectedIssues.find((i) => i.key === r.issueKey))
      .filter((i): i is JiraIssueSummary => i !== undefined);

    if (failedIssues.length === 0) return;

    setIsImporting(true);

    // Reset failed results to pending
    setResults((prev) =>
      prev.map((r) => (r.status === 'error' ? { ...r, status: 'pending' as const } : r))
    );

    onImport(failedIssues, settings, (updatedResults) => {
      // Merge updated results
      setResults((prev) => {
        const newResults = [...prev];
        updatedResults.forEach((updated) => {
          const index = newResults.findIndex((r) => r.issueKey === updated.issueKey);
          if (index !== -1) {
            newResults[index] = updated;
          }
        });
        return newResults;
      });
    })
      .then(() => {
        // Results already updated via onProgress callback
      })
      .catch((error) => {
        console.error('Retry failed:', error);
      })
      .finally(() => {
        setIsImporting(false);
      });
  }, [results, selectedIssues, settings, onImport]);

  const successCount = results.filter((r) => r.status === 'success').length;
  const errorCount = results.filter((r) => r.status === 'error').length;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bulk Import from Jira</DialogTitle>
          <DialogDescription>
            Import multiple Jira issues as separate tasks in {project.name}
          </DialogDescription>
        </DialogHeader>

        {/* Step 1: Select Issues */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Select Issues</h3>
              <span className="text-xs text-muted-foreground">Step 1 of 3</span>
            </div>
            <JiraIssueMultiSelector
              selectedIssues={selectedIssues}
              onSelectionChange={setSelectedIssues}
              maxSelections={20}
              isOpen={isOpen}
            />
          </div>
        )}

        {/* Step 2: Configure Settings */}
        {step === 2 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Configure Settings</h3>
              <span className="text-xs text-muted-foreground">Step 2 of 3</span>
            </div>

            <div className="space-y-4 rounded-md border border-border p-4">
              {/* Agent Selection */}
              <div className="space-y-2">
                <Label htmlFor="agent">Agent *</Label>
                <Select
                  value={settings.agent || undefined}
                  onValueChange={(value) =>
                    setSettings((prev) => ({ ...prev, agent: value as ProviderId }))
                  }
                >
                  <SelectTrigger id="agent">
                    <SelectValue placeholder="Select an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {terminalProviders.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        {provider.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  This agent will be used for all {selectedIssues.length} tasks
                </p>
              </div>

              <Separator />

              {/* Branch Prefix */}
              <div className="space-y-2">
                <Label htmlFor="branchPrefix">Branch Prefix (Optional)</Label>
                <Input
                  id="branchPrefix"
                  placeholder="e.g., jira/"
                  value={settings.branchPrefix}
                  onChange={(e) =>
                    setSettings((prev) => ({ ...prev, branchPrefix: e.target.value }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Add a prefix to all branch names (e.g., "jira/" → "jira/proj-123-fix-bug")
                </p>
              </div>

              <Separator />

              {/* Checkboxes */}
              <div className="space-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="autoApprove"
                    checked={settings.autoApprove}
                    onCheckedChange={(checked) =>
                      setSettings((prev) => ({ ...prev, autoApprove: checked as boolean }))
                    }
                  />
                  <Label htmlFor="autoApprove" className="cursor-pointer font-normal">
                    Auto-approve agent actions
                  </Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="useWorktree"
                    checked={settings.useWorktree}
                    onCheckedChange={(checked) =>
                      setSettings((prev) => ({ ...prev, useWorktree: checked as boolean }))
                    }
                  />
                  <Label htmlFor="useWorktree" className="cursor-pointer font-normal">
                    Create git worktrees (recommended)
                  </Label>
                </div>
              </div>
            </div>

            {/* Summary */}
            <div className="rounded-md bg-muted p-3 text-sm">
              <p className="font-medium">Import Summary:</p>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                <li>• {selectedIssues.length} issues will be imported</li>
                <li>• Each issue will create a separate task</li>
                <li>• All tasks will be created in parallel</li>
                <li>
                  • Branch naming: {settings.branchPrefix || ''}
                  [issue-key]-[slugified-summary]
                </li>
              </ul>
            </div>
          </div>
        )}

        {/* Step 3: Progress & Results */}
        {step === 3 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">
                {isImporting ? 'Creating Tasks...' : 'Import Complete'}
              </h3>
              <span className="text-xs text-muted-foreground">Step 3 of 3</span>
            </div>

            {/* Progress Summary */}
            <div className="flex items-center justify-between rounded-md bg-muted p-3">
              <div className="flex items-center gap-4 text-sm">
                {isImporting && (
                  <div className="flex items-center gap-2">
                    <Spinner size="sm" />
                    <span className="font-medium">
                      {successCount + errorCount} / {results.length}
                    </span>
                  </div>
                )}
                {!isImporting && (
                  <>
                    <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                      <CheckCircle2 className="h-4 w-4" />
                      <span>{successCount} succeeded</span>
                    </div>
                    {errorCount > 0 && (
                      <div className="flex items-center gap-2 text-destructive">
                        <XCircle className="h-4 w-4" />
                        <span>{errorCount} failed</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Results List */}
            <div className="max-h-[400px] overflow-y-auto rounded-md border border-border">
              <div className="divide-y divide-border">
                {results.map((result) => (
                  <div key={result.issueKey} className="flex items-start gap-3 p-3">
                    <div className="mt-0.5 flex-shrink-0">
                      {result.status === 'success' && (
                        <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                      )}
                      {result.status === 'error' && (
                        <XCircle className="h-4 w-4 text-destructive" />
                      )}
                      {(result.status === 'pending' || result.status === 'creating') && (
                        <Spinner size="sm" />
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{result.issueKey}</span>
                        <span className="text-xs text-muted-foreground">•</span>
                        <span className="truncate text-sm text-muted-foreground">
                          {result.issueSummary}
                        </span>
                      </div>
                      {result.taskName && (
                        <span className="text-xs text-muted-foreground">
                          Task: {result.taskName}
                        </span>
                      )}
                      {result.error && (
                        <span className="text-xs text-destructive">{result.error}</span>
                      )}
                      {result.status === 'creating' && (
                        <span className="text-xs text-muted-foreground">Creating...</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {errorCount > 0 && !isImporting && (
              <div className="flex items-start gap-2 rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-yellow-600 dark:text-yellow-400" />
                <div className="text-sm">
                  <p className="font-medium text-yellow-600 dark:text-yellow-400">
                    Some tasks failed to create
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    You can retry failed tasks or close this dialog and try again later.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === 1 && (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                onClick={handleNext}
                disabled={selectedIssues.length === 0}
                className="gap-2"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </>
          )}
          {step === 2 && (
            <>
              <Button variant="outline" onClick={handleBack} className="gap-2">
                <ChevronLeft className="h-4 w-4" />
                Back
              </Button>
              <Button onClick={handleNext} disabled={!settings.agent} className="gap-2">
                Start Import
              </Button>
            </>
          )}
          {step === 3 && (
            <>
              {errorCount > 0 && !isImporting && (
                <Button variant="outline" onClick={handleRetryFailed}>
                  Retry Failed
                </Button>
              )}
              <Button onClick={handleClose} disabled={isImporting}>
                {isImporting ? 'Please wait...' : 'Close'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default JiraBulkImportModal;
