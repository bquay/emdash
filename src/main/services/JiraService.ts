import { request } from 'node:https';
import { URL } from 'node:url';
import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

type JiraCreds = { siteUrl: string; email: string };

function encodeBasic(email: string, token: string) {
  const raw = `${email}:${token}`;
  return Buffer.from(raw).toString('base64');
}

export interface JiraConnectionStatus {
  connected: boolean;
  accountId?: string;
  displayName?: string;
  siteUrl?: string;
  error?: string;
}

export default class JiraService {
  private readonly SERVICE = 'emdash-jira';
  private readonly ACCOUNT = 'api-token';
  private readonly CONF_FILE = join(app.getPath('userData'), 'jira.json');

  private readCreds(): JiraCreds | null {
    try {
      if (!existsSync(this.CONF_FILE)) return null;
      const raw = readFileSync(this.CONF_FILE, 'utf8');
      const obj = JSON.parse(raw);
      const siteUrl = String(obj?.siteUrl || '').trim();
      const email = String(obj?.email || '').trim();
      if (!siteUrl || !email) return null;
      return { siteUrl, email };
    } catch {
      return null;
    }
  }

  private writeCreds(creds: JiraCreds) {
    const { siteUrl, email } = creds;
    const obj: any = { siteUrl, email };
    writeFileSync(this.CONF_FILE, JSON.stringify(obj), 'utf8');
  }

