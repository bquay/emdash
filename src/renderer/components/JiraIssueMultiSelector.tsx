import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Input } from './ui/input';
import { Search, Check } from 'lucide-react';
import jiraLogo from '../../assets/images/jira.png';
import { type JiraIssueSummary } from '../types/jira';
import { Separator } from './ui/separator';
import { Spinner } from './ui/spinner';
import { JiraIssuePreviewTooltip } from './JiraIssuePreviewTooltip';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';

interface Props {
  selectedIssues: JiraIssueSummary[];
  onSelectionChange: (issues: JiraIssueSummary[]) => void;
  maxSelections?: number;
  isOpen?: boolean;
  className?: string;
  disabled?: boolean;
}

const JiraIssueMultiSelector: React.FC<Props> = ({
  selectedIssues,
  onSelectionChange,
  maxSelections = 20,
  isOpen = false,
  className = '',
  disabled = false,
}) => {
  const [availableIssues, setAvailableIssues] = useState<JiraIssueSummary[]>([]);
  const [isLoadingIssues, setIsLoadingIssues] = useState(false);
  const [issueListError, setIssueListError] = useState<string | null>(null);
  const [hasRequestedIssues, setHasRequestedIssues] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<JiraIssueSummary[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const isMountedRef = useRef(true);
  const [hideResolved, setHideResolved] = useState(true); // Hide resolved by default
  const [projectFilter, setProjectFilter] = useState<string>(''); // Project key filter (e.g., "SMP")
  const [projectFilterInput, setProjectFilterInput] = useState<string>(''); // Immediate input value

  // Pagination state (browse mode) - using nextPageToken
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(undefined);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Pagination state (search mode) - using nextPageToken
  const [searchNextPageToken, setSearchNextPageToken] = useState<string | undefined>(undefined);
  const [isLoadingMoreSearch, setIsLoadingMoreSearch] = useState(false);

  // Debug: log filter values
  useEffect(() => {
    console.log('[JiraMultiSelector] Filter state:', { hideResolved, projectFilter });
  }, [hideResolved, projectFilter]);

  // Debounce project filter input (wait 500ms after user stops typing)
  useEffect(() => {
    const timer = setTimeout(() => {
      setProjectFilter(projectFilterInput);
    }, 500);
    return () => clearTimeout(timer);
  }, [projectFilterInput]);

  const canList = typeof window !== 'undefined' && !!window.electronAPI?.jiraInitialFetch;
  const issuesLoaded = availableIssues.length > 0;
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const isDisabled = disabled || (isConnected === false && (isLoadingIssues || !!issueListError || !issuesLoaded));

  useEffect(() => () => void (isMountedRef.current = false), []);

  useEffect(() => {
    if (!isOpen) {
      setAvailableIssues([]);
      setHasRequestedIssues(false);
      setIssueListError(null);
      setIsLoadingIssues(false);
      setSearchTerm('');
      setSearchResults([]);
      setIsSearching(false);
      // Reset browse pagination
      setNextPageToken(undefined);
      setIsLoadingMore(false);
      // Reset search pagination
      setSearchNextPageToken(undefined);
      setIsLoadingMoreSearch(false);
    }
  }, [isOpen]);

  // Check connection
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const api = window.electronAPI;
        const res = await api?.jiraCheckConnection?.();
        if (!cancel) setIsConnected(!!res?.connected);
      } catch {
        if (!cancel) setIsConnected(null);
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  const loadIssues = useCallback(
    async (append = false) => {
      if (!canList) return;
      const api = window.electronAPI;
      if (!api?.jiraInitialFetch) {
        setAvailableIssues([]);
        setIssueListError('Jira issue list unavailable in this build.');
        setHasRequestedIssues(true);
        return;
      }

      if (append) {
        setIsLoadingMore(true);
      } else {
        setIsLoadingIssues(true);
      }

      try {
        const options = {
          hideResolved,
          projectKey: projectFilter || undefined,
          nextPageToken: append ? nextPageToken : undefined,
        };

        console.log('[JiraMultiSelector] Loading issues:', { append, hasToken: !!options.nextPageToken, options });

        const result = await api.jiraInitialFetch(20, options);

        console.log('[JiraMultiSelector] API result:', {
          success: result?.success,
          issuesCount: result?.issues?.length || 0,
          total: result?.total,
          nextPageToken: result?.nextPageToken,
          hasNextPage: !!result?.nextPageToken,
        });

        if (!isMountedRef.current) return;
        if (!result?.success) throw new Error(result?.error || 'Failed to load Jira issues.');

        const newIssues = result.issues ?? [];

        if (append) {
          setAvailableIssues((prev) => [...prev, ...newIssues]);
        } else {
          setAvailableIssues(newIssues);
        }

        // Update pagination state with nextPageToken from response
        const token = result.nextPageToken;
        console.log('[JiraMultiSelector] Setting nextPageToken:', token);
        setNextPageToken(token);
        setIssueListError(null);
      } catch (error) {
        console.error('[JiraMultiSelector] Load error:', error);
        if (!isMountedRef.current) return;
        if (!append) {
          setAvailableIssues([]);
        }
        setIssueListError(error instanceof Error ? error.message : 'Failed to load Jira issues.');
      } finally {
        if (!isMountedRef.current) return;
        if (append) {
          setIsLoadingMore(false);
        } else {
          setIsLoadingIssues(false);
        }
        setHasRequestedIssues(true);
      }
    },
    [canList, hideResolved, projectFilter, nextPageToken]
  );

  // Initial load when modal opens
  useEffect(() => {
    if (!isOpen || !canList || isLoadingIssues || hasRequestedIssues) return;
    loadIssues();
  }, [isOpen, canList, isLoadingIssues, hasRequestedIssues, loadIssues]);

  // Track previous filter values to detect changes
  const prevFiltersRef = useRef({ hideResolved, projectFilter });
  const isInitialMountRef = useRef(true);

  // Reload when filters change (but not on initial mount)
  useEffect(() => {
    // Skip on initial mount
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      prevFiltersRef.current = { hideResolved, projectFilter };
      return;
    }

    const filtersChanged =
      prevFiltersRef.current.hideResolved !== hideResolved ||
      prevFiltersRef.current.projectFilter !== projectFilter;

    if (filtersChanged && isOpen && hasRequestedIssues) {
      console.log('[JiraMultiSelector] Filters changed, reloading...', {
        hideResolved,
        projectFilter,
      });

      // Update ref first to prevent re-triggering
      prevFiltersRef.current = { hideResolved, projectFilter };

      // Clear current results and reset pagination
      setAvailableIssues([]);
      setSearchResults([]);
      setNextPageToken(undefined);
      setSearchNextPageToken(undefined);
      setHasRequestedIssues(false);
    }
  }, [hideResolved, projectFilter, isOpen, hasRequestedIssues]);

  const searchIssues = useCallback(
    async (term: string, append = false, termChanged = false, currentToken?: string) => {
      if (!term.trim()) {
        setSearchResults([]);
        setIsSearching(false);
        setSearchNextPageToken(undefined);
        return;
      }

      if (append) {
        setIsLoadingMoreSearch(true);
      } else {
        setIsSearching(true);
        // Don't clear results immediately - keep old results visible while loading
        // Reset pagination token only when term changes, right before fetching
        if (termChanged) {
          setSearchNextPageToken(undefined);
        }
      }

      // Fetch from API with backend filtering
      const api = window.electronAPI;
      if (api?.jiraSearchIssues) {
        try {
          console.log('[JiraMultiSelector] Searching with filters:', {
            term: term.trim(),
            hideResolved,
            projectKey: projectFilter || undefined,
            hasToken: !!currentToken,
            append,
          });

          const result = await api.jiraSearchIssues(term.trim(), 20, {
            hideResolved,
            projectKey: projectFilter || undefined,
            nextPageToken: append ? currentToken : undefined,
          });

          console.log('[JiraMultiSelector] Search result:', {
            success: result?.success,
            issuesCount: result?.issues?.length || 0,
            hasNextPage: !!result?.nextPageToken,
          });

          if (!isMountedRef.current) return;

          if (result?.success) {
            const newIssues = result.issues ?? [];

            if (append) {
              setSearchResults((prev) => [...prev, ...newIssues]);
            } else {
              setSearchResults(newIssues);
            }

            // Update pagination state with nextPageToken from response
            setSearchNextPageToken(result.nextPageToken);
          }
        } catch (error) {
          console.error('[JiraMultiSelector] Search error:', error);
          if (!append) {
            setSearchResults([]);
          }
        }
      }

      if (isMountedRef.current) {
        if (append) {
          setIsLoadingMoreSearch(false);
        } else {
          setIsSearching(false);
        }
      }
    },
    [hideResolved, projectFilter]
  );

  // Track previous search term to detect changes
  const prevSearchTermRef = useRef('');

  useEffect(() => {
    const t = setTimeout(() => {
      const termChanged = searchTerm.trim() !== prevSearchTermRef.current;
      prevSearchTermRef.current = searchTerm.trim();

      // Don't reset token here - let searchIssues handle it to avoid flashing
      void searchIssues(searchTerm, false, termChanged);
    }, 250);
    return () => clearTimeout(t);
  }, [searchTerm, searchIssues]);

  const showIssues = useMemo(() => {
    if (searchTerm.trim()) {
      // When searching, show search results (already filtered by backend)
      return searchResults;
    } else {
      // When not searching, merge availableIssues with selectedIssues
      // This ensures selected issues are always visible even after clearing search
      const merged = [...availableIssues];
      const existingKeys = new Set(availableIssues.map((i) => i.key));

      // Add selected issues that aren't in available (they might be from previous filters)
      selectedIssues.forEach((selected) => {
        if (!existingKeys.has(selected.key)) {
          merged.unshift(selected); // Add selected issues to the top
        }
      });

      return merged;
    }
  }, [availableIssues, searchResults, searchTerm, selectedIssues]);

  // Debug: log pagination state
  useEffect(() => {
    console.log('[JiraMultiSelector] Pagination state:', {
      nextPageToken,
      searchNextPageToken,
      availableIssuesCount: availableIssues.length,
      searchResultsCount: searchResults.length,
      isSearching: !!searchTerm.trim(),
    });
  }, [nextPageToken, searchNextPageToken, availableIssues.length, searchResults.length, searchTerm]);


  const isIssueSelected = (issue: JiraIssueSummary) => {
    return selectedIssues.some((i) => i.key === issue.key);
  };

  const handleToggleIssue = (issue: JiraIssueSummary) => {
    if (isIssueSelected(issue)) {
      onSelectionChange(selectedIssues.filter((i) => i.key !== issue.key));
    } else {
      if (selectedIssues.length >= maxSelections) {
        return; // Don't allow more than max selections
      }
      onSelectionChange([...selectedIssues, issue]);
    }
  };

  const handleSelectAll = () => {
    const source = searchTerm.trim() ? searchResults : availableIssues;
    const toAdd = source.slice(0, maxSelections);
    onSelectionChange(toAdd);
  };

  const handleDeselectAll = () => {
    onSelectionChange([]);
  };

  if (!canList) {
    return (
      <div className={className}>
        <div className="rounded-md border border-border bg-muted p-4 text-center">
          <p className="text-sm text-muted-foreground">
            Jira integration unavailable. Connect Jira in Settings to browse issues.
          </p>
        </div>
      </div>
    );
  }

  // Split showIssues into selected and unselected for better loading UX
  const selectedIssuesInList = showIssues.filter((issue) => isIssueSelected(issue));
  const unselectedIssues = showIssues.filter((issue) => !isIssueSelected(issue));

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by key or summary..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          disabled={isDisabled}
          className="h-9 pl-9"
        />
      </div>

      {/* Filter controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center space-x-2">
          <Checkbox
            id="hideResolved"
            checked={hideResolved}
            onCheckedChange={(checked) => setHideResolved(checked as boolean)}
            disabled={isDisabled}
          />
          <label
            htmlFor="hideResolved"
            className="cursor-pointer text-sm text-muted-foreground"
          >
            Hide resolved/done tickets
          </label>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="projectFilter" className="text-sm text-muted-foreground">
            Project:
          </label>
          <Input
            id="projectFilter"
            placeholder="e.g., SMP"
            value={projectFilterInput}
            onChange={(e) => setProjectFilterInput(e.target.value.toUpperCase())}
            disabled={isDisabled}
            className="h-8 w-28 text-sm"
          />
        </div>
      </div>

      {/* Selection controls */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSelectAll}
            disabled={isDisabled || showIssues.length === 0}
          >
            Select All
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDeselectAll}
            disabled={isDisabled || selectedIssues.length === 0}
          >
            Deselect All
          </Button>
        </div>
        <span className="text-sm text-muted-foreground">
          {selectedIssues.length} / {maxSelections} selected
        </span>
      </div>

      <Separator />

      {/* Issue list */}
      <div className="max-h-[400px] overflow-y-auto overflow-x-hidden rounded-md border border-border">
        <div className="divide-y divide-border">
          {/* Helper function to render an issue */}
          {((issue: JiraIssueSummary) => {
            const selected = isIssueSelected(issue);
            const canSelect = selected || selectedIssues.length < maxSelections;
            return (
              <JiraIssuePreviewTooltip key={issue.id || issue.key} issue={issue} side="left">
                <div
                  className={`flex items-start gap-3 p-3 transition-colors hover:bg-muted ${
                    !canSelect ? 'opacity-50' : 'cursor-pointer'
                  } ${selected ? 'bg-muted/50' : ''}`}
                  onClick={() => canSelect && handleToggleIssue(issue)}
                >
                  <Checkbox
                    checked={selected}
                    disabled={!canSelect}
                    onCheckedChange={() => canSelect && handleToggleIssue(issue)}
                    className="mt-0.5"
                    onClick={(e) => e.stopPropagation()}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded border border-border bg-background px-1.5 py-0.5">
                        <img src={jiraLogo} alt="Jira" className="h-3.5 w-3.5" />
                        <span className="text-[11px] font-medium text-foreground">
                          {issue.key}
                        </span>
                      </span>
                      {issue.status?.name && (
                        <span className="text-xs text-muted-foreground">{issue.status.name}</span>
                      )}
                    </div>
                    <span className="text-sm text-foreground">{issue.summary}</span>
                    {issue.assignee?.displayName && (
                      <span className="text-xs text-muted-foreground">
                        Assigned to: {issue.assignee.displayName}
                      </span>
                    )}
                  </div>
                  {selected && <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />}
                </div>
              </JiraIssuePreviewTooltip>
            );
          }) && null}

          {/* Always show selected issues first */}
          {selectedIssuesInList.map((issue) => {
            const selected = true; // Already filtered to selected
            const canSelect = true;
            return (
              <JiraIssuePreviewTooltip key={issue.key} issue={issue} side="left">
                <div
                  className="flex items-start gap-3 p-3 cursor-pointer transition-colors hover:bg-muted bg-muted/50"
                  onClick={() => handleToggleIssue(issue)}
                >
                  <Checkbox
                    checked={selected}
                    onCheckedChange={() => handleToggleIssue(issue)}
                    className="mt-0.5"
                    onClick={(e) => e.stopPropagation()}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded border border-border bg-background px-1.5 py-0.5">
                        <img src={jiraLogo} alt="Jira" className="h-3.5 w-3.5" />
                        <span className="text-[11px] font-medium text-foreground">
                          {issue.key}
                        </span>
                      </span>
                      {issue.status?.name && (
                        <span className="text-xs text-muted-foreground">{issue.status.name}</span>
                      )}
                    </div>
                    <span className="text-sm text-foreground">{issue.summary}</span>
                    {issue.assignee?.displayName && (
                      <span className="text-xs text-muted-foreground">
                        Assigned to: {issue.assignee.displayName}
                      </span>
                    )}
                  </div>
                  <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
                </div>
              </JiraIssuePreviewTooltip>
            );
          })}

          {/* Show loading state */}
          {isLoadingIssues && (
            <div className="flex items-center justify-center gap-2 p-8">
              <Spinner size="sm" />
              <span className="text-sm text-muted-foreground">Loading Jira issues...</span>
            </div>
          )}

          {/* Show error state */}
          {issueListError && !isLoadingIssues && (
            <div className="p-4">
              <div className="rounded-md border border-destructive bg-destructive/10 p-3">
                <p className="text-sm text-destructive">Error: {issueListError}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Make sure Jira is connected in Settings.
                </p>
              </div>
            </div>
          )}

          {/* Show unselected issues */}
          {!isLoadingIssues &&
            !issueListError &&
            unselectedIssues.map((issue) => {
              const selected = false;
              const canSelect = selectedIssues.length < maxSelections;
              return (
                <JiraIssuePreviewTooltip key={issue.key} issue={issue} side="left">
                  <div
                    className={`flex items-start gap-3 p-3 transition-colors hover:bg-muted ${
                      !canSelect ? 'opacity-50' : 'cursor-pointer'
                    }`}
                    onClick={() => canSelect && handleToggleIssue(issue)}
                  >
                    <Checkbox
                      checked={selected}
                      disabled={!canSelect}
                      onCheckedChange={() => canSelect && handleToggleIssue(issue)}
                      className="mt-0.5"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex shrink-0 items-center gap-1.5 rounded border border-border bg-background px-1.5 py-0.5">
                          <img src={jiraLogo} alt="Jira" className="h-3.5 w-3.5" />
                          <span className="text-[11px] font-medium text-foreground">
                            {issue.key}
                          </span>
                        </span>
                        {issue.status?.name && (
                          <span className="text-xs text-muted-foreground">{issue.status.name}</span>
                        )}
                      </div>
                      <span className="text-sm text-foreground">{issue.summary}</span>
                      {issue.assignee?.displayName && (
                        <span className="text-xs text-muted-foreground">
                          Assigned to: {issue.assignee.displayName}
                        </span>
                      )}
                    </div>
                  </div>
                </JiraIssuePreviewTooltip>
              );
            })}

          {/* Show empty states */}
          {!isLoadingIssues &&
            !issueListError &&
            selectedIssuesInList.length === 0 &&
            unselectedIssues.length === 0 && (
              <div className="p-8 text-center text-sm text-muted-foreground">
                {searchTerm.trim() ? (
                  isSearching ? (
                    <div className="flex items-center justify-center gap-2">
                      <Spinner size="sm" />
                      <span>Searching...</span>
                    </div>
                  ) : (
                    `No issues found for "${searchTerm}"`
                  )
                ) : (
                  'No issues available'
                )}
              </div>
            )}

          {/* Load More button for browse mode - shown when nextPageToken is available */}
          {!isLoadingIssues &&
            !issueListError &&
            !searchTerm.trim() &&
            availableIssues.length > 0 &&
            nextPageToken && (
              <div className="border-t border-border p-4">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => loadIssues(true)}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore ? (
                    <>
                      <Spinner size="sm" className="mr-2" />
                      Loading...
                    </>
                  ) : (
                    'Load More'
                  )}
                </Button>
              </div>
            )}

          {/* Load More button for search mode - shown when searchNextPageToken is available */}
          {!isSearching &&
            !isLoadingIssues &&
            !issueListError &&
            searchTerm.trim() &&
            searchResults.length > 0 &&
            searchNextPageToken && (
              <div className="border-t border-border p-4">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => searchIssues(searchTerm, true, false, searchNextPageToken)}
                  disabled={isLoadingMoreSearch}
                >
                  {isLoadingMoreSearch ? (
                    <>
                      <Spinner size="sm" className="mr-2" />
                      Loading...
                    </>
                  ) : (
                    'Load More'
                  )}
                </Button>
              </div>
            )}
        </div>
      </div>
    </div>
  );
};

export default JiraIssueMultiSelector;