  async saveCredentials(
    siteUrl: string,
    email: string,
    token: string
  ): Promise<{
    success: boolean;
    displayName?: string;
    error?: string;
  }> {
    try {
      const me = await this.getMyself(siteUrl, email, token);
      const keytar = await import('keytar');
      await keytar.setPassword(this.SERVICE, this.ACCOUNT, token);
      this.writeCreds({ siteUrl, email });
      // Track connection
      void import('../telemetry').then(({ capture }) => {
        void capture('jira_connected');
      });
      return { success: true, displayName: me?.displayName };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  }

  async clearCredentials(): Promise<{ success: boolean; error?: string }> {
    try {
      const keytar = await import('keytar');
      try {
        await keytar.deletePassword(this.SERVICE, this.ACCOUNT);
      } catch {}
      try {
        if (existsSync(this.CONF_FILE)) unlinkSync(this.CONF_FILE);
      } catch {}
      // Track disconnection
      void import('../telemetry').then(({ capture }) => {
        void capture('jira_disconnected');
      });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  }

  async checkConnection(): Promise<JiraConnectionStatus> {
    try {
      const creds = this.readCreds();
      if (!creds) return { connected: false };
      const keytar = await import('keytar');
      const token = await keytar.getPassword(this.SERVICE, this.ACCOUNT);
      if (!token) return { connected: false };
      const me = await this.getMyself(creds.siteUrl, creds.email, token);
      return {
        connected: true,
        accountId: me?.accountId,
        displayName: me?.displayName,
        siteUrl: creds.siteUrl,
      };
    } catch (e: any) {
      return { connected: false, error: e?.message || String(e) };
    }
  }

  async initialFetch(
    limit = 50,
    options?: { hideResolved?: boolean; projectKey?: string; nextPageToken?: string }
  ): Promise<{ issues: any[]; total: number; startAt: number; maxResults: number; nextPageToken?: string }> {
    const { siteUrl, email, token } = await this.requireAuth();
    const nextPageToken = options?.nextPageToken;

    // Build filter clauses
    const filters: string[] = [];
    if (options?.hideResolved) {
      filters.push('status NOT IN (Done, Resolved, Closed)');
    }
    if (options?.projectKey) {
      filters.push(`project = "${options.projectKey}"`);
    }

    // Helper to build full JQL with filters
    const buildJql = (baseQuery: string) => {
      const filterStr = filters.join(' AND ');
      if (!baseQuery) {
        return `${filterStr} ORDER BY updated DESC`;
      }
      if (!filterStr) {
        return `${baseQuery} ORDER BY updated DESC`;
      }
      return `${filterStr} AND ${baseQuery} ORDER BY updated DESC`;
    };

    const jqlCandidates: string[] = [];
    // Try broadest query first to show all accessible issues (not just assigned)
    if (filters.length === 0) {
      // No filters, use simpler queries
      jqlCandidates.push(
        'ORDER BY updated DESC',
        '(assignee = currentUser() OR assignee is EMPTY) ORDER BY updated DESC',
        'assignee = currentUser() ORDER BY updated DESC'
      );
    } else {
      // With filters, need parentheses for correct precedence
      jqlCandidates.push(
        buildJql(''), // Just filters
        buildJql('(assignee = currentUser() OR assignee is EMPTY)'),
        buildJql('assignee = currentUser()')
      );
    }

    console.log('[JiraService] initialFetch filters:', { hideResolved: options?.hideResolved, projectKey: options?.projectKey });
    console.log('[JiraService] JQL candidates:', jqlCandidates);

    for (const jql of jqlCandidates) {
      try {
        console.log('[JiraService] Trying JQL:', jql);
        const result = await this.searchRaw(siteUrl, email, token, jql, limit, nextPageToken);
        console.log('[JiraService] Result:', { issuesCount: result.issues.length, total: result.total });
        if (result.issues.length > 0) {
          return {
            issues: this.normalizeIssues(siteUrl, result.issues),
            total: result.total,
            startAt: result.startAt,
            maxResults: result.maxResults,
            nextPageToken: result.nextPageToken,
          };
        }
      } catch (err) {
        console.log('[JiraService] JQL failed:', jql, err);
        // Try next candidate if this one is forbidden or failed
      }
    }

    // Don't use issue picker fallback when filters are active
    // (issue picker doesn't support filters, so results would be misleading)
    if (options?.hideResolved || options?.projectKey) {
      console.log('[JiraService] No results found with filters, returning empty');
      return { issues: [], total: 0, startAt: 0, maxResults: limit, nextPageToken: undefined };
    }

    // Final fallback: use issue picker to get recent/history issues, then hydrate via GET /issue/{key}
    // Note: Only use this fallback on initial fetch (no pagination token)
    if (!nextPageToken) {
      try {
        const keys = await this.getRecentIssueKeys(siteUrl, email, token, limit);
        if (keys.length > 0) {
          const results: any[] = [];
          for (const key of keys.slice(0, limit)) {
            try {
              const issue = await this.getIssueByKey(siteUrl, email, token, key);
              if (issue) results.push(issue);
            } catch {
              // skip individual failures
            }
          }
          if (results.length > 0) {
            return {
              issues: this.normalizeIssues(siteUrl, results),
              total: keys.length,
              startAt: 0,
              maxResults: limit,
              nextPageToken: undefined,
            };
          }
        }
      } catch {
        // ignore
      }
    }
    return { issues: [], total: 0, startAt: 0, maxResults: limit, nextPageToken: undefined };
  }

  async searchIssues(searchTerm: string, limit = 20): Promise<any[]> {
    const term = (searchTerm || '').trim();
    if (!term) return [];
    const { siteUrl, email, token } = await this.requireAuth();
    const sanitized = term.replace(/\"/g, '\\\"');
    const inner = `text ~ \"${sanitized}\" OR key = ${term}`;
    const jql = inner;
    const result = await this.searchRaw(siteUrl, email, token, jql, limit);
    return this.normalizeIssues(siteUrl, result.issues);
  }

  private async requireAuth(): Promise<{ siteUrl: string; email: string; token: string }> {
    const creds = this.readCreds();
    if (!creds) throw new Error('Jira credentials not set.');
    const keytar = await import('keytar');
    const token = await keytar.getPassword(this.SERVICE, this.ACCOUNT);
    if (!token) throw new Error('Jira token not found.');
    return { ...creds, token };
  }

  private async getMyself(siteUrl: string, email: string, token: string): Promise<any> {
    const url = new URL('/rest/api/3/myself', siteUrl);
    const body = await this.doGet(url, email, token);
    const data = JSON.parse(body || '{}');
    if (!data || data.errorMessages) {
      throw new Error('Failed to verify Jira token.');
    }
    return data;
  }

  private async searchRaw(
    siteUrl: string,
    email: string,
    token: string,
    jql: string,
    limit: number,
    nextPageToken?: string
  ) {
    // Use /rest/api/3/search/jql with nextPageToken pagination
    const url = new URL('/rest/api/3/search/jql', siteUrl);
    url.searchParams.set('jql', jql);
    url.searchParams.set('maxResults', String(Math.min(Math.max(limit, 1), 100)));
    url.searchParams.set('fields', 'summary,updated,project,status,assignee');

    // Add nextPageToken if provided (for subsequent pages)
    if (nextPageToken) {
      url.searchParams.set('nextPageToken', nextPageToken);
    }

    console.log('[JiraService] Search with nextPageToken:', { jql, limit, hasToken: !!nextPageToken });

    const body = await this.doGet(url, email, token);
    const data = JSON.parse(body || '{}');

    const issues = Array.isArray(data?.issues) ? data.issues : [];
    const issueKeys = issues.map((i: any) => i?.key).filter(Boolean);
    const responseNextPageToken = data?.nextPageToken;

    console.log('[JiraService] Search response:', {
      issuesCount: issues.length,
      total: data?.total,
      hasNextPage: !!responseNextPageToken,
      firstIssueKey: issueKeys[0],
      lastIssueKey: issueKeys[issueKeys.length - 1],
    });

    return {
      issues,
      total: typeof data?.total === 'number' ? data.total : 0,
      startAt: typeof data?.startAt === 'number' ? data.startAt : 0,
      maxResults: typeof data?.maxResults === 'number' ? data.maxResults : limit,
      nextPageToken: responseNextPageToken,
    };
  }

  private async doGet(url: URL, email: string, token: string): Promise<string> {
    return this.doRequest(url, email, token, 'GET');
  }

  private async doRequest(
    url: URL,
    email: string,
    token: string,
    method: 'GET' | 'POST',
    payload?: string,
    extraHeaders?: Record<string, string>
  ): Promise<string> {
    const auth = encodeBasic(email, token);
    return await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          protocol: url.protocol,
          method,
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json',
            ...(extraHeaders || {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              const snippet = data?.slice(0, 200) || '';
              return reject(
                new Error(`Jira API error ${res.statusCode}${snippet ? `: ${snippet}` : ''}`)
              );
            }
            resolve(data);
          });
        }
      );
      req.on('error', reject);
      if (payload && method === 'POST') {
        req.write(payload);
      }
      req.end();
    });
  }

  // Enhanced search that supports direct issue-key lookups and robust quoting
  async smartSearchIssues(
    searchTerm: string,
    limit = 20,
    options?: { hideResolved?: boolean; projectKey?: string; nextPageToken?: string }
  ): Promise<{ issues: any[]; total: number; startAt: number; maxResults: number; nextPageToken?: string }> {
    const term = (searchTerm || '').trim();
    if (!term) return { issues: [], total: 0, startAt: 0, maxResults: limit, nextPageToken: undefined };
    const { siteUrl, email, token } = await this.requireAuth();
    const nextPageToken = options?.nextPageToken;

    const looksLikeKey = /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(term);
    if (looksLikeKey && !nextPageToken) {
      const keyUpper = term.toUpperCase();
      try {
        const issue = await this.getIssueByKey(siteUrl, email, token, keyUpper);
        // Check if issue matches filters
        if (issue) {
          // Apply filters manually for direct key lookup
          if (options?.hideResolved) {
            const resolvedStatuses = ['done', 'resolved', 'closed'];
            const status = (issue.fields?.status?.name || '').toLowerCase();
            if (resolvedStatuses.includes(status)) {
              // Issue is resolved, skip it
              return { issues: [], total: 0, startAt: 0, maxResults: limit, nextPageToken: undefined };
            }
          }
          if (options?.projectKey) {
            const projectKey = issue.fields?.project?.key;
            if (projectKey !== options.projectKey) {
              // Issue doesn't match project filter
              return { issues: [], total: 0, startAt: 0, maxResults: limit, nextPageToken: undefined };
            }
          }
          const normalized = this.normalizeIssues(siteUrl, [issue]);
          return { issues: normalized, total: 1, startAt: 0, maxResults: limit, nextPageToken: undefined };
        }
      } catch {
        // If direct fetch fails (404/403/etc.), falling back to JQL search below
      }
    }

    // Build JQL safely (escape quotes in term)
    const sanitized = term.replace(/"/g, '\\"');

    // Use explicit field search instead of text~ which requires indexing
    // Only search in summary and issueKey for performance (description can be very long)
    // Add wildcard (*) for prefix matching unless term already has wildcards
    const wildcardTerm = sanitized.includes('*') ? sanitized : `${sanitized}*`;
    const summaryMatch = `summary ~ \"${wildcardTerm}\"`;
    const keyMatch = looksLikeKey ? `issueKey = \"${term.toUpperCase()}\"` : `issueKey ~ \"${wildcardTerm}\"`;

    const searchClause = `(${summaryMatch} OR ${keyMatch})`;

    // Build filter clauses
    const filters: string[] = [searchClause];
    if (options?.hideResolved) {
      filters.push('status NOT IN (Done, Resolved, Closed)');
    }
    if (options?.projectKey) {
      filters.push(`project = "${options.projectKey}"`);
    }

    const jql = filters.join(' AND ');

    console.log('[JiraService] Search term:', term, '-> with wildcard:', wildcardTerm);
    console.log('[JiraService] Generated JQL:', jql);

    try {
      const result = await this.searchRaw(siteUrl, email, token, jql, limit, nextPageToken);
      console.log('[JiraService] Search results count:', result.issues?.length || 0);
      return {
        issues: this.normalizeIssues(siteUrl, result.issues),
        total: result.total,
        startAt: result.startAt,
        maxResults: result.maxResults,
        nextPageToken: result.nextPageToken,
      };
    } catch (error) {
      console.error('[JiraService] Search error:', error);
      throw error;
    }
  }

  private async getIssueByKey(
    siteUrl: string,
    email: string,
    token: string,
    key: string
  ): Promise<any | null> {
    const url = new URL(`/rest/api/3/issue/${encodeURIComponent(key)}`, siteUrl);
    url.searchParams.set('fields', 'summary,updated,project,status,assignee');
    const body = await this.doGet(url, email, token);
    const data = JSON.parse(body || '{}');
    if (!data || data.errorMessages) return null;
    return data;
  }

  private async getRecentIssueKeys(
    siteUrl: string,
    email: string,
    token: string,
    limit: number
  ): Promise<string[]> {
    // Jira issue picker provides recent/history issue suggestions
    const url = new URL('/rest/api/3/issue/picker', siteUrl);
    url.searchParams.set('query', '');
    url.searchParams.set('currentJQL', '');
    const body = await this.doGet(url, email, token);
    const data = JSON.parse(body || '{}');
    const keys: string[] = [];
    const sections = Array.isArray(data?.sections) ? data.sections : [];
    for (const sec of sections) {
      const issues = Array.isArray(sec?.issues) ? sec.issues : [];
      for (const it of issues) {
        const k = String(it?.key || '').trim();
        if (k && !keys.includes(k)) keys.push(k);
        if (keys.length >= limit) break;
      }
      if (keys.length >= limit) break;
    }
    return keys;
  }

  private normalizeIssues(siteUrl: string, rawIssues: any[]): any[] {
    const base = siteUrl.replace(/\/$/, '');
    return (rawIssues || []).map((it) => {
      const fields = it?.fields || {};
      return {
        id: String(it?.id || it?.key || ''),
        key: String(it?.key || ''),
        summary: String(fields?.summary || ''),
        description: null,
        url: `${base}/browse/${it?.key}`,
        status: fields?.status ? { name: fields.status.name } : null,
        project: fields?.project ? { key: fields.project.key, name: fields.project.name } : null,
        assignee: fields?.assignee
          ? { displayName: fields.assignee.displayName, name: fields.assignee.name }
          : null,
        updatedAt: fields?.updated || null,
      };
    });
  }
}
